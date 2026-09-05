import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, MAX_RATE_LIMIT_COOLDOWN_MS } from "../config/errorConfig.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { redactSecretsText } from "./redact.js";
import { RID_HEADER } from "../../src/shared/observability/decide.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Statuses on which a retry can never succeed, so a `Retry-After` must never be
 * attached to one. Authentication (401), payment (402), policy (403) and a
 * missing resource (404) are the cases the caller must be told to STOP on; 400,
 * 413 and 422 are malformed requests that no amount of waiting repairs.
 *
 * This is the same set `ERROR_RULES` marks `pass: true` plus the FOUR that earn
 * a long account cooldown, and it is deliberately ONE list: a second hand-rolled
 * "is this retryable" test somewhere else is how a 401 starts advertising a
 * retry window that will never open.
 *
 * 404 was missing from this list while `errorConfig.js` gave it `COOLDOWN.long`
 * right beside 401/402/403, so an unknown model answered `404 Not Found` with a
 * `retry-after`. A model the account cannot reach is not created by waiting: the
 * caller has to change the request or the provider settings. Adding it here does
 * not change routing — `isDeterministicClientError(404)` was already true, so
 * rotation to a different credential still runs; what stops is the pointless
 * same-account replay of a request that failed for a non-transient reason.
 */
export const NEVER_RETRY_STATUSES = new Set([400, 401, 402, 403, 404, 413, 422]);

export function isRetryableStatus(statusCode) {
  return !NEVER_RETRY_STATUSES.has(Number(statusCode));
}

/**
 * Seconds a client should wait, from REAL state — a window reset instant (`at`)
 * or a measured wait budget (`ms`). Returns null when neither was supplied, so a
 * caller with nothing true to say emits no header rather than inventing one.
 *
 * The floor is 1 (overlay-spec §4): a reset already in the past, or a sub-second
 * budget, still has to name a delay, because `Retry-After: 0` reads as "retry
 * immediately" and turns a cooldown into a hot loop.
 */
export function retryAfterSeconds({ at = null, ms = null } = {}, now = Date.now()) {
  let remainingMs = null;
  if (at != null) {
    const atMs = at instanceof Date ? at.getTime() : (typeof at === "number" ? at : Date.parse(at));
    if (Number.isFinite(atMs)) remainingMs = atMs - now;
  }
  if (remainingMs === null && Number.isFinite(ms)) remainingMs = Number(ms);
  if (remainingMs === null) return null;
  return Math.max(Math.ceil(remainingMs / 1000), 1);
}

/**
 * Create error Response object (for non-streaming)
 *
 * `retryAfter` carries the real state behind the wait ({ at } = a quota window
 * reset instant, { ms } = a wait budget). `failurePhase` marks WHERE the request
 * died: "admission" means TokenProxy's own local gate refused it, which is not a
 * claim that the upstream provider is out of capacity — conflating the two is
 * what misleads a caller doing its own backoff math.
 *
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {{ retryAfter?: {at?: number|string|Date, ms?: number}, failurePhase?: string }} [options]
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, options = {}) {
  const body = buildErrorBody(statusCode, message);
  if (options.failurePhase) body.error.failure_phase = options.failurePhase;
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  if (options.rid) headers[RID_HEADER] = options.rid;
  // Gate first, compute second: a terminal status must not even carry a
  // computed wait, however real the number behind it is.
  if (options.retryAfter && isRetryableStatus(statusCode)) {
    const secs = retryAfterSeconds(options.retryAfter);
    if (secs !== null) headers["Retry-After"] = String(secs);
  }

  return new Response(JSON.stringify(body), { status: statusCode, headers });
}

export class CallerAbortError extends Error {
  constructor(reason) {
    super("Request aborted", { cause: reason });
    this.name = "CallerAbortError";
    this.code = "CLIENT_ABORTED";
    this.reason = reason;
  }
}

export function isCallerAbortError(error) {
  return error?.name === "CallerAbortError" || error?.code === "CLIENT_ABORTED";
}

export function createCallerAbortResult() {
  const status = 499;
  const error = "Request aborted";
  return {
    success: false,
    clientAborted: true,
    status,
    error,
    response: errorResponse(status, error),
  };
}

/**
 * Best-effort extraction of a precise rate-limit reset time from common
 * provider error shapes. GLM/Z.AI: "Your limit will reset at 2026-08-17 02:56:15"
 * (UTC). Also handles "retry in N seconds", "resets in Ns" and Retry-After.
 * Returns epoch ms or null.
 */
