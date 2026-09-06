/**
 * ABI projections: internal records to the wire shapes in
 * docs/reconciliation/admin-abi.json.
 *
 * EVERY FIELD IS PICKED BY NAME. No function here spreads an input into its
 * output, for the reason src/shared/utils/switchReceipt.js gives and for one
 * more specific to this layer: connectionsRepo.rowToConn spreads the DECRYPTED
 * credential blob into every connection object it returns, so a connection in
 * memory carries accessToken, refreshToken and apiKey beside its id. A
 * spread-then-redact projection would disclose the next secret field anyone
 * adds upstream. A pick cannot.
 */

import { isConnectionDegraded } from "@/lib/db/repos/connectionsRepo.js";
import { classifyWindow, windowHorizonMs } from "@/shared/utils/quotaRanking.js";

// An old measurement remains measured. Its age is a separate axis. The source
// writer uses unknown for synthetic percentage-scale rows, so do not infer an
// absolute quota unit from a denominator of 100.
const CONFIDENCE = { fresh: "measured", measured: "measured", stale: "measured", estimated: "estimated" };
const FRESHNESS_MAX_AGE_MS = 15 * 60_000; // same evidence-age policy as quotaWindowBridge

function num(value) {
  if (value == null || typeof value === "boolean" || !["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isoOrNull(value) {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function quotaFreshness(observedAt, resetAt, now = Date.now()) {
  const observed = isoOrNull(observedAt);
  const reset = isoOrNull(resetAt);
  const ageMs = observed ? now - Date.parse(observed) : null;
  const resetPassed = reset ? Date.parse(reset) <= now : null;
  const state = ageMs === null || ageMs < 0 ? "unknown"
    : ageMs > FRESHNESS_MAX_AGE_MS || resetPassed ? "stale" : "fresh";
  return { state, ageMs: ageMs !== null && ageMs >= 0 ? ageMs : null, maxAgeMs: FRESHNESS_MAX_AGE_MS,
    basis: "stored-observation-age-and-deadline" };
}

export function toWindowRecord(row, { now = Date.now(), source = "stored-quota-evidence" } = {}) {
  const scope = String(row?.scope ?? "");
  const resetAt = isoOrNull(row?.resetAt);
  const observedAt = isoOrNull(row?.observedAt);
  // Bare monthly/yearly names do not specify an exact period. The ranker has
  // ordering fallbacks for those names; a passive view must not call them facts.
  const horizon = /\(\s*\d+(?:\.\d+)?\s*(?:m|min|h|d|w)\s*\)/i.test(scope) ? windowHorizonMs(scope) : null;
  const durationMs = Number.isFinite(horizon) && horizon >= 60_000 ? horizon : null;
  const confidence = CONFIDENCE[row?.confidence] ?? "unknown";
  return {
    scope,
    remaining: num(row?.remaining),
    limit: num(row?.limit),
    resetAt,
    observedAt,
    confidence,
    source,
    unit: null,
    scale: confidence === "measured" ? "absolute" : "unknown",
    scaleNote: confidence === "measured" ? "Provider units were not retained."
      : "The stored scale may be synthetic; a denominator of 100 does not establish absolute entitlement.",
    durationMs,
    durationSource: durationMs === null ? null : "scope-label",
    windowType: classifyWindow(scope) ?? "unknown",
    windowTypeSource: "scope-label",
    resetSemantics: resetAt ? "stored-deadline" : "unknown",
    resetState: resetAt ? (Date.parse(resetAt) <= now ? "passed" : "upcoming") : "unknown",
    freshness: quotaFreshness(observedAt, resetAt, now),
  };
}

export function toWindowRecords(rows) {
  return Array.isArray(rows) ? rows.map((row) => toWindowRecord(row)) : [];
}

/**
 * Operator-visible failure text for a connection.
 *
 * Truncated and stripped of anything that looks like a bearer credential.
 * lastError is written from upstream responses by testUtils and the SSE layer,
 * and an upstream is free to echo the Authorization header it rejected back in
 * its error body. Length alone would not save us; the pattern strip is what
 * does.
 */
const CREDENTIAL_SHAPED = /\b(?:sk|pk|api|key|token|bearer|secret)[-_a-z0-9]*[-_ :=]+[A-Za-z0-9._~+/-]{8,}/gi;

export function redactError(value) {
  if (typeof value !== "string" || !value) return null;
  return value.replace(CREDENTIAL_SHAPED, "[redacted]").slice(0, 300);
}

/**
 * Connection status, in the ABI's vocabulary.
 *
 * Order matters and encodes precedence: draining is an operator's explicit
 * decision and outranks every observed condition, and an inactive connection
 * is unqualified regardless of how healthy its last probe looked.
 */
export function connectionStatus(conn, { isDraining, now = Date.now() } = {}) {
  if (isDraining) return "drained";
  if (!conn?.isActive) return "unqualified";
  const until = conn.rateLimitedUntil ? Date.parse(conn.rateLimitedUntil) : NaN;
  if (Number.isFinite(until) && until > now) return "cooldown";
  if (isConnectionDegraded(conn, now)) return "degraded";
  // No probe has ever run, so nothing has established the connection works.
  if (!conn.testStatus) return "unqualified";
  return "healthy";
}

export function toConnection(conn, { isDraining = false, now = Date.now() } = {}) {
  return {
    connectionId: conn.id,
    provider: conn.provider,
    displayName: typeof conn.name === "string" && conn.name ? conn.name : null,
    status: connectionStatus(conn, { isDraining, now }),
    isActive: Boolean(conn.isActive),
    isDraining: Boolean(isDraining),
    lastQualifiedAt: isoOrNull(conn.lastTestedAt),
    lastError: redactError(conn.lastError),
  };
}

export function toQuotaSnapshot(conn, windows, { now = Date.now() } = {}) {
  const stored = Array.isArray(windows) ? windows : [];
  const percentages = Array.isArray(conn.lastQuotaSnapshot?.windows) ? conn.lastQuotaSnapshot.windows : [];
  const percentageObservedAt = isoOrNull(conn.lastQuotaSnapshot?.fetchedAt);
  return {
    connectionId: conn.id, provider: conn.provider, asOf: new Date(now).toISOString(),
    mode: "passive", historyAvailable: false,
    windows: stored.map((row) => {
      const out = toWindowRecord(row, { now, source: "quotaWindows" });
      const snapshot = percentages.find((entry) => entry?.key === row.scope);
      const value = num(snapshot?.remainingPercentage);
      out.percentage = value !== null && value <= 100 ? {
        value, unit: "percent", source: "connection.lastQuotaSnapshot", measurement: "derived-percentage",
        observedAt: percentageObservedAt, resetAt: isoOrNull(snapshot.resetAt),
        freshness: quotaFreshness(percentageObservedAt, snapshot.resetAt, now),
      } : null;
      return out;
    }),
  };
}

// accountSwitches rows carry the trigger vocabulary the scheduler writes
// (first-pin, repin, cohort-degraded); the ABI's enum is closed and different.
// An unmapped trigger becomes "manual" rather than passing through, because a
// value outside the enum is a contract violation and "manual" is the reading
// that claims the least.
const TRIGGER = {
  exhausted: "exhausted",
  reset: "reset",
  drain: "drain",
  model_failure: "model_failure",
  "model-failure": "model_failure",
  "cohort-degraded": "model_failure",
  manual: "manual",
  "first-pin": "manual",
  repin: "reset",
};

export function toSwitchReceipt(row) {
  return {
    receiptId: row.id,
    timestamp: isoOrNull(row.switchedAt) ?? new Date(0).toISOString(),
    trigger: TRIGGER[row.trigger] ?? "manual",
    model: String(row.model ?? ""),
    // Already a one-way hash where the scheduler wrote it. Never re-derived
    // here: this layer must not be the place a raw session id could enter.
    sessionHash: String(row.sessionHash ?? ""),
    oldConnectionId: row.fromConnectionId ?? null,
    newConnectionId: row.toConnectionId,
    windows: {
      old: Array.isArray(row.windows?.old) ? toWindowRecords(row.windows.old) : null,
      // The scheduler persists the destination account's windows as a bare
      // array; the ABI splits them into old and new. A bare array is the new
      // account's evidence, which is the account the receipt is about.
      new: Array.isArray(row.windows) ? toWindowRecords(row.windows) : toWindowRecords(row.windows?.new),
    },
  };
}
