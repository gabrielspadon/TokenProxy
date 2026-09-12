import { EventEmitter } from "events";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { telemetryFilterSql } from '../analytics/telemetryFilter.mjs';
import { processTelemetryOrigin } from '../telemetryOrigin.js';
import { isCompletionId } from "../completionIdentity.mjs";
import { captureUsagePricing, persistUsagePricing, priceUsage, usageQuantityPresence } from "./usagePricing.js";
import { prepareBudgetUsage, recordBudgetUsage } from "./budgetRepo.js";
import { usageProjectIdentity } from '../projectIdentity.js';
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
// periodCutoffIso gives the oldest timestamp a period includes,
// or null for "all", which is an unbounded range. It lives in
// src/lib/usagePeriod.js, free of any DB import, because the usage SSE route
// scopes its pushes by the same boundary these aggregates use and must not pull
// the adapter chain in to do it.
import { periodCutoffIso } from "../../usagePeriod.js";
import { canonicalizeUsage } from "../../../../open-sse/utils/usageTracking.js";
import { KEY_ID_DISPLAY_CHARS } from "../../../shared/utils/apiKey.js";

/**
 * A display form that distinguishes one key from another WITHOUT carrying the
 * material that would let a reader rebuild it.
 *
 * The mask before #2206 was the first 8 characters, which for the
 * sk-{machineId}-{keyId}-{crc} format is "sk-" plus five characters of the
 * machineId — identical for every key issued on one install, so it
 * distinguished nothing.
 *
 * #2206 replaced it with the keyId IN FULL, on the reasoning that the crc needs
 * machineId as well and so a keyId alone is not reconstructible. That reasoning
 * does not hold and this is the correction. The machineId is the SAME for every
 * key on an install and is legible in plaintext inside any key the viewer
 * already holds, and the crc is a pure function of machineId and keyId under a
 * checksum secret that defaults to a literal shipped in source. A viewer with
 * one key of their own could therefore rebuild any other key on the install
 * from its displayed keyId alone.
 *
 * So only a PREFIX of the keyId is shown. At the current width that is 6 hex
 * characters revealed against 122 bits withheld, which still separates the keys
 * an install actually has. The trailing marker is what makes it read as
 * truncated rather than complete.
 *
 * A 6-character keyId minted before the widening is shown in full by this same
 * prefix rule, and that is not a mask failure: such a key carries about 31 bits
 * end to end and is guessable whether or not it is ever displayed. Rotation is
 * its remedy, not redaction.
 *
 * An old-format sk-{random8} key has no keyId, so it keeps a prefix mask; there
 * is nothing else in it to show.
 */
function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  const parts = key.startsWith("sk-") ? key.split("-") : [];
  if (parts.length === 4 && parts[2]) {
    return `sk-***-${parts[2].slice(0, KEY_ID_DISPLAY_CHARS)}***`;
  }
  if (key.length <= 8) return key.charAt(0) + "***";
  return key.slice(0, 8) + "***";
}

const PENDING_TIMEOUT_MS = 60 * 1000;
const RECENT_LIMIT = 50;
const USAGE_READ_BATCH = 512;

// Active (concurrent) sessions: in-flight + just-finished requests keyed by requestId.
// Token counts are back-filled from saveRequestUsage on completion; rows linger briefly
// so the dashboard can show the final in/out tallies before evicting.
const ACTIVE_SESSION_TTL_MS = 120 * 1000;        // safety evict if completion never recorded
const ACTIVE_SESSION_DONE_LINGER_MS = 20 * 1000; // keep finished rows visible so user sees tokens
const ACTIVE_SESSION_CAP = 200;
const CONN_CACHE_TTL_MS = 30 * 1000;
const ALL_TIME_CHART_MAX_POINTS = 120;
const USAGE_API_KEY_IDENTITY_SALT = "usageApiKeyIdentitySalt.v1";

if (!global._usageApiKeyIdentityFallbackSalt) {
  global._usageApiKeyIdentityFallbackSalt = randomBytes(32).toString("hex");
}

function getUsageApiKeyIdentitySalt(db) {
  const fallback = global._usageApiKeyIdentityFallbackSalt;
  try {
    let salt = null;
    db.transaction(() => {
      const existing = db.get("SELECT value FROM _meta WHERE key = ?", [USAGE_API_KEY_IDENTITY_SALT]);
      if (existing?.value) {
        salt = existing.value;
        return;
      }
      db.run(
        "INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING",
        [USAGE_API_KEY_IDENTITY_SALT, randomBytes(32).toString("hex")],
      );
      salt = db.get("SELECT value FROM _meta WHERE key = ?", [USAGE_API_KEY_IDENTITY_SALT])?.value || fallback;
    });
    return salt || fallback;
  } catch {
    return fallback;
  }
}

function getApiKeyAggregate(apiKey, model, provider, apiKeyMap, salt, legacyUnavailable = false) {
  const rawModel = model || "";
  const rawProvider = provider || "unknown";
  if (legacyUnavailable && apiKey == null) {
    return {
      aggregateKey: `legacy-unavailable|${rawModel}|${rawProvider}`,
      apiKeyKey: "legacy-unavailable",
      apiKeyMasked: null,
      keyName: "Legacy key unavailable",
    };
  }
  if (!apiKey || typeof apiKey !== "string") {
    return {
      aggregateKey: `local-no-key|${rawModel}|${rawProvider}`,
      apiKeyKey: "local-no-key",
      apiKeyMasked: null,
      keyName: "Local (No API Key)",
    };
  }

  const keyInfo = apiKeyMap[apiKey];
  const apiKeyKey = keyInfo?.id
    ? `id:${keyInfo.id}`
    : `hmac:${createHmac("sha256", salt).update(apiKey).digest("hex").slice(0, 32)}`;
  const apiKeyMasked = maskApiKey(apiKey);
  return {
    aggregateKey: `${apiKeyKey}|${rawModel}|${rawProvider}`,
    apiKeyKey,
    apiKeyMasked,
    keyName: keyInfo?.name || `${apiKeyMasked} (${apiKeyKey.slice(-8)})`,
  };
}

function dateKeyToUtcTime(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function dateKeyToLocalDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };
if (!global._activeSessions) global._activeSessions = new Map();
if (!global._activeSessionTimers) global._activeSessionTimers = {};

const pendingRequests = global._pendingRequests;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const connCache = global._connectionMapCache;
const statsEmitTimers = global._statsEmitTimers;
const activeSessions = global._activeSessions;
const activeSessionTimers = global._activeSessionTimers;

