import {
  ERROR_RULES,
  BACKOFF_CONFIG,
  TRANSIENT_COOLDOWN_MS,
  LONG_CONTEXT_DEPLETION_COOLDOWN_MS,
  isLongContextDepletion,
} from "../config/errorConfig.js";

// Envoy "request buffer limit exceeded" (HTTP 507): upstream could not buffer the
// body for a retry — the request must be replayed on the same account, not locked.
const REQUEST_REPLAY_BUFFER_ERROR = "exceeded request buffer limit while retrying upstream";

export function isRequestReplayBufferError(status, errorText) {
  if (Number(status) !== 507) return false;
  const message = typeof errorText === "string" ? errorText : JSON.stringify(errorText || "");
  return message.toLowerCase().includes(REQUEST_REPLAY_BUFFER_ERROR);
}

// Failures whose cause is shared by every credential in the pool: the provider's
// own model capacity, or this host's network path to it. Rotating once is still
// worth a try, but writing a persistent per-key model lock for one of these is
// how an 8-key pool ends up reporting 0/8 available for a condition no key could
// have fixed (#2951). Matched on structured codes and on our own thrown text
// only -- a bare "capacity" or "timeout" is generic enough to swallow a real
// per-account failure, and errorConfig.js already routes those to backoff.
const SHARED_PATH_FAILURE_MARKERS = [
  "model_capacity_exhausted",                 // NVIDIA NIM: provider/model-wide
  "[proxyfetch] proxy required but failed",   // our own strictProxy refusal
  "econnrefused",
  "enotfound",
  "eai_again",
  "etimedout",
  "und_err_connect_timeout",
  // OUR OWN response-header deadline (responseHeaderTimeout.js). It fires on
  // this host's path to the provider and on how long that provider takes to
  // send headers, never on which credential asked, so every key in the pool
  // hits it identically. Undici's UND_ERR_CONNECT_TIMEOUT above is a DIFFERENT
  // error -- it never fires once a socket is established -- so matching that
  // code alone left our own timeout falling through to the 5s transient
  // cooldown, writing LOCK.applied against a healthy account and draining the
  // pool one key per attempt. Matched on the message because
  // formatProviderError renders `[502]: <message>` and drops error.code.
  "upstream response headers exceeded",
];

