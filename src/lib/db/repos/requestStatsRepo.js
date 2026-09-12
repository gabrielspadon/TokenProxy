import { getAdapter } from "../driver.js";
import { saveContextMetrics, shouldIgnorePending, cleanupContext, retentionDays } from "./contextRepo.js";
import { canonicalizeUsage } from "../../../../open-sse/utils/usageTracking.js";
import { normalizeTerminalEvidence } from "../terminalEvidence.js";
import { telemetryFilterSql } from '../analytics/telemetryFilter.mjs';
import { processTelemetryOrigin } from '../telemetryOrigin.js';

// Full-history statistics source. One row per request (id is the requestDetail
// id, shared across the streaming start/complete upsert), written
// unconditionally from saveRequestDetail — independent of the observability
// ring-buffer toggle. History is preserved unless statsRetentionMode explicitly
// selects a window, cleaned on a cadence from saveRequestStats.

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const MIN_MS = 60000;

// Candidate bucket widths, coarse→fine. Auto-granularity picks the coarsest
// width that still yields ≥ MIN_SERIES_POINTS buckets over the actual data span.
const SERIES_BUCKET_MS = [
  DAY_MS,
  12 * HOUR_MS,
  6 * HOUR_MS,
  3 * HOUR_MS,
  HOUR_MS,
  30 * MIN_MS,
  15 * MIN_MS,
  5 * MIN_MS,
  MIN_MS,
];
const MIN_SERIES_POINTS = 30;
const MAX_STATS_FILTER_ROWS = 5000;

let lastCleanup = 0;
let backfillStarted = false;

export function seriesBounds(times) {
  let min = Infinity;
  let max = -Infinity;
  for (const time of times) {
    if (!Number.isFinite(time)) continue;
    min = Math.min(min, time);
    max = Math.max(max, time);
  }
  return Number.isFinite(min) ? { min, max } : null;
}

async function getConnectionMap() {
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    return map;
  } catch {
    return {};
  }
}

// The provider's display name comes from its provider node (the name the user
// configured for the node, e.g. "b-ai"), not the connection/account name
// (e.g. "2"). Standard registry providers have no node and keep their key.
async function getProviderNameMap() {
  try {
    const { getProviderNodes } = await import("./nodesRepo.js");
    const nodes = await getProviderNodes();
    const map = {};
    for (const n of nodes) {
      if (n.id && n.name && !map[n.id]) map[n.id] = n.name;
    }
    return map;
  } catch {
    return {};
  }
}

// Filter values may be a single value or an array (multi-select). Empty /
// falsy means "no filter on this dimension" (all). Arrays build an IN clause.
function colIn(col, values) {
  const list = (Array.isArray(values) ? values : values ? [values] : []).filter(Boolean);
  if (list.length === 0) return null;
  const placeholders = list.map(() => "?").join(", ");
  return { clause: `${col} IN (${placeholders})`, params: list };
}

export function buildStatsWhere(filter = {}) {
  const conds = [telemetryFilterSql('requestStats')];
  const params = [];
  for (const [col, key] of [["provider", "provider"], ["model", "model"], ["connectionId", "connectionId"]]) {
    const c = colIn(col, filter[key]);
    if (c) { conds.push(c.clause); params.push(...c.params); }
  }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return { where, params };
}

const pendingWrites = new Map();
export function saveRequestStats(detail) {
  const logicalId = detail?.contextTelemetry?.logicalRequestId;
  const write = saveRequestStatsInternal(detail);
  if (!logicalId) return write;
  const pending = pendingWrites.get(logicalId) || new Set();
  pendingWrites.set(logicalId, pending);
  const tracked = write.finally(() => {
    pending.delete(tracked);
    if (!pending.size) pendingWrites.delete(logicalId);
  });
  pending.add(tracked);
  return tracked;
}

export async function flushRequestStats(logicalId) {
  while (pendingWrites.has(logicalId)) await Promise.allSettled([...pendingWrites.get(logicalId)]);
}

