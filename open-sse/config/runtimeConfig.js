// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

// Re-export error config (backward compat)
export {
  ERROR_TYPES,
  DEFAULT_ERROR_MESSAGES,
  BACKOFF_CONFIG,
  COOLDOWN_MS,
} from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300, // 5 minutes
  modelAlias: 3600, // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  // A failed external-resolver lookup is remembered too (#864). Without it
  // a resolver this host cannot reach is re-queried on every request to a
  // MITM-bypass host, and each one waits out the resolver before falling
  // through. Short, so an outage is absorbed rather than written off.
  dnsFailCacheTtlMs: 60 * 1000,
  // c-ares defaults to 5s x 4 tries, which is 20s of stall per lookup on a
  // network that blackholes the resolver instead of refusing (#864).
  dnsQueryTimeoutMs: 2 * 1000,
  dnsQueryTries: 1,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
// With allowZero, an explicit `0` is accepted verbatim (a "disable" sentinel).
function envMs(name, def, allowZero = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && (n > 0 || (allowZero && n === 0)) ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl(
  "SEARXNG_URL",
  "http://localhost:8888/search",
);

// DDGS metasearch API server (deedy5/ddgs) used by the unauthenticated
// web-search provider. Same shape as SEARXNG_URL above: point it at a separate
// container or a remote host. Unlike SearXNG the path is chosen per search
// type, so this is the origin only.
export const DDGS_URL = envUrl(
  "DDGS_URL",
  "http://localhost:4479",
);

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs(
  "STREAM_STALL_TIMEOUT_MS",
  360 * 1000,
);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs(
  "STREAM_FIRST_CHUNK_TIMEOUT_MS",
  200 * 1000,
);

// SSE keepalive ping interval emitted downstream while the provider sends
// nothing (pre-TTFT silence). 0 disables. Env: SSE_KEEPALIVE_MS.
export const SSE_KEEPALIVE_MS = envMs("SSE_KEEPALIVE_MS", 10 * 1000, true);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs(
  "FETCH_CONNECT_TIMEOUT_MS",
  60 * 1000,
);

// Token budget for a credential/health probe. A reasoning model spends a tiny
// budget entirely on chain-of-thought and emits no answer, and several
// upstreams reject max_tokens:1 outright, so a probe that asked for one token
// reported a working key as broken (#1672, same cause as #3010). Both the
// connection test and the model ping read this, so they cannot drift apart.
export const PROBE_MAX_TOKENS = 1024;

// Non-streaming upstream bodies are consumed through a reader owner. Keep this
// distinct from the response-header deadline above: headers may arrive while a
// provider body stalls indefinitely. Env: RESPONSE_BODY_TIMEOUT_MS.
export const RESPONSE_BODY_TIMEOUT_MS = envMs(
  "RESPONSE_BODY_TIMEOUT_MS",
  300 * 1000,
);

// Cursor's legacy ChatService buffers its ConnectRPC response before
// translation. Refuse the whole response above this bound instead of
// accumulating an attacker-controlled body. AgentService uses the same bound
// for the bytes accepted from its HTTP/2 stream.
export const CURSOR_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

// OCR and moderation are single-response JSON endpoints. Bound their upstream
// wait independently so a client that stays connected cannot hold an account
// selection forever. Env: JSON_PROXY_TIMEOUT_MS.
export const JSON_PROXY_TIMEOUT_MS = envMs(
  "JSON_PROXY_TIMEOUT_MS",
  FETCH_CONNECT_TIMEOUT_MS,
);

// Connect timeout for ollama-local: higher default because local models may need extra time
// to load weights (especially large models). Env: OLLAMA_LOCAL_CONNECT_TIMEOUT_MS.
export const OLLAMA_LOCAL_CONNECT_TIMEOUT_MS = envMs(
  "OLLAMA_LOCAL_CONNECT_TIMEOUT_MS",
  120 * 1000,
);

// Cap on the upstream error text persisted per account and echoed to clients.
// The previous 100-char clip landed inside the upstream reason ("Upstream reques…"),
// discarding the only diagnostic that mattered and leaving operators with nothing.
export const ACCOUNT_ERROR_MESSAGE_MAX_CHARS = 2000;

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs(
  "GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS",
  45 * 1000,
);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

export const TOKEN_SAVER_HEADER = "x-tokenproxy-token-saver";

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000,
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
const BASE_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 },
};

// Bounds for the env overrides below. A typo must not become an unbounded retry
// storm (attempts) or a request that hangs for an hour between tries (delay),
// so anything non-integer or outside the range falls back to the compiled
// default rather than being clamped — a silently clamped value reads as
// accepted and hides the typo.
const RETRY_MAX_ATTEMPTS = 10;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1000;

function envRetryInt(name, def, max) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : def;
}

// Env: RETRY_ATTEMPTS_<status> / RETRY_DELAY_MS_<status>, e.g. RETRY_ATTEMPTS_502=5,
// RETRY_DELAY_MS_502=1500. Unset leaves the default above untouched. Per-provider
// `config.retry` still wins over these (executors/base.js spreads it last).
export const DEFAULT_RETRY_CONFIG = Object.fromEntries(
  Object.entries(BASE_RETRY_CONFIG).map(([status, { attempts, delayMs }]) => [
    status,
    {
      attempts: envRetryInt(`RETRY_ATTEMPTS_${status}`, attempts, RETRY_MAX_ATTEMPTS),
      delayMs: envRetryInt(`RETRY_DELAY_MS_${status}`, delayMs, RETRY_MAX_DELAY_MS),
    },
  ]),
);

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number")
    return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs,
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:",
];