export const statsEmitter = global._statsEmitter;

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  // A bucket written before cache writes were aggregated has no key yet.
  target[key].cacheCreationTokens = (target[key].cacheCreationTokens || 0) + (values.cacheCreationTokens || 0);
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  // Both cache quantities were normalized once by canonicalizeUsage before the
  // entry reached saveRequestUsage, so read the canonical names only. Reading a
  // raw provider alias here would be a second normalization point.
  const cachedTokens = entry.tokens?.cached_tokens || 0;
  const cacheCreationTokens = entry.tokens?.cache_creation_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cacheCreationTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cacheCreationTokens = (day.cacheCreationTokens || 0) + cacheCreationTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};
  // Additive dimension: the same model asked for at two efforts is two lines of
  // spend, and byModel cannot show that without changing its key and every
  // consumer of it (#2483).
  day.byReasoning ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });

  if (entry.reasoningEffort) {
    const reasoningKey = `${entry.reasoningEffort}|${entry.model}|${entry.provider || "unknown"}`;
    addToCounter(day.byReasoning, reasoningKey, {
      ...vals,
      meta: { reasoningEffort: entry.reasoningEffort, rawModel: entry.model, provider: entry.provider },
    });
  }

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

// A receipt may be applied or reverted by another process. Read the durable
// population on every display request; no process-local receipt cache is safe.
async function recentVisibleUsage() {
  const db = await getAdapter();
  return db.all(`SELECT timestamp, provider, model, apiKey, status, tokens, meta FROM usageHistory
    WHERE ${telemetryFilterSql('usageHistory')} ORDER BY id DESC LIMIT ?`, [RECENT_LIMIT]);
}

// Bounded retained-history reads avoid materializing a million-row JS array.
// Each page uses the immutable integer primary key, never an OFFSET scan.
function* visibleUsageRows(db, columns, predicates = [], params = []) {
  const where = [telemetryFilterSql('usageHistory'), ...predicates].join(' AND ');
  let afterId = 0;
  while (true) {
    const rows = db.all(`SELECT id, ${columns} FROM usageHistory WHERE id > ? AND ${where} ORDER BY id LIMIT ?`,
      [afterId, ...params, USAGE_READ_BATCH]);
    for (const row of rows) yield row;
    if (rows.length < USAGE_READ_BATCH) return;
    afterId = rows.at(-1).id;
  }
}

// Lifetime totals materialize public dimension groups, not every source row
// or serialized token payload. SQLite performs the scan and token aggregation.
function visibleUsageGroups(db, predicates, params) {
  const tokenJson = "CASE WHEN json_valid(tokens) THEN tokens ELSE '{}' END";
  const metaJson = "CASE WHEN json_valid(meta) THEN meta ELSE '{}' END";
  return db.all(`WITH visible AS (
    SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost,
      COALESCE(NULLIF(promptTokens,0),json_extract(${tokenJson},'$.prompt_tokens'),json_extract(${tokenJson},'$.input_tokens'),0) AS promptTokens,
      COALESCE(NULLIF(completionTokens,0),json_extract(${tokenJson},'$.completion_tokens'),json_extract(${tokenJson},'$.output_tokens'),0) AS completionTokens,
      COALESCE(json_extract(${tokenJson},'$.cached_tokens'),0) AS cachedTokens,
      COALESCE(json_extract(${tokenJson},'$.cache_creation_input_tokens'),0) AS cacheCreationTokens,
      CASE WHEN json_extract(${metaJson},'$.legacyImport.contract')='nine-router-history-v1'
        AND json_extract(${metaJson},'$.legacyImport.apiKeyIdentity')='unavailable' THEN 1 ELSE 0 END AS legacyKeyUnavailable
    FROM usageHistory WHERE ${[telemetryFilterSql('usageHistory'), ...predicates].join(' AND ')}
  ) SELECT provider,model,connectionId,apiKey,endpoint,legacyKeyUnavailable,MAX(timestamp) AS timestamp,
    COUNT(*) AS requests,SUM(promptTokens) AS promptTokens,SUM(completionTokens) AS completionTokens,
    SUM(cachedTokens) AS cachedTokens,SUM(cacheCreationTokens) AS cacheCreationTokens,SUM(cost) AS cost
    FROM visible GROUP BY provider,model,connectionId,apiKey,endpoint,legacyKeyUnavailable`, params);
}

