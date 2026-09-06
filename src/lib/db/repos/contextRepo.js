import { getAdapter } from "../driver.js";
import { getSettings } from "./settingsRepo.js";

const DAY_MS = 86400000;
const STAGE_NAMES = new Set(["tools", "schema", "thinking", "rtk", "privacy", "inject", "pxpipe", "mem", "headroom", "qac", "pairs", "reorder", "midinject", "final"]);
const CONTROL_NAMES = new Set(["rtk", "rtkAllowLossy", "schema", "schemaAllowLossy", "thinking", "privacy", "caveman", "ponytail", "pxpipe", "pxpipeAllowLossy", "memory", "headroom", "headroomAllowLossy", "qac", "pairs", "reorder", "midinject", "clientOptOut"]);
const TERMINAL = new Set(["success", "error", "cancelled", "aborted"]);
const number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const present = (...values) => values.some((v) => number(v) !== null);
const short = (v, max = 200) => typeof v === "string" ? v.slice(0, max) : null;

export class ContextQueryError extends Error {}

export function normalizeContextStages(stages) {
  if (!Array.isArray(stages)) return [];
  let previous = null;
  return stages.slice(0, 32).map((s, ordinal) => {
    if (!STAGE_NAMES.has(s.stage) || number(s.in) === null || number(s.out) === null) throw new Error("Invalid context stage");
    if (previous !== null && previous !== s.in) throw new Error("Context stage boundaries do not reconcile");
    previous = s.out;
    return { ordinal, stage: s.stage, beforeBytes: s.in, afterBytes: s.out, deltaBytes: s.out - s.in,
      outcome: s.ran === false ? "skipped" : s.in === s.out ? "unchanged" : "applied",
      risk: s.stage === "rtk" && s.semanticPreserving ? "semantic-preserving" : ["tools", "final"].includes(s.stage) ? "normalization" : "content-changing" };
  });
}