export function extractResetsAtMs(response, message) {
  if (!message) return null;
  const text = typeof message === "string" ? message : JSON.stringify(message);

  // GLM/Z.AI: "reset at 2026-08-17 02:56:15" (provider sends UTC without suffix)
  const resetAt = text.match(/reset at\s+(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/i);
  if (resetAt) {
    const ms = Date.parse(`${resetAt[1]}T${resetAt[2]}Z`);
    if (Number.isFinite(ms) && ms > Date.now()) return ms;
  }

  // "retry in 300 seconds" / "resets in 5 minutes" / "try again in 1 hour"
  const inTime = text.match(/(?:retry|try again|resets?)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?)/i);
  if (inTime) {
    const n = Number(inTime[1]);
    const unit = inTime[2][0].toLowerCase();
    const mult = unit === "s" ? 1000 : unit === "m" ? 60000 : 3600000;
    const ms = Date.now() + n * mult;
    if (Number.isFinite(ms)) return ms;
  }

  // Retry-After header (seconds or HTTP-date)
  const ra = response?.headers?.get?.("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs > 0) return Date.now() + secs * 1000;
    const dateMs = Date.parse(ra);
    if (Number.isFinite(dateMs) && dateMs > Date.now()) return dateMs;
  }

  return extractRateLimitWindowMs(response);
}

// The per-key request window an OpenAI-compatible upstream reports alongside a
// 429. Reading it benches the account for exactly as long as the provider says
// and no longer, so a burst rotates through the pool inside its real window
// instead of parking every key on the blind exponential backoff, which is how a
// short RPM limit took a whole healthy pool out for minutes (#3203). Nothing new
// holds this state: it rides the existing resetsAtMs path into the model lock.
//
// The request-specific header wins over the shared one, which on several
// providers reports the far longer token window.
const RATE_LIMIT_RESET_HEADERS = ["x-ratelimit-reset-requests", "x-ratelimit-reset"];

// A duration as OpenAI writes it: "20s", "1m30s", "6m0s", "500ms".
const RATE_LIMIT_DURATION = /^(?:\d+(?:ms|h|m|s))+$/;

function parseRateLimitDurationMs(text) {
  if (!RATE_LIMIT_DURATION.test(text)) return null;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)(ms|h|m|s)/g)) {
    total += Number(amount) * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60000 : 3600000);
  }
  return total > 0 ? total : null;
}

// Strict on purpose, for the reason the body parser above is: a value that
// cannot be read exactly is left to the classifier rather than guessed at, since
// a wrong guess here benches a healthy account. A bare integer is read as a
// window in seconds and only up to an hour -- past that it is far more likely to
// be an epoch stamp, and mistaking one for a duration would lock the account for
// the maximum.
const MAX_BARE_WINDOW_SECONDS = 3600;

function extractRateLimitWindowMs(response) {
  for (const name of RATE_LIMIT_RESET_HEADERS) {
    const raw = response?.headers?.get?.(name)?.trim();
    if (!raw) continue;

    const durationMs = parseRateLimitDurationMs(raw.toLowerCase());
    if (durationMs) return Date.now() + Math.min(durationMs, MAX_RATE_LIMIT_COOLDOWN_MS);

    const seconds = Number(raw);
    if (Number.isInteger(seconds) && seconds > 0 && seconds <= MAX_BARE_WINDOW_SECONDS) {
      return Date.now() + seconds * 1000;
    }

    const absoluteMs = parseFutureRfc3339(raw);
    if (absoluteMs) return Math.min(absoluteMs, Date.now() + MAX_RATE_LIMIT_COOLDOWN_MS);
  }
  return null;
}

const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

function parseFutureRfc3339(timestamp) {
  const parts = RFC3339_TIMESTAMP.exec(timestamp);
  if (!parts) return null;

  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) return null;

  const resetAtMs = Date.parse(timestamp);
  return Number.isFinite(resetAtMs) && resetAtMs > Date.now() ? resetAtMs : null;
}