export function trackPendingRequest(model, provider, connectionId, started, error = false) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (started) {
    pendingRequests.byModel[modelKey] = (pendingRequests.byModel[modelKey] || 0) + 1;
    if (connectionId) {
      pendingRequests.byAccount[connectionId] ||= {};
      pendingRequests.byAccount[connectionId][modelKey] = (pendingRequests.byAccount[connectionId][modelKey] || 0) + 1;
    }

    const requests = pendingTimers[timerKey] ||= new Set();
    const pending = {
      timer: null,
      finish() {
        if (!requests.delete(pending)) return;
        clearTimeout(pending.timer);
        if (requests.size === 0) delete pendingTimers[timerKey];
        pendingRequests.byModel[modelKey] = Math.max(0, (pendingRequests.byModel[modelKey] || 0) - 1);
        if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];
        if (connectionId && pendingRequests.byAccount[connectionId]) {
          const account = pendingRequests.byAccount[connectionId];
          account[modelKey] = Math.max(0, (account[modelKey] || 0) - 1);
          if (account[modelKey] === 0) delete account[modelKey];
          if (Object.keys(account).length === 0) delete pendingRequests.byAccount[connectionId];
        }
        scheduleStatsEvent("pending");
      }
    };
    requests.add(pending);
    pending.timer = setTimeout(pending.finish, PENDING_TIMEOUT_MS);
    pending.timer?.unref?.();
  } else {
    // The legacy API has no request id; match stops FIFO within the exact
    // account/model bucket without cancelling another request's expiry.
    pendingTimers[timerKey]?.values().next().value?.finish();
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
    stampActiveSession({ provider, model, connectionId, status: "error" });
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

/**
 * Recent-request row: the resolved model and the client-sent form carried
 * separately (plus provider), so the UI renders either the bare model name or
 * the prefixed provider/model form without server-side string joining. Rows
 * come from the in-memory ring (parsed tokens/meta) or usageHistory rows
 * (JSON strings) — handle both.
 */
export function buildRecentRequestRow(e) {
  const t = typeof e.tokens === "string" ? parseJson(e.tokens, {}) : (e.tokens || {});
  const requestedModel = e.requestedModel || (e.meta ? (parseJson(e.meta, {}).requestedModel || null) : null);
  const reasoningEffort = e.reasoningEffort || (e.meta ? (parseJson(e.meta, {}).reasoningEffort || null) : null);
  return {
    timestamp: e.timestamp,
    model: e.model || "",
    requestedModel: requestedModel || null,
    reasoningEffort: reasoningEffort || null,
    provider: e.provider || "",
    promptTokens: t.prompt_tokens || t.input_tokens || 0,
    completionTokens: t.completion_tokens || t.output_tokens || 0,
    status: e.status || "ok",
    // Which key served the request. MASKED here rather than at the view, so a
    // raw key cannot reach a client through this row whatever renders it: the
    // API response is the trust boundary, not the component.
    apiKey: maskApiKey(e.apiKey),
  };
}

// ---- Active (concurrent) sessions ----
// One row per in-flight request. Completion tokens are back-filled from
// saveRequestUsage; errors are stamped from trackPendingRequest(error=true).
// Everything here is fail-open: a throw must never escape, since these run
// inline on the request hot path.

function evictActiveSession(requestId) {
  activeSessions.delete(requestId);
  const timer = activeSessionTimers[requestId];
  if (timer) {
    clearTimeout(timer);
    delete activeSessionTimers[requestId];
  }
}

function scheduleActiveSessionEviction(requestId, delayMs) {
  clearTimeout(activeSessionTimers[requestId]);
  const timer = setTimeout(() => {
    delete activeSessionTimers[requestId];
    activeSessions.delete(requestId);
    scheduleStatsEvent("pending");
  }, delayMs);
  if (timer.unref) timer.unref();
  activeSessionTimers[requestId] = timer;
}

export function trackActiveSession({ clientId, sessionId, model, provider, connectionId } = {}) {
  try {
    const requestId = randomUUID();
    if (activeSessions.size >= ACTIVE_SESSION_CAP) {
      const oldest = activeSessions.keys().next().value;
      if (oldest) evictActiveSession(oldest);
    }
    activeSessions.set(requestId, {
      requestId,
      dataOrigin: processTelemetryOrigin(),
      usageRowId: null,
      clientId: clientId || "unknown",
      sessionId: sessionId || "",
      model: model || "unknown",
      provider: (provider || "unknown").toLowerCase(),
      connectionId: connectionId || null,
      startedAt: Date.now(),
      completedAt: null,
      durationMs: 0,
      promptTokens: null,
      completionTokens: null,
      status: "active",
    });
    scheduleActiveSessionEviction(requestId, ACTIVE_SESSION_TTL_MS);
    scheduleStatsEvent("pending");
    return requestId;
  } catch {
    return null;
  }
}

// FIFO-match the oldest still-tokenless row for this key and stamp it.
// Used by saveRequestUsage (success) and trackPendingRequest(error) alike.
function stampActiveSession({ provider, model, connectionId, promptTokens, completionTokens, status, usageRowId = null }) {
  try {
    const prov = (provider || "").toLowerCase();
    let target = null;
    for (const entry of activeSessions.values()) {
      if (entry.promptTokens !== null && status !== "error") continue; // already stamped
      if (status === "error" && entry.status === "error") continue;
      if (entry.provider !== prov) continue;
      if (model && entry.model !== model) continue;
      if (connectionId && entry.connectionId && entry.connectionId !== connectionId) continue;
      target = entry;
      break; // Map iterates insertion order, so this is the oldest match
    }
    if (!target) return;
    target.promptTokens = promptTokens ?? target.promptTokens;
    target.completionTokens = completionTokens ?? target.completionTokens;
    target.completedAt = Date.now();
    target.durationMs = target.completedAt - target.startedAt;
    target.status = status || "done";
    if (usageRowId !== null) target.usageRowId = usageRowId;
    scheduleActiveSessionEviction(target.requestId, ACTIVE_SESSION_DONE_LINGER_MS);
    scheduleStatsEvent("pending");
  } catch {
    // fail-open
  }
}

export async function getActiveSessions() {
  const connectionMap = await getConnectionMapCached();
  const db = await getAdapter();
  const usageIds = [...activeSessions.values()].map(entry => entry.usageRowId).filter(id => id != null);
  const visibleIds = new Set(usageIds.length ? db.all(`SELECT id FROM usageHistory
    WHERE ${telemetryFilterSql('usageHistory')} AND id IN (${usageIds.map(() => '?').join(',')})`, usageIds).map(row => String(row.id)) : []);
  const now = Date.now();
  const rows = [];
  for (const entry of activeSessions.values()) {
    if (entry.dataOrigin === 'test' || (entry.usageRowId != null && !visibleIds.has(String(entry.usageRowId)))) continue;
    rows.push({
      requestId: entry.requestId,
      clientId: entry.clientId,
      sessionId: entry.sessionId,
      model: entry.model,
      provider: entry.provider,
      connectionId: entry.connectionId ?? null,
      account: entry.connectionId
        ? (connectionMap[entry.connectionId] || `Account ${String(entry.connectionId).slice(0, 8)}...`)
        : null,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      durationMs: entry.completedAt ? entry.durationMs : (now - entry.startedAt),
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      status: entry.status,
    });
  }
  rows.sort((a, b) => b.startedAt - a.startedAt);
  return rows;
}

export async function getActiveRequests() {
  const activeRequests = [];
  const connectionMap = await getConnectionMapCached();

  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  const recentRows = await recentVisibleUsage();
  const seen = new Set();
  const recentRequests = recentRows
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map(buildRecentRequestRow)
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";
  const sessions = await getActiveSessions();
  return { activeRequests, recentRequests, errorProvider, activeSessions: sessions };
}

export async function saveRequestUsage(entry) {
  try {
    const db = await getAdapter();

    entry = { ...entry, timestamp: entry.timestamp || new Date().toISOString() };

    // Cache read and cache write aliases normalize HERE, at the one boundary
    // every persistence path crosses — the chat handler, embeddings and rerank
    // alike — so the request row, the daily aggregate, the per-account bucket
    // and the cost below all read the same two canonical fields. canonicalizeUsage
    // is idempotent, so a caller that already normalized is not normalized twice.
    const presence = entry.usagePresence || usageQuantityPresence(entry.tokens);
    if (entry.tokens && typeof entry.tokens === "object") {
      entry.tokens = canonicalizeUsage(entry.tokens) || entry.tokens;
      entry.tokens.input_tokens_present = presence.input;
      entry.tokens.output_tokens_present = presence.output;
      entry.tokens.cache_read_tokens_present = presence.cacheRead;
      entry.tokens.cache_write_tokens_present = presence.cacheWrite;
    }
    const context = entry.contextTelemetry;
    const requestId = context?.requestId || entry.requestId || null;
    const snapshot = context?.pricingSnapshot || await captureUsagePricing(entry.provider, entry.model);
    Object.assign(entry, priceUsage(entry.tokens, snapshot, presence.input && presence.output));
    if (!entry.costEvidence && entry.estimatedCostUsd !== null) {
      entry.costEvidence = { source: "application-rate-card", currency: "USD",
        captureBoundary: context?.pricingSnapshot ? "before-dispatch" : "usage-recording" };
    }
    const logicalRequestId = context?.logicalRequestId || entry.logicalRequestId || null;
    const attempt = context?.attempt ?? entry.attempt ?? null;
    const usageSource = presence.input || presence.output ? (entry.tokens?.estimated === true ? "estimated" : "provider") : "missing";

    const tokens = entry.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

    let inserted = false;
    let usageRowId = null;

    // All 3 writes (history insert, daily upsert, lifetime counter) in ONE transaction.
    // better-sqlite3 is sync → no JS yield mid-transaction → no race in same process.
    db.transaction(() => {
      // Only an exact recorded attempt may complete an existing row. Similar
      // timestamps, models and counts are never evidence of request identity.
      const existing = requestId ? db.get(`SELECT id FROM usageHistory WHERE requestId=?`, [requestId]) : null;
      if (existing) {
        if (entry.endpoint) db.run(`UPDATE usageHistory SET endpoint=COALESCE(NULLIF(endpoint,''),?) WHERE id=?`, [entry.endpoint, existing.id]);
        return;
      }
      const rateSnapshotId = persistUsagePricing(db, snapshot);
      const budgetKeyId = prepareBudgetUsage(db, entry.apiKey, requestId, context?.apiKeyId);
      const principal = budgetKeyId ?? context?.apiKeyId ?? (entry.apiKey ? db.get('SELECT id FROM apiKeys WHERE key=?', [entry.apiKey])?.id : null);
      const identity = usageProjectIdentity(db, { requestId, context, apiKeyId: principal, logicalRequestId, attempt,
        provider: entry.provider, model: entry.model, connectionId: entry.connectionId });
      const session = requestId && context?.identitySource === "explicit" ? db.get(`SELECT r.contextSessionId FROM requestStats r
        JOIN contextSessions s ON s.id=r.contextSessionId WHERE r.id=? AND s.identitySource='explicit' AND s.sessionHash=?`, [requestId, context.sessionHash]) : null;
      const insertedUsage = db.run(
        `INSERT INTO usageHistory(timestamp,provider,model,connectionId,apiKey,endpoint,promptTokens,completionTokens,cost,status,tokens,meta,
          requestId,logicalRequestId,attempt,contextSessionId,projectId,rateSnapshotId,pricingCapturedAt,costSource,costEvidence,usageSource,estimatedCostUsd,reportedCostUsd,dispatchCoverage,completionId,dataOrigin)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [entry.timestamp, entry.provider || null, entry.model || null, entry.connectionId || null, entry.apiKey || null, entry.endpoint || null,
          promptTokens, completionTokens, entry.cost, entry.status || "ok", stringifyJson(tokens),
          stringifyJson({ requestedModel: entry.requestedModel || null, reasoningEffort: entry.reasoningEffort || null,
            ...(entry.receiptEvidence ? { reconciliation: entry.receiptEvidence } : {}) }),
          requestId, logicalRequestId, attempt, session?.contextSessionId ?? null, identity.projectId, rateSnapshotId, snapshot.capturedAt,
          entry.costSource, entry.costEvidence ? stringifyJson(entry.costEvidence) : null, usageSource, entry.estimatedCostUsd, entry.reportedCostUsd, ["physical-dispatch", "executor-invocation"].includes(context?.dispatchCoverage) ? context.dispatchCoverage : null,
          isCompletionId(entry.completionId) ? entry.completionId : null, processTelemetryOrigin()]
      );
      // The scalar identity snapshot has its own lifetime, independent of the
      // optional request/structure retention policy. No historical backfill.
      const identityColumns = Object.entries(identity).filter(([field]) => field !== 'projectId');
      if (identityColumns.length) db.run(`UPDATE usageHistory SET ${identityColumns.map(([field]) => `${field}=?`).join(',')} WHERE id=?`,
        [...identityColumns.map(([, value]) => value), insertedUsage.lastInsertRowid]);

      recordBudgetUsage(db, { apiKeyId: budgetKeyId, requestId, usageRowId: insertedUsage.lastInsertRowid,
        promptTokens: presence.input && usageSource !== "estimated" ? promptTokens : null,
        completionTokens: presence.output && usageSource !== "estimated" ? completionTokens : null,
        costUsd: usageSource !== "estimated" ? entry.cost : null,
        recorded: { promptTokens, completionTokens, costUsd: entry.cost },
        receiptEvidence: entry.receiptEvidence,
        final: entry.usageFinality !== "partial" && context?.usageFinality !== "partial" });

      const dateKey = getLocalDateKey(entry.timestamp);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      const day = row ? parseJson(row.data, {}) : {
        requests: 0, promptTokens: 0, completionTokens: 0, cost: 0,
        byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
      };
      aggregateEntryToDay(day, entry);
      db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`, [dateKey, stringifyJson(day)]);

      // Atomic counter increment in same transaction
      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);
      usageRowId = insertedUsage.lastInsertRowid;
      inserted = true;
    });

    if (inserted) {
      stampActiveSession({
        provider: entry.provider, model: entry.model, connectionId: entry.connectionId,
        promptTokens, completionTokens, status: "done", usageRowId,
      });
      scheduleStatsEvent("update", 250);
    }
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

// A later, explicit provider-usage receipt may complete uncertain exposure.
// Ordinary duplicate finalizers never enter this path. Keep the exact row and
// rate version, adjust its daily/lifetime quantities once, and retain evidence.
export async function reconcileBudgetUsage(apiKeyId, requestId, evidence) {
  if (evidence?.kind !== "provider-usage" || typeof evidence.reference !== "string"
    || !evidence.reference.trim() || evidence.reference.length > 500 || !evidence.tokens
    || typeof evidence.tokens !== "object" || Array.isArray(evidence.tokens)) throw new TypeError("A provider-usage receipt and token or USD quantities are required");
  const allowed = new Set(["prompt_tokens", "input_tokens", "completion_tokens", "output_tokens", "cached_tokens", "cache_creation_input_tokens", "reasoning_tokens", "cost_usd", "cost_in_usd"]);
  for (const [key, value] of Object.entries(evidence.tokens)) {
    if (!allowed.has(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0
      || (!key.includes("cost") && !Number.isSafeInteger(value))) throw new TypeError("Receipt quantities must be finite nonnegative counts or explicit USD amounts");
  }
  // A receipt naming one quantity under two spellings with different values is
  // ambiguous. It is refused before any write instead of silently choosing one.
  for (const [a, b] of [["prompt_tokens", "input_tokens"], ["completion_tokens", "output_tokens"], ["cost_usd", "cost_in_usd"]]) {
    if (a in evidence.tokens && b in evidence.tokens && evidence.tokens[a] !== evidence.tokens[b])
      throw new TypeError(`Receipt supplies conflicting values for ${a} and ${b}`);
  }
  const db = await getAdapter();
  const reservation = db.get("SELECT * FROM apiKeyBudgetReservations WHERE apiKeyId=? AND requestId=?", [apiKeyId, requestId]);
  if (!reservation) return null;
  const snapshotRow = reservation.rateSnapshotId ? db.get("SELECT * FROM usageRateSnapshots WHERE id=?", [reservation.rateSnapshotId]) : null;
  const snapshot = snapshotRow ? { ...snapshotRow, rates: parseJson(snapshotRow.rates, null) } : { rates: null };
  const presence = usageQuantityPresence(evidence.tokens);
  const tokens = canonicalizeUsage(evidence.tokens) || {};
  tokens.input_tokens_present = presence.input; tokens.output_tokens_present = presence.output;
  tokens.cache_read_tokens_present = presence.cacheRead; tokens.cache_write_tokens_present = presence.cacheWrite;
  const costs = priceUsage(evidence.tokens, snapshot, presence.input && presence.output);
  if (!presence.input && !presence.output && costs.reportedCostUsd === null) throw new TypeError("Receipt contains no measured quantity");
  const descriptor = { source: "operator-supplied-provider-usage", reference: evidence.reference.trim(), currency: costs.reportedCostUsd !== null ? "USD" : null };
  let result;
  const existing = db.get("SELECT * FROM usageHistory WHERE requestId=?", [requestId]);
  if (!existing) {
    const attempt = db.get("SELECT * FROM requestStats WHERE id=?", [requestId]);
    if (!attempt) throw new TypeError("The original attempt is unavailable; receipt cannot be attributed safely");
    const key = db.get("SELECT key FROM apiKeys WHERE id=?", [apiKeyId]);
    await saveRequestUsage({ provider: attempt.provider, model: attempt.model, connectionId: attempt.connectionId,
      apiKey: key?.key, receiptEvidence: descriptor, contextTelemetry: { requestId, logicalRequestId: reservation.logicalRequestId,
        pricingSnapshot: snapshotRow ? snapshot : { rates: null, capturedAt: reservation.createdAt },
        attempt: attempt.attempt, dispatchCoverage: reservation.dispatchCoverage }, tokens: evidence.tokens });
    result = db.get("SELECT * FROM apiKeyBudgetReservations WHERE requestId=?", [requestId]);
    if (result?.usageRowId == null) throw new Error("Receipt usage did not persist");
    return db.get("SELECT * FROM apiKeyBudgetReservations WHERE requestId=?", [requestId]);
  }
  db.transaction(() => {
    const current = db.get("SELECT * FROM apiKeyBudgetReservations WHERE requestId=?", [requestId]);
    const row = db.get("SELECT * FROM usageHistory WHERE requestId=?", [requestId]);
    if (current.state === "settled") {
      if (current.actualPromptTokens !== (presence.input ? tokens.prompt_tokens : null)
        || current.actualCompletionTokens !== (presence.output ? tokens.completion_tokens : null)
        || current.actualCostUsd !== costs.cost) throw new TypeError("This attempt already has different settled quantities");
      result = current; return;
    }
    const oldEntry = { ...row, tokens: parseJson(row.tokens, {}), ...parseJson(row.meta, {}) };
    const newEntry = { ...oldEntry, tokens, ...costs };
    db.run(`UPDATE usageHistory SET promptTokens=?,completionTokens=?,cost=?,tokens=?,meta=?,status='ok',
      costSource=?,costEvidence=?,usageSource='provider',estimatedCostUsd=?,reportedCostUsd=? WHERE id=?`,
    [tokens.prompt_tokens ?? 0, tokens.completion_tokens ?? 0, costs.cost, stringifyJson(tokens),
      stringifyJson({ ...parseJson(row.meta, {}), reconciliation: descriptor, previousResolution: parseJson(current.resolutionEvidence, null) }),
      costs.costSource, stringifyJson(costs.costEvidence), costs.estimatedCostUsd, costs.reportedCostUsd, row.id]);
    const dayKey = getLocalDateKey(row.timestamp);
    const daily = db.get("SELECT data FROM usageDaily WHERE dateKey=?", [dayKey]);
    if (daily) {
      const day = parseJson(daily.data, {}), oldDelta = {}, nextDelta = {};
      aggregateEntryToDay(oldDelta, oldEntry); aggregateEntryToDay(nextDelta, newEntry);
      const fields = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cacheCreationTokens", "cost"];
      const apply = (target, old, next) => { for (const field of fields) target[field] = (target[field] || 0) + (next?.[field] || 0) - (old?.[field] || 0); };
      apply(day, oldDelta, nextDelta);
      for (const scope of ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint", "byReasoning"]) {
        for (const key of new Set([...Object.keys(oldDelta[scope] || {}), ...Object.keys(nextDelta[scope] || {})])) {
          day[scope] ||= {}; day[scope][key] ||= {};
          apply(day[scope][key], oldDelta[scope]?.[key], nextDelta[scope]?.[key]);
        }
      }
      db.run("UPDATE usageDaily SET data=? WHERE dateKey=?", [stringifyJson(day), dayKey]);
    }
    recordBudgetUsage(db, { apiKeyId, requestId, usageRowId: row.id,
      promptTokens: presence.input ? tokens.prompt_tokens : null, completionTokens: presence.output ? tokens.completion_tokens : null,
      costUsd: costs.cost, final: true, previous: { ...row, ...current } });
    db.run("UPDATE apiKeyBudgetReservations SET resolutionEvidence=? WHERE requestId=?", [JSON.stringify(descriptor), requestId]);
    result = db.get("SELECT * FROM apiKeyBudgetReservations WHERE requestId=?", [requestId]);
  });
  scheduleStatsEvent("update");
  return result;
}

export async function getDailyConnectionUsage(connectionId, now = new Date()) {
  // Quota accounting retains every acknowledged dispatch, including telemetry
  // excluded from dashboards. Quarantine never grants additional allowance.
  if (!connectionId) {
    return { requests: 0, tokens: 0, resetAt: null };
  }

  const current = now instanceof Date ? now : new Date(now);
  const startOfDay = new Date(current);
  startOfDay.setHours(0, 0, 0, 0);
  const nextDay = new Date(startOfDay);
  nextDay.setDate(nextDay.getDate() + 1);

  const db = await getAdapter();
  const row = db.get(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens
       FROM usageHistory
      WHERE timestamp >= ? AND timestamp < ? AND connectionId = ?`,
    [startOfDay.toISOString(), nextDay.toISOString(), String(connectionId)],
  );

  return {
    requests: Number(row?.requests) || 0,
    tokens: Number(row?.tokens) || 0,
    resetAt: nextDay.toISOString(),
  };
}

export async function getUsageHistory(filter = {}) {
  const db = await getAdapter();
  const conds = [telemetryFilterSql('usageHistory')];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ${where} ORDER BY id ASC`, params);

  return rows.map((r) => ({
    timestamp: r.timestamp, provider: r.provider, model: r.model,
    connectionId: r.connectionId, apiKeyMasked: maskApiKey(r.apiKey), endpoint: r.endpoint,
    cost: r.cost, status: r.status, tokens: parseJson(r.tokens, {}),
  }));
}

// A bare YYYY-MM-DD names a calendar day where the reader is, so it is parsed
// as a LOCAL day. `new Date("2026-08-30")` is UTC midnight, which is the 29th
// anywhere west of Greenwich — and usageDaily is keyed by local date, so that
// reading would return the wrong day's numbers. A full timestamp is left alone.
function parseLocalDay(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// An explicit day range, so "yesterday" and "the day before" are selectable
// rather than only the fixed trailing windows (#3442). Both ends are inclusive
// LOCAL days, because that is what usageDaily is keyed by and what the person
// reading the page means by a date. Anything unparseable, or a range that runs
// backwards, is no range at all and the caller falls back to its period.
export function resolveDayRange(range) {
  if (!range?.startDate) return null;
  const start = parseLocalDay(range.startDate);
  if (!start) return null;
  const end = (range.endDate && parseLocalDay(range.endDate)) || start;
  if (end.getTime() < start.getTime()) return null;

  const startOfDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
  return {
    startKey: getLocalDateKey(startOfDay),
    endKey: getLocalDateKey(endOfDay),
    startIso: startOfDay.toISOString(),
    endIso: endOfDay.toISOString(),
  };
}

// The inclusive list of local date keys the range covers.
function eachDateKey(startKey, endKey) {
  const keys = [];
  const end = dateKeyToLocalDate(endKey).getTime();
  for (let d = dateKeyToLocalDate(startKey); d.getTime() <= end; d.setDate(d.getDate() + 1)) {
    keys.push(getLocalDateKey(d));
  }
  return keys;
}

function visibleDays(adapter, startIso = null, endIso = null) {
  const predicates = [telemetryFilterSql('usageHistory')], params = [];
  if (startIso) { predicates.push('timestamp >= ?'); params.push(startIso); }
  if (endIso) { predicates.push('timestamp <= ?'); params.push(endIso); }
  return adapter.all(`SELECT date(timestamp, 'localtime') AS dateKey,
    SUM(promptTokens) AS promptTokens, SUM(completionTokens) AS completionTokens, SUM(cost) AS cost
    FROM usageHistory WHERE ${predicates.join(' AND ')} GROUP BY dateKey ORDER BY dateKey`, params)
    .map(row => ({ dateKey: row.dateKey, data: stringifyJson(row) }));
}

function loadDaysBetween(adapter, startKey, endKey) {
  const win = resolveDayRange({ startDate: startKey, endDate: endKey });
  return visibleDays(adapter, win.startIso, win.endIso);
}

function loadDaysInRange(adapter, maxDays) {
  return visibleDays(adapter, maxDays == null ? null : periodCutoffIso(`${maxDays}d`));
}

// The whole-period form, `all` meaning no lower bound at all. It is
// getUsageStatsInRange with no range, and every existing caller uses it.
export async function getUsageStats(period = "all") {
  return getUsageStatsInRange(period, null);
}

export async function getUsageStatsInRange(period = "all", range = null) {
  const db = await getAdapter();
  // An explicit range wins over the period. Every panel uses retained rows
  // and the current receipt state, including windows previously using rollups.
  const win = resolveDayRange(range);

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  let allConnections = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap = {};
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap = {};
  for (const k of allApiKeys) apiKeyMap[k.key] = { name: k.name, id: k.id, createdAt: k.createdAt };
  const apiKeyIdentitySalt = getUsageApiKeyIdentitySalt(db);

  // recentRequests from live history (last 100 entries enough for 20 deduped).
  // Scoped to the same period as the totals below: unscoped, this panel listed
  // rows from outside the selection beside a "Total Requests 0" that had
  // correctly excluded them.
  const recentCutoff = win ? win.startIso : periodCutoffIso(period);
  const recentWhere = win
    ? "WHERE timestamp >= ? AND timestamp <= ?"
    : recentCutoff ? "WHERE timestamp >= ?" : "WHERE 1=1";
  const recentParams = win ? [win.startIso, win.endIso] : recentCutoff ? [recentCutoff] : [];
  const recentRows = db.all(
    `SELECT timestamp, provider, model, tokens, status, meta FROM usageHistory
     ${recentWhere} AND ${telemetryFilterSql('usageHistory')} ORDER BY id DESC LIMIT 100`,
    recentParams
  );
  const seen = new Set();
  const recentRequests = recentRows
    .map((r) => ({
      ...buildRecentRequestRow(r),
      cachedTokens: (parseJson(r.tokens, {}) || {}).cached_tokens || 0,
    }))
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0,
    // Cache WRITE is billed at its own rate and is not recoverable from the read
    // total, so it is exported as its own line rather than folded into it.
    totalCacheCreationTokens: 0, totalCost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
    activeSessions: [],
    recentRequests,
    errorProvider: (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "",
  };

  // Active requests
  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        stats.activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  stats.activeSessions = await getActiveSessions();

  // last10Minutes — query 10min window
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    stats.last10Minutes.push(bucketMap[ts]);
  }
  const recent10 = visibleUsageRows(db, 'timestamp, promptTokens, completionTokens, cost',
    ['timestamp >= ?', 'timestamp <= ?'], [tenMinutesAgo.toISOString(), now.toISOString()]);
  for (const r of recent10) {
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      bucketMap[minuteStart].cost += r.cost || 0;
    }
  }

  const predicates = [], params = [];
  const cutoff = win ? win.startIso : periodCutoffIso(period);
  if (cutoff) { predicates.push('timestamp >= ?'); params.push(cutoff); }
  if (win) { predicates.push('timestamp <= ?'); params.push(win.endIso); }
  const filtered = visibleUsageGroups(db, predicates, params);

  for (const r of filtered) {
    const requests = r.requests;
    const promptTokens = r.promptTokens || 0;
    const completionTokens = r.completionTokens || 0;
    const cachedTokens = r.cachedTokens || 0;
    const cacheCreationTokens = r.cacheCreationTokens || 0;
    const entryCost = r.cost || 0;
    const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;

    stats.totalPromptTokens += promptTokens;
    stats.totalCompletionTokens += completionTokens;
    stats.totalCachedTokens += cachedTokens;
    stats.totalCacheCreationTokens += cacheCreationTokens;
    stats.totalCost += entryCost;

    if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, cost: 0 };
    stats.byProvider[r.provider].requests += requests;
    stats.byProvider[r.provider].promptTokens += promptTokens;
    stats.byProvider[r.provider].completionTokens += completionTokens;
    stats.byProvider[r.provider].cachedTokens += cachedTokens;
    stats.byProvider[r.provider].cacheCreationTokens = (stats.byProvider[r.provider].cacheCreationTokens || 0) + cacheCreationTokens;
    stats.byProvider[r.provider].cost += entryCost;

    const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
    if (!stats.byModel[modelKey]) {
      stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
    }
    stats.byModel[modelKey].requests += requests;
    stats.byModel[modelKey].promptTokens += promptTokens;
    stats.byModel[modelKey].completionTokens += completionTokens;
    stats.byModel[modelKey].cachedTokens += cachedTokens;
    stats.byModel[modelKey].cacheCreationTokens = (stats.byModel[modelKey].cacheCreationTokens || 0) + cacheCreationTokens;
    stats.byModel[modelKey].cost += entryCost;
    if (new Date(r.timestamp) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.timestamp;

    if (r.connectionId) {
      const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
      const accountKey = `${r.model} (${r.provider} - ${accountName})`;
      if (!stats.byAccount[accountKey]) {
        stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.timestamp };
      }
      stats.byAccount[accountKey].requests += requests;
      stats.byAccount[accountKey].promptTokens += promptTokens;
      stats.byAccount[accountKey].completionTokens += completionTokens;
      stats.byAccount[accountKey].cachedTokens += cachedTokens;
      stats.byAccount[accountKey].cacheCreationTokens = (stats.byAccount[accountKey].cacheCreationTokens || 0) + cacheCreationTokens;
      stats.byAccount[accountKey].cost += entryCost;
      if (new Date(r.timestamp) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.timestamp;
    }

    const identity = getApiKeyAggregate(r.apiKey, r.model, r.provider, apiKeyMap, apiKeyIdentitySalt, r.legacyKeyUnavailable === 1);
    if (!stats.byApiKey[identity.aggregateKey]) {
      stats.byApiKey[identity.aggregateKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked: identity.apiKeyMasked, keyName: identity.keyName, apiKeyKey: identity.apiKeyKey, lastUsed: r.timestamp };
    }
    const ake = stats.byApiKey[identity.aggregateKey];
    ake.requests += requests; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cacheCreationTokens = (ake.cacheCreationTokens || 0) + cacheCreationTokens; ake.cost += entryCost;
    if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;

    const endpoint = r.endpoint || "Unknown";
    const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
    if (!stats.byEndpoint[epKey]) {
      stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, cost: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
    }
    const epe = stats.byEndpoint[epKey];
    epe.requests += requests; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens; epe.cacheCreationTokens = (epe.cacheCreationTokens || 0) + cacheCreationTokens; epe.cost += entryCost;
    if (new Date(r.timestamp) > new Date(epe.lastUsed)) epe.lastUsed = r.timestamp;
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  // Say which selection these numbers answer. Without it, a snapshot from the
  // REST route and one from the SSE stream are indistinguishable, so a consumer
  // that has since moved to another period cannot tell that the payload in its
  // hand describes the previous one and has to be dropped (#3198).
  stats.period = win ? "range" : period;
  stats.range = win ? { startDate: win.startKey, endDate: win.endKey } : null;
  return stats;
}

export async function getChartData(period = "7d", range = null) {
  const db = await getAdapter();
  const now = Date.now();

  // Same precedence as getUsageStats: an explicit range answers the question a
  // trailing window cannot (#3442). Days with no traffic are still plotted, so
  // a quiet day reads as zero rather than vanishing from the axis.
  const win = resolveDayRange(range);
  if (win) {
    const dayMap = {};
    for (const r of loadDaysBetween(db, win.startKey, win.endKey)) dayMap[r.dateKey] = parseJson(r.data, {});
    const days = eachDateKey(win.startKey, win.endKey);
    const bucketDays = Math.max(1, Math.ceil(days.length / ALL_TIME_CHART_MAX_POINTS));
    const buckets = [];
    for (let i = 0; i < days.length; i += bucketDays) {
      let tokens = 0;
      let cost = 0;
      for (const dateKey of days.slice(i, i + bucketDays)) {
        const day = dayMap[dateKey];
        if (!day) continue;
        tokens += (day.promptTokens || 0) + (day.completionTokens || 0);
        cost += day.cost || 0;
      }
      buckets.push({
        label: dateKeyToLocalDate(days[i]).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        tokens,
        cost,
      });
    }
    return buckets;
  }

  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    // `label` is formatted with the SERVER process zone, so a viewer elsewhere
    // reads hours that are not theirs and has nothing to re-format from (#3163).
    // Carry the bucket's own instant as well: it is zone-free, so the browser
    // can render local hours without a `tz` request parameter, which would make
    // the viewer's "today" disagree with the persisted gateway day.
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
      bucketStart: startTime + i * bucketMs,
      label: labelFn(startTime + i * bucketMs),
      tokens: 0,
      cost: 0,
    }));

    const rows = visibleUsageRows(db, 'timestamp, promptTokens, completionTokens, cost',
      ['timestamp >= ?'], [new Date(startTime).toISOString()]);
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
        buckets[idx].cost += r.cost || 0;
      }
    }
    return buckets;
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startTime = now - bucketCount * bucketMs;
    // Same canonical instant as the "today" branch above (#3163).
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
      bucketStart: startTime + i * bucketMs,
      label: labelFn(startTime + i * bucketMs),
      tokens: 0,
      cost: 0,
    }));

    const rows = visibleUsageRows(db, 'timestamp, promptTokens, completionTokens, cost',
      ['timestamp >= ?'], [new Date(startTime).toISOString()]);
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      buckets[idx].cost += r.cost || 0;
    }
    return buckets;
  }

  if (period === "all") {
    const bounds = db.get(`SELECT date(MIN(timestamp),'localtime') AS firstDateKey,
      date(MAX(timestamp),'localtime') AS lastDateKey FROM usageHistory WHERE ${telemetryFilterSql('usageHistory')}`);
    if (!bounds?.firstDateKey || !bounds?.lastDateKey) return [];

    const spanDays = Math.floor((dateKeyToUtcTime(bounds.lastDateKey) - dateKeyToUtcTime(bounds.firstDateKey)) / 86400000) + 1;
    const bucketDays = Math.max(1, Math.ceil(spanDays / ALL_TIME_CHART_MAX_POINTS));
    const rows = db.all(
      `SELECT
         CAST((julianday(date(timestamp,'localtime')) - julianday(?)) / ? AS INTEGER) AS bucketIndex,
         MIN(date(timestamp,'localtime')) AS bucketStart,
         SUM(promptTokens + completionTokens) AS tokens, SUM(cost) AS cost
       FROM usageHistory WHERE ${telemetryFilterSql('usageHistory')}
       GROUP BY bucketIndex
       ORDER BY bucketIndex ASC`,
      [bounds.firstDateKey, bucketDays]
    );

    return rows.map((row) => {
      return {
        label: dateKeyToLocalDate(row.bucketStart).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        tokens: Number(row.tokens) || 0,
        cost: Number(row.cost) || 0,
      };
    });
  }

  const bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const today = new Date();
  const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // Build map of dateKey → day data
  const dayRows = loadDaysInRange(db, bucketCount);
  const dayMap = {};
  for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (bucketCount - 1 - i));
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    return {
      label: labelFn(d),
      tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
      cost: dayData ? (dayData.cost || 0) : 0,
    };
  });
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

