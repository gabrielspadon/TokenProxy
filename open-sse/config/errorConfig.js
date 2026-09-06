// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  413: { type: "invalid_request_error", code: "context_length_exceeded" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" },
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  413: "Context length exceeded",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout",
};

// Exponential backoff config for rate limits. The defaults preserve the
// historical 2s -> 5m schedule when no environment variables are supplied.
const DEFAULT_BACKOFF_CONFIG = Object.freeze({
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
});

function parsePositiveInteger(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveBackoffConfig(env = process.env) {
  const base = parsePositiveInteger(env.BACKOFF_BASE_MS);
  const max = parsePositiveInteger(env.BACKOFF_MAX_MS);
  const maxLevel = parsePositiveInteger(env.BACKOFF_MAX_LEVEL);

  const config = {
    base: base ?? DEFAULT_BACKOFF_CONFIG.base,
    max: max ?? DEFAULT_BACKOFF_CONFIG.max,
    maxLevel: maxLevel ?? DEFAULT_BACKOFF_CONFIG.maxLevel
  };

  // Each knob can be tuned independently, but a cap below the initial delay
  // is contradictory and would make the schedule hard to reason about.
  if (config.max < config.base) return DEFAULT_BACKOFF_CONFIG;

  return Object.freeze(config);
}

export const BACKOFF_CONFIG = resolveBackoffConfig();

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 5 * 1000;

// Cooldown after a provider returns HTTP 200 with no usable content (null/empty
// message, no tool_calls, no reasoning). Upstream reports success but produced
// nothing — lock the model on this account for a few minutes so the combo/account
// fallback loop skips straight to the next candidate instead of retrying a backend
// that just failed silently, then automatically retries it once the lock expires.
export const EMPTY_CONTENT_COOLDOWN_MS = 7 * 60 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// Ceiling for a provider whose real rate-limit window is roughly a minute. A
// free pool answers a burst with an hours-long Retry-After, or earns the blind
// backoff below, and honoring either verbatim benches every key at once for far
// longer than the window it is actually enforcing -- the router then has nothing
// left to route to and the client sees a 500 (#2895). The provider's number is
// still respected when it is SHORTER than this; only the overlong ones are cut.
export const FREE_TIER_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

// Claude Code (2.1.263) carries a session-global latch: a 429 body containing
// either phrase sets `longContext1mCreditsBlocked` and clamps EVERY later
// request of that session to 200k, even on an account whose window is 1m. One
// pooled account lacking long-context credits therefore poisons the client
// session if its body is relayed. Two consequences, both keyed on this list:
// checkFallbackError treats the 429 as (account, model) depletion and rotates
// without a same-account retry, and buildErrorBody/unavailableResponse rewrite
// the phrase out of any client-bound body. Matched case-insensitively.
export const LONG_CONTEXT_DEPLETION_MARKERS = Object.freeze([
  "extra usage is required for long context",
  "usage credits are required for long context",
]);

// Long enough to clear SAME_ACCOUNT_RETRY_MAX_COOLDOWN_MS (chat.js) so the
// loop moves to the next account instead of replaying on the depleted one.
export const LONG_CONTEXT_DEPLETION_COOLDOWN_MS = COOLDOWN.long;

// Client-facing substitute. Names the depletion without either latch phrase.
export const LONG_CONTEXT_DEPLETION_MESSAGE =
  "upstream account has no remaining quota for this request size";

const LONG_CONTEXT_DEPLETION_RE = new RegExp(
  LONG_CONTEXT_DEPLETION_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "gi",
);

/** True when an upstream error body carries a long-context credit refusal. */
export function isLongContextDepletion(errorText) {
  if (!errorText) return false;
  const text = typeof errorText === "string" ? errorText : JSON.stringify(errorText);
  LONG_CONTEXT_DEPLETION_RE.lastIndex = 0;
  return typeof text === "string" && LONG_CONTEXT_DEPLETION_RE.test(text);
}

/** Replace every latch phrase in a client-bound message; other input passes through untouched. */
export function scrubLongContextDepletion(message) {
  if (typeof message !== "string") return message;
  return message.replace(LONG_CONTEXT_DEPLETION_RE, LONG_CONTEXT_DEPLETION_MESSAGE);
}

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff?, pass? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 *   - pass: true = client-side error, do NOT lock the account (shouldFallback: false)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { text: "no credentials", cooldownMs: COOLDOWN.long },
  { text: "request not allowed", cooldownMs: COOLDOWN.short },
  // Client-side request errors: request is invalid / malformed — no account can fix this, don't lock
  { text: "invalid_request_error", pass: true },
  { text: "invalid_request", pass: true },
  { text: "improperly formed request", pass: true },
  { text: "invalid model id", pass: true },
  // A model the provider does not serve is a user-side name, usually a typo or a
  // vendor/model form the upstream spells differently. Locking the account fixes
  // nothing and blocks every OTHER model on it, which is the hour-long lockout
  // reported in #2032. Kept model-specific rather than matching a bare "does not
  // exist", which is generic enough to catch an unrelated body.
  { text: "model_not_found", pass: true },
  { text: "model not found", pass: true },
  { text: "unknown model", pass: true },
  { text: "no such model", pass: true },
  { text: "bad request", pass: true },
  { text: "unsupported parameter", pass: true },
  { text: "unsupported_parameter", pass: true },
  { text: "invalid parameter", pass: true },
  { text: "invalid_parameter", pass: true },
  { text: "maximum context length", pass: true },
  { text: "context_length_exceeded", pass: true },
  { text: "prompt is too long", pass: true },
  { text: "exceeds the limit", pass: true },
  // A policy rejection is a fact about the REQUEST, not the account. Rotating
  // burns every key in the pool on a request that no key will accept, and the
  // caller is told to retry something that can only fail again. The status-based
  // 403 rule below still rotates on the quota-exhausted reading of 403 (#2429's
  // key_retry_on list), because text rules run first and only these words reach
  // here.
  { text: "content policy", pass: true },
  { text: "content_policy", pass: true },
  { text: "policy violation", pass: true },
  { text: "prohibited_content", pass: true },
  { text: "blocked by safety", pass: true },
  { text: "safety_violation", pass: true },
  { text: "rate limit", backoff: true },
  { text: "too many requests", backoff: true },
  { text: "quota exceeded", backoff: true },
  { text: "capacity", backoff: true },
  { text: "overloaded", backoff: true },
  // AiHubMix free-tier abuse gate ("Sorry, to prevent abuse of free resources,
  // accounts that have not been recharged can only try 10 times") matches this
  // rule, so it already rotates the account. See #3602.
  { text: "to prevent abuse", backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 400, pass: true },
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 413, pass: true },
  { status: 422, pass: true },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
