import "open-sse/index.js";
import { randomUUID } from "node:crypto";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  isValidApiKey,
} from "../services/auth.js";
// Lease release lives in its own module, not in auth.js: a handler test that
// partially mocks account SELECTION must still run the real release path.
import { releaseAccountLease, releaseAccountLeaseOnResponse } from "../services/accountLeaseRegistry.js";
import { resolveClientApiKey } from "@/lib/auth/clientApiKey";
import { getSettings } from "@/lib/localDb";
import { isInternalModelTestAuthorized } from "@/lib/auth/internalCliToken";
import { getModelInfo, getComboModels, isModelDisabled } from "../services/model.js";
import { getReachableProviders } from "../services/auth.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL, parseHeadroomTimeoutMs } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { appendTokenSaverEvent } from "@/lib/tokenSaver/events.js";
import { errorResponse, unavailableResponse, isRetryableStatus } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities, resolveComboMemberConnection, resolveComboTokenSaver } from "open-sse/services/combo.js";
import { AUTO_MODEL_IDS, resolveAutoModel } from "@/sse/services/autoRouter.js";
import { detectAgentRole, applyAgentRoleGroup } from "open-sse/utils/agentRole.js";
import { refuseDisallowedModel } from "@/sse/services/modelAccess.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { isRequestReplayBufferError } from "open-sse/services/accountFallback.js";
import { peekStreamForContent } from "open-sse/utils/streamContent.js";
import { getActiveRequests } from "@/lib/usageDb.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { EMPTY_CONTENT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { decide, idPrefix, relativeReset, requestRid, reqSummary } from "@/shared/observability/decide.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { looksLikeClaudeWrappedModel,
  stripContextSuffix, normalizeClaudeModelName, buildClaudeRoutingIndex, readClaudeCompat } from "@/lib/claudeCompat";
import { recordApiKeyDevice } from "@/sse/services/apiKeyDevices.js";

// The header a caller uses to name the exact account a request must run on.
// Shared spelling with the image and video handlers.
const REQUEST_CONNECTION_HEADER = "x-connection-id";
// The header a caller uses to cap how many accounts one request may spend.
const REQUEST_MAX_ATTEMPTS_HEADER = "x-max-attempts";
const logicalRequestIds = new WeakMap();

function logicalRequestId(request) {
  if (!request || typeof request !== "object") return randomUUID();
  let id = logicalRequestIds.get(request);
  if (!id) {
    id = randomUUID();
    logicalRequestIds.set(request, id);
  }
  return id;
}

/**
 * Read the caller's attempt ceiling. Anything that is not a positive safe
 * integer is no ceiling at all: a "0", a "-1" or a "many" must not be read as
 * "stop after zero attempts", which would refuse every request.
 * @param {Request} request
 * @returns {number|null}
 */
