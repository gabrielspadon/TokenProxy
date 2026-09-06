import { createHash, randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";

import { DATA_FILE } from "../paths.js";
import { readContextAnalytics } from "../analytics/client.js";
import { parseQuotaHistoryQuery } from "../analytics/quotaHistoryQueries.mjs";
export { parseQuotaHistoryQuery, QUOTA_HISTORY_DEFAULT_DAYS, QUOTA_HISTORY_MAX_PAGE } from "../analytics/quotaHistoryQueries.mjs";
const text = (v) => typeof v === "string" && v.length <= 512 && v.trim() ? v : null;
const number = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
const date = (v) => typeof v === "string" && v.trim() && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

// Projection is a whitelist. Credentials, provider blobs and exception messages
// cannot reach retained telemetry through this boundary. Unknown scale stays
// unknown: several adapters synthesize a 100 denominator for percentage quotas.
export function quotaObservationsFromUsage(connection, usage, { capturedAt = new Date().toISOString() } = {}) {
  if (!connection?.id || !usage?.quotas || usage.error || usage.message || usage.expired) return [];
  const entries = Array.isArray(usage.quotas)
    ? usage.quotas.map((q) => Array.isArray(q) ? q : [q?.name, q]) : Object.entries(usage.quotas);
  const receipt = usage.quotaObservation;
  return entries.flatMap(([scope, q]) => {
    if (!text(scope) || !q || typeof q !== "object") return [];
    const unit = text(q.unit);
    const remaining = unit ? number(q.remaining) : null;
    const limit = unit ? number(q.total) : null;
    const reportedPercent = number(q.remainingPercentage);
    const percentage = reportedPercent !== null && reportedPercent >= 0 && reportedPercent <= 100 ? reportedPercent : null;
    const row = {
      connectionId: connection.id, provider: text(connection.provider), scope,
      source: "provider-usage", observationKind: "observed",
      resourceType: text(q.resourceType) ?? (q.wallet === true ? "monetary-budget" : null),
      unit, remaining, limit, percentage, resetAt: date(q.resetAt),
      observedAt: date(receipt?.observedAt) ?? date(usage.observedAt),
      confidence: unit && (remaining !== null || limit !== null) ? "reported" : percentage !== null ? "reported-percentage" : "unknown",
      windowDurationMs: Number.isSafeInteger(q.windowDurationMs) && q.windowDurationMs > 0 ? q.windowDurationMs : null,
      windowType: text(q.windowType),
    };
    // Payload participates even when source timestamps or IDs collide. Capture
    // time does not: another reader of this observation is not another sample.
    return [{ id: digest([text(receipt?.id), row]), ...row, capturedAt: date(capturedAt) ?? new Date().toISOString() }];
  });
}

export async function captureQuotaUsage(connection, usage, options) {
  const rows = quotaObservationsFromUsage(connection, usage, options);
  if (!rows.length) return 0;
  const db = await getAdapter();
  return db.transaction(() => {
    let inserted = 0;
    for (const row of rows) {
      const { changes } = db.run(`INSERT OR IGNORE INTO quotaObservations
        (id,connectionId,provider,scope,source,observationKind,resourceType,unit,remaining,"limit",percentage,resetAt,observedAt,capturedAt,confidence,windowDurationMs,windowType)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id,row.connectionId,row.provider,row.scope,row.source,row.observationKind,row.resourceType,row.unit,row.remaining,row.limit,row.percentage,row.resetAt,row.observedAt,row.capturedAt,row.confidence,row.windowDurationMs,row.windowType]);
      inserted += changes;
    }
    return inserted;
  });
}

// Evidence retention must not turn a successful provider read into a failure or
// trigger another provider call. Failure is visible without logging raw payloads.
export async function retainQuotaUsage(connection, usage) {
  try { return await captureQuotaUsage(connection, usage); }
  catch { console.warn("[QuotaHistory] observation_write_failed"); return null; }
}

const EVENT_TYPES = new Set(["scheduled", "started", "usage-read", "failed", "warm-response", "warm-recorded", "clock-running", "still-cold", "completed"]);
const EVENT_CODES = new Set(["reset-not-before", "probe-not-before", "required_proxy_unavailable", "credential_refresh_failed", "usage_unreadable", "usage_exception", "warm_rejected", "warm_exception", "state_write_failed", "check_exception", "observed", "blocking_quota_exhausted", "every-window-running", "warm-policy-held", "scheduler-recorded", "response-status-unknown", "verified"]);

export async function recordQuotaCheckEvent(event) {
  if (!text(event?.connectionId) || !EVENT_TYPES.has(event.eventType)) throw new TypeError("Invalid quota check event");
  if (event.code != null && !EVENT_CODES.has(event.code) && !/^http_[1-5]\d{2}$/.test(event.code)) throw new TypeError("Invalid quota check code");
  const row = {
    checkId: text(event.checkId) ?? randomUUID(), connectionId: event.connectionId,
    provider: text(event.provider), scope: text(event.scope), source: "quota-auto-ping",
    eventType: event.eventType, scheduledFor: date(event.scheduledFor), resetAt: date(event.resetAt),
    observedAt: date(event.observedAt), capturedAt: date(event.capturedAt) ?? new Date().toISOString(), code: text(event.code),
  };
  const id = event.eventType === "scheduled"
    ? digest([row.connectionId,row.provider,row.scope,row.eventType,row.scheduledFor,row.resetAt,row.code])
    : row.eventType === "warm-response" ? randomUUID() : digest([row.checkId,row.scope,row.eventType,row.code]);
  const db = await getAdapter();
  return db.run(`INSERT OR IGNORE INTO quotaCheckEvents
    (id,checkId,connectionId,provider,scope,source,eventType,scheduledFor,resetAt,observedAt,capturedAt,code)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id,row.checkId,row.connectionId,row.provider,row.scope,row.source,row.eventType,row.scheduledFor,row.resetAt,row.observedAt,row.capturedAt,row.code]).changes;
}

export async function getQuotaHistory(params = new URLSearchParams(), options = {}) {
  const query = parseQuotaHistoryQuery(params, options);
  const writer = await getAdapter();
  return readContextAnalytics({ operation: "quota-history", ...query },
    { file: DATA_FILE, driver: writer.driver, signal: options.signal });
}

// Totals cover all retained source evidence and run outside the request thread.
export async function getQuotaHistorySummary({ signal } = {}) {
  const writer = await getAdapter();
  return readContextAnalytics({ operation: "quota-history-summary" },
    { file: DATA_FILE, driver: writer.driver, signal });
}
