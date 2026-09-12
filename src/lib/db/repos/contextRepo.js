import { DATA_FILE } from "../paths.js";
import { readContextAnalytics } from "../analytics/client.js";
import { ContextQueryError, validId } from "../analytics/contextQueries.mjs";
import { getAdapter } from "../driver.js";
import { getSettings } from "./settingsRepo.js";

import { normalizeContextIdentity, saveContextStructures } from "./contextEvidenceRepo.js";
import { STAGE_OUTCOMES, STAGE_ERROR_CODES } from "../../../../open-sse/utils/stageOutcome.js";
import { resolveCacheTokens } from "../../../../open-sse/utils/usageTracking.js";
import { saveHandoffApplications } from './shapingHandoffsRepo.js';

const DAY_MS = 86400000;
const STAGE_NAMES = new Set(["tools", "schema", "thinking", "rtk", "privacy", "inject", "pxpipe", "mem", "headroom", "qac", "pairs", "reorder", "midinject", "diet", "lingua", "epochMicro", "epochAuto", "handoff", "final"]);
const CONTROL_NAMES = new Set(["contextStructure", "rtk", "rtkAllowLossy", "schema", "schemaAllowLossy", "thinking", "privacy", "caveman", "ponytail", "pxpipe", "pxpipeAllowLossy", "memory", "headroom", "headroomAllowLossy", "qac", "pairs", "reorder", "midinject", "diet", "lingua", "epochMicro", "epochAuto", "handoff", "adaptiveCacheTtl", "clientOptOut"]);
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
    const explicit = s.outcomeSource === "execution";
    if (explicit && (!STAGE_OUTCOMES.has(s.outcome) ||
      (["failed", "cancelled"].includes(s.outcome) ? !STAGE_ERROR_CODES.has(s.errorCode) : s.errorCode != null))) {
      throw new Error("Invalid context stage outcome");
    }
    if (explicit && ((s.outcome === "cancelled") !== (s.errorCode === "caller_cancelled"))) throw new Error("Invalid stage cancellation evidence");
    if (explicit && s.executionRequestId != null &&
      (typeof s.executionRequestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(s.executionRequestId))) throw new Error("Invalid stage execution identity");
    return { ordinal, stage: s.stage, beforeBytes: s.in, afterBytes: s.out, deltaBytes: s.out - s.in,
      outcome: explicit ? s.outcome : s.ran === false ? "skipped" : s.in === s.out ? "unchanged" : "applied",
      errorCode: explicit ? s.errorCode ?? null : null, outcomeSource: explicit ? "execution" : null,
      executionRequestId: explicit ? s.executionRequestId ?? null : null,
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
  const existing = db.get(`SELECT * FROM requestStats WHERE id=?`, [detail.id]);
  const identity = Object.fromEntries(Object.entries(normalizeContextIdentity(c.explicitIdentity))
    .filter(([field, value]) => value !== null && existing?.[field] == null));
  if (Object.keys(identity).length) {
    const fields = Object.keys(identity);
    db.run(`UPDATE requestStats SET ${fields.map((field) => `${field}=COALESCE(${field},?)`).join(",")} WHERE id=?`, [...Object.values(identity), detail.id]);
  }
  saveContextStructures(db, detail.id, c.structures);
  saveHandoffApplications(db, detail);
  const controls = Object.fromEntries(Object.entries(c.controls || {}).filter(([k,v]) => CONTROL_NAMES.has(k) && typeof v === "boolean"));
  const at = detail.timestamp;
  const identitySource = ["explicit", "inferred", "routing"].includes(c.identitySource) ? c.identitySource : "request";
  const session = db.get(`SELECT id,identitySource,firstSeenAt,lastSeenAt FROM contextSessions WHERE sessionHash=?`, [c.sessionHash]);
  if (!session || session.identitySource !== identitySource || at < session.firstSeenAt || at > session.lastSeenAt) db.run(`INSERT INTO contextSessions(sessionHash, identitySource, firstSeenAt, lastSeenAt) VALUES(?, ?, ?, ?)
    ON CONFLICT(sessionHash) DO UPDATE SET identitySource=excluded.identitySource, firstSeenAt = MIN(firstSeenAt, excluded.firstSeenAt), lastSeenAt = MAX(lastSeenAt, excluded.lastSeenAt)`,
  [c.sessionHash, identitySource, at, at]);
  const sessionId = session?.id ?? db.get(`SELECT id FROM contextSessions WHERE sessionHash = ?`, [c.sessionHash]).id;
  const u = detail.tokens;
  const hasUsage = u && present(u.prompt_tokens, u.input_tokens, u.completion_tokens, u.output_tokens, u.cached_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens);
  const source = detail.status === "pending" || !hasUsage ? "missing" : u.estimated ? "estimated" : "provider";
  // Canonical alias table, not a local key list: a nested spelling (OpenAI's
  // input_tokens_details.cache_write_tokens) was missed here and persisted as
  // cacheWritePresent=0. Read from RAW tokens, since canonicalizeUsage
  // synthesizes 0 and cannot distinguish absent from reported zero.
  const cache = u && typeof u === "object" ? resolveCacheTokens(u) : { read: undefined, write: undefined };
  const cacheRead = present(cache.read);
  const cacheWrite = present(cache.write);
  const metrics = {
    contextTelemetryError: null, contextSessionId: sessionId, logicalRequestId: short(c.logicalRequestId, 128),
    requestedModel: short(c.requestedModel), clientTool: short(c.clientTool, 60), contextEstimate: number(c.contextEstimate),
    inputEstimate: number(c.inputEstimate), bodyBeforeBytes: stages[0]?.beforeBytes ?? number(c.bodyAfterBytes),
    bodyAfterBytes: stages.at(-1)?.afterBytes ?? number(c.bodyAfterBytes), cachePrefixBytes: number(c.cachePrefixBytes),
    compactHint: c.compactHint ? 1 : 0, usageSource: source, usageInputPresent: u && present(u.prompt_tokens, u.input_tokens) ? 1 : 0,
    usageOutputPresent: u && present(u.completion_tokens, u.output_tokens) ? 1 : 0, cacheReadPresent: cacheRead ? 1 : 0,
    cacheWritePresent: cacheWrite ? 1 : 0, messageCount: number(c.messageCount), toolCount: number(c.toolCount),
    routeKind: short(c.routeKind, 40), formatPair: short(c.formatPair, 100), selection: short(c.selection, 80),
    contextControls: JSON.stringify(controls), attempt: number(c.attempt),
  };
  if (Object.entries(metrics).some(([field, value]) => existing?.[field] !== value)) {
    db.run(`UPDATE requestStats SET ${Object.keys(metrics).map((field) => `${field}=?`).join(",")} WHERE id=?`,
      [...Object.values(metrics), detail.id]);
  }
  const storedStages = new Map(db.all(`SELECT * FROM contextStages WHERE requestId=?`, [detail.id]).map((stage) => [stage.ordinal, stage]));
  for (const s of stages) {
    const stored = storedStages.get(s.ordinal);
    if (stored && Object.entries(s).every(([field, value]) => stored[field] === value)) continue;
    db.run(`INSERT INTO contextStages(requestId, ordinal, stage, beforeBytes, afterBytes, deltaBytes, outcome, risk, errorCode, outcomeSource, executionRequestId) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(requestId,ordinal) DO UPDATE SET stage=excluded.stage,beforeBytes=excluded.beforeBytes,afterBytes=excluded.afterBytes,
        deltaBytes=excluded.deltaBytes,outcome=excluded.outcome,risk=excluded.risk,errorCode=excluded.errorCode,outcomeSource=excluded.outcomeSource,executionRequestId=excluded.executionRequestId`,
      [detail.id, s.ordinal, s.stage, s.beforeBytes, s.afterBytes, s.deltaBytes, s.outcome, s.risk, s.errorCode, s.outcomeSource, s.executionRequestId]);
  }
  if ([...storedStages.keys()].some((ordinal) => ordinal >= stages.length)) {
    db.run(`DELETE FROM contextStages WHERE requestId=? AND ordinal>=?`, [detail.id, stages.length]);
  }
  if (!db.get(`SELECT value FROM _meta WHERE key='contextRecordingStartedAt'`)) {
    db.run(`INSERT INTO _meta(key,value) VALUES('contextRecordingStartedAt',?) ON CONFLICT(key) DO NOTHING`, [at]);
  }
}