// Parsed error bodies sometimes carry structured quota metadata instead of a
// human-readable retry message. Keep this deliberately narrow: only the
// established error envelope and unambiguous values become account cooldowns.
function extractBodyResetsAtMs(errorPayload) {
  const error = errorPayload?.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;

  const retryAfter = error.retryAfter;
  if (typeof retryAfter === "string") {
    const resetAtMs = parseFutureRfc3339(retryAfter);
    if (resetAtMs) return resetAtMs;
  }

  for (const delayMs of [error.retry_after_ms, error.retryAfterMs]) {
    if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs <= 0) continue;
    const resetAtMs = Date.now() + Math.min(delayMs, MAX_RATE_LIMIT_COOLDOWN_MS);
    if (Number.isFinite(resetAtMs) && resetAtMs > Date.now()) return resetAtMs;
  }

  return null;
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number, errorPayload?: object|null}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  let errorPayload = null;
  try {
    errorPayload = JSON.parse(bodyText);
  } catch {
    errorPayload = null;
  }

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const msg = redactSecretsText(parsed.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`);
        // Executor parse wins; fill resetsAtMs from generic patterns when absent
        const resetsAtMs = parsed.resetsAtMs ?? (
          response.status === 429
            ? extractResetsAtMs(response, msg) ?? extractBodyResetsAtMs(errorPayload)
            : null
        );
        return {
          statusCode: parsed.status || response.status,
          message: msg,
          resetsAtMs,
          errorPayload,
          ...(parsed.validation ? { validation: parsed.validation } : {}),
        };
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  let providerName = null;
  let invalidUrlEmpty = false;
  try {
    if (!errorPayload) throw new Error("not JSON");
    message = errorPayload.error?.message || errorPayload.message || errorPayload.error || bodyText;
    providerName = errorPayload.error?.metadata?.provider_name || null;
    // OpenRouter's internal "Stealth" upstream returns a malformed message like
    // "Invalid URL: " with the URL value left empty (the upstream's url field in
    // OpenRouter's routing table is unset). Detect the signature so we can
    // surface a friendlier hint instead of the opaque 502 + empty message.
    if (typeof message === "string") {
      const m = /^Invalid URL:\s*(.*)$/.exec(message);
      if (m) invalidUrlEmpty = m[1].trim() === "";
    }
  } catch {
    message = bodyText;
  }

  // The upstream body is untrusted free text that reaches client-visible error
  // strings and logs; a provider echoing an Authorization header would leak it.
  const messageStr = redactSecretsText(
    typeof message === "string" ? message : JSON.stringify(message),
  );
  let finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  // Annotate OpenRouter "Stealth" (or any upstream whose routing table has an
  // empty url field) with a hint explaining the failure mode. The OpenRouter
  // executor sets `provider.allow_fallbacks = true` on outbound requests; this
  // annotation gives the user a legible reason when no alternate upstream exists.
  if ((providerName || invalidUrlEmpty) && (response.status === HTTP_STATUS.BAD_GATEWAY || response.status === HTTP_STATUS.SERVER_ERROR)) {
    const hint = providerName
      ? `OpenRouter upstream "${providerName}" returned an invalid routing URL — its endpoint is misconfigured on OpenRouter's side`
      : "Upstream returned an invalid (empty) routing URL";
    finalMessage = `${finalMessage} — ${hint}. Try a different model, or set \`provider: { allow_fallbacks: true }\` to opt into OpenRouter's automatic upstream fallback.`;
  }

  // Generic reset-time extraction for rate limits (GLM "reset at ...", Retry-After, ...)
  if (response.status === 429) {
    const resetsAtMs = extractResetsAtMs(response, finalMessage) ?? extractBodyResetsAtMs(errorPayload);
    if (resetsAtMs) return { statusCode: 429, message: finalMessage, resetsAtMs, errorPayload };
  }

  return { statusCode: response.status, message: finalMessage, errorPayload };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number, failureMetadata?: object }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, failureMetadata, rid = null) {
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    ...(failureMetadata ? { failureMetadata } : {}),
    response: errorResponse(statusCode, message, rid ? { rid } : {})
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.rid) headers[RID_HEADER] = options.rid;
  // Same gate as errorResponse, same reason. `retryAfter` here is a real lock
  // expiry, but a 401 or 402 is terminal no matter how truthful the instant is.
  const mayAdvertiseWait = isRetryableStatus(statusCode);
  // The BODY is gated on the same fact as the header. Suffixing the human
  // "(reset after 1m 53s)" unconditionally made a terminal fault contradict its
  // own headers: a revoked credential came back with no Retry-After and prose
  // promising it would recover on a timer, so an operator read a dead key as a
  // transient outage. A caller that must stop is told nothing about waiting.
  const msg = mayAdvertiseWait && retryAfterHuman ? `${message} (${retryAfterHuman})` : message;
  if (mayAdvertiseWait) {
    const secs = retryAfterSeconds({ at: retryAfter });
    if (secs !== null) headers["Retry-After"] = String(secs);
  }
  return new Response(JSON.stringify({ error: { message: msg } }), { status: statusCode, headers });
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
