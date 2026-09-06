import { DATA_FILE } from "../paths.js";
import { readContextAnalytics } from "../analytics/client.js";
import { ContextQueryError, validId } from "../analytics/contextQueries.mjs";
import { getAdapter } from "../driver.js";
import { getSettings } from "./settingsRepo.js";

const DAY_MS = 86400000;
const STAGE_NAMES = new Set(["tools", "schema", "thinking", "rtk", "privacy", "inject", "pxpipe", "mem", "headroom", "qac", "pairs", "reorder", "midinject", "final"]);
const CONTROL_NAMES = new Set(["rtk", "rtkAllowLossy", "schema", "schemaAllowLossy", "thinking", "privacy", "caveman", "ponytail", "pxpipe", "pxpipeAllowLossy", "memory", "headroom", "headroomAllowLossy", "qac", "pairs", "reorder", "midinject", "clientOptOut"]);
const TERMINAL = new Set(["success", "error", "cancelled", "aborted"]);
const number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const present = (...values) => values.some((v) => number(v) !== null);
const short = (v, max = 200) => typeof v === "string" ? v.slice(0, max) : null;


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

export { ContextQueryError, parseContextFilter } from "../analytics/contextQueries.mjs";

export async function getContextOverview(f = {}, options = {}) {
  const db = await getAdapter();
  const settings = await getSettings();
  return readContextAnalytics({ operation: "overview", filter: f, retainedDays: retentionDays(settings) },
    { ...options, file: DATA_FILE, driver: db.driver });
}

export async function getContextSession(id, f = {}, options = {}) {
  const db = await getAdapter();
  return readContextAnalytics({ operation: "session", sessionId: validId(id), filter: f },
    { ...options, file: DATA_FILE, driver: db.driver });
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