export function readAttemptCeiling(request) {
  const raw = Number(request?.headers?.get(REQUEST_MAX_ATTEMPTS_HEADER));
  return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

function terminalAttemptResponse(response, cooldownMs = 0) {
  const headers = new Headers(response.headers);
  headers.set("x-tokenproxy-replay-safe", "false");
  if (cooldownMs > 0 && isRetryableStatus(response.status) && !headers.has("retry-after")) {
    headers.set("retry-after", String(Math.max(1, Math.ceil(cooldownMs / 1000))));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function rejectedAttemptResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("x-tokenproxy-replay-safe", "true");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function createAntigravityVerificationHooks(connectionId) {
  const { createAntigravityVerificationHooks: createHooks } = await import("@/lib/antigravityVerification");
  return createHooks(connectionId);
}

// The wait a local admission refusal advertises. There is no queue behind the
// per-provider cap yet (see HANDOFF in the leaf report), so the honest budget is
// the overlay spec's own floor rather than a number invented to look precise:
// the in-flight requests this cap is counting have no knowable finish time.
const ADMISSION_RETRY_HINT_MS = 1000;
// Retry-After floor from overlay-spec §4: a retryable status always names some
// delay, because `Retry-After: 0` reads as "retry immediately" and turns a
// refusal into a hot loop.
const RETRY_AFTER_FLOOR_MS = 1000;

// Admission is TWO gates, split on whether the caller authenticated.
//
// UNAUTHENTICATED (client IP, or "anonymous"): the sliding-window HARD refusal
// below, unchanged. A caller that presented no credential is the abuse
// boundary, and it gets counted and refused.
//
// AUTHENTICATED (a valid api key): QUEUED, never counted. A request-count
// window is the wrong shape for this topology -- ~30 trusted parallel agents
// share ONE key through a loopback gateway, so any fixed per-key ceiling either
// refuses legitimate bursts or stops protecting. Measured on production, six
// hours of journal: 7,745 of 17,422 requests (44.5% of ALL traffic) refused
// here, every one on a single key at 60/60s, against 5 real upstream 429s in
// the same window. The gate was manufacturing the storm it exists to prevent.
// What actually needs bounding is CONCURRENCY (how many upstream calls one key
// has in flight) and MEMORY, neither of which a request counter measures, so an
// authenticated request over the concurrency ceiling WAITS in a bounded FIFO
// queue and 429 becomes the overflow valve it should always have been: only a
// full queue or a spent wait budget refuses.
function readPositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
const RATE_LIMIT_WINDOW_MS = readPositiveIntEnv("RATE_LIMIT_WINDOW_MS", 60 * 1000);
const RATE_LIMIT_MAX_REQUESTS = readPositiveIntEnv("RATE_LIMIT_MAX_REQUESTS", 240);
const rateLimitHits = new Map();
const CLIENT_CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);

let lastRateLimitSweep = Date.now();

// Entries were only ever added: one per api key or client IP, kept for the
// process lifetime even after that caller went away. A gateway left running for
// days therefore grew this map without bound, which is the linear memory growth
// reported in #1245. Sweeping keys whose whole window has gone quiet bounds it
// to the callers actually seen in the last window; once per window keeps the
// scan cost negligible next to the request it rides on.
function sweepRateLimitHits(now) {
  if (now - lastRateLimitSweep < RATE_LIMIT_WINDOW_MS) return;
  lastRateLimitSweep = now;
  for (const [k, timestamps] of rateLimitHits) {
    const newest = timestamps[timestamps.length - 1];
    if (newest === undefined || now - newest >= RATE_LIMIT_WINDOW_MS) rateLimitHits.delete(k);
  }
}

function isRateLimited(key) {
  const now = Date.now();
  sweepRateLimitHits(now);
  const timestamps = (rateLimitHits.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) return true;
  timestamps.push(now);
  rateLimitHits.set(key, timestamps);
  return false;
}

// The instant this caller's window reopens: the oldest hit still inside the
// window ages out one window after it landed. Real state the limiter already
// held and was discarding, which is what a truthful Retry-After is made of --
// a constant here would be a guess that is wrong for every caller but one.
function rateLimitResetAtMs(key) {
  const oldest = (rateLimitHits.get(key) || [])[0];
  return oldest === undefined ? null : oldest + RATE_LIMIT_WINDOW_MS;
}

// Test seam: the limiter is a process-wide singleton, so a suite needs a way to
// drive it and start from empty without reaching into the map.
export const __rateLimiter = {
  isRateLimited,
  resetAtMs: rateLimitResetAtMs,
  size: () => rateLimitHits.size,
  reset: () => {
    rateLimitHits.clear();
    lastRateLimitSweep = Date.now();
  },
};

// Authenticated admission: a per-key concurrency gate in front of a bounded
// FIFO wait queue. Three knobs, env-tunable for the same reason the window's
// are -- the right numbers are a property of the deployment (how many agents,
// how slow the upstream), not of this file.
const ADMISSION_MAX_INFLIGHT = readPositiveIntEnv("ADMISSION_MAX_INFLIGHT", 32);
const ADMISSION_QUEUE_DEPTH = readPositiveIntEnv("ADMISSION_QUEUE_DEPTH", 512);
const ADMISSION_MAX_WAIT_MS = readPositiveIntEnv("ADMISSION_MAX_WAIT_MS", 30 * 1000);

// key -> { active, queue, idleSince }. Same memory shape as rateLimitHits and
// therefore the same #1245 obligation: one entry per key ever seen, so it is
// swept on the same cadence rather than grown for the process lifetime.
const admissionKeys = new Map();
let lastAdmissionSweep = Date.now();

function sweepAdmissionKeys(now) {
  if (now - lastAdmissionSweep < RATE_LIMIT_WINDOW_MS) return;
  lastAdmissionSweep = now;
  for (const [k, state] of admissionKeys) {
    if (state.active > 0 || state.queue.length > 0) continue;
    if (now - state.idleSince >= RATE_LIMIT_WINDOW_MS) admissionKeys.delete(k);
  }
}

// The earliest instant a QUEUE slot can free without waiting on an upstream
// nobody can predict: the head waiter either gets in or is evicted at its own
// deadline. Real state, which is what separates this hint from a constant.
function queueReliefMs(state, now) {
  const head = state.queue[0];
  return Math.max(RETRY_AFTER_FLOOR_MS, head ? head.deadline - now : ADMISSION_MAX_WAIT_MS);
}

/**
 * Take one in-flight slot for `key`, waiting in FIFO order when the key is at
 * its ceiling. Resolves to an admission or to a refusal; it never throws and
 * never rejects, because an admission decision is not an error.
 *
 * ponytail: the slot is held from admission until the handler RETURNS, which
 * for a streamed answer is first byte rather than last. Hand it to the response
 * body (releaseAccountLeaseOnResponse is the shape) if stream-duration
 * concurrency ever needs bounding too.
 */
function acquireAdmission(key) {
  const now = Date.now();
  sweepAdmissionKeys(now);
  let state = admissionKeys.get(key);
  if (!state) {
    state = { active: 0, queue: [], idleSince: now };
    admissionKeys.set(key, state);
  }
  if (state.active < ADMISSION_MAX_INFLIGHT) {
    state.active += 1;
    return Promise.resolve({ admitted: true, waitedMs: 0, queued: state.queue.length, active: state.active });
  }
  if (state.queue.length >= ADMISSION_QUEUE_DEPTH) {
    return Promise.resolve({
      admitted: false,
      why: "queue-full",
      waitedMs: 0,
      retryAfterMs: queueReliefMs(state, now),
      queued: state.queue.length,
      active: state.active,
    });
  }
  return new Promise((resolve) => {
    const waiter = { enqueuedAt: now, deadline: now + ADMISSION_MAX_WAIT_MS, settled: false, timer: null };
    // Settled exactly once, by whichever path gets there first: a release
    // handing the slot over, or the wait budget running out.
    waiter.settle = (admitted) => {
      if (waiter.settled) return;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      const at = state.queue.indexOf(waiter);
      if (at !== -1) state.queue.splice(at, 1);
      const endedAt = Date.now();
      const waitedMs = endedAt - waiter.enqueuedAt;
      if (admitted) {
        state.active += 1;
        resolve({ admitted: true, waitedMs, queued: state.queue.length, active: state.active });
        return;
      }
      if (state.active === 0 && state.queue.length === 0) state.idleSince = endedAt;
      resolve({
        admitted: false,
        why: "wait-timeout",
        waitedMs,
        retryAfterMs: queueReliefMs(state, endedAt),
        queued: state.queue.length,
        active: state.active,
      });
    };
    waiter.timer = setTimeout(() => waiter.settle(false), ADMISSION_MAX_WAIT_MS);
    // A queued request is never the reason a process refuses to exit.
    waiter.timer?.unref?.();
    state.queue.push(waiter);
  });
}

/** Give the slot back, handing it straight to the head of the queue. */
function releaseAdmission(key) {
  const state = admissionKeys.get(key);
  if (!state) return;
  state.active = Math.max(0, state.active - 1);
  const next = state.queue[0];
  if (next) next.settle(true);
  else if (state.active === 0) state.idleSince = Date.now();
}

// Test seam, matching __rateLimiter's: the queue is a process-wide singleton,
// so a suite needs to drive it and start from empty without reaching in.
export const __admissionQueue = {
  acquire: acquireAdmission,
  release: releaseAdmission,
  size: () => admissionKeys.size,
  stateOf: (key) => {
    const state = admissionKeys.get(key);
    return state ? { active: state.active, queued: state.queue.length } : null;
  },
  limits: () => ({
    inflight: ADMISSION_MAX_INFLIGHT,
    depth: ADMISSION_QUEUE_DEPTH,
    waitMs: ADMISSION_MAX_WAIT_MS,
  }),
  reset: () => {
    for (const state of admissionKeys.values()) {
      for (const waiter of [...state.queue]) waiter.settle(false);
    }
    admissionKeys.clear();
    lastAdmissionSweep = Date.now();
  },
};

function withoutClientCredentialHeaders(clientRawRequest) {
  if (!clientRawRequest?.headers) return clientRawRequest;
  const entries = clientRawRequest.headers instanceof Headers
    ? clientRawRequest.headers.entries()
    : Object.entries(clientRawRequest.headers);
  const headers = Object.fromEntries(
    [...entries].filter(([name]) => !CLIENT_CREDENTIAL_HEADER_NAMES.has(String(name).toLowerCase())),
  );
  return { ...clientRawRequest, headers };
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null, options = {}) {
  const resolvedApiKey = await resolveClientApiKey(request, isValidApiKey);
  const apiKey = resolvedApiKey.valid ? resolvedApiKey.apiKey : null;
  const rateLimitKey = apiKey || request.headers.get("x-forwarded-for") || "anonymous";
  // The request id for everything this call emits. Adopted from the front
  // proxy's x-tp-rid when it sent one, minted here otherwise.
  const rid = requestRid(request);
  // A SHA-256 prefix, never the credential: two callers stay distinguishable
  // and no admission line has ever carried a key. One spelling across all three
  // admission verdicts, so `rg 'key=api:20f88033'` returns the whole story.
  const keyTag = apiKey
    ? `api:${idPrefix(apiKey)}`
    : rateLimitKey === "anonymous" ? "anon" : `ip:${idPrefix(rateLimitKey)}`;

  // UNAUTHENTICATED: the hard window. No credential, no queue.
  if (!apiKey) {
    if (isRateLimited(rateLimitKey)) {
      const resetAt = rateLimitResetAtMs(rateLimitKey);
      // This was `log.warn("CHAT", "Rate limit exceeded")`: 15,548 lines in a
      // measured six-hour window, 73.9% of the whole journal, naming neither
      // the caller, the limit, the window nor the reset -- while all four were
      // in scope on the next line. It is now one folded ADM.ratelimited
      // carrying all four: the window lives inside `limit=60/60s`, so there is
      // no `win` field. `why` is a closed enum. `model` is deliberately absent:
      // the body is not parsed until after this gate and reading it here to
      // decorate a log line would consume the request stream.
      decide("ADM", "ratelimited", {
        rid,
        key: keyTag,
        limit: `${RATE_LIMIT_MAX_REQUESTS}/${RATE_LIMIT_WINDOW_MS / 1000}s`,
        reset: relativeReset(resetAt),
        why: rateLimitKey === "anonymous" ? "anon-window" : "ip-window",
      });
      // D-10: VERDICTS.REQ.refused had no emitters — the refusal IS the
      // request's summary line.
      reqSummary("refused", { rid, why: "rate-limited" });
      return errorResponse(HTTP_STATUS.RATE_LIMITED, "Too many requests, please slow down", {
        retryAfter: { at: resetAt },
        failurePhase: "admission",
      });
    }
    return handleAdmittedChat(request, clientRawRequest, options, { resolvedApiKey, rid });
  }

  // AUTHENTICATED: shaped, not refused. A wait is the answer; a 429 is only
  // what is left when the queue itself is out of room.
  const slot = await acquireAdmission(rateLimitKey);
  if (!slot.admitted) {
    decide("ADM", "evicted", {
      rid,
      key: keyTag,
      waited: `${slot.waitedMs}ms`,
      limit: `${ADMISSION_MAX_INFLIGHT}x${ADMISSION_QUEUE_DEPTH}/${ADMISSION_MAX_WAIT_MS}ms`,
      why: slot.why,
      queued: slot.queued,
      active: slot.active,
      status: HTTP_STATUS.RATE_LIMITED,
    });
    reqSummary("refused", { rid, why: "admission-overflow" });
    return errorResponse(HTTP_STATUS.RATE_LIMITED, "Too many concurrent requests, please retry", {
      retryAfter: { ms: slot.retryAfterMs },
      failurePhase: "admission",
    });
  }
  // Only a request that actually WAITED costs a line: shaping is the news,
  // nominal admission is not, and one line per request is exactly the volume
  // this whole design exists to avoid.
  if (slot.waitedMs > 0) {
    decide("ADM", "queued", {
      rid,
      key: keyTag,
      waited: `${slot.waitedMs}ms`,
      limit: `${ADMISSION_MAX_INFLIGHT}x${ADMISSION_QUEUE_DEPTH}/${ADMISSION_MAX_WAIT_MS}ms`,
      queued: slot.queued,
      active: slot.active,
    });
  }
  try {
    return await handleAdmittedChat(request, clientRawRequest, options, { resolvedApiKey, rid });
  } finally {
    releaseAdmission(rateLimitKey);
  }
}

/**
 * The request proper, downstream of admission. Split out of handleChat only so
 * the concurrency slot has a `finally` to be released in without wrapping four
 * hundred lines in a try block; every caller still arrives through handleChat.
 */
async function handleAdmittedChat(request, clientRawRequest, options, { resolvedApiKey, rid }) {
  const presentedApiKey = resolvedApiKey.apiKey;
  const apiKey = resolvedApiKey.valid ? presentedApiKey : null;

  let body = options.body;
  if (body === undefined) {
    try {
      body = await request.json();
    } catch {
      log.warn("CHAT", "Invalid JSON body");
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
    }
  }
  const callerSignal = options.signal || request?.signal;

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  clientRawRequest = withoutClientCredentialHeaders(clientRawRequest);
  let modelStr = body.model;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  if (apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings, or forced by the environment.
  //
  // REQUIRE_API_KEY appeared in .env.example and the deployment docs while no
  // code read it, so an operator who set it believed the gate was on and it was
  // not (#2834). It is honoured here, and it can only TIGHTEN: the env var adds
  // the requirement, and there is deliberately no value of it that removes one
  // the stored setting imposes. A container operator has no dashboard to click,
  // which is why the env var has to work at all.
  const settings = await getSettings();
  // `source` is which requirement fired: the stored setting wins when both
  // are set, because the env var can only tighten, never relax (see below).
  const requireApiKeySource = settings.requireApiKey ? "setting" : "env";
  const requireApiKey = settings.requireApiKey || process.env.REQUIRE_API_KEY === "true";
  if (requireApiKey) {
    const authorized = await isInternalModelTestAuthorized(request, apiKey, isValidApiKey);
    if (!authorized) {
      // One decision, one line: ADM.key-required when nothing was presented,
      // ADM.key-invalid when a key was presented but did not validate. The key
      // itself never appears (silence policy), only `presented=true|false`.
      decide("ADM", presentedApiKey ? "key-invalid" : "key-required", {
        rid,
        source: requireApiKeySource,
        presented: presentedApiKey ? true : false,
      });
      // D-10: the key-gate refusal is the whole request — it gets REQ.refused.
      reqSummary("refused", { rid, why: presentedApiKey ? "key-invalid" : "key-required" });
      const message = presentedApiKey ? "Invalid API key" : "Missing API key";
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, message);
    }
    // Count the distinct clients on this key, so a leaked or shared key is
    // visible as more than a bigger bill (#930). Only a VALIDATED key is
    // recorded: counting unchecked strings would let anyone grow the map.
    recordApiKeyDevice(apiKey, request);
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Claude compat layer: Anthropic clients echo back ids like
  // "claude-bai/deepseek-v4-flash[1m]" from our rewritten /v1/models. Strip
  // the markers back to the routable name before combo/account selection so
  // the whole pipeline (and usage records) sees the real model.
  // The [1m] marker is tokenproxy's own, so strip it whatever the compat toggle
  // says. A client caches the model list, so an id minted while compat was on
  // is still echoed back after it is turned off, and forwarding the suffix
  // verbatim gives a 404 that reads as a missing model. The rest of the
  // rewrite (the claude- prefix and routing-index resolution) stays gated.
  const unsuffixed = stripContextSuffix(modelStr);
  if (unsuffixed !== modelStr) {
    // DEBUG, not INFO: one line per request that names nothing an operator
    // acts on (the doc's row 10 records the strip via path=, not narration).
    log.debug("CHAT", `Context suffix: "${modelStr}" -> "${unsuffixed}"`);
    body.model = unsuffixed;
    modelStr = unsuffixed;
  }

  if (
    looksLikeClaudeWrappedModel(modelStr) &&
    process.env.DISABLE_CLAUDE_COMPAT !== "true"
  ) {
    const compat = readClaudeCompat(settings);
    if (compat.enabled) {
      const normalized = normalizeClaudeModelName(modelStr, await buildClaudeRoutingIndex());
      if (normalized !== modelStr) {
        log.info("CHAT", `Claude compat: "${modelStr}" -> "${normalized}"`);
        body.model = normalized;
        modelStr = normalized;
      }
    }
  }

  // The key's model allowlist (#1154) was only ever enforced in rerank, so
  // every other modality could reach a barred model with the same key
  // (#448, #2833). Checked once modelStr is final and the key is valid,
  // and before any upstream work or rotation slot is spent.
  const barred = await refuseDisallowedModel(apiKey, modelStr, log);
  if (barred) return barred;

  // A disabled model vanished from /v1/models but still answered when asked
  // for by name, because getModelInfo never consulted the disabled list
  // (#577). Combos were already handled by #1521; this is the direct path.
  // Skipped for a combo name, which has no alias/model shape and whose
  // members are filtered later.
  if (await isModelDisabled(modelStr)) {
    log.warn("CHAT", `Disabled model requested: ${modelStr}`);
    return errorResponse(HTTP_STATUS.NOT_FOUND, `Model is disabled: ${modelStr}`);
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  // "auto" is a virtual id, not a model: pick a real one from the request and
  // continue down the ordinary path, so combos, the capacity adapter, account
  // fallback and usage all see a normal model string (#1386). A combo the user
  // named "auto" still wins, because a thing they configured outranks a
  // built-in default.
  if (AUTO_MODEL_IDS.has(modelStr) && !(await getComboModels(modelStr))) {
    const routed = await resolveAutoModel(body, settings);
    if (!routed) {
      log.info("CHAT", `Auto router: nothing routable for "${modelStr}"`);
      return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, `No model available to route "${modelStr}" to`);
    }
    log.info("CHAT", `Auto router: ${routed.taskClass} (${routed.source}) -> "${routed.model}"`);
    body.model = routed.model;
    modelStr = routed.model;
  }

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const rawComboModels = await getComboModels(modelStr);
  // A combo is one flat pool, so a sub-agent spawned for an auxiliary task
  // draws from the same top-tier members the main loop does. When the user has
  // assigned a model group to a role, narrow the combo to it, keeping the
  // combo's own order and falling back to the full list if nothing is left
  // (#1092). Inert until a group is configured.
  const agentRole = rawComboModels ? detectAgentRole(body, userAgent) : null;
  const comboModels = rawComboModels
    ? applyAgentRoleGroup(rawComboModels, agentRole, settings)
    : rawComboModels;
  if (comboModels) {
    if (agentRole && comboModels.length !== rawComboModels.length) {
      log.info("CHAT", `Agent role "${agentRole}": combo "${modelStr}" narrowed to ${comboModels.length}/${rawComboModels.length} models`);
    }
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const { models: augmentedModels, adapterAdded } = await reachableAugmentation(
      comboModels,
      augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings),
    );

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, new Set([modelStr]), callerSignal);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        // Seed the cycle guard with this combo so a member naming it is refused
        // at the first hop rather than the second. See handleSingleModelChat.
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, new Set([modelStr]), callerSignal),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const { models: soloAugmented, adapterAdded } = await reachableAugmentation(
    [modelStr],
    augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings),
  );
  if (soloAugmented.length > 1) {
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, callerSignal),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, null, callerSignal);
}