export async function getRecentLogs(limit = 200) {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens, meta FROM usageHistory WHERE ${telemetryFilterSql('usageHistory')} ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const ts = formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const meta = r.meta ? parseJson(r.meta, {}) : {};
      const requestedModel = meta.requestedModel || null;
      const m = (requestedModel && requestedModel !== r.model) ? `${requestedModel} → ${r.model}` : (r.model || "-");
      const account = connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? "-";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}

// ─── System state (read-only) ────────────────────────────────────────────────
// Backs the `spend` measure of GET /api/system/state. usageHistory is the only
// table carrying cost evidence. A legacy scalar 0 with no costSource is not
// proof of a free request: only explicitly provider-reported or rate-card
// estimated rows contribute to spend, and the unknown population is returned
// beside the total.
// Plan: SEARCH usageHistory USING INDEX idx_uh_ts (timestamp>?).
export async function getSpendWindow(sinceIso) {
  const db = await getAdapter();
  const row =
    db.get(
      `SELECT COUNT(*) AS samples,
              SUM(CASE WHEN costSource='provider-reported' AND COALESCE(reportedCostUsd,cost) IS NOT NULL THEN 1 ELSE 0 END) AS providerReportedSamples,
              SUM(CASE WHEN costSource='application-estimate' AND COALESCE(estimatedCostUsd,cost) IS NOT NULL THEN 1 ELSE 0 END) AS estimatedSamples,
              SUM(CASE WHEN costSource='provider-reported' THEN COALESCE(reportedCostUsd,cost) END) AS providerReportedUsd,
              SUM(CASE WHEN costSource='application-estimate' THEN COALESCE(estimatedCostUsd,cost) END) AS estimatedUsd,
              SUM(CASE WHEN costSource IS NULL OR costSource NOT IN ('provider-reported','application-estimate')
                OR (costSource='provider-reported' AND COALESCE(reportedCostUsd,cost) IS NULL)
                OR (costSource='application-estimate' AND COALESCE(estimatedCostUsd,cost) IS NULL)
                THEN 1 ELSE 0 END) AS unknownSamples
       FROM usageHistory WHERE ${telemetryFilterSql('usageHistory')} AND timestamp >= ?`,
      [sinceIso]
    ) || {};
  const samples = row.samples || 0;
  const providerReportedSamples = row.providerReportedSamples || 0;
  const estimatedSamples = row.estimatedSamples || 0;
  const pricedSamples = providerReportedSamples + estimatedSamples;
  const providerReportedUsd = providerReportedSamples ? row.providerReportedUsd ?? null : null;
  const estimatedUsd = estimatedSamples ? row.estimatedUsd ?? null : null;
  const spendUsd = pricedSamples ? (providerReportedUsd || 0) + (estimatedUsd || 0) : null;
  const evidenceKind = providerReportedSamples && estimatedSamples
    ? 'mixed'
    : providerReportedSamples
      ? 'provider-reported'
      : estimatedSamples
        ? 'application-estimate'
        : 'unknown';
  return {
    spendUsd,
    samples,
    pricedSamples,
    providerReportedUsd,
    providerReportedSamples,
    estimatedUsd,
    estimatedSamples,
    unknownSamples: row.unknownSamples || 0,
    evidenceKind,
  };
}