export function shouldIgnorePending(existing, detail) {
  return detail.status === "pending" && TERMINAL.has(existing?.status);
}

export { ContextQueryError, parseContextFilter } from "../analytics/contextQueries.mjs";

export async function getContextOverview(f = {}, options = {}) {
  if (f.view === "routing") throw new ContextQueryError("Routing history requires an exact session");
  const db = await getAdapter();
  const settings = await getSettings();
  return readContextAnalytics({ operation: "overview", filter: f, retainedDays: retentionDays(settings) },
    { ...options, file: DATA_FILE, driver: db.driver });
}

export async function getContextSession(id, f = {}, options = {}) {
  if (["projects", "interval-comparison"].includes(f.view)) throw new ContextQueryError("This projection uses the Context population endpoint");
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
  if (settings?.statsRetentionMode !== "window") return null;
  return Math.min(365, Math.max(1, Number(settings?.statsRetentionDays) || 45));
}
export function cleanupContext(db, now, days) {
  if (days === null) return;
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  db.transaction(() => {
    db.run(`DELETE FROM requestStats WHERE timestamp < ?`, [cutoff]);
    db.run(`DELETE FROM contextClientEvents WHERE occurredAt < ?`, [cutoff]);
    db.run(`DELETE FROM contextStructures WHERE NOT EXISTS (SELECT 1 FROM requestStats r WHERE r.id=contextStructures.requestId)`);
    db.run(`DELETE FROM contextStages WHERE NOT EXISTS (SELECT 1 FROM requestStats r WHERE r.id=contextStages.requestId)`);
    db.run(`DELETE FROM contextSessions WHERE lastSeenAt < ? AND NOT EXISTS (SELECT 1 FROM requestStats r WHERE r.contextSessionId=contextSessions.id)`, [cutoff]);
  });
}