async function saveRequestStatsInternal(detail) {
  if (!detail || typeof detail !== "object" || !detail.id) return;
  try {
    const terminalEvidence = normalizeTerminalEvidence(detail.terminalEvidence, detail.status);
    const db = await getAdapter();
    const tokens = canonicalizeUsage(detail.tokens) || {};
    const latency = detail.latency || {};
    const { persistUsagePricing } = await import("./usagePricing.js");
    db.transaction(() => {
      const existing = db.get(`SELECT * FROM requestStats WHERE id=?`, [detail.id]);
      if (detail.status === "pending" && existing?.terminalObservedAt) return;
      if (shouldIgnorePending(existing, detail)) return;
      const timestamp = detail.timestamp || new Date().toISOString();
      const values = {
        timestamp, status: detail.status || "success", promptTokens: tokens.prompt_tokens || 0,
        completionTokens: tokens.completion_tokens || 0, cachedTokens: tokens.cached_tokens || 0,
        cacheCreationTokens: tokens.cache_creation_input_tokens || 0, reasoningTokens: tokens.reasoning_tokens || 0,
        latencyTotal: latency.total || 0, latencyTtft: latency.ttft || 0,
      };
      if (!existing || Object.entries(values).some(([field, value]) => existing[field] !== value)) db.run(
        `INSERT INTO requestStats(id, timestamp, provider, model, connectionId, status,
           promptTokens, completionTokens, cachedTokens, cacheCreationTokens, reasoningTokens,
           latencyTotal, latencyTtft, dataOrigin)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           timestamp = excluded.timestamp,
           status = excluded.status,
           promptTokens = excluded.promptTokens,
           completionTokens = excluded.completionTokens,
           cachedTokens = excluded.cachedTokens,
           cacheCreationTokens = excluded.cacheCreationTokens,
           reasoningTokens = excluded.reasoningTokens,
           latencyTotal = excluded.latencyTotal,
           latencyTtft = excluded.latencyTtft`,
        [
          detail.id,
          timestamp,
          detail.provider || null,
          detail.model || null,
          detail.connectionId || null,
          detail.status || "success",
          tokens.prompt_tokens || 0,
          tokens.completion_tokens || 0,
          tokens.cached_tokens || 0,
          tokens.cache_creation_input_tokens || 0,
          tokens.reasoning_tokens || 0,
          latency.total || 0,
          latency.ttft || 0,
          processTelemetryOrigin(),
        ]
      );
      const coverage = detail.contextTelemetry?.dispatchCoverage;
      if (["physical-dispatch", "executor-invocation", "preparation-only"].includes(coverage) && existing?.dispatchCoverage !== coverage) {
        db.run(`UPDATE requestStats SET dispatchCoverage=? WHERE id=?`, [coverage, detail.id]);
      }
      const snapshot = detail.contextTelemetry?.pricingSnapshot;
      // The foreign-key join already proves this immutable rate card was stored.
      const snapshotId = snapshot?.id && snapshot.id === existing?.rateSnapshotId
        ? existing.rateSnapshotId : persistUsagePricing(db, snapshot);
      if (snapshotId && (!existing?.rateSnapshotId || !existing?.pricingCapturedAt)) db.run(`UPDATE requestStats SET rateSnapshotId=COALESCE(rateSnapshotId,?),
        pricingCapturedAt=COALESCE(pricingCapturedAt,?) WHERE id=?`, [snapshotId, snapshot.capturedAt, detail.id]);
      try {
        db.transaction(() => saveContextMetrics(db, { ...detail, timestamp }));
      } catch {
        // Optional observability must never roll back authoritative billed usage.
        db.run(`UPDATE requestStats SET contextSessionId=NULL,contextTelemetryError='invalid-metrics' WHERE id=?`, [detail.id]);
        db.run(`DELETE FROM contextStages WHERE requestId=?`, [detail.id]);
        db.run(`DELETE FROM contextStructures WHERE requestId=?`, [detail.id]);
      }
      if (terminalEvidence) db.run(`UPDATE requestStats SET terminalState=?,terminalReason=?,terminalSource=?,terminalObservedAt=? WHERE id=?`,
        [terminalEvidence.terminalState, terminalEvidence.terminalReason, terminalEvidence.terminalSource, terminalEvidence.terminalObservedAt, detail.id]);
    });
    await maybeCleanup(db);
  } catch (e) {
    console.error("[requestStats] save failed:", e);
  }
}

async function maybeCleanup(db) {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    cleanupContext(db, now, retentionDays(settings));
  } catch {}
}

