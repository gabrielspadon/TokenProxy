import { CONTEXT_STRUCTURE_DEFINITIONS, readContextRelated } from "./contextRelated.mjs";

// Fixed read-only Context projections. No driver, migration or writer imports.
export class ContextQueryError extends Error {}

const FILTER_KEYS = new Set(["view", "provider", "model", "connectionId", "clientTool", "clientKeyId", "clientRef", "clientSessionRef", "taskRef", "projectRef", "logicalRequestId", "requestId", "projectLabel", "from", "to", "until", "page", "pageSize"]);
export function validateAnalyticsQuery(query) {
  if (!query || !["overview", "session"].includes(query.operation)
    || Object.keys(query).some((key) => !["operation", "filter", "sessionId", "retainedDays"].includes(key))) throw new ContextQueryError("Invalid analytics operation");
  if (!query.filter || typeof query.filter !== "object" || Array.isArray(query.filter)
    || Object.entries(query.filter).some(([key, value]) => !FILTER_KEYS.has(key) || !["string", "number"].includes(typeof value))) throw new ContextQueryError("Invalid analytics filter");
  const filter = parseContextFilter(new URLSearchParams(query.filter));
  if (query.operation === "session") return { operation: "session", sessionId: validId(query.sessionId), filter };
  if (query.retainedDays !== null && (!Number.isInteger(query.retainedDays) || query.retainedDays < 1 || query.retainedDays > 365)) throw new ContextQueryError("Invalid retention");
  return { operation: "overview", filter, retainedDays: query.retainedDays };
}

export function parseContextFilter(params) {
  const f = {};
  const view = params.get("view");
  if (view !== null && !["full", "summary"].includes(view)) throw new ContextQueryError("Invalid view");
  if (view !== null) f.view = view;
  for (const name of ["provider", "model", "connectionId", "clientTool", "clientKeyId", "clientRef", "clientSessionRef", "taskRef", "projectRef", "logicalRequestId", "requestId", "projectLabel"]) {
    const value = params.get(name);
    if (value !== null) {
      if (!value || value.length > 200) throw new ContextQueryError(`Invalid ${name}`);
      f[name] = value;
    }
  }
  for (const name of ["from", "to", "until"]) {
    const value = params.get(name);
    if (value !== null) {
      if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ContextQueryError(`Invalid ${name}`);
      const [year, month, day] = value.slice(0, 10).split("-").map(Number);
      if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new ContextQueryError(`Invalid ${name}`);
      f[name] = new Date(value).toISOString();
    }
  }
  if (f.from && f.to && f.from > f.to) throw new ContextQueryError("from must precede to");
  if (f.to && f.until) throw new ContextQueryError("Use either inclusive to or exclusive until");
  if (f.from && f.until && f.from >= f.until) throw new ContextQueryError("from must precede until");
  for (const [name, fallback, max] of [["page", 1, 10000], ["pageSize", 50, 100]]) {
    const raw = params.get(name);
    if (raw !== null && (!/^[1-9]\d*$/.test(raw) || Number(raw) > max)) throw new ContextQueryError(`Invalid ${name}`);
    f[name] = raw === null ? fallback : Number(raw);
  }
  return f;
}