// ─── Provider health (read-only) ─────────────────────────────────────────────
// Backs GET /api/usage/stats/health (#1336). Capture was never the gap: every
// request already writes provider, connectionId, model, status, latencyTotal
// and latencyTtft into requestStats, so nothing here opens a second store. What
// was missing is the rollup — getStatsSummary collapses one filtered population
// into a single figure and getTrafficWindow covers the whole instance, so
// neither can say WHICH provider, which account of it, or which model on that
// account is slow or failing. One GROUP BY over the same table answers all
// three, at whichever grain the caller asks for.
// Plan: SCAN requestStats, narrowing to SEARCH USING INDEX idx_rs_ts whenever a
// period or range bounds the window (only "all" is unbounded).
const HEALTH_GROUPS = {
  provider: ["provider"],
  account: ["provider", "connectionId"],
  model: ["provider", "connectionId", "model"],
};

export async function getProviderHealth({ period = "7d", range = null, groupBy = "account" } = {}) {
  const grain = HEALTH_GROUPS[groupBy] ? groupBy : "account";
  const cols = HEALTH_GROUPS[grain];
  const db = await getAdapter();
  const { ensureStatsBackfilled, buildStatsWhere } = await import("./requestStatsRepo.js");
  await ensureStatsBackfilled();

  // A date range wins over the period, the same precedence getUsageStatsInRange
  // applies, so both surfaces answer for the same selection (#3442).
  const win = resolveDayRange(range);
  const startIso = win ? win.startIso : periodCutoffIso(period);
  const endIso = win ? win.endIso : null;
  const { where, params } = buildStatsWhere({
    ...(startIso ? { startDate: startIso } : {}),
    ...(endIso ? { endDate: endIso } : {}),
  });

  const groupSql = cols.join(", ");
  const rows = db.all(
    `SELECT ${groupSql},
            COUNT(*) AS requests,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
            AVG(CASE WHEN latencyTotal > 0 THEN latencyTotal END) AS avgLatency,
            SUM(CASE WHEN latencyTotal > 0 THEN 1 ELSE 0 END) AS latencySamples,
            AVG(CASE WHEN latencyTtft > 0 THEN latencyTtft END) AS avgTtft,
            SUM(CASE WHEN latencyTtft > 0 THEN 1 ELSE 0 END) AS ttftSamples
     FROM requestStats ${where}
     GROUP BY ${groupSql}
     ORDER BY requests DESC`,
    params,
  );

  const connectionMap = await getConnectionMapCached();
  const providerNodeNameMap = {};
  try {
    const { getProviderNodes } = await import("./nodesRepo.js");
    for (const n of await getProviderNodes()) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  return {
    // The window travels with the numbers: a success rate with no period
    // attached is not a measurement.
    period: win ? "range" : period,
    startDate: startIso,
    endDate: endIso,
    groupBy: grain,
    rows: rows.map((r) => {
      const requests = r.requests || 0;
      const errors = r.errors || 0;
      const latencySamples = r.latencySamples || 0;
      const ttftSamples = r.ttftSamples || 0;
      return {
        provider: r.provider || "",
        providerName: providerNodeNameMap[r.provider] || r.provider || "",
        ...(cols.includes("connectionId")
          ? {
              connectionId: r.connectionId || "",
              account: connectionMap[r.connectionId] || r.connectionId || "",
            }
          : {}),
        ...(cols.includes("model") ? { model: r.model || "" } : {}),
        requests,
        errors,
        // null, not 1: an empty group measured no outcome at all, and 1 would
        // award a clean record to a provider nothing ever reached.
        successRate: requests > 0 ? (requests - errors) / requests : null,
        // latencyTotal/latencyTtft are 0 on rows that never measured them
        // (backfilled history, and any writer that omitted them). Averaging
        // those in would count them as instant responses, so they are excluded
        // and the sample counts travel with the averages, exactly as
        // getStatsSummary states its own denominator.
        avgLatencyMs: latencySamples > 0 ? r.avgLatency : null,
        avgTtftMs: ttftSamples > 0 ? r.avgTtft : null,
        latencySamples,
        ttftSamples,
      };
    }),
  };
}