// One-time backfill of the pre-existing usageHistory rows (they carry the same
// canonical token shape, but no latency — those columns stay 0). Runs on the
// first statistics read when the table is empty.
export async function ensureStatsBackfilled() {
  if (backfillStarted) return;
  backfillStarted = true;
  try {
    const db = await getAdapter();
    const row = db.get(`SELECT COUNT(*) as c FROM requestStats`);
    if (row && row.c > 0) return;
    const meta = db.get(`SELECT value FROM _meta WHERE key = 'statsBackfilled'`);
    if (meta) return;
    db.transaction(() => {
      db.run(
        `INSERT INTO requestStats(id, timestamp, provider, model, connectionId, status,
           promptTokens, completionTokens, cachedTokens, cacheCreationTokens, reasoningTokens, dataOrigin, originReceiptId, sourceUsageId)
         SELECT 'bh-' || id, timestamp, provider, model, connectionId, status,
                promptTokens, completionTokens,
                COALESCE(json_extract(tokens, '$.cached_tokens'), json_extract(tokens, '$.cache_read_input_tokens'), 0),
                COALESCE(json_extract(tokens, '$.cache_creation_input_tokens'), 0),
                COALESCE(json_extract(tokens, '$.reasoning_tokens'), 0), dataOrigin, originReceiptId, id
         FROM usageHistory`
      );
      db.run(`INSERT INTO _meta(key, value) VALUES('statsBackfilled', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    });
  } catch (e) {
    console.error("[requestStats] backfill failed:", e);
  }
}

export async function getStatsFilters(filter = {}) {
  await ensureStatsBackfilled();
  const db = await getAdapter();
  const connMap = await getConnectionMap();
  const providerNameMap = await getProviderNameMap();
  // Facets intentionally ignore the currently selected dimensions so the UI
  // can offer alternate values, but they must share the route's validated
  // time window. A stable hard cap bounds both SQLite work and response size.
  const { where, params } = buildStatsWhere({
    startDate: filter.startDate,
    endDate: filter.endDate,
  });
  const nonEmptyFacet = "(provider IS NOT NULL OR model IS NOT NULL OR connectionId IS NOT NULL)";
  const boundedWhere = where ? `${where} AND ${nonEmptyFacet}` : `WHERE ${nonEmptyFacet}`;

  const rows = db.all(
    `SELECT DISTINCT provider, model, connectionId FROM requestStats
     ${boundedWhere}
     ORDER BY provider, model, connectionId
     LIMIT ?`,
    [...params, MAX_STATS_FILTER_ROWS],
  );

  const providerSet = new Map();
  const modelSet = new Set();
  const accountSet = new Map();
  const accountsByProvider = new Map();
  const modelsByProvider = new Map();
  const modelsByAccount = new Map();

  const add = (map, key, val) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(val);
  };

  for (const r of rows) {
    const p = r.provider;
    const m = r.model;
    const c = r.connectionId;
    if (p) providerSet.set(p, { id: p, name: providerNameMap[p] || p });
    if (m) modelSet.add(m);
    if (c) accountSet.set(c, { id: c, name: connMap[c] || c });
    add(modelsByProvider, p, m);
    add(modelsByAccount, c, m);
    add(accountsByProvider, p, c);
  }

  const toSorted = (set) => [...set].sort((a, b) => String(a).localeCompare(String(b)));
  const toAccounts = (set) =>
    toSorted(set).map((id) => ({ id, name: connMap[id] || id }));

  return {
    providers: [...providerSet.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    models: toSorted(modelSet),
    accounts: [...accountSet.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    // Linkage maps so the UI can cascade Provider → Account → Model.
    accountsByProvider: Object.fromEntries([...accountsByProvider].map(([p, s]) => [p, toAccounts(s)])),
    modelsByProvider: Object.fromEntries([...modelsByProvider].map(([p, s]) => [p, toSorted(s)])),
    modelsByAccount: Object.fromEntries([...modelsByAccount].map(([c, s]) => [c, toSorted(s)])),
  };
}

export async function getStatsSummary(filter = {}) {
  await ensureStatsBackfilled();
  const db = await getAdapter();
  const { where, params } = buildStatsWhere(filter);
  const row = db.get(
    `SELECT COUNT(*) as requests,
            COALESCE(SUM(promptTokens), 0) as promptTokens,
            COALESCE(SUM(completionTokens), 0) as completionTokens,
            COALESCE(SUM(cachedTokens), 0) as cachedTokens,
            COALESCE(SUM(cacheCreationTokens), 0) as cacheCreationTokens,
            AVG(CASE WHEN latencyTotal > 0 THEN latencyTotal END) as avgLatency,
            SUM(CASE WHEN latencyTotal > 0 THEN 1 ELSE 0 END) as latencySamples,
            AVG(CASE WHEN latencyTtft > 0 THEN latencyTtft END) as avgTtft,
            SUM(CASE WHEN latencyTtft > 0 THEN 1 ELSE 0 END) as ttftSamples
     FROM requestStats ${where}`,
    params
  );
  const requests = row.requests || 0;
  const prompt = row.promptTokens || 0;
  const cached = row.cachedTokens || 0;
  const created = row.cacheCreationTokens || 0;
  const inputOnly = Math.max(0, prompt - cached - created);
  const hitDenom = inputOnly + cached;
  // latencyTotal/latencyTtft are 0 on rows that never measured them (backfilled
  // history, and any writer that omitted them), exactly as getTrafficWindow
  // treats them. Averaging across those rows would put the average over a
  // different population than the request count printed beside it, so the
  // sample counts travel with the averages and the UI states them.
  const latencySamples = row.latencySamples || 0;
  const ttftSamples = row.ttftSamples || 0;
  return {
    totalRequests: requests,
    totalTokens: prompt + (row.completionTokens || 0),
    inputTokens: inputOnly,
    outputTokens: row.completionTokens || 0,
    cacheReadTokens: cached,
    cacheCreationTokens: created,
    // null, not 0: with nothing to divide there is no rate at all, and 0 would
    // claim every request missed the cache.
    cacheHitRate: hitDenom > 0 ? cached / hitDenom : null,
    latency: {
      avgLatencyMs: latencySamples > 0 ? row.avgLatency : null,
      avgTtftMs: ttftSamples > 0 ? row.avgTtft : null,
      latencySamples,
      ttftSamples,
      requests,
    },
  };
}

// Auto-granularity series: the bucket width is derived from the actual data
// span (min..max timestamps), not the requested filter range, so a narrow real
// window yields fine buckets and the curve keeps ≥ MIN_SERIES_POINTS points.
export async function getStatsSeries(filter = {}) {
  await ensureStatsBackfilled();
  const db = await getAdapter();
  const { where, params } = buildStatsWhere(filter);
  const rows = db.all(
    `SELECT timestamp, promptTokens, completionTokens, cachedTokens, cacheCreationTokens FROM requestStats ${where}`,
    params
  );
  if (!rows.length) return [];

  const bounds = seriesBounds(rows.map((r) => new Date(r.timestamp).getTime()));
  if (!bounds) return [];
  const { min, max } = bounds;
  const span = Math.max(max - min, MIN_MS);
  // Coarsest bucket width that still fits ≥ MIN_SERIES_POINTS points across
  // the span (span/w + 1 >= MIN_SERIES_POINTS  ⇒  w <= span/MIN_SERIES_POINTS).
  const bucketMs = SERIES_BUCKET_MS.find((w) => w <= span / MIN_SERIES_POINTS) || MIN_MS;
  const start = Math.floor(min / bucketMs) * bucketMs;
  const end = Math.max(max, start + bucketMs);

  const isDay = bucketMs === DAY_MS;
  const isHour = bucketMs === HOUR_MS || bucketMs === 12 * HOUR_MS || bucketMs === 6 * HOUR_MS || bucketMs === 3 * HOUR_MS;
  const buckets = new Map();
  for (let t = start; t <= end; t += bucketMs) {
    const d = new Date(t);
    const label = isDay
      ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : isHour
        ? d.toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        : d.toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    buckets.set(t, { label, requests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheHitRate: null });
  }

  for (const r of rows) {
    const t = new Date(r.timestamp).getTime();
    if (!Number.isFinite(t)) continue;
    const idx = Math.floor(t / bucketMs) * bucketMs;
    const b = buckets.get(idx);
    if (!b) continue;
    const prompt = r.promptTokens || 0;
    const cached = r.cachedTokens || 0;
    const created = r.cacheCreationTokens || 0;
    const inputOnly = Math.max(0, prompt - cached - created);
    b.requests += 1;
    b.totalTokens += prompt + (r.completionTokens || 0);
    b.inputTokens += inputOnly;
    b.outputTokens += r.completionTokens || 0;
    b.cacheReadTokens += cached;
    b.cacheCreationTokens += created;
  }

  const out = [...buckets.values()];
  for (const b of out) {
    const denom = b.inputTokens + b.cacheReadTokens;
    b.cacheHitRate = denom > 0 ? b.cacheReadTokens / denom : null;
  }
  return out;
}

export async function getStatsItems(filter = {}) {
  await ensureStatsBackfilled();
  const db = await getAdapter();
  const { where, params } = buildStatsWhere(filter);
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestStats ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT id, timestamp, provider, model, connectionId, status,
            promptTokens, completionTokens, cachedTokens, cacheCreationTokens, reasoningTokens,
            latencyTotal, latencyTtft
     FROM requestStats ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const connectionMap = await getConnectionMap();
  const items = rows.map((r) => {
    const prompt = r.promptTokens || 0;
    const cached = r.cachedTokens || 0;
    const created = r.cacheCreationTokens || 0;
    const inputOnly = Math.max(0, prompt - cached - created);
    const hitDenom = inputOnly + cached;
    return {
      id: r.id,
      timestamp: r.timestamp,
      provider: r.provider,
      model: r.model,
      account: connectionMap[r.connectionId] || r.connectionId || "",
      status: r.status || "success",
      inputTokens: inputOnly,
      outputTokens: r.completionTokens || 0,
      cacheReadTokens: cached,
      cacheCreationTokens: created,
      reasoningTokens: r.reasoningTokens || 0,
      cacheHitRate: hitDenom > 0 ? cached / hitDenom : null,
      latencyMs: r.latencyTotal > 0 ? r.latencyTotal : null,
      ttftMs: r.latencyTtft > 0 ? r.latencyTtft : null,
    };
  });

  return {
    items,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

// ─── System state (read-only) ────────────────────────────────────────────────
// Backs GET /api/system/state. Read-only by contract: it never triggers the
// usageHistory backfill above, because the endpoint only ever asks about a
// short rolling window and every live request writes requestStats directly
// (saveRequestDetail → saveRequestStats). Backfilled rows would only add old
// history whose latency columns are 0 anyway.
//
// Query plans (verified with EXPLAIN QUERY PLAN against this schema):
//   counters   → SEARCH requestStats USING INDEX idx_rs_ts (timestamp>?)
//   percentile → SEARCH requestStats USING INDEX idx_rs_ts + temp B-tree sort
//   freshness  → SEARCH requestStats USING COVERING INDEX idx_rs_ts
// The sort is over the window slice only, which is why the caller clamps the
// window rather than accepting an arbitrary range.
export async function getTrafficWindow(sinceIso, { percentile = 0.95 } = {}) {
  const db = await getAdapter();

  const counts =
    db.get(
      `SELECT COUNT(*) AS requests,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN latencyTotal > 0 THEN 1 ELSE 0 END) AS latencySamples
       FROM requestStats WHERE ${telemetryFilterSql('requestStats')} AND timestamp >= ?`,
      [sinceIso]
    ) || {};

  // Unbounded on purpose: the freshness indicator has to distinguish "quiet
  // instance" from "no telemetry at all", which the windowed count cannot.
  const freshness = db.get(`SELECT MAX(timestamp) AS lastEventAt FROM requestStats WHERE ${telemetryFilterSql('requestStats')}`) || {};

  // latencyTotal is 0 for rows whose latency was never measured (backfilled
  // history, and any writer that omitted it), so those are excluded from the
  // percentile rather than counted as instant responses.
  const latencySamples = counts.latencySamples || 0;
  let latencyPercentileMs = null;
  if (latencySamples > 0) {
    // Nearest-rank: the ⌈p·n⌉-th smallest measured latency, taken by OFFSET so
    // no row set is ever materialised in JS.
    const offset = Math.max(0, Math.ceil(percentile * latencySamples) - 1);
    const row = db.get(
      `SELECT latencyTotal FROM requestStats
       WHERE ${telemetryFilterSql('requestStats')} AND timestamp >= ? AND latencyTotal > 0
       ORDER BY latencyTotal ASC LIMIT 1 OFFSET ?`,
      [sinceIso, offset]
    );
    latencyPercentileMs = row ? row.latencyTotal : null;
  }

  return {
    requests: counts.requests || 0,
    errors: counts.errors || 0,
    latencySamples,
    latencyPercentileMs,
    lastEventAt: freshness.lastEventAt || null,
  };
}