// Called inside the requestStats transaction. Only allowlisted scalar metrics
// cross this boundary; bodies, raw identities, headers and credentials cannot.
export function saveContextMetrics(db, detail) {
  const c = detail.contextTelemetry;
  if (!c) return;
  if (!/^[a-f0-9]{32,64}$/.test(c.sessionHash || "")) throw new Error("Invalid context identity");
  const stages = normalizeContextStages(c.stages);
  const controls = Object.fromEntries(Object.entries(c.controls || {}).filter(([k,v]) => CONTROL_NAMES.has(k) && typeof v === "boolean"));
  const at = detail.timestamp;
  db.run(`INSERT INTO contextSessions(sessionHash, identitySource, firstSeenAt, lastSeenAt) VALUES(?, ?, ?, ?)
    ON CONFLICT(sessionHash) DO UPDATE SET identitySource=excluded.identitySource, firstSeenAt = MIN(firstSeenAt, excluded.firstSeenAt), lastSeenAt = MAX(lastSeenAt, excluded.lastSeenAt)`,
  [c.sessionHash, ["explicit", "inferred", "routing"].includes(c.identitySource) ? c.identitySource : "request", at, at]);
  const sessionId = db.get(`SELECT id FROM contextSessions WHERE sessionHash = ?`, [c.sessionHash]).id;
  const u = detail.tokens;
  const hasUsage = u && present(u.prompt_tokens, u.input_tokens, u.completion_tokens, u.output_tokens, u.cached_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens);
  const source = detail.status === "pending" || !hasUsage ? "missing" : u.estimated ? "estimated" : "provider";
  const cacheRead = present(u?.cached_tokens, u?.cache_read_input_tokens, u?.prompt_tokens_details?.cached_tokens, u?.input_tokens_details?.cached_tokens);
  const cacheWrite = present(u?.cache_creation_input_tokens, u?.cache_write_tokens);
  db.run(`UPDATE requestStats SET contextTelemetryError=NULL,contextSessionId=?, logicalRequestId=?, requestedModel=?, clientTool=?,
    contextEstimate=?, inputEstimate=?, bodyBeforeBytes=?, bodyAfterBytes=?, cachePrefixBytes=?, compactHint=?,
    usageSource=?, usageInputPresent=?, usageOutputPresent=?, cacheReadPresent=?, cacheWritePresent=?,
    messageCount=?, toolCount=?, routeKind=?, formatPair=?, selection=?, contextControls=?, attempt=? WHERE id=?`,
  [sessionId, short(c.logicalRequestId, 128), short(c.requestedModel), short(c.clientTool, 60), number(c.contextEstimate), number(c.inputEstimate),
    stages[0]?.beforeBytes ?? number(c.bodyAfterBytes), stages.at(-1)?.afterBytes ?? number(c.bodyAfterBytes), number(c.cachePrefixBytes), c.compactHint ? 1 : 0,
    source, u && present(u.prompt_tokens, u.input_tokens) ? 1 : 0, u && present(u.completion_tokens, u.output_tokens) ? 1 : 0,
    cacheRead ? 1 : 0, cacheWrite ? 1 : 0, number(c.messageCount), number(c.toolCount), short(c.routeKind, 40), short(c.formatPair, 100), short(c.selection, 80), JSON.stringify(controls), number(c.attempt), detail.id]);
  db.run(`DELETE FROM contextStages WHERE requestId=?`, [detail.id]);
  for (const s of stages) db.run(`INSERT INTO contextStages(requestId, ordinal, stage, beforeBytes, afterBytes, deltaBytes, outcome, risk) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [detail.id, s.ordinal, s.stage, s.beforeBytes, s.afterBytes, s.deltaBytes, s.outcome, s.risk]);
  db.run(`INSERT INTO _meta(key,value) VALUES('contextRecordingStartedAt',?) ON CONFLICT(key) DO NOTHING`, [at]);
}

export function shouldIgnorePending(existing, detail) {
  return detail.status === "pending" && TERMINAL.has(existing?.status);
}

export function parseContextFilter(params) {
  const f = {};
  for (const name of ["provider", "model", "connectionId", "clientTool", "projectLabel"]) {
    const value = params.get(name);
    if (value !== null) {
      if (!value || value.length > 200) throw new ContextQueryError(`Invalid ${name}`);
      f[name] = value;
    }
  }
  for (const name of ["from", "to"]) {
    const value = params.get(name);
    if (value !== null) {
      if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new ContextQueryError(`Invalid ${name}`);
      f[name] = new Date(value).toISOString();
    }
  }
  if (f.from && f.to && f.from > f.to) throw new ContextQueryError("from must precede to");
  for (const [name, fallback, max] of [["page", 1, 10000], ["pageSize", 50, 100]]) {
    const raw = params.get(name);
    if (raw !== null && (!/^[1-9]\d*$/.test(raw) || Number(raw) > max)) throw new ContextQueryError(`Invalid ${name}`);
    f[name] = raw === null ? fallback : Number(raw);
  }
  return f;
}

function whereFor(f, sessionId) {
  const clauses = ["r.contextSessionId IS NOT NULL"];
  const args = [];
  for (const key of ["provider", "model", "connectionId", "clientTool"]) if (f[key]) { clauses.push(`r.${key}=?`); args.push(f[key]); }
  if (f.projectLabel) { clauses.push("s.projectLabel=?"); args.push(f.projectLabel); }
  if (f.from) { clauses.push("r.timestamp>=?"); args.push(f.from); }
  if (f.to) { clauses.push("r.timestamp<=?"); args.push(f.to); }
  if (sessionId) { clauses.push("r.contextSessionId=?"); args.push(sessionId); }
  return { sql: `WHERE ${clauses.join(" AND ")}`, args };
}
const JOIN = "FROM requestStats r JOIN contextSessions s ON s.id=r.contextSessionId";
const SUMMARY = `COUNT(*) AS attempts, COUNT(DISTINCT COALESCE(r.logicalRequestId,r.id)) AS requests,
 COUNT(DISTINCT r.contextSessionId) AS sessions,
 SUM(CASE WHEN r.status='success' THEN 1 ELSE 0 END) AS succeeded,
 SUM(CASE WHEN r.status='pending' THEN 1 ELSE 0 END) AS pending,
 SUM(CASE WHEN r.status IN ('error','cancelled','aborted') THEN 1 ELSE 0 END) AS failed,
 SUM(CASE WHEN r.usageSource='provider' THEN 1 ELSE 0 END) AS providerUsageSamples,
 SUM(CASE WHEN r.usageSource='estimated' THEN 1 ELSE 0 END) AS estimatedUsageSamples,
 SUM(CASE WHEN r.usageSource='missing' OR r.usageSource IS NULL THEN 1 ELSE 0 END) AS missingUsageSamples,
 SUM(CASE WHEN r.usageSource='provider' AND r.usageInputPresent=1 THEN r.promptTokens END) AS providerInputTokens,
 SUM(CASE WHEN r.usageSource='provider' AND r.usageOutputPresent=1 THEN r.completionTokens END) AS providerOutputTokens,
 SUM(CASE WHEN r.usageSource='provider' AND r.cacheReadPresent=1 THEN r.cachedTokens END) AS cacheReadTokens,
 SUM(CASE WHEN r.usageSource='provider' AND r.cacheWritePresent=1 THEN r.cacheCreationTokens END) AS cacheWriteTokens,
 SUM(CASE WHEN r.usageSource='provider' AND r.cacheReadPresent=1 AND r.usageInputPresent=1 THEN r.promptTokens END) AS cacheEligibleInputTokens,
 SUM(CASE WHEN r.usageSource='provider' AND r.cacheReadPresent=1 AND r.usageInputPresent=1 THEN r.cachedTokens END) AS cacheEligibleReadTokens,
 SUM(CASE WHEN r.usageSource='estimated' AND r.usageInputPresent=1 THEN r.promptTokens END) AS estimatedInputTokens,
 SUM(CASE WHEN r.usageSource='estimated' AND r.usageOutputPresent=1 THEN r.completionTokens END) AS estimatedOutputTokens,
 SUM(r.bodyBeforeBytes-r.bodyAfterBytes) AS savedBytes,
 SUM(r.compactHint) AS compactionHints, MIN(r.timestamp) AS firstSeenAt, MAX(r.timestamp) AS lastSeenAt`;
function summary(db, filter) {
  const row = db.get(`SELECT ${SUMMARY} ${JOIN} ${filter.sql}`, filter.args);
  for (const k of ["attempts", "requests", "sessions", "succeeded", "pending", "failed", "providerUsageSamples", "estimatedUsageSamples", "missingUsageSamples", "compactionHints"]) row[k] ??= 0;
  row.cacheHitRate = row.cacheEligibleInputTokens > 0 ? row.cacheEligibleReadTokens / row.cacheEligibleInputTokens : null;
  return row;
}
function pagination(f, totalItems) {
  const page = f.page || 1, pageSize = f.pageSize || 50;
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize), hasNext: page * pageSize < totalItems, hasPrev: page > 1 };
}
function stageSummary(db, filter) {
  return db.all(`SELECT st.stage, COUNT(*) AS samples, SUM(st.beforeBytes) AS beforeBytes, SUM(st.afterBytes) AS afterBytes,
    SUM(-st.deltaBytes) AS savedBytes, SUM(CASE WHEN st.outcome='applied' THEN 1 ELSE 0 END) AS applied,
    SUM(CASE WHEN st.outcome='skipped' THEN 1 ELSE 0 END) AS skipped
    ${JOIN} JOIN contextStages st ON st.requestId=r.id ${filter.sql} GROUP BY st.stage ORDER BY MIN(st.ordinal)`, filter.args);
}
function dimensions(db, filter) {
  return db.all(`SELECT r.provider,r.model,r.connectionId,${SUMMARY} ${JOIN} ${filter.sql}
    GROUP BY r.provider,r.model,r.connectionId ORDER BY attempts DESC LIMIT 100`, filter.args).map((r) => ({ ...r,
    cacheHitRate: r.cacheEligibleInputTokens > 0 ? r.cacheEligibleReadTokens / r.cacheEligibleInputTokens : null }));
}
export async function getContextOverview(f = {}) {
  const db = await getAdapter();
  const filter = whereFor(f);
  const totals = summary(db, filter);
  const p = pagination(f, totals.sessions);
  const sessions = db.all(`SELECT s.id,s.projectLabel,s.identitySource,r.clientTool,MAX(r.timestamp) AS lastSeenAt,MIN(r.timestamp) AS firstSeenAt,
    COUNT(*) AS attempts,COUNT(DISTINCT COALESCE(r.logicalRequestId,r.id)) AS requests,
    SUM(CASE WHEN r.usageSource='provider' AND r.usageInputPresent=1 THEN r.promptTokens END) AS providerInputTokens,
    SUM(r.bodyBeforeBytes-r.bodyAfterBytes) AS savedBytes
    ${JOIN} ${filter.sql} GROUP BY s.id ORDER BY lastSeenAt DESC,s.id DESC LIMIT ? OFFSET ?`, [...filter.args,p.pageSize,(p.page-1)*p.pageSize]);
  const projects = db.all(`SELECT s.projectLabel,COUNT(DISTINCT s.id) AS sessions,COUNT(*) AS attempts ${JOIN} ${filter.sql}
    GROUP BY s.projectLabel ORDER BY attempts DESC LIMIT 100`, filter.args);
  const settings = await getSettings();
  const recording = db.get(`SELECT COUNT(*) AS rejectedAttempts,MAX(timestamp) AS lastRejectedAt FROM requestStats WHERE contextTelemetryError IS NOT NULL`);
  return { recording: { ...recording, scope: "all retained attempts" }, summary: totals, sessions, pagination: p, projects, stages: stageSummary(db,filter), dimensions: dimensions(db,filter),
    retentionDays: retentionDays(settings), recordingStartedAt: db.get(`SELECT value FROM _meta WHERE key='contextRecordingStartedAt'`)?.value ?? null,
    units: { context: "tokens", shaping: "bytes", latency: "ms" }, filters: f,
    definitions: { providerInputTokens: "Cache-inclusive input reported by upstream; missing input is excluded.", savedBytes: "Signed sum of before minus after across measured stages; negative values are expansion.", cacheHitRate: "Observed cache-read / cache-inclusive input, only for attempts reporting both.", compactionHints: "Prefix discontinuity observations, not proof of a client compaction.", projectLabel: "Operator assigned; no prompt or path inference.", pending: "In flight or interrupted before completion was persisted; never assumed successful." } };
}

function publicTurn(row) {
  const provider = row.usageSource === "provider";
  return { id: row.id, timestamp: row.timestamp, status: row.status, logicalRequestId: row.logicalRequestId, attempt: row.attempt,
    provider: row.provider, model: row.model, requestedModel: row.requestedModel, connectionId: row.connectionId, clientTool: row.clientTool,
    contextEstimate: row.contextEstimate, inputEstimate: row.inputEstimate, bodyBeforeBytes: row.bodyBeforeBytes, bodyAfterBytes: row.bodyAfterBytes,
    savedBytes: row.bodyBeforeBytes == null || row.bodyAfterBytes == null ? null : row.bodyBeforeBytes-row.bodyAfterBytes,
    cachePrefixBytes: row.cachePrefixBytes, compactHint: row.compactHint === 1, usageSource: row.usageSource,
    providerInputTokens: provider && row.usageInputPresent ? row.promptTokens : null,
    providerOutputTokens: provider && row.usageOutputPresent ? row.completionTokens : null,
    estimatedInputTokens: row.usageSource === "estimated" && row.usageInputPresent ? row.promptTokens : null,
    estimatedOutputTokens: row.usageSource === "estimated" && row.usageOutputPresent ? row.completionTokens : null,
    cacheReadTokens: provider && row.cacheReadPresent ? row.cachedTokens : null,
    cacheWriteTokens: provider && row.cacheWritePresent ? row.cacheCreationTokens : null,
    controls: row.contextControls ? JSON.parse(row.contextControls) : {},
    messageCount: row.messageCount, toolCount: row.toolCount, routeKind: row.routeKind, formatPair: row.formatPair, selection: row.selection,
    latencyMs: row.latencyTotal > 0 ? row.latencyTotal : null, ttftMs: row.latencyTtft > 0 ? row.latencyTtft : null };
}
function validId(id) {
  if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw new ContextQueryError("Invalid session id");
  return Number(id);
}
export async function getContextSession(id, f = {}) {
  const db = await getAdapter();
  const session = db.get(`SELECT * FROM contextSessions WHERE id=?`, [validId(id)]);
  if (!session) return null;
  const filter = whereFor(f, session.id);
  const totals = summary(db,filter);
  const p = pagination(f,totals.attempts);
  const rows = db.all(`SELECT r.* ${JOIN} ${filter.sql} ORDER BY r.timestamp ASC,r.id ASC LIMIT ? OFFSET ?`, [...filter.args,p.pageSize,(p.page-1)*p.pageSize]);
  const ids = rows.map((r) => r.id);
  const stages = ids.length ? db.all(`SELECT * FROM contextStages WHERE requestId IN (${ids.map(() => '?').join(',')}) ORDER BY requestId,ordinal`, ids) : [];
  const pins = db.all(`SELECT model,connectionId,providerNode,pinnedAt,expiresAt,lastSeenAt FROM sessionAffinity WHERE sessionHash=? ORDER BY model LIMIT 100`, [session.sessionHash]);
  const switches = db.all(`SELECT id,model,fromConnectionId,toConnectionId,trigger,reason,switchedAt FROM accountSwitches WHERE sessionHash=? ORDER BY switchedAt DESC LIMIT 100`, [session.sessionHash]);
  const { sessionHash: _private, ...safeSession } = session;
  return { session: safeSession, summary: totals, turns: rows.map((r) => ({...publicTurn(r),stages: stages.filter((s) => s.requestId===r.id).map(({requestId: _id,...s})=>s)})),
    pagination: p, stages: stageSummary(db,filter), dimensions: dimensions(db,filter), pins, switches,
    routingScope: "Latest retained affinity and at most 100 switch receipts for this session, independent of the turn time filter." };
}
export async function updateContextSession(id, body) {
  if (!body || Object.keys(body).some((k) => k !== "projectLabel")) throw new ContextQueryError("Only projectLabel can be changed");
  const label = body.projectLabel;
  if (label !== null && (typeof label !== "string" || !label.trim() || label.length > 80 || /[\x00-\x1f]/.test(label))) throw new ContextQueryError("projectLabel must be null or 1-80 printable characters");
  const db = await getAdapter();
  return db.run(`UPDATE contextSessions SET projectLabel=? WHERE id=?`, [label?.trim() || null, validId(id)]).changes > 0;
}
export function retentionDays(settings) {
  return Math.min(365, Math.max(1, Number(settings?.statsRetentionDays) || 45));
}
export function cleanupContext(db, now, days) {
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  db.transaction(() => {
    db.run(`DELETE FROM requestStats WHERE timestamp < ?`, [cutoff]);
    db.run(`DELETE FROM contextStages WHERE NOT EXISTS (SELECT 1 FROM requestStats r WHERE r.id=contextStages.requestId)`);
    db.run(`DELETE FROM contextSessions WHERE lastSeenAt < ? AND NOT EXISTS (SELECT 1 FROM requestStats r WHERE r.contextSessionId=contextSessions.id)`, [cutoff]);
  });
}