/**
 * Handle single model chat request
 */
// Keep only adapter-pool entries whose provider this install can actually
// reach. The pool is prepended ahead of the requested model, so an entry from a
// provider that was never connected takes the first attempt, fails on missing
// credentials, and logs that failure against a request that never asked for it
// (#2555).
async function reachableAugmentation(base, augmented) {
  const added = augmented.filter((m) => !base.includes(m));
  if (added.length === 0) return { models: augmented, adapterAdded: added };
  const reachable = await getReachableProviders();
  const providerOf = (m) => String(m).split("/")[0];
  const usable = added.filter((m) => reachable.has(providerOf(m)));
  if (usable.length === added.length) return { models: augmented, adapterAdded: added };
  return { models: [...usable, ...base], adapterAdded: usable };
}

// How many requests this provider may have in flight at once, from
// providerStrategies[<provider>].maxConcurrent. Anything that is not a
// positive integer means "no cap", so a malformed setting fails open rather
// than throttling to zero. Returns the refusal text, or null to proceed.
export async function providerConcurrencyOverflow(provider, settings = null) {
  let limit;
  try {
    const s = settings || (await getSettings());
    limit = s?.providerStrategies?.[provider]?.maxConcurrent;
  } catch {
    return null; // fail open: an unreadable setting must not block routing
  }
  if (!Number.isInteger(limit) || limit <= 0) return null;
  let inFlight = 0;
  try {
    for (const r of await getActiveRequests()) {
      if (r.provider === provider) inFlight += r.count;
    }
  } catch {
    return null;
  }
  if (inFlight < limit) return null;
  return `at the configured concurrency limit (${inFlight}/${limit} in flight)`;
}