/** True when the failure belongs to the provider or the network path, not the key. */
export function isSharedPathFailure(errorText) {
  if (!errorText) return false;
  const message = (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase();
  return SHARED_PATH_FAILURE_MARKERS.some((marker) => message.includes(marker));
}

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 2s, Level 2: 4s, Level 3: 8s... capped at 5 minutes
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

// 4xx statuses that describe TIMING rather than a malformed request, so a
// retry (on this key or the next) can still succeed. Everything else in the
// 4xx range is deterministic: the same request gets the same answer.
export const RETRYABLE_CLIENT_ERROR_STATUSES = new Set([402, 408, 409, 425, 429]);

/**
 * True when a 4xx is the caller's request being deterministically wrong, so no
 * account rotation and no model cooldown can change the outcome.
 * @param {number} status
 * @returns {boolean}
 */
export function isDeterministicClientError(status) {
  const code = Number(status);
  return Number.isFinite(code)
    && code >= 400
    && code < 500
    && !RETRYABLE_CLIENT_ERROR_STATUSES.has(code);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0) {
  if (isRequestReplayBufferError(status, errorText)) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  // Rotate (and let a combo advance), but leave no lock and no backoff level
  // behind: the next key would hit the same provider capacity or the same dead
  // proxy, and the pool would drain one key per attempt.
  if (isSharedPathFailure(errorText)) {
    return { shouldFallback: true, cooldownMs: 0 };
  }

  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  // A rate limit is a fact about the status, and no wording in the body changes
  // it. The text rules below run first and match by substring, several of them
  // marked pass, so a 429 whose message happened to carry a phrase like
  // "invalid_request_error" was reclassified as a client error: the account was
  // not rotated and, worse, a combo STOPPED on that member instead of trying
  // the rest (#2556). The combo layer already carries a partial workaround for
  // the same collision on model_not_found, which is the tell that this ordering
  // bites in practice. Decided before the loop so no body text can reach it.
  if (status === 429) {
    // A long-context credit refusal is depletion of this (account, model), not
    // a window: the 2s backoff below would replay the same account up to the
    // retry limit and relock it almost immediately. A fixed long lock rotates
    // at once and keeps the account out of selection for the model.
    if (isLongContextDepletion(errorText)) {
      return { shouldFallback: true, cooldownMs: LONG_CONTEXT_DEPLETION_COOLDOWN_MS };
    }
    const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
    return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
  }

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      // pass: true = client-side error, do not lock the account
      if (rule.pass) return { shouldFallback: false, cooldownMs: 0 };
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      // pass: true = client-side error, do not lock the account
      if (rule.pass) return { shouldFallback: false, cooldownMs: 0 };
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  // A 4xx no rule above claimed is the caller's own request being wrong, and
  // replaying it verbatim on the next key produces the identical rejection.
  // Falling through to the transient cooldown quarantined a perfectly healthy
  // model for 5 seconds on a 405, a 415 or a 451 while the client retried, so
  // an unsupported method or an unacceptable media type drained the pool one
  // key at a time. The exceptions are the four 4xx statuses that are genuinely
  // about timing rather than about the request: 408 timeout, 409 contention,
  // 425 too-early, and 429, which is decided above.
  //
  // The statuses ERROR_RULES already names (400, 401, 402, 403, 404, 413, 422)
  // never reach here, so this closes the gap without reclassifying a credential
  // fact: a 401 or 403 is a statement about the KEY and still rotates.
  if (isDeterministicClientError(status)) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Prefix for model-specific failure metadata on connection records */
export const MODEL_FAILURE_PREFIX = "modelFailure_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/** Build the flat field key for failure metadata paired with a model lock. */
export function getModelFailureKey(model) {
  return model ? `${MODEL_FAILURE_PREFIX}${model}` : `${MODEL_FAILURE_PREFIX}__all`;
}

function isActiveLockUntil(until, now = Date.now()) {
  const expiry = new Date(until).getTime();
  return Number.isFinite(expiry) && expiry > now;
}

/**
 * Antigravity is the one provider whose quota buckets are keyed by MODEL instead
 * of by time window, so a quota read already names the exact account/model pair
 * that is out. `open-sse/services/usage/google.js` writes `quotas[modelKey]`
 * straight from the upstream `fetchAvailableModels` payload, and those keys are
 * the registry model ids (`open-sse/providers/registry/antigravity.js`
 * `models[].id`) -- the same string routing already carries as `model`.
 * `deriveQuotaSnapshot` copies each key verbatim onto
 * `lastQuotaSnapshot.windows[].key`, so the exhausted pair is readable off the
 * connection with no live call and no key left to guess.
 */
const MODEL_KEYED_QUOTA_PROVIDERS = new Set(["antigravity"]);

/**
 * The provider's own statement that this exact model is out until a stated time.
 * Deliberately narrow: exactly zero remaining, not unlimited, and a reset still
 * ahead. A model whose upstream entry carries no `quotaInfo` lands as 0% with a
 * null resetAt (google.js reads `remainingFraction || 0`, and parseResetTime
 * returns null for a missing resetTime), and that shape is NOT read as
 * exhausted: skipping there would strand a healthy account, which costs more
 * than the one upstream round trip this saves. Reads persisted state only, so a
 * missing, malformed or stale snapshot fails open.
 * @returns {{key: string, until: string}|null}
 */
export function getExhaustedQuotaWindow(connection, model, now = Date.now()) {
  if (!connection || !model) return null;
  if (!MODEL_KEYED_QUOTA_PROVIDERS.has(connection.provider)) return null;
  const windows = connection.lastQuotaSnapshot?.windows;
  if (!Array.isArray(windows)) return null;
  const quotaWindow = windows.find((entry) => entry?.key === model);
  if (!quotaWindow || quotaWindow.unlimited === true) return null;
  const remaining = quotaWindow.remainingPercentage;
  // Unknown values must not become measured depletion through Number(null),
  // Number('') or Number(false). Providers may supply finite numeric strings.
  if (typeof remaining !== 'number' && (typeof remaining !== 'string' || !remaining.trim())) return null;
  if (!Number.isFinite(Number(remaining)) || Number(remaining) !== 0) return null;
  const resetAt = new Date(quotaWindow.resetAt).getTime();
  if (!Number.isFinite(resetAt) || resetAt <= now) return null;
  return { key: quotaWindow.key, until: new Date(resetAt).toISOString() };
}

/**
 * Check whether a connection is unavailable for this model right now, either
 * under a timed lock or because the provider itself already reported that
 * model's quota exhausted (see `getExhaustedQuotaWindow`).
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model, now = Date.now()) {
  // Each key is judged on its own expiry. `a || b` picked the per-model key on the
  // truthiness of the string, so a stale one hid a still-active account-wide lock:
  // the connection then read as free for exactly the model that had just failed,
  // while still reading as locked for every other model. Nothing clears the stale
  // key either -- the lazy cleanup runs only after a successful request, and an
  // account under an `__all` lock never gets one. Same rule the sibling
  // `getEarliestModelLockUntil` already applies when it skips expired entries.
  return isActiveLockUntil(connection[getModelLockKey(model)], now)
    || isActiveLockUntil(connection[MODEL_LOCK_ALL], now)
    || getExhaustedQuotaWindow(connection, model, now) !== null;
}

/**
 * Return the active lock and only its matching metadata. Account-wide state
 * has precedence. Legacy locks are intentionally non-diagnostic. With no lock
 * standing, an exhausted model quota answers with the upstream's own reset time,
 * so all-exhausted selection still reports retry timing rather than a bare
 * "no accounts available".
 */
export function getActiveModelFailure(connection, model, now = Date.now()) {
  if (!connection) return null;
  const models = model ? [null, model] : [null];
  for (const candidate of models) {
    const lockKey = getModelLockKey(candidate);
    const until = connection[lockKey];
    if (!isActiveLockUntil(until, now)) continue;
    const failureKey = getModelFailureKey(candidate);
    const metadata = connection[failureKey];
    const matchingMetadata = metadata && typeof metadata === "object" && metadata.until === until
      ? metadata
      : null;
    return {
      lockKey,
      failureKey,
      until,
      status: matchingMetadata?.status ?? null,
      message: matchingMetadata?.message ?? null,
      resetsAt: matchingMetadata?.resetsAt ?? null,
      clientErrorStatus: matchingMetadata?.clientErrorStatus ?? null,
      unknownModelVerified: matchingMetadata?.unknownModelVerified === true,
    };
  }

  const exhausted = getExhaustedQuotaWindow(connection, model, now);
  if (exhausted) {
    return {
      lockKey: getModelLockKey(model),
      failureKey: getModelFailureKey(model),
      until: exhausted.until,
      status: 429,
      message: `Quota exhausted for ${exhausted.key}`,
      resetsAt: exhausted.until,
      clientErrorStatus: null,
      unknownModelVerified: false,
    };
  }
  return null;
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection, model) {
  if (!connection) return null;
  if (arguments.length > 1) return getActiveModelFailure(connection, model)?.until || null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  return buildModelLockUpdateAt(model, new Date(Date.now() + cooldownMs).toISOString());
}

/** Build update object to set a model lock to an already selected expiry. */
export function buildModelLockUpdateAt(model, until) {
  return { [getModelLockKey(model)]: until };
}

/** Build update object for metadata paired atomically with one model lock. */
export function buildModelFailureUpdate(model, {
  status = null,
  message = null,
  until,
  resetsAt = null,
  clientErrorStatus = null,
  unknownModelVerified = false,
} = {}) {
  return {
    [getModelFailureKey(model)]: {
      status,
      message,
      until,
      resetsAt,
      clientErrorStatus,
      unknownModelVerified: unknownModelVerified === true,
    },
  };
}

/** Build update object that clears one exact lock and metadata pair. */
export function buildClearModelFailurePairUpdate(model) {
  return {
    [getModelLockKey(model)]: null,
    [getModelFailureKey(model)]: null,
  };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
    if (key.startsWith(MODEL_FAILURE_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