function whereFor(f, sessionId, attributedOnly = true) {
  const clauses = [attributedOnly ? "r.contextSessionId IS NOT NULL" : "1=1"];
  const args = [];
  for (const key of ["provider", "model", "connectionId", "clientTool", "clientKeyId", "clientRef", "clientSessionRef", "taskRef", "projectRef", "logicalRequestId", "requestId"]) if (f[key]) { clauses.push(`r.${key === "requestId" ? "id" : key}=?`); args.push(f[key]); }
  if (f.projectLabel) { clauses.push("s.projectLabel=?"); args.push(f.projectLabel); }
  if (f.from) { clauses.push("r.timestamp>=?"); args.push(f.from); }
  if (f.to) { clauses.push("r.timestamp<=?"); args.push(f.to); }
  if (f.until) { clauses.push("r.timestamp<?"); args.push(f.until); }
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
export function readContextOverview(db, f = {}, retainedDays = null) {
  const filter = whereFor(f);
  const totals = summary(db, filter);
  const coverageFilter = whereFor(f, null, false);
  const recording = db.get(`SELECT COUNT(*) AS totalRetainedAttempts,
    COUNT(CASE WHEN r.contextSessionId IS NOT NULL THEN 1 END) AS attributedAttempts,
    COUNT(CASE WHEN r.contextTelemetryError IS NOT NULL THEN 1 END) AS rejectedAttempts,
    COUNT(CASE WHEN r.contextSessionId IS NULL AND r.contextTelemetryError IS NULL THEN 1 END) AS unattributedAttempts,
    MAX(CASE WHEN r.contextTelemetryError IS NOT NULL THEN r.timestamp END) AS lastRejectedAt
    FROM requestStats r LEFT JOIN contextSessions s ON s.id=r.contextSessionId ${coverageFilter.sql}`, coverageFilter.args);
  const common = { view: f.view || "full", recording: { ...recording, scope: "filtered retained attempts" }, summary: totals,
    retentionDays: retainedDays, recordingStartedAt: db.get(`SELECT value FROM _meta WHERE key='contextRecordingStartedAt'`)?.value ?? null,
    units: { context: "tokens", shaping: "bytes", latency: "ms" }, filters: f,
    definitions: { providerInputTokens: "Cache-inclusive input reported by upstream; missing input is excluded.", savedBytes: "Signed sum of before minus after across measured stages; negative values are expansion.", cacheHitRate: "Observed cache-read / cache-inclusive input, only for attempts reporting both.", compactionHints: "Prefix discontinuity observations, not proof of a client compaction.", projectLabel: "Operator assigned; no prompt or path inference.", pending: "In flight or interrupted before completion was persisted; never assumed successful." } };
  if (f.view === "summary") return common;
  const p = pagination(f, totals.sessions);
  const sessions = db.all(`SELECT s.id,s.projectLabel,s.identitySource,r.clientTool,MAX(r.timestamp) AS lastSeenAt,MIN(r.timestamp) AS firstSeenAt,
    COUNT(*) AS attempts,COUNT(DISTINCT COALESCE(r.logicalRequestId,r.id)) AS requests,
    SUM(CASE WHEN r.usageSource='provider' AND r.usageInputPresent=1 THEN r.promptTokens END) AS providerInputTokens,
    SUM(r.bodyBeforeBytes-r.bodyAfterBytes) AS savedBytes
    ${JOIN} ${filter.sql} GROUP BY s.id ORDER BY lastSeenAt DESC,s.id DESC LIMIT ? OFFSET ?`, [...filter.args,p.pageSize,(p.page-1)*p.pageSize]);
  const projects = db.all(`SELECT s.projectLabel,COUNT(DISTINCT s.id) AS sessions,COUNT(*) AS attempts ${JOIN} ${filter.sql}
    GROUP BY s.projectLabel ORDER BY attempts DESC LIMIT 100`, filter.args);
  return { ...common, sessions, pagination: p, projects, stages: stageSummary(db,filter), dimensions: dimensions(db,filter) };
}

export function publicTurn(row) {
  const provider = row.usageSource === "provider";
  return { id: row.id, contextSessionId: row.contextSessionId ?? null, dispatchCoverage: row.dispatchCoverage ?? null, timestamp: row.timestamp, status: row.status, logicalRequestId: row.logicalRequestId, attempt: row.attempt,
    explicitIdentity: Object.fromEntries(["clientKeyId", "clientRef", "clientSessionRef", "taskRef", "projectRef", "clientIdentitySource"].map((key) => [key, row[key] ?? null])),
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
function sessionTrend(db, filter, totals) {
  if (!totals.attempts) return { bucketMs: 60000, points: [] };
  const span = Date.parse(totals.lastSeenAt) - Date.parse(totals.firstSeenAt);
  const bucketMs = Math.max(60000, Math.ceil((span + 1) / (119 * 60000)) * 60000);
  const points = db.all(`SELECT CAST((CAST(strftime('%s',r.timestamp) AS INTEGER)*1000)/? AS INTEGER)*? AS bucketStart,
    COUNT(*) AS attempts, MIN(r.timestamp) AS firstSeenAt, MAX(r.timestamp) AS lastSeenAt,
    MAX(r.contextEstimate) AS maxContextEstimate,
    SUM(CASE WHEN r.usageSource='provider' AND r.usageInputPresent=1 THEN r.promptTokens END) AS providerInputTokens,
    SUM(CASE WHEN r.usageSource='provider' AND r.cacheReadPresent=1 THEN r.cachedTokens END) AS cacheReadTokens,
    SUM(r.bodyBeforeBytes-r.bodyAfterBytes) AS savedBytes
    ${JOIN} ${filter.sql} GROUP BY bucketStart ORDER BY bucketStart LIMIT 120`, [bucketMs,bucketMs,...filter.args])
    .map((row) => ({ ...row, bucketStart: new Date(row.bucketStart).toISOString() }));
  return { bucketMs, points, scope: "All filtered attempts in this session; empty intervals are omitted.",
    units: { bucketMs: "ms", maxContextEstimate: "estimated tokens", providerInputTokens: "provider tokens", cacheReadTokens: "provider tokens", savedBytes: "signed bytes" } };
}
export function validId(id) {
  if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw new ContextQueryError("Invalid session id");
  return Number(id);
}
export function readContextSession(db, id, f = {}) {
  const session = db.get(`SELECT * FROM contextSessions WHERE id=?`, [validId(id)]);
  if (!session) return null;
  const filter = whereFor(f, session.id);
  const totals = summary(db,filter);
  const p = pagination(f,totals.attempts);
  const rows = db.all(`SELECT r.* ${JOIN} ${filter.sql} ORDER BY r.timestamp ASC,r.id ASC LIMIT ? OFFSET ?`, [...filter.args,p.pageSize,(p.page-1)*p.pageSize]);
  const ids = rows.map((r) => r.id);
  const stages = ids.length ? db.all(`SELECT * FROM contextStages WHERE requestId IN (${ids.map(() => '?').join(',')}) ORDER BY requestId,ordinal`, ids) : [];
  const related = readContextRelated(db, ids);
  const pins = db.all(`SELECT model,connectionId,providerNode,pinnedAt,expiresAt,lastSeenAt FROM sessionAffinity WHERE sessionHash=? ORDER BY model LIMIT 100`, [session.sessionHash]);
  const switches = db.all(`SELECT id,model,fromConnectionId,toConnectionId,trigger,reason,switchedAt FROM accountSwitches WHERE sessionHash=? ORDER BY switchedAt DESC LIMIT 100`, [session.sessionHash]);
  const { sessionHash: _private, ...safeSession } = session;
  return { session: safeSession, summary: totals, turns: rows.map((r) => ({...publicTurn(r),structures: related.structures.get(r.id) ?? [],costRecords: related.costs.get(r.id) ?? [],stages: stages.filter((s) => s.requestId===r.id).map(({requestId: _id,...s})=>s)})),
    pagination: p, trend: sessionTrend(db,filter,totals), stages: stageSummary(db,filter), dimensions: dimensions(db,filter), pins, switches,
    structuralDefinitions: CONTEXT_STRUCTURE_DEFINITIONS,
    routingScope: "Latest retained affinity and at most 100 switch receipts for this session, independent of the turn time filter." };
}