async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, comboChain = null, callerSignal = request?.signal) {
  // Same request object handleChat saw, so readRid's memoised WeakMap hands
  // back the SAME rid every hop of a recursive chat call.
  const rid = requestRid(request);
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      // Nested combos are deliberate: a member with no provider is expanded as a
      // combo in its own right. Without a cycle guard a combo naming itself, or
      // A listing B while B lists A, recurses until the stack overflows and takes
      // the whole gateway down with it — reachable by anyone who can save a combo
      // (#1235). Refuse to re-enter a combo already being expanded.
      const chain = comboChain || new Set();
      if (chain.has(modelStr)) {
        const cycle = [...chain, modelStr].join(" -> ");
        log.warn("CHAT", `Combo cycle refused: ${cycle}`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `Combo "${modelStr}" contains itself (${cycle})`);
      }
      chain.add(modelStr);
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const { models: augmentedModels, adapterAdded } = await reachableAugmentation(
        comboModels,
        augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings),
      );

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, new Set(chain), callerSignal);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, new Set(chain), callerSignal),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return rejectedAttemptResponse(errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format"));
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Per-provider in-flight cap (#2519). Reuses the per-provider settings bag
  // this handler already reads, so there is no new schema:
  // providerStrategies[<provider>].maxConcurrent. The counter is the one
  // chatCore already maintains for the whole stream lifetime, so nothing new
  // has to be released. Over the cap answers 503, which combo and account
  // fallback already read as "try the next candidate" — which is what the
  // report asks for: spread a combo over its members instead of piling every
  // request onto the first one. Unset (the default) skips the lookup entirely.
  const overflow = await providerConcurrencyOverflow(provider);
  if (overflow) {
    log.warn("CHAT", `[${provider}/${model}] ${overflow}`);
    // A LOCAL admission refusal, not a claim that the provider is out of
    // capacity — those are different facts, and a caller doing its own backoff
    // math is misled by the conflation. `failure_phase` is what lets it tell
    // them apart, and the wait budget is the local gate's own, so the message
    // names TokenProxy rather than the upstream.
    return errorResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `[${provider}/${model}] TokenProxy is ${overflow}`,
      { retryAfter: { ms: ADMISSION_RETRY_HINT_MS }, failurePhase: "admission" },
    );
  }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  // Per-connection consecutive-failure counter: the SAME account is retried
  // up to ACCOUNT_RETRY_LIMIT times before the loop excludes it and switches.
  const ACCOUNT_RETRY_LIMIT = 3;
  const failCountByConn = new Map();
  let upstreamAttempt = 0;
  const telemetryRequestId = logicalRequestId(request);
  let lastError = null;
  let lastStatus = null;
  // Envoy request-buffer overflow (507): retry the SAME account once — the
  // failure is upstream buffering, not the account, and other accounts may not
  // hold the credential state the retry needs.
  let requestReplayConnectionId = null;
  let requestReplayAttempted = false;
  // Only a combo member can be pinned, so a plain request never pays the read.
  const pinnedConnectionId = comboChain
    ? resolveComboMemberConnection(comboChain, modelStr, await getSettings())
    : null;
  if (pinnedConnectionId) {
    log.info("CHAT", `[${provider}/${model}] pinned to connection ${pinnedConnectionId.slice(0, 8)}`);
  }
  // A caller may name the exact account this request must run on. The image and
  // video handlers already read this header; chat did not, so a client holding
  // per-account session state had no way to say which account it meant and its
  // follow-up landed on whichever account selection happened to pick.
  const requestedConnectionId = request?.headers?.get(REQUEST_CONNECTION_HEADER) || null;
  // Optional caller-supplied ceiling on how many accounts one request may burn.
  // Without it the loop rotates through the whole pool, which is right for a
  // background job and wrong for an interactive client that would rather see
  // the first real error than wait out eight upstream timeouts.
  const maxAttempts = readAttemptCeiling(request);

  while (true) {
    if (callerSignal?.aborted) return errorResponse(499, "Request aborted");
    const lastFailedConn = failCountByConn.size ? [...failCountByConn.entries()].find(([id, c]) => c >= 1 && c < ACCOUNT_RETRY_LIMIT)?.[0] : null;
    // Session affinity's ONLY input. resolveRoutingSessionHash (auth.js) hashes
    // whatever identity sessionManager can read out of these two fields; given
    // neither, it falls back to the literal "anonymous" and every request of a
    // provider collapses onto ONE pin, which is what made the durable pin -- and
    // the prompt-cache locality it exists to protect -- inert.
    //
    // clientRawRequest.headers is a PLAIN object: sessionManager's headerValue
    // indexes headers by name, so handing it a Headers instance would read as
    // "no session evidence" without erroring. withoutClientCredentialHeaders has
    // already stripped the credential headers from it, so no bearer can reach
    // the hash input.
    const credentialOptions = {
      clientHeaders: clientRawRequest?.headers || null,
      clientBody: body,
      clientApiKey: apiKey,
      // Decision-log context for auth.js (docs/logging-design.md 3.2): rid
      // joins every SEL/LEASE/LOCK line this selection emits.
      logCtx: { rid },
    };
    if (lastFailedConn) credentialOptions.ignoreModelLockConnId = lastFailedConn;
    if (requestReplayConnectionId) credentialOptions.preferredConnectionId = requestReplayConnectionId;
    // A combo may pin this member to one account (#1477): not every account of a
    // provider is equivalent, and a combo built to try a free tier before a paid
    // one cannot say so when selection is provider-wide. Strict on purpose: a
    // user who named an account has chosen it, so falling back to another would
    // spend the wrong subscription. When it is unavailable the member fails and
    // the combo advances, which is what a combo is for. A replay pin, which is
    // about reaching the connection that just failed, still wins.
    else if (pinnedConnectionId) {
      credentialOptions.preferredConnectionId = pinnedConnectionId;
      credentialOptions.strictPreferredConnection = true;
    }
    // Lowest precedence: a replay pin is about reaching the account that just
    // failed and a combo pin is configuration, so both outrank what the caller
    // asked for on this single request.
    else if (requestedConnectionId) credentialOptions.preferredConnectionId = requestedConnectionId;
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, credentialOptions);
    // The slot this selection reserved (auth.js reserve). It is held for the
    // WHOLE attempt and given back exactly once, whichever of this loop's many
    // exits ends it: the four aborts, the empty-stream rotation, the replay
    // retry, the attempt-ceiling return, every same-account and next-account
    // retry, and any throw from handleChatCore. `finally` is what makes that
    // exhaustive - an exit added later is covered without being enumerated,
    // and a rotation that picks a DIFFERENT account next pass cannot leak the
    // previous one because release happens before `continue` leaves the block.
    //
    // The single exception is a response that is still streaming when the
    // handler returns: ownership moves to the body, and `leaseHandedOff` says
    // so, because releasing at `return` would report the account idle for the
    // entire stream. Release is idempotent (accountLease.js), so the belt is
    // free even where the braces already held.
    const accountLease = credentials?.accountLease || null;
    let leaseHandedOff = false;
    try {

      // Selection may substitute a healthy account for the pinned one. For a
      // caller that named an account that is not a helpful fallback: it spends the
      // wrong subscription and breaks whatever account-bound state the pin existed
      // to reach. Say so instead of silently serving someone else.
      if (requestedConnectionId && credentials && credentials.allRateLimited !== true
          && credentials.connectionId !== requestedConnectionId) {
        return rejectedAttemptResponse(errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "Pinned connection unavailable", {
          failurePhase: "provider",
        }));
      }

      // All accounts unavailable
      if (!credentials || credentials.allRateLimited) {
        if (credentials?.allRateLimited) {
          const errorMsg = credentials.lastError || "Unavailable";
          // Selection's own status and message, deliberately. They describe the
          // account selection actually consulted; substituting the status or
          // the text of an account that failed EARLIER in this cascade reports
          // one account's problem as another's. Selection is now the layer that
          // knows an exhausted pool is a 429 and what its earliest real reset
          // is (auth.js), so there is nothing left for this branch to correct.
          const status = credentials.clientErrorStatus
            ?? (Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE);
          log.warn(
            "CHAT",
            `[${provider}/${model}] ${errorMsg} [${status}] (${credentials.retryAfterHuman})`,
          );
          return rejectedAttemptResponse(unavailableResponse(
            status,
            `[${provider}/${model}] ${errorMsg}`,
            credentials.retryAfter,
            credentials.retryAfterHuman,
          ));
        }
        if (excludeConnectionIds.size === 0) {
          log.warn("AUTH", `No active credentials for provider: ${provider}`);
          return rejectedAttemptResponse(errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`));
        }
        log.warn("CHAT", "No more accounts available", { provider });
        const exhaustedStatus = lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE;
        // Every account is out, and none of them told us when it comes back
        // (a lock with an expiry took the unavailableResponse branch above). The
        // §4 floor fills the absence so the caller is never handed a retryable
        // status with no delay hint at all — and isRetryableStatus keeps it off a
        // 401 or 402, where the correct advice is to stop rather than to wait.
        return rejectedAttemptResponse(errorResponse(exhaustedStatus, lastError || "All accounts unavailable", {
          retryAfter: { ms: RETRY_AFTER_FLOOR_MS },
          failurePhase: "provider",
        }));
      }

      // Account selection shown in the unified "▶" line (acc:...)
      const refreshedCredentials = await checkAndRefreshToken(provider, credentials);
      const effectiveModel = !modelStr.includes("/") && credentials.defaultModel
        ? credentials.defaultModel
        : model;

      // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
      if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
        const projectVerificationHooks = provider === "antigravity"
          ? await createAntigravityVerificationHooks(credentials.connectionId)
          : {};
        const pid = await getProjectIdForConnection(
          credentials.connectionId,
          refreshedCredentials.accessToken,
          provider,
          projectVerificationHooks,
        );
        if (pid) {
          refreshedCredentials.projectId = pid;
          // Persist to DB in background so subsequent requests have it immediately
          updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
        }
      }

      // Use shared chatCore
      const chatSettings = await getSettings();
      // The token saver was global, so a combo mixing an expensive model with a
      // cheap one had to be saved for both or neither (#2289, #2037). The chain
      // names the combo this attempt came from, so a combo's own overrides apply
      // to its members; a combo that declares nothing resolves to the global
      // settings unchanged, and a request outside a combo has no chain at all.
      const comboTokenSaver = resolveComboTokenSaver(comboChain, chatSettings);
      const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
      const connectTimeout = {
        providerOverride: chatSettings.providerStrategies?.[provider]?.connectTimeoutMs,
        globalTimeout: chatSettings.connectTimeoutMs,
      };
      const chatVerificationHooks = provider === "antigravity"
        ? await createAntigravityVerificationHooks(credentials.connectionId)
        : {};
      const result = await handleChatCore({
        // Same Request object as handleChat saw, so this is the SAME rid: the
        // admission line and the request lines join on one grep.
        requestId: requestRid(request),
        contextTelemetry: { logicalRequestId: telemetryRequestId, attempt: ++upstreamAttempt },
        body: { ...body, model: `${provider}/${effectiveModel}` },
        modelInfo: { provider, model: effectiveModel },
        credentials: refreshedCredentials,
        callerSignal,
        log,
        clientRawRequest,
        connectionId: credentials.connectionId,
        userAgent,
        apiKey,
        ccFilterNaming: !!chatSettings.ccFilterNaming,
        rtkEnabled: comboTokenSaver.rtkEnabled,
        rtkAllowLossy: chatSettings.rtkAllowLossy === true,
        schemaDistillEnabled: comboTokenSaver.schemaDistillEnabled,
        schemaAllowLossy: chatSettings.schemaAllowLossy === true,
        thinkingStripEnabled: comboTokenSaver.thinkingStripEnabled,
        queryAwareCompressionEnabled: comboTokenSaver.queryAwareCompressionEnabled,
        pairDropEnabled: comboTokenSaver.pairDropEnabled,
        embedReorderEnabled: comboTokenSaver.embedReorderEnabled,
        // url/model are global: a combo overrides the reorder switch, not the
        // local embed endpoint every member would share.
        embedReorderUrl: chatSettings.embedReorderUrl,
        embedReorderModel: chatSettings.embedReorderModel,
        midPrefixInjectEnabled: comboTokenSaver.midPrefixInjectEnabled,
        privacyEnabled: !!chatSettings.privacyFilterEnabled,
        privacyTerms: chatSettings.privacyFilterTerms || [],
        headroomEnabled: comboTokenSaver.headroomEnabled,
        headroomAllowLossy: chatSettings.headroomAllowLossy === true,
        headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
        headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
        headroomTimeoutMs: chatSettings.headroomTimeoutMs ?? parseHeadroomTimeoutMs(),
        cavemanEnabled: comboTokenSaver.cavemanEnabled,
        cavemanLevel: chatSettings.cavemanLevel || "full",
        ponytailEnabled: comboTokenSaver.ponytailEnabled,
        ponytailLevel: chatSettings.ponytailLevel || "full",
        pxpipeEnabled: comboTokenSaver.pxpipeEnabled,
        pxpipeAllowLossy: chatSettings.pxpipeAllowLossy === true,
        pxpipeMinChars: chatSettings.pxpipeMinChars,
        pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
        // Lazily warms the in-process module on first use; null when not installed (fail-open)
        pxpipeTransform: comboTokenSaver.pxpipeEnabled ? await getPxpipeTransform() : null,
        onPxpipeEvent: appendPxpipeEvent,
        onTokenSaverEvent: appendTokenSaverEvent,
        // 8-char session prefix for REQ ce= cache-epoch telemetry; idPrefix
        // returns null when selection carried no client-derived session.
        sid: idPrefix(credentials.sessionHash),
        providerThinking,
        connectTimeout,
        codexFastMode: chatSettings.providerStrategies?.codex?.fastMode === true,
        memorySettings: chatSettings,
        toolDisclosure: (chatSettings.toolDisclosureEnabled || chatSettings.toolDisclosureFilterEnabled) ? {
          disclosureEnabled: !!chatSettings.toolDisclosureEnabled,
          filterEnabled: !!chatSettings.toolDisclosureFilterEnabled,
          maxTools: chatSettings.toolDisclosureMaxTools ?? 20,
          excludeServers: chatSettings.toolDisclosureExcludeServers || [],
          excludeTools: chatSettings.toolDisclosureExcludeTools || [],
        } : null,
        // Detect source format by endpoint + body
        sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
        verificationContext: chatVerificationHooks.verificationContext,
        onValidationRequired: chatVerificationHooks.onValidationRequired,
        onVerificationSuccess: chatVerificationHooks.onVerificationSuccess,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            ...newCreds,
            existingProviderSpecificData: credentials.providerSpecificData,
            testStatus: "active"
          });
        },
        onRequestSuccess: async () => {
          await clearAccountError(credentials.connectionId, credentials, model);
        },
        // Record accepted empty generations without replaying the request.
        onEmptyStream: async () => {
          await markAccountUnavailable(
            credentials.connectionId,
            HTTP_STATUS.BAD_GATEWAY,
            `Empty streaming response from ${provider}/${model}`,
            provider,
            model,
            Date.now() + EMPTY_CONTENT_COOLDOWN_MS,
            { safeToReplay: false },
            { rid }
          );
        }
      });

      if (callerSignal?.aborted) return errorResponse(499, "Request aborted");

      // A successful upstream status can represent billable work even when no
      // usable output arrives. Inspect the stream, but never replay that work.
      if (result.success) {
        const peeked = await peekStreamForContent(result.response);
        if (callerSignal?.aborted) return errorResponse(499, "Request aborted");
        if (peeked.hasContent) {
          // The answer is live from here to the last token, which for a long
          // stream is minutes after this return. Ownership of the slot moves to
          // the body so the ceiling counts requests actually on the wire; the
          // `finally` below stands down because releasing now would free it
          // while the client is still reading.
          leaseHandedOff = true;
          // Non-SSE replies come back with body:null and pass through as-is.
          return releaseAccountLeaseOnResponse(
            peeked.body
              ? new Response(peeked.body, {
                status: result.response.status,
                statusText: result.response.statusText,
                headers: result.response.headers,
              })
              : result.response,
            accountLease,
          );
        }
        const reason = peeked.upstreamError?.reason || "provider returned an empty stream";
        lastError = reason;
        lastStatus = peeked.upstreamError?.status || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `ACC:${credentials.connectionName} accepted generation ended without usable content`);
        decide("UP", "no-replay", { rid, why: "accepted-empty-generation" });
        await markAccountUnavailable(
          credentials.connectionId,
          HTTP_STATUS.BAD_GATEWAY,
          `${reason} from ${provider}/${model}`,
          provider,
          model,
          Date.now() + EMPTY_CONTENT_COOLDOWN_MS,
          { safeToReplay: false },
          { rid }
        );
        return terminalAttemptResponse(errorResponse(lastStatus, reason, {
          retryAfter: { ms: EMPTY_CONTENT_COOLDOWN_MS },
          failurePhase: "provider",
        }));
      }

      if (result.clientAborted || result.status === 499) {
        // The client is gone or going, but the upstream body it was handed may
        // still be open. The helper releases at once when there is nothing to
        // read, and on cancel otherwise, so neither case leaks.
        leaseHandedOff = true;
        return releaseAccountLeaseOnResponse(result.response, accountLease);
      }
      if (result.failureMetadata?.safeToReplay === true
          && !requestReplayAttempted && isRequestReplayBufferError(result.status, result.error)) {
        requestReplayAttempted = true;
        requestReplayConnectionId = credentials.connectionId;
        log.warn("RETRY", `ACC:${credentials.connectionName} replaying once after upstream request-buffer overflow`);
        decide("UP", "replay-overflow", { rid });
        continue;
      }

      // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
      const accountFailureArgs = [
        credentials.connectionId,
        result.status,
        result.error,
        provider,
        model,
        result.resetsAtMs,
        result.failureMetadata || null,
        { rid },
      ];
      const { shouldFallback, cooldownMs, mustWait, retrySameAccount } = await markAccountUnavailable(...accountFailureArgs);

      if (result.failureMetadata?.safeToReplay !== true || mustWait) {
        decide("UP", "no-replay", { rid, why: mustWait ? "account-cooldown" : "generation-outcome-uncertain" });
        leaseHandedOff = true;
        return releaseAccountLeaseOnResponse(terminalAttemptResponse(result.response, cooldownMs), accountLease);
      }

      if (shouldFallback) {
        // A rate limit is the most actionable thing a caller can be told, and the
        // loop used to overwrite it with whatever the next account happened to
        // fail with. A client handed a generic 503 has no reset time to wait for,
        // so it retries immediately into the same quota.
        if (lastStatus === null
            || (result.status === HTTP_STATUS.RATE_LIMITED && lastStatus !== HTTP_STATUS.RATE_LIMITED)) {
          lastError = result.error;
          lastStatus = result.status;
        }
        // The caller capped how many accounts this request may spend. Hand back
        // the real upstream response rather than rotating past the budget.
        if (maxAttempts && excludeConnectionIds.size + 1 >= maxAttempts) {
          log.warn("CHAT", `[${provider}/${model}] attempt ceiling ${maxAttempts} reached`);
          decide("UP", "attempt-ceiling", { rid, attempts: maxAttempts });
          leaseHandedOff = true;
          return releaseAccountLeaseOnResponse(terminalAttemptResponse(result.response, cooldownMs), accountLease);
        }
        const fails = (failCountByConn.get(credentials.connectionId) || 0) + 1;
        failCountByConn.set(credentials.connectionId, fails);
        // The same-account retry exists for a transient glitch. markAccountUnavailable
        // already computed how long this account is out for, and that answer was
        // being discarded: an account locked for two minutes was still hammered
        // three times in a row before the loop moved on, costing the user two
        // pointless upstream calls and the latency of both (#1641).
        // A terminal status never earns a same-account retry, whatever the
        // cooldown works out to. Re-dispatching the identical request against the
        // identical credential after a 401, 402 or 403 spends an upstream call to
        // be told the same thing. Rotation to a DIFFERENT credential still runs
        // below — a distinct key is a distinct fact, which is what #2429 pins.
        if (retrySameAccount === true && isRetryableStatus(result.status)
            && fails < ACCOUNT_RETRY_LIMIT && cooldownMs === 0) {
          // Same account, immediate retry — cooldown was skipped for transient
          // errors, so this is a fast re-dispatch rather than a wait.
          log.warn("RETRY", `⇄ ACC:${credentials.connectionName} failed (${result.status}) attempt ${fails}/${ACCOUNT_RETRY_LIMIT} → RETRY SAME`);
          decide("UP", "retry", { rid, conn: String(credentials.connectionId).slice(0, 8), attempt: fails, why: `status-${result.status}` });
          continue;
        }
        if (cooldownMs > 0) {
          log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} locked ${Math.round(cooldownMs / 1000)}s (${result.status}) → NEXT ACCOUNT`);
          decide("UP", "failover", { rid, from: String(credentials.connectionId).slice(0, 8), to: "pool", why: `locked-${Math.round(cooldownMs / 1000)}s` });
          excludeConnectionIds.add(credentials.connectionId);
          continue;
        }
        log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE after ${ACCOUNT_RETRY_LIMIT} tries (${result.status}) → NEXT ACCOUNT`);
        decide("UP", "failover", { rid, from: String(credentials.connectionId).slice(0, 8), to: "pool", why: `unavailable-${result.status}` });
        excludeConnectionIds.add(credentials.connectionId);
        continue;
      }

      // shouldFallback === false: this upstream response IS the answer, and its
      // body may still be unread. Same handoff as the peeked path; a body-less
      // response releases immediately inside the helper.
      leaseHandedOff = true;
      return releaseAccountLeaseOnResponse(rejectedAttemptResponse(result.response), accountLease);
    } finally {
      if (!leaseHandedOff) releaseAccountLease(accountLease);
    }
  }
}
