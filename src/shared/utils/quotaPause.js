/**
 * Pure per-account quota-pause helpers shared by the routing engine
 * (src/sse/services/quotaGuard.js) and the dashboard UI. No DB/server imports
 * so this is safe to use in client components — it only reads plain fields that
 * already live on the connection object (quotaPauseThresholds, lastQuotaSnapshot).
 *
 * Per-window model: `connection.quotaPauseThresholds` is a map of
 * { [windowKey]: number }. An account pauses for routing when ANY window that has
 * a configured threshold drops to/below it. Windows without a threshold (or
 * unlimited ones) never auto-pause. Paused state is derived, never stored, so an
 * account auto-recovers once the offending window rebounds (e.g. after resetAt).
 *
 * windowKey is the exact key from the provider's usage.quotas (e.g. "session (5h)",
 * "weekly (7d)", "session", "weekly", "chat"), as persisted in lastQuotaSnapshot.
 */

import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";

export function isQuotaEligible(connection) {
  if (!connection) return false;
  // #1322: "access_token" is an OAuth token pasted by hand rather than collected
  // through the redirect (src/app/api/oauth/codex/import-token/route.js). The
  // usage call needs only the token, and open-sse/services/provider.js already
  // maps this authType onto "oauth" for routing, so treating it as anything else
  // here left an install whose Codex account was imported that way reporting no
  // connected providers at all.
  const isOAuth =
    connection.authType === "oauth" || connection.authType === "access_token";
  const isApikeyAuth =
    connection.authType === "apikey" || connection.authType === "api_key";
  const isApikeyEligible =
    isApikeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider);
  return isOAuth || isApikeyEligible;
}

export function getWindowThresholds(connection) {
  const t = connection?.quotaPauseThresholds;
  return (t && typeof t === "object") ? t : {};
}

export function normalizeWindowThreshold(v) {
  const t = finiteQuotaNumber(v);
  if (t === null || t <= 0 || t > 100) return 0;
  return t;
}

function finiteQuotaNumber(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function windowPauseState(w, thresholds, now) {
  const threshold = normalizeWindowThreshold(thresholds[w.key]);
  const number = finiteQuotaNumber(w.remainingPercentage);
  const remainingPercentage = number !== null && number <= 100 ? number : null;
  const reset = typeof w.resetAt === "string" && w.resetAt ? Date.parse(w.resetAt) : NaN;
  const resetPassed = Number.isFinite(reset) ? reset <= now : null;
  return { key: w.key, remainingPercentage, threshold, configured: threshold > 0, resetPassed,
    paused: threshold > 0 && w.unlimited !== true && resetPassed !== true
      && remainingPercentage !== null && remainingPercentage <= threshold };
}

// Returns the window key that triggered a pause, or null when not paused.
// A window triggers when it has a configured threshold (>0), is not unlimited,
// and its known remaining % <= that threshold before a reported reset expires.
// An expired snapshot is retained as evidence, never rewritten as replenished.
export function getPausedWindow(connection, now = Date.now()) {
  if (!isQuotaEligible(connection)) return null;
  const thresholds = getWindowThresholds(connection);
  const windows = connection?.lastQuotaSnapshot?.windows;
  if (!windows || !Array.isArray(windows) || windows.length === 0) return null;
  let triggered = null;
  for (const w of windows) {
    if (!w || w.unlimited === true) continue;
    const state = windowPauseState(w, thresholds, now);
    if (state.paused) {
      // Pick the most-depleted triggering window for the badge.
      if (triggered === null || state.remainingPercentage < triggered.remainingPercentage) {
        triggered = { key: w.key, remainingPercentage: state.remainingPercentage, threshold: state.threshold };
      }
    }
  }
  return triggered;
}

export function isQuotaPaused(connection, now = Date.now()) {
  return getPausedWindow(connection, now) !== null;
}

export function getQuotaPauseInfo(connection, now = Date.now()) {
  const thresholds = getWindowThresholds(connection);
  const stored = connection?.lastQuotaSnapshot?.windows;
  const windows = Array.isArray(stored) ? stored.filter((w) => w && typeof w === "object") : [];
  const enabled = Object.values(thresholds).some((v) => normalizeWindowThreshold(v) > 0);
  const triggered = getPausedWindow(connection, now);
  const eligible = isQuotaEligible(connection);
  return {
    enabled,
    paused: triggered !== null,
    triggered,
    eligible,
    windows: windows.map((w) => {
      const state = windowPauseState(w, thresholds, now);
      return { ...state, paused: eligible && state.paused };
    }),
  };
}

// ─── Snapshot derivation from raw provider usage ──────────────────────────────
// getUsageForProvider returns { plan, quotas: { name: { used, total, remaining,
// remainingPercentage, resetAt, unlimited }, ... } }. Collapse that into a
// per-window gating snapshot (one entry per quota window).

function pct(used, total) {
  const t = finiteQuotaNumber(total);
  const u = finiteQuotaNumber(used);
  if (t === null || t <= 0 || u === null) return null;
  if (u === 0) return 100;
  if (u >= t) return 0;
  return Math.max(0, Math.min(100, Math.round(((t - u) / t) * 100)));
}

function quotaRemainingPercentage(q) {
  const remaining = finiteQuotaNumber(q?.remainingPercentage);
  if (remaining !== null && remaining <= 100) {
    return Math.round(remaining);
  }
  // Prefer used/total over a bare `remaining` (absolute count for some providers)
  // to avoid misreading it as a percentage.
  return pct(q?.used, q?.total);
}

/**
 * Derive a per-window gating snapshot from raw provider usage.
 * @param {string} provider
 * @param {Object} rawUsage - result of getUsageForProvider
 * @returns {{windows:Array<{key:string, remainingPercentage:number, resetAt:?string, unlimited:boolean}>, fetchedAt:string}|null}
 *   null when there's no usable quota data (caller should fail-open).
 */
export function deriveQuotaSnapshot(provider, rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object" || rawUsage.message || rawUsage.error) return null;
  const quotas = rawUsage.quotas;
  if (!quotas || typeof quotas !== "object") return null;

  const entries = Array.isArray(quotas) ? quotas : Object.entries(quotas);
  if (entries.length === 0) return null;

  const now = new Date().toISOString();
  const windows = [];

  for (const entry of entries) {
    // Array form: [key, quota]; object form: we already have [key, quota].
    const [key, q] = Array.isArray(entry) ? entry : [entry?.name, entry];
    if (!q || typeof q !== "object") continue;
    const remainingPercentage = quotaRemainingPercentage(q);
    if (remainingPercentage == null) continue;
    let resetAt = null;
    if (q.resetAt) {
      const t = new Date(q.resetAt).getTime();
      if (Number.isFinite(t)) resetAt = new Date(t).toISOString();
    }
    windows.push({
      key: String(key ?? q.name ?? "unknown"),
      remainingPercentage,
      resetAt,
      unlimited: q.unlimited === true,
    });
  }

  if (windows.length === 0) return null;
  return { windows, fetchedAt: now };
}
