import { classifyHttpTerminalEvidence } from "../../src/lib/db/terminalEvidence.js";
import { prepareContextCapture } from "../../src/lib/db/repos/contextEvidenceRepo.js";
import { isReplaySafeRejection, isSafeQuotaAccountRejection, withReplaySafety } from "../utils/replaySafety.js";
import { isFallbackDeadlineError } from "../utils/fallbackDeadline.js";
import { withRequestLifetime } from "../utils/requestLifetime.js";
import { waitForPreparation } from "../utils/preparationAbort.js";
import { createStageGuard } from "../utils/stageOutcome.js";
import { pendingShapingHandoffs } from "../../src/lib/db/repos/shapingHandoffsRepo.js";
import { injectHandoffPackets } from "../services/memory/handoffStore.js";
import { createContextTelemetry, recordContextAttempt, nextContextAttempt } from "./chatCore/contextTelemetry.js";
import { requireBudgetDispatchCoverage, beginBudgetDispatch, observeBudgetResponse, budgetErrorResult } from "../../src/sse/services/budgetDispatch.js";
import { BudgetAdmissionError, markBudgetUncertain, releaseUndispatchedBudgetReservation } from "../../src/lib/db/repos/budgetRepo.js";
import { isLocalTransportPoolRefusal } from "../utils/dispatcherCache.js";
import { createHash } from "node:crypto";
import { detectFormat } from "../services/provider.js";
import { resolveUpstreamRoute } from "./chatCore/upstreamRoute.js";
import { translateRequest } from "../translator/index.js";
import { assertTranslationContent, TranslationInputError } from "../translator/concerns/translationError.js";
import {
  applyThinking,
  extractThinking,
  stripThinkingSuffix,
} from "../translator/concerns/thinkingUnified.js";
import { FORMATS } from "../translator/formats.js";
import {
  normalizeClaudePassthrough,
  anchorClaudeCache,
  countCacheAnchors,
} from "../translator/formats/claude.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import {
  getModelStrip,
  getModelUpstreamId,
  getModelType,
  PROVIDER_ID_TO_ALIAS,
} from "../config/providerModels.js";
import { PROVIDERS } from "../config/providers.js";
import {
  createCallerAbortResult,
  createErrorResult,
  parseUpstreamError,
  formatProviderError,
  isCallerAbortError,
} from "../utils/error.js";
import { ANTIGRAVITY_SAFE_ERROR_MESSAGE } from "../services/antigravityValidation.js";
import { HTTP_STATUS, TOKEN_SAVER_HEADER } from "../config/runtimeConfig.js";
import { isBodyReadTimeoutError } from "../utils/bodyTimeout.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import {
  trackPendingRequest,
  appendRequestLog,
  saveRequestDetail,
  trackActiveSession,
} from "../../src/lib/usageDb.js";
import { decide, nextRid, req, reqSummary, notePath, RID_HEADER, onReqSummary } from "../../src/shared/observability/decide.js";
import { getExecutor } from "../executors/index.js";
import { supportsGrokCliReasoningEffort } from "../config/grokCli.js";
import {
  buildRequestDetail,
  extractRequestConfig,
} from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { withSaverHeaders } from "./chatCore/saverHeaders.js";
import { writeContextStatus } from "./chatCore/contextStatusStore.js";
import { sumSavedUsdSince, waitForLedgerWrite } from "../../src/lib/db/repos/costLedgerRepo.js";
import { clientRequestedStreaming as requestedStreaming } from "./chatCore/streamMode.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import {
  handleStreamingResponse,
  buildOnStreamComplete,
} from "./chatCore/streamingHandler.js";
import {
  detectClientTool,
  isNativePassthrough,
} from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { distillToolSchemas } from "../utils/schemaDistiller.js";
import { stripHistoricalThinking } from "../utils/thinkingStrip.js";
import { compressPrefixByQuery } from "../utils/queryAwareCompress.js";
import { dropOldestPairs } from "../utils/pairDropper.js";
import {
  microcompact,
  autocompact,
  computeEpochCutIndex,
  placeholderEpochSummarizer,
} from "../utils/epochCompact.js";
import { pruneExpiredToolResults } from "../utils/dietPrune.js";
import { compressBlobs, resolveLinguaEndpoint } from "../utils/linguaCompress.js";
import {
  chooseCacheTtl,
  recordEpochRate,
  topLevelKeySpans,
  volatileFieldReport,
} from "../utils/prefixStability.js";
import { reorderByRelevance } from "../utils/embedReorder.js";
import {
  injectBoundaryNote,
  composeBoundaryNote,
} from "../utils/midPrefixInject.js";
import { toolFilter } from "../utils/toolFilter.js";
import { disclosureTools } from "../utils/toolDisclosure.js";
import { injectCaveman } from "../rtk/caveman.js";
import { injectPonytail } from "../rtk/ponytail.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { redactOutbound } from "../utils/privacyFilter.js";
import { redactProxyUrlForLog } from "../utils/proxyFetch.js";
import {
  compressWithHeadroom,
  formatHeadroomLog,
  formatHeadroomSizeLog,
  isHeadroomPhantomSavings,
} from "../rtk/headroom.js";
import { compressWithPxpipe } from "../rtk/pxpipe.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { stripUnsupportedModalities } from "../translator/concerns/modality.js";
import {
  stripRejectedFields,
  addRejectedFields,
  getRejectedFields,
  extractRejectedFieldNamesFromError,
} from "../translator/concerns/adaptiveStripper.js";
import { MediaAggregateLimitError, prefetchRemoteImages } from "../translator/concerns/prefetch.js";
import { defaultClaudeToolType } from "../translator/concerns/toolCall.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { applyMemoryEnhancements } from "../services/memory/index.js";
// Imported from contextBudget directly rather than through the memory index:
// several suites mock that index wholesale, and a re-export would make the
// Headroom gate disappear (undefined is not callable) in every one of them.
import { measureContextPressure, estimateRequestTokens, calibrationFactor, CHARS_PER_TOKEN } from "../services/memory/contextBudget.js";
import { memoGet, memoSet } from "../services/memory/sessionMemo.js";
import { isConnectTimeoutError } from "../utils/responseHeaderTimeout.js";
import { applyCodexFastMode } from "../config/codexFastMode.js";
import { projectClientModelStatus } from "../config/modelErrorClassifier.js";

// Own every JSON container before translation or shaping mutates it. Direct
// engine callers can also attach opaque signals/streams/functions; retain
// those handles without sharing their surrounding mutable request records.
function isolateRequestBody(value, copies = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  if (copies.has(value)) return copies.get(value);
  const copy = Array.isArray(value) ? new Array(value.length) : Object.create(prototype);
  copies.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: isolateRequestBody(item, copies), enumerable: true, writable: true, configurable: true,
    });
  }
  return copy;
}

/**
 * One PROXY line per request, describing which egress the attempt uses.
 * Both branches go through redactProxyUrlForLog: the relay branch used to
 * print its URL whole while the sibling proxy branch masked its own, so a
 * relay token in a query string reached the log the proxy password never
 * did, and the proxy branch fell back to the RAW url whenever `new URL()`
 * threw (#2343).
 */
export function logProxySelection({ proxyOptions, credentials, provider, model, log }) {
  const connectionName =
    credentials?.connectionName || credentials?.connectionId || "unknown";
  const poolId =
    credentials?.providerSpecificData?.connectionProxyPoolId || "none";
  const prefix = `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId}`;

  if (proxyOptions.vercelRelayUrl) {
    log?.info?.("PROXY", `${prefix} | vercel-relay=${redactProxyUrlForLog(proxyOptions.vercelRelayUrl)}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    log?.info?.("PROXY", `${prefix} | url=${redactProxyUrlForLog(proxyOptions.connectionProxyUrl)}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    log?.debug?.(
      "PROXY",
      `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`,
    );
  }
}

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
/**
 * Remove translator-internal continuity fields from the outbound upstream
 * body. The Responses→Chat request translator stashes reasoning
 * `encrypted_content` on assistant messages so a later openai→responses
 * round-trip can restore the store=false continuity blob; that stash must
 * never reach an upstream provider. Chat-native proxies reject the unknown
 * assistant-message field and answer every turn with a literal "400" body
 * (observed with multi-turn Codex sessions via OpenAI-compatible nodes).
 */
export function stripContinuityFields(body, provider, model, log) {
  if (!body || !Array.isArray(body.messages)) return body;
  if (provider && model) {
    const rejected = getRejectedFields(provider, model);
    if (rejected.size) {
      log?.debug?.(
        "FIELDSTRIP",
        `preSend strip ${provider}/${model}: blocked ${[...rejected].join(", ")}`,
      );
      const stripped = stripRejectedFields(body, provider, model);
      if (stripped) body = stripped;
    }
  }
  for (const msg of body.messages) {
    if (msg && typeof msg === "object") {
      delete msg.encrypted_content;
      delete msg.reasoning_encrypted_content;
    }
  }
  return body;
}

// REQ ce= cache-epoch collector: sid -> { blocks, tail, tailOff, len, at }.
// Bounded the same way decide.js bounds its path collector: cap 2048, TTL 30
// min, LRU eviction, one trim pass per insert. T-F1: per-block digests plus at
// most one raw block (64 KiB) are retained per session — 2048 entries times
// multi-MB bodies was GB-scale resident memory and an OOM trigger.
const CE_CAP = 2048;
const CE_TTL_MS = 30 * 60 * 1000;
const CE_BLOCK_BYTES = 64 * 1024;
const ceBodies = new Map();

// rid -> sid for in-flight requests, so the REQ summary a handler writes on
// completion can land the provider-billed prompt size on the session's
// context-status entry. A byte estimate divided by four undercounts a code
// and JSON heavy prompt by up to half, and an agent sizing its context from
// it believed it had room it did not have.
const ridSessions = new Map();
// sid -> provider-count / estimate ratio, the context budget's per-session
// calibration (contextBudget.calibrationFactor). Learned from each completed
// request and smoothed, so the ladder measures pressure in the tokens the
// window is actually enforced in rather than in a fixed chars-per-token guess.
const sessionCalibration = new Map();
function boundedSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > CE_CAP) {
    for (const k of map.keys()) {
      map.delete(k);
      if (map.size <= CE_CAP * 0.9) break;
    }
  }
}
function rememberRidSession(rid, sid, estimatedTokens, calibrationKey = sid) {
  if (!rid || !calibrationKey) return;
  boundedSet(ridSessions, rid, { sid, estimatedTokens, calibrationKey });
}
export function sessionCalibrationFor(sid) {
  return (sid && sessionCalibration.get(sid)) || 1;
}
onReqSummary((verdict, fields) => {
  const rid = typeof fields?.rid === "string" ? fields.rid : null;
  if (!rid) return;
  const key = fields.row || rid;
  const entry = ridSessions.get(key);
  if (!entry) return;
  ridSessions.delete(key);
  if (verdict !== "ok") return;
  const actual = fields.ctx;
  if (typeof actual !== "number" || !Number.isFinite(actual) || actual <= 0) return;
  if (entry.sid) {
    writeContextStatus(entry.sid, { rid, ctxTokensActual: actual });
    // Dollar rollup for the same entry: what the savers saved this session in
    // the last 24h, from the cost ledger's saver component (the cache-discount
    // component rides the same rollup but never claims to be saver work).
    // Async fire-and-forget; the sum resolves after the rid-stamped write
    // above, and the store's writeQueue serializes in invocation order, so
    // this merges over that row without a rid (it carries no completion field
    // and cannot trip the rid guard). waitForLedgerWrite chains THIS request's
    // async ledger write ahead of the read, or the rollup would lag one
    // request behind its own savings.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    waitForLedgerWrite(rid)
      .then(() => sumSavedUsdSince(entry.sid, since))
      .then((rollup) => {
        if (rollup && Number.isFinite(rollup.saverSavedUsd)) {
          writeContextStatus(entry.sid, { dollarsSaved: rollup.saverSavedUsd });
        }
      })
      .catch(() => { /* telemetry must never break the request path */ });
  }
  if (entry.estimatedTokens > 0) {
    const ratio = actual / entry.estimatedTokens;
    const prev = sessionCalibration.get(entry.calibrationKey);
    boundedSet(sessionCalibration, entry.calibrationKey, prev ? prev * 0.5 + ratio * 0.5 : ratio);
  }
});

// Shared-prefix byte count of `whole` against a stored previous body: one
// digest per CE_BLOCK_BYTES block plus a byte-for-byte tail compare, exact
// when the new body extends the old one, block-granular when history was
// rewritten earlier. See the digest rationale in trackCacheEpoch below.
function sharedPrefixBytes(prev, whole, byteLen) {
  const blocks = [];
  for (let off = 0; off < byteLen; off += CE_BLOCK_BYTES) {
    blocks.push(createHash("sha1").update(whole.subarray(off, off + CE_BLOCK_BYTES)).digest("base64"));
  }
  const fullPrev = Math.max(0, prev.blocks.length - 1);
  const n = Math.min(fullPrev, blocks.length);
  let i = 0;
  while (i < n && prev.blocks[i] === blocks[i]) i++;
  let ce = i * CE_BLOCK_BYTES;
  if (i === fullPrev && prev.tail) {
    const here = whole.subarray(prev.tailOff, prev.tailOff + prev.tail.length);
    const m = Math.min(prev.tail.length, here.length);
    let j = 0;
    while (j < m && prev.tail[j] === here[j]) j++;
    ce = prev.tailOff + j;
  }
  return Math.min(ce, prev.len, byteLen);
}

// Read-only sibling of trackCacheEpoch for the epoch-compaction stages: the
// same comparison against the session's previous final body WITHOUT storing
// this intermediate body (storing it would corrupt the epoch chain — the
// stages below may still mutate, and the tracker must record the final
// pre-dispatch body exactly once).
function peekCacheEpoch(sid, serialized) {
  const prev = sid ? ceBodies.get(sid) : null;
  if (!prev || Date.now() - prev.at > CE_TTL_MS) return null;
  const whole = Buffer.from(serialized, "utf8");
  return { ce: sharedPrefixBytes(prev, whole, whole.length), prevBytes: prev.len, bytes: whole.length };
}

function trackCacheEpoch(sid, serialized) {
  const whole = Buffer.from(serialized, "utf8");
  const byteLen = whole.length;
  const now = Date.now();
  // One digest per CE_BLOCK_BYTES block of the final body plus the raw bytes
  // of its last block. The shared prefix is then exact when the new body
  // extends the old one (the common case: a turn appended, so the first
  // difference falls inside the old last block, which is compared byte for
  // byte) and block-granular when history was rewritten earlier. Keeping
  // only the first 64 KiB of raw bytes pinned ce at 65536 for every body
  // over that size, and compactHint (ce under half the previous size) then
  // fired on every request of every large session, including byte-identical
  // resends: the MCP context_status tool told agents to compact constantly.
  const blocks = [];
  for (let off = 0; off < byteLen; off += CE_BLOCK_BYTES) {
    blocks.push(createHash("sha1").update(whole.subarray(off, off + CE_BLOCK_BYTES)).digest("base64"));
  }
  const lastOff = blocks.length ? (blocks.length - 1) * CE_BLOCK_BYTES : 0;
  let out;
  const prev = ceBodies.get(sid);
  if (prev && now - prev.at <= CE_TTL_MS) {
    out = { ce: sharedPrefixBytes(prev, whole, byteLen), prevBytes: prev.len, bytes: byteLen };
  }
  ceBodies.delete(sid);
  ceBodies.set(sid, {
    blocks,
    tail: Buffer.from(whole.subarray(lastOff)),
    tailOff: lastOff,
    len: byteLen,
    at: now,
  });
  if (ceBodies.size > CE_CAP) {
    for (const key of ceBodies.keys()) {
      ceBodies.delete(key);
      if (ceBodies.size <= CE_CAP * 0.9) break;
    }
  }
  return out;
}

// Prefix-stabilization telemetry per contextScope (context-tuning suite, task
// 6): the rolling epoch hit-rate samples, the recent inter-request gaps the
// adaptive TTL rule reads, and the previous body's top-level key sketch for
// volatile-field detection. Same bounded-Map + 30-min TTL discipline as
// ceBodies above; the sketch stores digests and lengths, never body bytes.
const prefixTelemetry = new Map();
const TELEMETRY_GAP_WINDOW = 8;

// Read-only peek for the anchor step: no entry is created for a request that
// may still bail before the final serializer records it.
function peekPrefixTelemetry(scope) {
  const entry = scope ? prefixTelemetry.get(scope) : null;
  if (!entry || Date.now() - entry.at > CE_TTL_MS) return null;
  return entry;
}

// One update per final pre-dispatch body, beside the trackCacheEpoch call:
// record the inter-request gap and the epoch sample, diff the top-level key
// sketch against the previous body's, and return the fields the
// context-status write carries ({ epochHitRate, volatileKeys }, each
// undefined when nothing was measured). Telemetry only — request bytes are
// never touched here.
function updatePrefixTelemetry(scope, serialized, tracked) {
  const now = Date.now();
  let entry = prefixTelemetry.get(scope);
  if (!entry || now - entry.at > CE_TTL_MS) {
    entry = { rates: [], gaps: [], lastAt: 0, sketch: null };
  }
  if (entry.lastAt > 0) {
    entry.gaps.push(now - entry.lastAt);
    if (entry.gaps.length > TELEMETRY_GAP_WINDOW) entry.gaps.shift();
  }
  entry.lastAt = now;
  entry.at = now;
  let epochHitRate;
  if (tracked && tracked.prevBytes > 0) {
    epochHitRate = recordEpochRate(entry.rates, tracked.ce / tracked.prevBytes);
  } else {
    epochHitRate = recordEpochRate(entry.rates, NaN);
  }
  let volatileKeys;
  const sketch = topLevelKeySpans(serialized);
  if (sketch) {
    if (entry.sketch) {
      volatileKeys = volatileFieldReport([entry.sketch, sketch]).volatileKeys;
    }
    entry.sketch = sketch;
  }
  boundedSet(prefixTelemetry, scope, entry);
  return { epochHitRate, volatileKeys };
}

export async function handleChatCore(options) {
  try {
    options.callerSignal?.throwIfAborted();
    options.connectTimeout?.fallbackDeadline?.throwIfExpired(options.callerSignal);
    const deadline = options.connectTimeout?.fallbackDeadline;
    return deadline
      ? await deadline.run((signal, releaseFallbackPreparation) => handleChatCoreAttempt({
        ...options, callerSignal: signal, releaseFallbackPreparation,
      }), { signal: options.callerSignal, onLateResult: discardLateResponse })
      : await handleChatCoreAttempt(options);
  } catch (error) {
    if (isFallbackDeadlineError(error)) {
      trackPendingRequest(options.modelInfo.model, options.modelInfo.provider, options.connectionId, false);
      return createErrorResult(504, error.message, null, { safeToReplay: false }, options.requestId);
    }
    if (!options.callerSignal?.aborted) throw error;
    trackPendingRequest(options.modelInfo.model, options.modelInfo.provider, options.connectionId, false);
    return createCallerAbortResult();
  }
}

function discardLateResponse(result) {
  try { Promise.resolve(result?.response?.body?.cancel()).catch(() => {}); } catch {}
}

async function handleChatCoreAttempt({
  requestId,
  contextTelemetry: contextIdentity = {},
  contextStructureEnabled = true,
  rtkAllowLossy = false,
  schemaAllowLossy = false,
  headroomAllowLossy = false,
  pxpipeAllowLossy = false,
  body,
  modelInfo,
  credentials: rawCredentials,
  callerSignal,
  log,
  onCredentialsRefreshed,
  onRequestSuccess,
  verificationContext,
  onValidationRequired,
  onVerificationSuccess,
  onEmptyStream,
  onDisconnect,
  clientRawRequest,
  connectionId,
  userAgent,
  apiKey,
  ccFilterNaming,
  rtkEnabled,
  schemaDistillEnabled,
  thinkingStripEnabled,
  queryAwareCompressionEnabled,
  pairDropEnabled,
  embedReorderEnabled,
  embedReorderUrl,
  embedReorderModel,
  midPrefixInjectEnabled,
  epochMicroEnabled,
  epochAutoEnabled,
  dietEnabled,
  linguaEnabled,
  adaptiveCacheTtlEnabled,
  privacyEnabled,
  privacyTerms,
  headroomEnabled,
  headroomUrl,
  headroomCompressUserMessages,
  headroomTimeoutMs,
  cavemanEnabled,
  cavemanLevel,
  ponytailEnabled,
  ponytailLevel,
  pxpipeEnabled,
  pxpipeMinChars,
  pxpipeTimeoutMs,
  pxpipeTransform,
  onPxpipeEvent,
  onTokenSaverEvent,
  sid,
  sourceFormatOverride,
  providerThinking,
  connectTimeout,
  releaseFallbackPreparation,
  memorySettings,
  toolDisclosure,
  codexFastMode,
  routeKindOverride = null,
}) {
  body = isolateRequestBody(body);
  const credentials = rawCredentials
    ? {
        ...rawCredentials,
        ...(rawCredentials.providerSpecificData &&
        typeof rawCredentials.providerSpecificData === "object" &&
        !Array.isArray(rawCredentials.providerSpecificData)
          ? { providerSpecificData: { ...rawCredentials.providerSpecificData } }
          : {}),
      }
    : rawCredentials;
  const { provider, model } = modelInfo;
  const contextScope = credentials?.sessionHash ? `${credentials.sessionHash}:${provider}:${model}:${connectionId || ""}` : sid;
  const notifyTerminalVerificationSuccess =
    onVerificationSuccess && verificationContext?.challengeIdAtStart
      ? async () => {
          try {
            await onVerificationSuccess({ challengeId: verificationContext.challengeIdAtStart });
          } catch {
            log?.warn?.("VERIFICATION", `success callback failed for ${String(connectionId).slice(0, 8)}`);
          }
        }
      : null;
  const requestStartTime = Date.now();
  const endPreparationSpan = contextIdentity.startSpan?.('preparation');
  // Stable per-session color so all lines of one CLI conversation share a tag
  const sessionSeed = (() => {
    try {
      return resolveSessionId({
        headers: clientRawRequest?.headers,
        body,
        connectionId,
        scope: provider,
      });
    } catch {
      return connectionId || "";
    }
  })();
  const emojiTag = log?.tagForSession
    ? log.tagForSession(sessionSeed)
    : log?.nextTag
      ? log.nextTag()
      : "";
  // `reqTag` is a display prefix and nothing else -- every consumer passes it
  // straight to log.line/log.errorLine -- so putting the request id INSIDE it
  // gives all ~20 emit sites in this file and its handlers a correlation id for
  // no further plumbing. That is what makes the existing ▶ and 📊 lines joinable:
  // the emoji namespace has 8 buckets and collides above ~4 in-flight requests,
  // which is why the live journal shows a 🟢 DONE landing before the 🟡 that
  // started it. The emoji stays for the operator's own eye.
  const rid = requestId || nextRid();
  const connPrefix = connectionId ? String(connectionId).slice(0, 8) : undefined;
  const reqTag = rid ? `${emojiTag} rid=${rid}`.trim() : emojiTag;

  const sourceFormat = sourceFormatOverride || detectFormat(body);
  const clientServiceTierSpecified = Object.prototype.hasOwnProperty.call(
    body,
    "service_tier",
  );

  // Check for bypass patterns (warmup, skip, cc naming) BEFORE tracking. These
  // return early and never reach completion, so they must not create a session
  // row that would linger as a phantom "active" entry on the dashboard.
  const bypassResponse = handleBypassRequest(
    body,
    model,
    ccFilterNaming,
  );
  if (bypassResponse) return bypassResponse;
  const contextCapture = await prepareContextCapture({ body: clientRawRequest?.body ?? body,
    headers: clientRawRequest?.headers, apiKey, enabled: contextStructureEnabled });
  callerSignal?.throwIfAborted();

  // Track as an active (concurrent) session for the dashboard. clientId is the
  // real client IP stamped by custom-server.js as x-tp-real-ip, which is the
  // only trustworthy source here: that wrapper deletes client-supplied
  // x-forwarded-for and trusts x-real-ip only from a loopback reverse proxy.
  // sessionId is the conversation-stable id resolved above. Fail-open: this
  // never blocks the request.
  try {
    const trackingHeaders = clientRawRequest?.headers || {};
    const clientId = trackingHeaders["x-tp-real-ip"] || "unknown";
    trackActiveSession({
      clientId,
      sessionId: sessionSeed,
      model,
      provider,
      connectionId,
    });
  } catch {
    // dashboard tracking must never break a request
  }

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  // Multi-endpoint providers: pick transport matching sourceFormat → zero translation.
  // A model-level targetFormat overrides that choice, and the transport follows it so
  // the body format and the endpoint never diverge.
  const { targetFormat, transport: useTransport } = resolveUpstreamRoute({
    provider,
    alias,
    model,
    sourceFormat,
    credentials,
  });
  if (useTransport && credentials) credentials.runtimeTransport = useTransport;
  const stripList = getModelStrip(alias, model);
  const upstreamModel = getModelUpstreamId(alias, model);
  const inputEstimate = estimateRequestTokens(body);
  const messageCount = Array.isArray(body.messages) ? body.messages.length : Array.isArray(body.input) ? body.input.length : null;
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);

  // Inject provider-level thinking config. A translated, unlevelled Claude
  // marker lets an explicit provider level supply the missing effort.
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  if (!passthrough && providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    const clientThinking = extractThinking(body);
    const explicitClientEffort =
      body.reasoning_effort ?? body.reasoning?.effort;
    const hasExplicitClientEffort =
      typeof explicitClientEffort === "string" && explicitClientEffort !== "auto";
    const hasUnlevelledClaudeThinking =
      sourceFormat === FORMATS.CLAUDE &&
      body.thinking &&
      clientThinking?.mode === "auto";

    if (hasUnlevelledClaudeThinking && mode !== "on" && mode !== "off") {
      // The Claude shape wins extractThinking's precedence, so remove an
      // unlevelled enabled/adaptive marker before the configured level is
      // captured for a translated route. Keep an explicit client effort.
      body = { ...body };
      delete body.thinking;
      if (body.output_config?.effort === "auto") {
        const { effort: _effort, ...outputConfig } = body.output_config;
        if (Object.keys(outputConfig).length) body.output_config = outputConfig;
        else delete body.output_config;
      }
      if (body.reasoning_effort === "auto") delete body.reasoning_effort;
      if (body.reasoning?.effort === "auto") {
        const { effort: _effort, ...reasoning } = body.reasoning;
        if (Object.keys(reasoning).length) body.reasoning = reasoning;
        else delete body.reasoning;
      }
      if (!hasExplicitClientEffort) body.reasoning_effort = mode;
    } else if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const clientRequestedStreaming = requestedStreaming(body, sourceFormat);
  const providerRequiresStreaming = PROVIDERS[provider]?.forceStream === true;
  let stream = providerRequiresStreaming ? true : clientRequestedStreaming;

  // Image generation models require non-streaming (Google v1internal:generateContent)
  const modelType = getModelType(alias, model);
  const isImageGenModel =
    modelType === "imageGen" || /image|imagen|image-generation/i.test(model);
  if (
    isImageGenModel &&
    (provider === "antigravity" || provider === "gemini-cli")
  ) {
    stream = false;
  }

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  if (clientTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (
    clientPrefersJson &&
    !clientPrefersSSE &&
    body.stream !== true &&
    !providerRequiresStreaming
  ) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(
    sourceFormat,
    targetFormat,
    model,
    { signal: callerSignal },
  );
  let loggerOwnsStream = false;
  const closeRequestLog = () => { Promise.resolve(reqLogger.close?.()).catch(() => {}); };
  const deliverLoggedStream = async (options) => {
    const result = await handleStreamingResponse(options);
    loggerOwnsStream = result?.success === true;
    return result;
  };
  try {
  if (clientRawRequest)
    reqLogger.logClientRawRequest(
      clientRawRequest.endpoint,
      clientRawRequest.body,
      clientRawRequest.headers,
    );
  reqLogger.logRawRequest(body);
  log?.debug?.(
    "FORMAT",
    `${sourceFormat} → ${targetFormat} | stream=${stream}`,
  );

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  // Expose raw client headers to translators/executors for session-id resolution
  if (credentials) credentials.rawHeaders = clientRawRequest?.headers || {};

  // Auto-strip media blocks the model can't read (vision/audio/pdf) before translation.
  if (!passthrough) {
    try {
      assertTranslationContent(sourceFormat, targetFormat, body);
    } catch (error) {
      if (!(error instanceof TranslationInputError)) throw error;
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, error.message, null, {
        safeToReplay: false,
        failurePhase: "translation",
      }, rid);
    }
    const caps = getCapabilitiesForModel(provider, model);
    if (stripUnsupportedModalities(body, sourceFormat, caps)) {
      log?.debug?.(
        "MODALITY",
        `stripped unsupported media for ${provider}/${model}`,
      );
    }
    // Convert remote image URLs to base64 for targets that can't fetch URLs.
    try {
      const n = await prefetchRemoteImages(body, sourceFormat, targetFormat, {
        signal: callerSignal,
      });
      if (n > 0)
        log?.debug?.(
          "MODALITY",
          `prefetched ${n} remote image(s) for ${targetFormat}`,
        );
    } catch (e) {
      callerSignal?.throwIfAborted();
      if (e instanceof MediaAggregateLimitError) {
        return createErrorResult(413, e.message, null, { safeToReplay: false, failurePhase: 'preparation' }, rid);
      }
      log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`);
    }
  }

  let translatedBody;
  let toolNameMap;
  let customToolNames;
  let responsesToolNameMap;
  if (passthrough) {
    log?.debug?.(
      "PASSTHROUGH",
      `${clientTool} → ${provider} | native lossless`,
    );
    translatedBody = { ...body, model: stripThinkingSuffix(upstreamModel) };
    // The Responses API takes reasoning.effort NESTED; a flat reasoning_effort is
    // rejected. Gating this on provider === "codex" meant the official OpenAI
    // provider, which is a distinct registry entry serving the same API, got the
    // flat field and answered 400 on gpt-5.6 (#3154). The condition that actually
    // matters is the wire format, not which provider happens to speak it.
    if (targetFormat === FORMATS.OPENAI_RESPONSES) {
      const suffixThinking = {};
      applyThinking(FORMATS.OPENAI, upstreamModel, suffixThinking, provider);
      if (suffixThinking.reasoning_effort) {
        const reasoning = translatedBody.reasoning;
        translatedBody.reasoning = {
          ...(reasoning &&
          typeof reasoning === "object" &&
          !Array.isArray(reasoning)
            ? reasoning
            : {}),
          effort: suffixThinking.reasoning_effort,
        };
        delete translatedBody.reasoning_effort;
      }
    }
    // Normalize newer Cowork/CC beta shapes (adaptive thinking, mid-conversation system) the API rejects
    if (clientTool === "claude") {
      normalizeClaudePassthrough(
        translatedBody,
        translatedBody.model,
        clientRawRequest?.headers || null,
      );
    }
  } else {
    try {
      translatedBody = translateRequest(
      sourceFormat,
      targetFormat,
      upstreamModel,
      body,
      stream,
      credentials,
      provider,
      reqLogger,
      stripList,
      connectionId,
      clientTool,
      );
    } catch (error) {
      if (!(error instanceof TranslationInputError)) throw error;
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, error.message, null, {
        safeToReplay: false,
        failurePhase: "translation",
      }, rid);
    }
    if (!translatedBody) {
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(
        HTTP_STATUS.BAD_REQUEST,
        `Failed to translate request for ${sourceFormat} → ${targetFormat}`,
      );
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    customToolNames = translatedBody._customToolNames;
    delete translatedBody._customToolNames;
    responsesToolNameMap = translatedBody._responsesToolNameMap;
    delete translatedBody._responsesToolNameMap;
    translatedBody.model = stripThinkingSuffix(upstreamModel);
    translatedBody = stripContinuityFields(translatedBody, provider, model, log);
  }

  translatedBody = applyCodexFastMode(translatedBody, {
    provider,
    model,
    enabled: codexFastMode,
    clientServiceTierSpecified,
    clientServiceTier: body.service_tier,
  });

  // Sync the negotiated stream flag into the upstream body. `stream` may differ
  // from the client's body.stream (forceStream providers, Accept-header JSON
  // preference). Guarded: gemini-cli/antigravity passthrough bodies never carry
  // the key, and injecting stream:true into them would change the wire format.
  if ("stream" in translatedBody || providerRequiresStreaming) {
    if (translatedBody.stream !== stream) translatedBody.stream = stream;
  }

  // Tool normalization: MCP-equivalent built-in dedup (Claude clients) + same-name
  // dedup for DeepSeek models (upstream rejects duplicate tool names on all endpoints).
  // Ledger: the whole block ran pre-ledger and was invisible in save=. Measure
  // the tools bytes before dedupe, close the stage after disclosure, and fold
  // the result into saverStages below so a strip shows up as a "tools" stage
  // entry (negative delta) instead of vanishing into the entry bytes.
  let toolsStageDelta = null;
  let toolsStripped = false;
  const toolsBeforeSerialized = JSON.stringify(translatedBody);
  const toolsBeforeBytes = Buffer.byteLength(toolsBeforeSerialized);
  // Serializing the whole body twice to bracket this block cost a second full
  // pass over every request, including the overwhelmingly common one where
  // nothing in the block fires. Every mutation between the two measurements
  // sets this flag, so the closing measurement runs only when the bytes can
  // actually have moved; otherwise it reuses the opening number, which is then
  // exact rather than an estimate. `toolsStripped` cannot stand in: a
  // disclosure pass that strips nothing still replaces the array and can
  // reorder it, and the TTS branch below changes messages as well as tools.
  let toolsBodyMutated = false;
  // Per-request opt-out: computed early so token savers (including disclosure) can respect it.
  const tokenSaverEnabled =
    clientRawRequest?.headers?.[TOKEN_SAVER_HEADER]?.toLowerCase?.() !== "off";
  const toolsGuard = createStageGuard({
    rollback: () => { translatedBody = JSON.parse(toolsBeforeSerialized); toolsBodyMutated = false; toolsStripped = false; },
  });
  toolsGuard.sync("tools", () => {
  if (Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools, { clientTool, model });
    if (stripped.length > 0) {
      toolsStripped = true;
      translatedBody.tools = deduped;
      toolsBodyMutated = true;
      log?.debug?.(
        "TOOLDEDUP",
        `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`,
      );
    }
  }


  // Progressive tool disclosure: static filter (Phase 1) + BM25 selection (Phase 2).
  // Runs after dedupeTools, before RTK/headroom. cache_control stamping is NOT
  // done here — anchorClaudeCache at the end of the pipeline stays the single
  // source of truth for cache breakpoints.
  if (Array.isArray(translatedBody.tools) && translatedBody.tools.length > 0) {
    const beforeN = translatedBody.tools.length;
    const beforeBytes = log?.debug
      ? JSON.stringify(translatedBody.tools).length
      : 0;

    if (tokenSaverEnabled) {
      if (toolDisclosure?.filterEnabled) {
        const filtered = toolFilter(translatedBody.tools, toolDisclosure);
        if (filtered.length < translatedBody.tools.length) {
          toolsStripped = true;
          log?.debug?.(
            "TOOLDISCLOSE",
            `filter: ${translatedBody.tools.length}→${filtered.length} tools`,
          );
          translatedBody.tools = filtered;
          toolsBodyMutated = true;
        }
      }

      if (toolDisclosure?.disclosureEnabled) {
        // Keyed by the client session, not by connection: one connection
        // serves many interleaved sessions, an account failover moves a
        // session across connections, and the disclosed list is sticky per
        // session (toolDisclosure.js) so the tools prefix stays cacheable.
        const { tools: disclosed, stats } = disclosureTools(
          translatedBody.tools,
          body,
          sid ? `sid|${sid}` : connectionId,
          toolDisclosure,
        );
        if (stats) {
          if ((stats.stripped ?? 0) > 0) toolsStripped = true;
          log?.debug?.(
            "TOOLDISCLOSE",
            `bm25: ${stats.before}→${stats.after} tools (-${stats.stripped})`,
          );
          translatedBody.tools = disclosed;
          toolsBodyMutated = true;
        }
      }
    }

    const afterN = translatedBody.tools.length;
    if (log?.debug) {
      const afterBytes = JSON.stringify(translatedBody.tools).length;
      log.debug(
        "TOOLDISCLOSE",
        `measure: ${beforeN}tools ${beforeBytes}B → ${afterN}tools ${afterBytes}B`,
      );
    }
  }

  });
  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(
      (msg) => msg.role !== "tool",
    );
    delete translatedBody.tools;
    toolsBodyMutated = true;
  }

  // Token-saver byte ledger: whole-body per-stage deltas with serialization
  // only at potentially changed boundaries. Feeds REQ save=/save_tok=, the XFORM.saver-guard anomaly
  // line, bytesSaved on the saver event rows, and the honest growth check.
  // Disabled stages retain explicit zero-delta rows without body serialization.
  // privacy runs under its own flag below (line ~758), independent of
  // tokenSaverEnabled, so its measurement must not depend on the token-saver
  // union either.
  const saverWillRun = Boolean(
    pxpipeEnabled ||
      privacyEnabled ||
      (tokenSaverEnabled &&
        (rtkEnabled ||
          schemaDistillEnabled ||
          thinkingStripEnabled ||
          queryAwareCompressionEnabled ||
          pairDropEnabled ||
          embedReorderEnabled ||
          midPrefixInjectEnabled ||
          epochMicroEnabled ||
          epochAutoEnabled ||
          dietEnabled ||
          linguaEnabled ||
          headroomEnabled ||
          cavemanEnabled ||
          ponytailEnabled ||
          memorySettings)),
  );
  // preSaverSerialized is the cost ledger's counterfactual baseline, so the
  // serialize is unconditional; toolsBodyMutated still gates the byte delta.
  const preSaverSerialized = JSON.stringify(translatedBody);
  const toolsAfterBytes = toolsBodyMutated ? Buffer.byteLength(preSaverSerialized) : toolsBeforeBytes;
  toolsStageDelta = { in: toolsBeforeBytes, out: toolsAfterBytes, delta: toolsAfterBytes - toolsBeforeBytes, ran: true,
    ...toolsGuard.measurement("tools", true, preSaverSerialized !== toolsBeforeSerialized) };
  const saverStages = [];
  const contextStages = [{ stage: "tools", ...toolsStageDelta }];
  const contextHandoffs = [];
  // The tools-normalization block above ran before this ledger existed; fold
  // its measured delta in as the first stage so save= attributes the strip.
  if (toolsStageDelta.delta !== 0) saverStages.push({ stage: "tools", ...toolsStageDelta });
  if (toolsStripped) notePath(rid, "XFORM.tool-strip");
  // Per-stage compressed-turn indices for the qac/thinking event rows (the
  // dashboard shows WHICH turns a stage compressed, bounded at 8).
  let thinkingTurns = [];
  let qacTurns = [];
  let memStats = null;
  // Accumulates the human-readable summary the mid-prefix note lands at the
  // kept-region boundary (midPrefixInject below). Capped at 12 entries.
  const PREFIX_NOTES_MAX = 12;
  const prefixNotes = [];
  const prefixTurnIndices = [];
  const pushPrefixNote = (note) => {
    if (prefixNotes.length < PREFIX_NOTES_MAX) prefixNotes.push(note);
  };
  const saverPrev = { bytes: toolsAfterBytes, serialized: preSaverSerialized };
  const saverEntryBytes = saverPrev ? saverPrev.bytes : 0;
  const stageGuard = createStageGuard({
    signal: callerSignal,
    rollback: () => { translatedBody = JSON.parse(saverPrev.serialized); },
    onCancelled: async (stage) => {
      measureSaverStage(stage, true);
      const cancelled = createContextTelemetry({
        ...contextIdentity, sessionHash: credentials?.sessionHash, sessionIdentitySource: credentials?.sessionIdentitySource,
        dispatchCoverage: "preparation-only", explicitIdentity: contextCapture.identity,
        structures: [contextCapture.initial].filter(Boolean), timestamp: new Date(requestStartTime).toISOString(),
        requestedModel: clientRawRequest?.body?.model || body.model, clientTool, inputEstimate, messageCount, toolCount,
        bodyAfterBytes: saverPrev.bytes, stages: contextStages, handoffs: contextHandoffs,
        routeKind: routeKindOverride || (passthrough ? "passthrough" : sourceFormat === targetFormat ? "same-format" : "translated"),
        formatPair: `${sourceFormat}>${targetFormat}`,
      });
      await recordContextAttempt(cancelled, { provider, model, connectionId, status: "aborted" });
    },
  });
  const measureSaverStage = (stage, ran, measuredBytes, evaluated = ran) => {
    // Every mutation between ledger boundaries belongs to a gated stage.
    // A disabled stage retains its exact predecessor measurement and still
    // contributes an explicit zero-delta row. The final serializer supplies
    // its already-measured size so the ledger never serializes it twice.
    let serialized;
    try {
      serialized = ran ? (measuredBytes === undefined ? JSON.stringify(translatedBody) : finalSerialized) : saverPrev.serialized;
    } catch (error) {
      stageGuard.failed(stage, error);
      serialized = saverPrev.serialized;
    }
    const at = measuredBytes ?? (ran ? Buffer.byteLength(serialized) : saverPrev.bytes);
    const measurement = { ran: Boolean(ran), stage, delta: at - saverPrev.bytes, in: saverPrev.bytes, out: at,
      ...stageGuard.measurement(stage, Boolean(evaluated), serialized !== saverPrev.serialized) };
    contextStages.push(measurement);
    if (saverWillRun && at !== saverPrev.bytes) saverStages.push(measurement);
    saverPrev.bytes = at;
    saverPrev.serialized = serialized;
  };

  // Schema distillation: strip validation-noise JSON-Schema keywords from
  // tool input_schemas (default/examples/example/$schema/title) plus schema
  // description whitespace. Conservative: tool name/description are never
  // touched, structural keywords survive, and it engages only past an 8KB
  // serialized-tools floor. It runs here, after the ledger baseline, rather
  // than up beside dedupeTools, so measureSaverStage attributes the
  // whole-body delta to the "schema" stage instead of folding it into the
  // entry bytes and losing it from save=.
  const schemaDistillRan =
    tokenSaverEnabled && schemaDistillEnabled && Array.isArray(translatedBody.tools);
  stageGuard.sync("schema", () => {
    const distilled = distillToolSchemas(translatedBody.tools, { allowLossy: schemaAllowLossy });
    if (distilled.savedBytes > 0) {
      translatedBody.tools = distilled.tools;
      notePath(rid, "XFORM.tool-distill");
    }
  }, schemaDistillRan);
  measureSaverStage("schema", schemaDistillRan);

  // Prefix token-savers (#token-savers). The pipeline is in two halves.
  //
  //   1. Deterministic, every request: thinking strip, rtk, privacy, the
  //      style injections, pxpipe. Same input, same output, so the prompt
  //      prefix the provider cached keeps matching turn to turn.
  //   2. Under context pressure only, least loss first: the memory ladder
  //      (media, then tool results oldest-first), headroom on the oldest
  //      slice, query-aware compression, pair dropping, embedding reorder.
  //      Each decision here is remembered per client session
  //      (services/memory/sessionMemo.js) and replayed identically on later
  //      turns, so a rung that fired once does not fire differently next
  //      time and rewrite the cached prefix again.
  //
  // The boundary note (midinject) then lands on the live user turn, which
  // is new every request anyway, never inside the cached region. All prefix
  // stages are Claude-target only, same gate as anchorClaudeCache below.
  const claudePrefixTarget = finalFormat === FORMATS.CLAUDE;
  const prefixMessages = () =>
    Array.isArray(translatedBody.messages) ? translatedBody.messages : null;
  // Text of the LAST user message: string content, or the concatenated text
  // blocks of an array content. Empty means the stage has no query to work
  // against and stays silent.
  const lastUserQuery = (messages) => {
    if (!Array.isArray(messages)) return "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== "user") continue;
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n");
        if (text.trim()) return text;
      }
      return "";
    }
    return "";
  };

  // Thinking strip: reasoning blocks in historical assistant turns pay full
  // token cost for reasoning the model cannot act on; only the live turn keeps
  // its chain.
  // Anthropic itself drops previous-turn thinking from the billed prompt
  // (measured through the live gateway: identical prompt size with and
  // without a 1.5 KB historical thinking block), so on its own endpoint the
  // strip saves nothing and only moves the prefix. It stays for
  // Claude-compatible third-party upstreams, which bill what they receive.
  const anthropicNative = provider === "claude" || provider === "anthropic";
  const thinkingWillRun =
    tokenSaverEnabled && thinkingStripEnabled && claudePrefixTarget && !anthropicNative && !!prefixMessages();
  stageGuard.sync("thinking", () => {
    const res = stripHistoricalThinking(translatedBody.messages, { keepRecentTurns: 1 });
    if (res.stripped > 0) {
      translatedBody.messages = res.messages;
      notePath(rid, "XFORM.thinking-stripped");
      for (const n of res.notes) {
        if (typeof n?.turn === "number") prefixTurnIndices.push(n.turn);
      }
      thinkingTurns = res.notes
        .filter((n) => typeof n?.turn === "number")
        .map((n) => n.turn)
        .slice(0, 8);
      pushPrefixNote({ kind: "thinking", text: `stripped ${res.stripped} reasoning block(s)` });
    }
  }, thinkingWillRun);
  measureSaverStage("thinking", thinkingWillRun);

  // RTK rewrites only this attempt's privately owned request containers.
  const rtkWillRun = tokenSaverEnabled && rtkEnabled;
  let rtkStats = null;
  stageGuard.sync("rtk", () => {
    const diagnostics = {};
    rtkStats = compressMessages(translatedBody, rtkWillRun, { allowLossy: rtkAllowLossy, diagnostics });
    stageGuard.report("rtk", diagnostics);
  });
  if (stageGuard.measurement("rtk", rtkWillRun, false).outcome === "failed") rtkStats = null;
  const rtkLine = formatRtkLog(rtkStats);
  if (rtkLine) console.log(rtkLine);
  measureSaverStage("rtk", rtkWillRun);
  // Row emission for every saver is deferred to just after the anchor stage
  // below, where the whole-body delta and the final-body cache epoch are both
  // known; the path code speaks here where the stage ran.
  if (tokenSaverEnabled && rtkStats?.hits?.length) {
    notePath(rid, "XFORM.rtk-applied");
  }

  // Privacy filter (#2728): pseudonymise emails and operator terms in the
  // outbound body, and carry the mapping to the response path so the client
  // gets its own values back and never sees a placeholder. Off by default —
  // when off, nothing below this comment runs.
  //
  // Skipped for a forced-SSE-to-JSON request: handleForcedSSEToJson assembles
  // the client body outside the two handlers wired for restoration, and a
  // one-directional redaction that leaks aliases is worse than no filter.
  let privacyFilter = null;
  // T-F3: the privacy filter mutates the body between the rtk and headroom
  // stage measures; without its own stage those bytes were attributed to
  // headroom (wrong save= and a false saver-guard).
  let privacyRan = false;
  stageGuard.sync("privacy", () => {
    privacyRan = true;
    privacyFilter = redactOutbound(translatedBody, privacyTerms);
    if (privacyFilter) {
      log?.debug?.("PRIVACY", `pseudonymised ${privacyFilter.size} value(s)`);
      if (privacyFilter.size > 0) notePath(rid, "XFORM.privacy-applied");
    }
  }, privacyEnabled && !(providerRequiresStreaming && !clientRequestedStreaming));
  measureSaverStage("privacy", privacyRan);

  // Token-saver flags accumulator for the single "⚙" log line below.
  const xf = [];

  // Caveman: inject terse-style system prompt. injectCaveman reports whether
  // the body actually changed; an unknown level or an already-injected prompt
  // must not claim XFORM.injected.
  stageGuard.sync("inject", () => {
  if (tokenSaverEnabled && cavemanEnabled && cavemanLevel) {
    if (injectCaveman(translatedBody, finalFormat, cavemanLevel)) {
      xf.push(`CAVEMAN:${cavemanLevel}`);
      notePath(rid, "XFORM.injected");
    }
  }

  // Ponytail: inject lazy-senior-dev system prompt (same gate as caveman)
  if (tokenSaverEnabled && ponytailEnabled && ponytailLevel) {
    if (injectPonytail(translatedBody, finalFormat, ponytailLevel)) {
      xf.push(`PONYTAIL:${ponytailLevel}`);
      notePath(rid, "XFORM.injected");
    }
  }
  });
  measureSaverStage(
    "inject",
    tokenSaverEnabled &&
      ((cavemanEnabled && cavemanLevel) || (ponytailEnabled && ponytailLevel)),
  );

  // PXPIPE: image bulky context (Claude-format bodies only), last saver before dispatch
  let pxpipeSummary = null;
  await stageGuard.async("pxpipe", async () => {
    const pxpipeResult = await compressWithPxpipe(translatedBody, {
      enabled: tokenSaverEnabled,
      allowLossy: pxpipeAllowLossy,
      format: finalFormat,
      model: upstreamModel,
      minChars: pxpipeMinChars,
      timeoutMs: pxpipeTimeoutMs,
      transform: pxpipeTransform,
      signal: callerSignal,
    });
    pxpipeSummary = pxpipeResult.summary;
    if (pxpipeResult.body) translatedBody = pxpipeResult.body;
    if (pxpipeSummary?.applied) {
      xf.push(`PXPIPE:${pxpipeSummary.imageCount}img`);
      notePath(rid, "XFORM.pxpipe-applied");
    }
    try {
      onPxpipeEvent?.({ provider, model, ...pxpipeSummary });
    } catch {
      /* stats must not break requests */
    }
    stageGuard.report("pxpipe", pxpipeSummary);
  }, pxpipeEnabled);
  measureSaverStage("pxpipe", pxpipeEnabled);

  // Memory & Context Optimizer (Tool & Media Pruning, Compaction, Cache Anchoring, Handoffs)
  await stageGuard.async("mem", async () => {
    // THE MODEL'S OWN WINDOW decides when history has to be cut, and the
    // capability table already knows it (1,000,000 for the Opus and Sonnet 5
    // class, and a conservative default for anything it has not heard of).
    // Without this the memory pipeline ran on fixed thresholds and pruned a
    // conversation occupying 3% of its window.
    const memoryCaps = getCapabilitiesForModel(provider, upstreamModel);
    const memRes = await applyMemoryEnhancements(translatedBody, {
      settings: memorySettings,
      targetFormat: finalFormat,
      contextWindow: memoryCaps?.contextWindow ?? null,
      calibration: sessionCalibrationFor(contextScope),
      log,
    });
    stageGuard.report("mem", memRes);
    memStats = memRes.stats || null;
    const memBudget = memRes.stats?.budget;
    if (memBudget) {
      // The occupancy line, on every request. It is the only way to see from a
      // journal that a session is actually using the window it pays for, and
      // it is what made the old behavior visible in the first place.
      xf.push(
        `CTX:${Math.round(memBudget.projectedAfter / 1000)}k`
        + `/${Math.round(memBudget.limit / 1000)}k`,
      );
    }
    if (memRes.stats?.toolPruning?.applied) {
      xf.push(
        `TOOL-PRUNE:~${Math.round(memRes.stats.toolPruning.savedChars / 4)}t`,
      );
      notePath(rid, "XFORM.mem-pruned");
    }
    if (memRes.stats?.mediaPruning?.applied) {
      xf.push(`MEDIA-PRUNE:${memRes.stats.mediaPruning.savedItems}`);
    }
    if (memRes.stats?.compaction?.applied) {
      xf.push(`COMPACT:${memRes.stats.compaction.savedTokens}t`);
      notePath(rid, "XFORM.compact-applied");
    }
  }, tokenSaverEnabled && memorySettings);
  measureSaverStage("mem", tokenSaverEnabled && memorySettings);

  // ---- Pressure-driven prefix rungs. A rung rewrites the cached prefix, so
  // it runs only when the request does not fit, and its decisions are
  // memoised per session so the NEXT request reproduces them instead of
  // deciding afresh.
  // Keyed by the CLIENT session alone: an account failover retries the same
  // request on another connection, and a memo keyed by connection would
  // start over on exactly that retry.
  const sessionKey = sid || null;
  let prefixRewritten = Boolean(
    memStats?.toolPruning?.applied || memStats?.mediaPruning?.applied || memStats?.compaction?.applied,
  );
  const measurePrefixPressure = () =>
    measureContextPressure(translatedBody, {
      contextWindow: getCapabilitiesForModel(provider, upstreamModel)?.contextWindow ?? null,
      settings: memorySettings || undefined,
      calibration: sessionCalibrationFor(contextScope),
    });
  // The memory ladder cuts tool results oldest-first and prunes on chunk
  // crossings only, so between crossings the prefix is byte-stable and on a
  // crossing it changes from the NEWEST cut result onward. The text rungs
  // below (query-aware compression, pair dropping) edit turns anywhere in
  // the history, so a fresh decision from them lands EARLIER in the prefix
  // than the ladder's cut and costs more cache than it saves (measured: 701
  // KB of re-cache against 451 KB for the ladder alone). They are therefore
  // the ladder's next rung: they take new decisions only once the ladder has
  // run out of tool results to cut and the request is still over budget, and
  // otherwise only replay their memo. With no ladder rung enabled they are
  // the ladder and decide on any over-budget request.
  const memRungEnabled = Boolean(
    memorySettings &&
      (memorySettings.memoryToolPruningEnabled !== false ||
        memorySettings.memoryMediaPruningEnabled !== false ||
        memorySettings.memoryCompactionEnabled === true),
  );
  const mayDecideAnew = () => (memRungEnabled ? memStats?.budget?.overAfter === true : true);
  // Pair dropping asks for the same quantized deficit the ladder uses, so two
  // requests inside one relief chunk drop the same pairs.
  const quantizedDeficitChars = (pressure) => {
    const chunk = Math.max(1, Math.ceil((pressure.budget - pressure.target) * (CHARS_PER_TOKEN / (pressure.calibration || 1))));
    return Math.ceil(pressure.deficitChars / chunk) * chunk;
  };

  // Headroom: optional external proxy compression; fail open if proxy is absent.
  //
  // The measurement is taken here and passed down; headroom.js owns the gate
  // and the reason it exists. Inside the budget the body is left exactly as the
  // client sent it, so the prompt prefix stays byte-identical turn to turn and
  // the provider's cache keeps hitting.
  const headroomDiagnostics = {};
  const headroomPressure = tokenSaverEnabled && headroomEnabled ? measurePrefixPressure() : null;
  let headroomStats = null;
  await stageGuard.async("headroom", async () => {
    headroomStats = await compressWithHeadroom(translatedBody, {
    enabled: tokenSaverEnabled && headroomEnabled,
    allowLossy: headroomAllowLossy,
    url: headroomUrl,
    model: upstreamModel,
    format: finalFormat,
    compressUserMessages: headroomCompressUserMessages,
    timeoutMs: headroomTimeoutMs,
    contextPressure: headroomPressure,
    diagnostics: headroomDiagnostics,
    signal: callerSignal,
  });
    stageGuard.report("headroom", headroomDiagnostics);
  });
  const headroomLine = formatHeadroomLog(headroomStats);
  const headroomSizeLine = formatHeadroomSizeLog(headroomDiagnostics);
  measureSaverStage("headroom", tokenSaverEnabled && headroomEnabled);
  if (
    tokenSaverEnabled &&
    Number.isFinite(headroomStats?.tokens_saved) &&
    headroomDiagnostics?.after
  ) {
    // Row emission deferred past the anchor stage, where the whole-body
    // delta and the final-body cache epoch are both known (same as RTK).
    notePath(rid, "XFORM.headroom-applied");
    prefixRewritten = true;
  }
  if (headroomLine) {
    log?.info?.(
      "HEADROOM",
      `${headroomLine}${headroomSizeLine ? ` | ${headroomSizeLine}` : ""}`,
    );
    if (isHeadroomPhantomSavings(headroomStats, headroomDiagnostics)) {
      const phantomBefore = headroomDiagnostics?.before?.bodyBytes || 0;
      const phantomAfter = headroomDiagnostics?.after?.bodyBytes || 0;
      decide("XFORM", "headroom-phantom", {
        rid,
        delta: headroomStats.tokens_saved,
        shrunk_pct: phantomBefore > 0 ? Math.round(((phantomBefore - phantomAfter) / phantomBefore) * 1000) / 10 : 0,
      });
      log?.warn?.(
        "HEADROOM",
        `reported token delta, but outbound JSON shrank <5%; provider may bill near-original payload | ${formatHeadroomSizeLog(headroomDiagnostics)}`,
      );
    }
  } else if (tokenSaverEnabled) {
    // Folded fork (docs/logging-design.md row 52): a path code on the REQ
    // line, not its own line.
    notePath(rid, "XFORM.headroom-skip");
    // Gating this warn on headroomEnabled meant the ONE case a user needs told
    // about, the toggle being off while the dashboard reads Running because the
    // proxy answers, was the case that logged nothing at all (#1956). Say why in
    // both cases; the reason already distinguishes them.
    log?.warn?.(
      "HEADROOM",
      `skipped: ${headroomEnabled ? (headroomDiagnostics.reason || "compression unavailable") : "disabled in settings"}${headroomDiagnostics.endpoint ? ` (${headroomDiagnostics.endpoint})` : ""}`,
    );
  }


  // Query-aware compression. Memo replay every turn (a block compressed on an
  // earlier turn stays compressed whatever this turn's query says); fresh
  // scoring only while the request is still over budget. A tool_result turn
  // has no query and used to skip the stage, which flipped the whole
  // historical prefix between placeholder and full text on alternate
  // requests.
  const qacWillRun =
    tokenSaverEnabled && queryAwareCompressionEnabled && claudePrefixTarget && !!prefixMessages();
  stageGuard.sync("qac", () => {
    let qacMemo = sessionKey ? memoGet("qac", sessionKey) : null;
    if (sessionKey && !qacMemo) {
      qacMemo = new Set();
      memoSet("qac", sessionKey, qacMemo);
    }
    const scoreNew = measurePrefixPressure().over && mayDecideAnew();
    const query = lastUserQuery(translatedBody.messages);
    if (query.trim() || qacMemo?.size) {
      const res = compressPrefixByQuery(translatedBody.messages, {
        query,
        keepRecentTurns: 2,
        memo: qacMemo,
        scoreNew,
      });
      if (res.compressed > 0) {
        translatedBody.messages = res.messages;
        notePath(rid, "XFORM.qac-applied");
        if (res.added > 0) prefixRewritten = true;
        qacTurns = res.notes
          .filter((n) => typeof n?.turn === "number")
          .map((n) => n.turn)
          .slice(0, 8);
        pushPrefixNote({
          kind: "qac",
          text: `compressed ${res.compressed} low-relevance turn(s)`,
        });
      }
    } else stageGuard.report("qac", { outcome: "skipped" });
  }, qacWillRun);
  measureSaverStage("qac", qacWillRun);

  // Pair dropping: demand-driven, like the memory pruner. The deficit is how
  // far the request overruns its budget target, measured with the same
  // measureContextPressure call the headroom and memory stages use, with the
  // model's own window from the capability table. Nothing drops while the
  // request fits its window. Runs AFTER the mem stage on purpose: toolPruner
  // covers 12-25x more deficit per run than pairs, so pairs burning droppable
  // pairs first would spend them before the cheaper, larger reclaim ran.
  const pairsWillRun =
    tokenSaverEnabled && pairDropEnabled && claudePrefixTarget && !!prefixMessages();
  stageGuard.sync("pairs", () => {
    const pairsPressure = measurePrefixPressure();
    if (pairsPressure.deficitChars > 0 && mayDecideAnew()) {
      const res = dropOldestPairs(translatedBody.messages, {
        deficitChars: quantizedDeficitChars(pairsPressure),
        keepRecentTurns: 6,
      });
      if (res.droppedPairs > 0) {
        translatedBody.messages = res.messages;
        notePath(rid, "XFORM.pairs-dropped");
        prefixRewritten = true;
        // Pairs DELETES entries and reorder PERMUTES them: the turn indices
        // thinking/qac recorded now point at whatever slid into those slots,
        // and min() of them could land the boundary note on a live recent
        // turn (a false statement to the model). Clear them: the
        // last-user-message fallback below then applies.
        prefixTurnIndices.length = 0;
        pushPrefixNote({
          kind: "pairs",
          text: `dropped ${res.droppedPairs} pair(s) (~${res.savedChars} chars)`,
        });
      }
    } else stageGuard.report("pairs", { outcome: "skipped" });
  }, pairsWillRun);
  measureSaverStage("pairs", pairsWillRun);

  // Epoch-aligned compaction cascade (#context-tuning): diet prunes expired
  // tool_result payloads, microcompact stubs old tool_result payloads,
  // autocompact replaces the pre-tail history with one summary message. All
  // mutate ONLY below the session's cache-epoch cut — the byte region the
  // provider still serves from cache — so they run after pairs and before the
  // final cache anchor. The cut comes from a read-only peek at the previous
  // epoch entry: storing this intermediate body would corrupt the epoch
  // chain the final serializer records. diet runs first and replaces payloads
  // in place (no message count change), so the index-based cut stays valid
  // for the later stages.
  const epochStageWanted =
    tokenSaverEnabled &&
    (epochMicroEnabled || epochAutoEnabled || dietEnabled || linguaEnabled) &&
    claudePrefixTarget &&
    !!prefixMessages();
  let epochCutIndex = 0;
  if (epochStageWanted) {
    const peek = peekCacheEpoch(contextScope, JSON.stringify(translatedBody));
    epochCutIndex = peek ? computeEpochCutIndex(translatedBody.messages, peek) : 0;
  }

  // AgentDiet-style expired tool-result pruning: old, unreferenced tool_result
  // payloads below the epoch cut are stubbed; pairs and tool_use blocks are
  // never touched. Default off (dietEnabled).
  const dietWillRun = epochStageWanted && dietEnabled;
  let dietApplied = false;
  stageGuard.sync("diet", () => {
    const res = pruneExpiredToolResults(translatedBody, {
      epochCutIndex,
      minAgeTurns: 8,
      minBlockChars: 2048,
      referenceScanTurns: 3,
    });
    if (res.applied) {
      translatedBody.messages = res.messages;
      dietApplied = true;
      prefixRewritten = true;
      notePath(rid, "XFORM.diet");
      pushPrefixNote({
        kind: "diet",
        text: `pruned ${res.prunedBlocks} expired tool_result(s) (~${res.prunedChars} chars)`,
      });
    }
  }, dietWillRun && epochCutIndex > 0);
  measureSaverStage("diet", dietApplied, undefined, dietWillRun && epochCutIndex > 0);

  // LLMLingua-2 selective compression: large natural-language-ish user/
  // tool_result blobs below the epoch cut are compressed in place by a
  // loopback-only sidecar (env TOKENPROXY_LINGUA_ENDPOINT, read at request
  // time). The content classifier skips JSON/code-fence/diff-hunk/keyword-
  // heavy blobs; system messages and the latest assistant turn are never
  // candidates. Fail-closed: any backend failure reports applied:false and
  // leaves the body byte-identical, with the reason in the debug log only.
  // Default off (linguaEnabled).
  const linguaWillRun = epochStageWanted && linguaEnabled;
  let linguaApplied = false;
  let linguaSkip = null;
  await stageGuard.async("lingua", async () => {
    const res = await compressBlobs(translatedBody, {
      epochCutIndex,
      endpoint: resolveLinguaEndpoint(),
      signal: callerSignal,
      log,
    });
    linguaSkip = res.skip ?? null;
    stageGuard.report("lingua", res);
    if (res.applied) {
      translatedBody.messages = res.messages;
      linguaApplied = true;
      prefixRewritten = true;
      notePath(rid, "XFORM.lingua");
      pushPrefixNote({
        kind: "lingua",
        text: `compressed ${res.compressedBlocks} blob(s) (~${res.savedChars} chars)`,
      });
    }
  }, linguaWillRun && epochCutIndex > 0);
  measureSaverStage("lingua", linguaApplied, undefined, linguaWillRun && epochCutIndex > 0);

  const epochMicroWillRun = epochStageWanted && epochMicroEnabled;
  let epochMicroApplied = false;
  stageGuard.sync("epochMicro", () => {
    const res = microcompact(translatedBody, {
      epochCutIndex,
      keepLastTurns: 4,
    });
    if (res.applied) {
      translatedBody.messages = res.messages;
      epochMicroApplied = true;
      prefixRewritten = true;
      notePath(rid, "XFORM.epoch-micro");
      pushPrefixNote({
        kind: "epochMicro",
        text: `cleared ${res.clearedBlocks} block(s) (~${res.clearedChars} chars)`,
      });
    }
  }, epochMicroWillRun && epochCutIndex > 0);
  measureSaverStage("epochMicro", epochMicroApplied, undefined, epochMicroWillRun && epochCutIndex > 0);

  const epochAutoWillRun = epochStageWanted && epochAutoEnabled;
  let epochAutoApplied = false;
  // Skip-cause classification for the telemetry row: a stable/unknown epoch
  // is "epoch_boundary"; only a genuinely below-trigger evaluation is
  // "window_pressure"; every other non-fire (no window known, nothing
  // droppable, summarizer failure, pair straddling the cut) reports no
  // reason rather than a wrong one.
  let epochAutoSkipReason = null;
  if (epochAutoWillRun && epochCutIndex === 0) {
    epochAutoSkipReason = "epoch_boundary";
  }
  await stageGuard.async("epochAuto", async () => {
    // The model's own window from the capability table, same lookup the
    // memory ladder and pair dropping use.
    const epochWindowTokens =
      getCapabilitiesForModel(provider, upstreamModel)?.contextWindow ?? null;
    if (Number.isFinite(epochWindowTokens) && epochWindowTokens > 0) {
      const res = await autocompact(translatedBody, {
        windowTokens: epochWindowTokens,
        usedTokens: estimateRequestTokens(translatedBody),
        summarizeFn: placeholderEpochSummarizer,
        keepRecentTurns: 6,
        epochCutIndex,
      });
      stageGuard.report("epochAuto", res);
      if (res.applied) {
        translatedBody.messages = res.messages;
        epochAutoApplied = true;
        prefixRewritten = true;
        notePath(rid, "XFORM.epoch-auto");
        pushPrefixNote({
          kind: "epochAuto",
          text: `auto-compacted ${res.droppedTurns} turn(s)`,
        });
      } else if (res.skip === "below_trigger") {
        epochAutoSkipReason = "window_pressure";
      }
    }
  }, epochAutoWillRun && epochCutIndex > 0);
  measureSaverStage("epochAuto", epochAutoApplied, undefined, epochAutoWillRun && epochCutIndex > 0);

  // Embedding reorder: moves the most relevant historical pairs next to the
  // recent tail via local OpenAI-compatible embeddings. A permutation of the
  // prefix is a full cache rewrite, so a fresh embedding pass runs only on a
  // request whose prefix a rung above already rewrote; every other request
  // replays the order memoised for this session, and a session without a
  // memo is left in chronological order. Fail-open: an embed failure logs one
  // debug line and leaves the prefix in order.
  const reorderWillRun =
    tokenSaverEnabled && embedReorderEnabled && claudePrefixTarget && !!prefixMessages();
  await stageGuard.async("reorder", async () => {
    let reorderMemo = sessionKey ? memoGet("reorder", sessionKey) : null;
    if (sessionKey && !reorderMemo) {
      reorderMemo = { order: [] };
      memoSet("reorder", sessionKey, reorderMemo);
    }
    const recompute = !reorderMemo || prefixRewritten;
    const query = lastUserQuery(translatedBody.messages);
    if ((recompute && query.trim()) || (!recompute && reorderMemo.order.length > 0)) {
      const res = await reorderByRelevance(translatedBody.messages, {
        query,
        embedUrl: embedReorderUrl,
        embedModel: embedReorderModel,
        keepRecentTurns: 2,
        memo: reorderMemo,
        recompute,
        signal: callerSignal,
      });
      if (res.error) {
        log?.debug?.("REORDER", `skipped: ${String(res.error).slice(0, 80)}`);
        // DEBUG is dark in production; the failure must still be visible.
        decide("XFORM", "reorder-degraded", {
          rid,
          why: res.errorCode || "invalid_configuration",
        });
      }
      stageGuard.report("reorder", res);
      if (res.moved > 0) {
        translatedBody.messages = res.messages;
        notePath(rid, "XFORM.reorder-applied");
        if (!res.replayed) {
          pushPrefixNote({
            kind: "reorder",
            text: `reordered ${res.moved} pair(s) by relevance`,
          });
        }
      }
    } else stageGuard.report("reorder", { outcome: "skipped" });
  }, reorderWillRun);
  measureSaverStage("reorder", reorderWillRun);

  // Boundary note: after the prefix rungs reshaped history, one short note
  // tells the model what the earlier region once contained. It lands on the
  // LIVE user turn, which is new on every request, so the cached prefix is
  // untouched; landing it at the oldest compressed turn, as it used to,
  // rewrote everything after that turn on every request whose note text
  // differed. INTENTIONALLY ADDITIVE, which is why the saver-guard exempts
  // it below (same rationale as "inject").
  const midinjectWillRun =
    tokenSaverEnabled &&
    midPrefixInjectEnabled &&
    claudePrefixTarget &&
    prefixNotes.length > 0 &&
    !!prefixMessages();
  let midinjectApplied = false;
  stageGuard.sync("midinject", () => {
    const noteText = composeBoundaryNote(prefixNotes);
    let insertIndex = -1;
    for (let i = translatedBody.messages.length - 1; i >= 0; i--) {
      if (translatedBody.messages[i]?.role === "user") {
        insertIndex = i;
        break;
      }
    }
    const res = injectBoundaryNote(translatedBody.messages, insertIndex, noteText);
    if (res.injected) {
      translatedBody.messages = res.messages;
      midinjectApplied = true;
      notePath(rid, "XFORM.midinject-applied");
    }
  }, midinjectWillRun);

  measureSaverStage("midinject", midinjectApplied, undefined, midinjectWillRun);

  // Insert approved summaries after history mutations so later pruning cannot
  // remove them. The pressure check includes the addition before accepting it;
  // final anchoring and wire measurements then see the complete body.
  const handoffWillRun = tokenSaverEnabled && memorySettings?.memoryHandoffEnabled === true;
  let handoffApplications = [];
  await stageGuard.async("handoff", async () => {
    const packets = await pendingShapingHandoffs(contextCapture.identity);
    callerSignal?.throwIfAborted();
    if (!packets.length) return;
    const result = injectHandoffPackets(translatedBody, packets);
    if (!result.injected) throw Object.assign(new Error("handoff format unsupported"), { code: "invalid_configuration" });
    const capacity = getCapabilitiesForModel(provider, upstreamModel);
    const pressure = measureContextPressure(translatedBody, { contextWindow: capacity?.contextWindow ?? null, settings: memorySettings, calibration: sessionCalibrationFor(contextScope) });
    if (pressure.over) throw Object.assign(new Error("handoff exceeds context allowance"), { code: "capacity_exceeded" });
    handoffApplications = result.applied;
    notePath(rid, "XFORM.handoff");
  }, handoffWillRun);
  measureSaverStage("handoff", handoffWillRun);
  if (stageGuard.measurement("handoff", handoffWillRun, false).outcome !== "failed") contextHandoffs.push(...handoffApplications);

  if (xf.length && log?.line) log.line(reqTag, "⚙", xf.join(" · "));
  const endFinalStage = stageGuard.start('final');

  // Pin cache breakpoints to the final body — every saver above can reshape
  // system/tools/messages, and a stale anchor costs a full prefix rewrite.
  // Gated on the FINAL format, not on native passthrough: prepareClaudeRequest
  // stamps the same breakpoints during translation, i.e. BEFORE tool/media
  // pruning and compaction run, so any non-Claude-CLI client reaching a
  // Claude-format upstream was left with an anchor pointing at a prefix that no
  // longer existed and paid the whole prompt uncached (#2808).
  if (finalFormat === FORMATS.CLAUDE) {
    // Anthropic requires tools[].type explicitly; strict compatible gateways
    // (MiniMax, error 2013) 400 a legacy payload that omits it. Defaulted here,
    // on the final body, so it covers native passthrough as well as every
    // translated route, and lands after the savers above reshape tools.
    if (Array.isArray(translatedBody.tools)) {
      translatedBody.tools = defaultClaudeToolType(translatedBody.tools);
    }
    const anchorsBefore = countCacheAnchors(body);
    // Adaptive breakpoint TTL (context-tuning suite, task 6): with the knob
    // on, a session whose recent inter-request gaps outlive the 5m breakpoint
    // (>= 3 gap samples, p90 > 20 min) gets the 1h lifetime on its ephemeral
    // anchors (positions never move). "5m" is the legacy policy byte for
    // byte, and flag-off keeps the historical single-argument call.
    if (adaptiveCacheTtlEnabled) {
      const tele = peekPrefixTelemetry(contextScope);
      const cacheTtl = chooseCacheTtl(tele?.gaps);
      anchorClaudeCache(translatedBody, { ttl: cacheTtl });
      if (cacheTtl === "1h") {
        log?.debug?.("CACHE", `adaptive ttl 1h | gaps=${tele?.gaps.length}`);
      }
    } else {
      anchorClaudeCache(translatedBody);
    }
    // Path codes (doc §2 XFORM rows): client multi-anchor plan survived
    // translation vs the re-anchor fallback.
    const anchorsAfter = countCacheAnchors(translatedBody);
    notePath(rid, anchorsBefore >= 2 && anchorsAfter >= anchorsBefore ? "XFORM.cache-keep" : "XFORM.cache-legacy");
  }

  // REQ save=/save_tok=/ce=: per-saver byte deltas (negative = saved, positive
  // growth reported honestly) plus the cache-epoch prefix this request shares
  // with its session's previous final pre-dispatch body. savers off -> silent.
  const saverFields = {};
  // The complete stage ledger requires the final serialization even with
  // optional savers disabled. Reuse its size for the final row and its string
  // for cache-prefix and structural evidence consumers.
  let finalBodyBytes = null;
  let finalSerialized = null;
  let compactHint = false;
  let prefixFields = null;
  if (saverPrev || sid) {
    finalSerialized = JSON.stringify(translatedBody);
    finalBodyBytes = Buffer.byteLength(finalSerialized);
    endFinalStage();
    measureSaverStage("final", true, finalBodyBytes);
    if (contextScope) {
      const tracked = trackCacheEpoch(contextScope, finalSerialized);
      if (tracked) {
        saverFields.ce = tracked.ce;
        // HEADERS: the compact hint fires only on a known ce that dropped
        // more than 50% against the session's previous request.
        if (tracked.prevBytes > 0 && tracked.ce < tracked.prevBytes * 0.5) {
          compactHint = true;
        }
      }
      prefixFields = updatePrefixTelemetry(contextScope, finalSerialized, tracked);
    }
  }
  // HEADERS finding: model-self-sizing response headers, all derived from the
  // values computed above — zero marginal serialization.
  // The reported prompt size is the calibrated estimate, not bytes/4. Measured
  // live on Haiku over an 18-turn tool-heavy session, bytes/4 sat 26% to 34%
  // under the provider's own count on every single turn (mean absolute error
  // 32.4%), while estimateRequestTokens times the session calibration landed
  // within 2.8%. It is also the derivation the pressure ladder prunes against,
  // so the number an agent self-sizes from can no longer disagree with the
  // number that decides whether history gets cut.
  const estTokens = finalBodyBytes === null ? null : estimateRequestTokens(translatedBody);
  const saverMeta = {};
  if (estTokens !== null && (saverWillRun || sid)) {
    // measureContextPressure.projected, arrived at by the same arithmetic:
    // the clamped calibration and the same rounding, so the header and the
    // ladder cannot report two different sizes for one body.
    saverMeta.ctxTokens = Math.ceil(estTokens * calibrationFactor(sessionCalibrationFor(contextScope)));
  }
  if (saverStages.length) {
    saverMeta.saveBytes = Math.round(
      saverStages.reduce((a, st) => a + st.delta, 0),
    );
  }
  if (saverFields.ce !== undefined) saverMeta.ce = saverFields.ce;
  if (compactHint) saverMeta.compactHint = true;
  let contextTelemetry = createContextTelemetry({
    ...contextIdentity, sessionHash: credentials?.sessionHash, sessionIdentitySource: credentials?.sessionIdentitySource,
    dispatchCoverage: "executor-invocation",
    explicitIdentity: contextCapture.identity,
    structures: [contextCapture.initial, contextCapture.capture(translatedBody, "gateway-shaped", finalSerialized)].filter(Boolean),
    timestamp: new Date(requestStartTime).toISOString(),
    requestedModel: clientRawRequest?.body?.model || body.model,
    clientTool, inputEstimate, messageCount, toolCount,
    contextEstimate: Math.ceil(estTokens * calibrationFactor(sessionCalibrationFor(contextScope))), bodyAfterBytes: finalBodyBytes,
    cachePrefixBytes: saverMeta.ce, compactHint,
    routeKind: routeKindOverride || (passthrough ? "passthrough" : sourceFormat === targetFormat ? "same-format" : "translated"),
    formatPair: `${sourceFormat}>${targetFormat}`, selection: credentials?.selection?.verdict,
    controls: {
      contextStructure: contextStructureEnabled,
      rtk: Boolean(rtkWillRun), rtkAllowLossy, schema: Boolean(schemaDistillRan), schemaAllowLossy,
      thinking: Boolean(thinkingWillRun), privacy: Boolean(privacyEnabled),
      caveman: Boolean(tokenSaverEnabled && cavemanEnabled), ponytail: Boolean(tokenSaverEnabled && ponytailEnabled),
      pxpipe: Boolean(tokenSaverEnabled && pxpipeEnabled), pxpipeAllowLossy,
      memory: Boolean(tokenSaverEnabled && memorySettings), handoff: handoffWillRun, headroom: Boolean(tokenSaverEnabled && headroomEnabled), headroomAllowLossy,
      qac: Boolean(qacWillRun), pairs: Boolean(pairsWillRun), reorder: Boolean(reorderWillRun), midinject: Boolean(tokenSaverEnabled && midPrefixInjectEnabled),
      diet: Boolean(dietWillRun), lingua: Boolean(linguaWillRun), epochMicro: Boolean(epochMicroWillRun), epochAuto: Boolean(epochAutoWillRun),
      adaptiveCacheTtl: Boolean(adaptiveCacheTtlEnabled && finalFormat === FORMATS.CLAUDE), clientOptOut: !tokenSaverEnabled,
    },
    stages: contextStages.map((stage) => ({ ...stage, ...(stage.stage === "rtk" ? { semanticPreserving: rtkStats?.semanticPreserving === true } : {}) })),
    handoffs: contextHandoffs,
  });
  Object.defineProperties(saverMeta, {
    requestId: { get: () => contextTelemetry.requestId },
    logicalRequestId: { get: () => contextTelemetry.logicalRequestId },
  });
  await recordContextAttempt(contextTelemetry, { provider, model, connectionId });
  endPreparationSpan?.('succeeded', contextTelemetry.requestId);
  // MCP context_status state: sid-keyed self-sizing snapshot for the
  // /api/v1/mcp tool. Written before dispatch so an upstream failure still
  // leaves fresh telemetry. The store swallows its own errors; this catch is
  // the belt on the same contract, telemetry never breaks the request.
  if (contextScope) {
    rememberRidSession(contextTelemetry.requestId, sid, estTokens, contextScope);
    try {
      if (sid) writeContextStatus(sid, {
        rid,
        ctxTokens: saverMeta.ctxTokens,
        saveBytes: saverMeta.saveBytes,
        ceBytes: saverMeta.ce,
        compactHint: saverMeta.compactHint,
        // Undefined means "not measured this request" and must stay absent so
        // the merge keeps the session's last measured value; an empty
        // volatileKeys list IS measured and clears the previous one.
        ...(prefixFields?.epochHitRate !== undefined ? { epochHitRate: prefixFields.epochHitRate } : {}),
        ...(prefixFields?.volatileKeys !== undefined ? { volatileKeys: prefixFields.volatileKeys } : {}),
      });
    } catch (err) {
      log?.debug?.("CTXSTATUS", `write failed: ${String(err?.message || err).slice(0, 60)}`);
    }
  }
  if (saverStages.length) {
    saverFields.save = saverStages
      .map((st) => `${st.stage}:${st.delta}`)
      .join(",");
    saverFields.save_tok = Math.round(
      saverStages.reduce((a, st) => a + st.delta, 0) / 4,
    );
    for (const st of saverStages) {
      // Phantom-growth anomaly, the inverse of the headroom phantom saver:
      // a saver that grows the body by more than 5% of entry bytes is a bug,
      // not a saver. Speak once per (rid, stage) — one request, one line.
      // The inject stage is exempt: prompt injection ADDS the style text on
      // purpose, and on small bodies that intentional addition trips the
      // threshold — the guard is for compressors that were supposed to shrink.
      // "final" is exempt with "inject": it is not a saver, it only
      // attributes post-saver reshaping (cache anchoring) honestly.
      // "midinject" is exempt with "inject": the boundary note it adds is the
      // whole point, and on small bodies that intentional addition trips the
      // threshold, the guard is for compressors that were supposed to shrink.
      if (
        st.stage !== "inject" &&
        st.stage !== "final" &&
        st.stage !== "midinject" &&
        st.delta > saverEntryBytes * 0.05
      ) {
        decide("XFORM", "saver-guard", {
          rid,
          stage: st.stage,
          in: st.in,
          out: st.out,
        });
      }
    }
  }
  // Token-saver aggregate rows, one per saver that ran. Emitted here — after
  // every saver stage and the anchor — so each row carries the whole-body
  // bytesSaved/saveTokEst and the final-body cache epoch (ce), not just the
  // per-tool char/token figures. Unit discipline (chars vs tokens vs bytes)
  // lives in src/lib/tokenSaver/events.js; fields absent when unknown.
  const saverStageDelta = (name) =>
    saverStages.find((st) => st.stage === name)?.delta;
  try {
    if (tokenSaverEnabled && rtkStats?.hits?.length) {
      const bytesSaved = saverStageDelta("rtk");
      onTokenSaverEvent?.({
        saver: "rtk",
        rid,
        applied: true,
        appliedCount: rtkStats.hits.length,
        charsBefore: rtkStats.bytesBefore,
        charsAfter: rtkStats.bytesAfter,
        charsSaved: Math.max(
          0,
          (rtkStats.bytesBefore || 0) - (rtkStats.bytesAfter || 0),
        ),
        bytesSaved,
        saveTokEst:
          bytesSaved === undefined ? undefined : Math.round(bytesSaved / 4),
        ce: saverFields.ce,
      });
    }
    if (
      tokenSaverEnabled &&
      Number.isFinite(headroomStats?.tokens_saved) &&
      headroomDiagnostics?.after
    ) {
      const bytesSaved = saverStageDelta("headroom");
      onTokenSaverEvent?.({
        saver: "headroom",
        rid,
        applied: true,
        tokensBefore: headroomStats.tokens_before,
        tokensAfter: headroomStats.tokens_after,
        tokensSaved: headroomStats.tokens_saved,
        bodyBytesBefore: headroomDiagnostics.before?.bodyBytes,
        bodyBytesAfter: headroomDiagnostics.after?.bodyBytes,
        bytesSaved,
        saveTokEst:
          bytesSaved === undefined ? undefined : Math.round(bytesSaved / 4),
        ce: saverFields.ce,
      });
    }
    // PXPIPE also lands in the main sink (the native onPxpipeEvent emit above
    // feeds its own UI only): the row below is what the dashboard stage table
    // and the rid-join read. Both emits stay — each sink keeps its contract.
    if (pxpipeSummary?.applied) {
      onTokenSaverEvent?.({
        saver: "pxpipe",
        rid,
        applied: true,
        bytesSaved: saverStageDelta("pxpipe"),
        imageCount: pxpipeSummary.imageCount,
        ce: saverFields.ce,
      });
    }
    // Ledger-backed stages: one row each when the stage actually changed the
    // body — the ledger records a stage only on a byte change. Emits inject's
    // intentional growth (positive bytesSaved) and mem/schema/privacy/tools
    // savings into the same per-saver aggregation the dashboard's stage table
    // reads. Privacy runs under its own flag, not tokenSaverEnabled, so its
    // gate is the delta alone.
    for (const stageName of [
      "tools",
      "inject",
      "mem",
      "schema",
      "privacy",
      "thinking",
      "qac",
      "pairs",
      "diet",
      "lingua",
      "reorder",
      "midinject",
      "epochMicro",
      "epochAuto",
    ]) {
      const stageBytes = saverStageDelta(stageName);
      const stageGated =
        stageName === "privacy" ? true : tokenSaverEnabled;
      if (stageGated && stageBytes !== undefined) {
        const row = {
          saver: stageName,
          rid,
          applied: true,
          bytesSaved: stageBytes,
          saveTokEst: Math.round(stageBytes / 4),
          ce: saverFields.ce,
        };
        // Which turns the stage compressed, for the dashboard timeline
        // (bounded integer array, never free text).
        if (stageName === "thinking" && thinkingTurns.length > 0) row.turns = thinkingTurns;
        if (stageName === "qac" && qacTurns.length > 0) row.turns = qacTurns;
        // Mem sub-action attribution: the mem row names which rungs fired,
        // not just the whole-body delta.
        if (stageName === "mem" && memStats) {
          const toolPrunedChars = memStats.toolPruning?.savedChars;
          const mediaPrunedItems = memStats.mediaPruning?.savedItems;
          const compactedTokens = memStats.compaction?.savedTokens;
          if (Number.isFinite(toolPrunedChars)) row.toolPrunedChars = toolPrunedChars;
          if (Number.isFinite(mediaPrunedItems)) row.mediaPrunedItems = mediaPrunedItems;
          if (Number.isFinite(compactedTokens)) row.compactedTokens = compactedTokens;
        }
        onTokenSaverEvent?.(row);
      }
    }
    // Epoch cascade skips are reported, not silenced, with the cause the
    // stage actually had: a stable/unknown epoch is "epoch_boundary", a
    // below-trigger evaluation is "window_pressure", and everything else
    // (no eligible blocks, no window known, nothing droppable, summarizer
    // failure) reports reason omitted rather than mislabeled.
    if (dietWillRun && !dietApplied) {
      const row = {
        saver: "diet",
        rid,
        applied: false,
        bytesSaved: contextStages.find((stage) => stage.stage === "diet")?.delta,
        ce: saverFields.ce,
      };
      if (epochCutIndex === 0) row.reason = "epoch_boundary";
      onTokenSaverEvent?.(row);
    }
    if (linguaWillRun && !linguaApplied) {
      const row = {
        saver: "lingua",
        rid,
        applied: false,
        bytesSaved: contextStages.find((stage) => stage.stage === "lingua")?.delta,
        ce: saverFields.ce,
      };
      if (epochCutIndex === 0) row.reason = "epoch_boundary";
      else if (linguaSkip === "no_backend") row.reason = "no_backend";
      onTokenSaverEvent?.(row);
    }
    if (epochMicroWillRun && !epochMicroApplied) {
      const row = {
        saver: "epochMicro",
        rid,
        applied: false,
        bytesSaved: contextStages.find((stage) => stage.stage === "epochMicro")?.delta,
        ce: saverFields.ce,
      };
      if (epochCutIndex === 0) row.reason = "epoch_boundary";
      onTokenSaverEvent?.(row);
    }
    if (epochAutoWillRun && !epochAutoApplied) {
      const row = {
        saver: "epochAuto",
        rid,
        applied: false,
        bytesSaved: contextStages.find((stage) => stage.stage === "epochAuto")?.delta,
        ce: saverFields.ce,
      };
      if (epochAutoSkipReason) row.reason = epochAutoSkipReason;
      onTokenSaverEvent?.(row);
    }
  } catch {
    /* stats must not break requests */
  }

  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(
    () => {},
  );

  const msgCount =
    translatedBody.messages?.length ||
    translatedBody.input?.length ||
    translatedBody.contents?.length ||
    translatedBody.request?.contents?.length ||
    0;
  log?.debug?.(
    "REQUEST",
    `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`,
  );

  // Set once the response turns out to be streaming; finalizes the placeholder
  // requestDetail row on disconnect or upstream mid-stream error (the SSE
  // transform's flush()/cancel() never run on those paths).
  let abandonStreamingDetail = null;

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      reqLogger.cancel?.();
      trackPendingRequest(model, provider, connectionId, false);
      abandonStreamingDetail?.(typeof reason?.reason === "string" ? reason.reason : "client_disconnected");
      if (onDisconnect) onDisconnect(reason);
    },
    onError: (err) => {
      reqLogger.cancel?.();
      trackPendingRequest(model, provider, connectionId, false);
      abandonStreamingDetail?.(err?.message === "stream stall timeout" ? "stall_timeout" : "stream_error");
    },
    log,
    provider,
    model,
    reqTag,
  });
  const executionSignal = callerSignal
    ? AbortSignal.any([callerSignal, streamController.signal])
    : streamController.signal;

  const proxyOptions = {
    connectionProxyEnabled:
      credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl:
      credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy:
      credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
    strictProxy: credentials?.providerSpecificData?.strictProxy === true,
  };

  logProxySelection({ proxyOptions, credentials, provider, model, log });

  // Execute request
  let providerResponse, providerUrl, providerHeaders, finalBody;
  // Most executors return their registry format. Cursor AgentService is an
  // exception: it is decoded by the executor into OpenAI-compatible output.
  let providerResponseFormat = targetFormat;
  const mapTransportError = async (error) => {
    if (isLocalTransportPoolRefusal(error)) {
      await releaseUndispatchedBudgetReservation(contextTelemetry?.budgetReservationId, error);
      trackPendingRequest(model, provider, connectionId, false, true);
      await recordContextAttempt(contextTelemetry, { provider, model, connectionId, status: "error" });
      streamController.handleComplete();
      reqSummary("refused", { rid, conn: connPrefix, status: 503, why: error.code, ...saverFields });
      const response = withReplaySafety(Response.json({ error: { type: 'local_admission_error', code: error.code,
        message: error.message, failure_phase: 'admission' } }, { status: 503 }), false, 1000, true);
      return withSaverHeaders({ success: false, status: 503, error: error.message, response,
        failureMetadata: { safeToReplay: false, failurePhase: 'admission', transportDispatched: false }, rid }, saverMeta);
    }
    if (error instanceof BudgetAdmissionError) {
      trackPendingRequest(model, provider, connectionId, false, true);
      await recordContextAttempt(contextTelemetry, { provider, model, connectionId, status: "error" });
      streamController.handleComplete();
      return budgetErrorResult(error, rid);
    }
    if (contextTelemetry?.budgetReservationId) await markBudgetUncertain(contextTelemetry.budgetReservationId, "transport-outcome-unknown");
    if (isFallbackDeadlineError(error)) {
      trackPendingRequest(model, provider, connectionId, false, true);
      await recordContextAttempt(contextTelemetry, { provider, model, connectionId, status: "error" });
      streamController.handleComplete();
      reqSummary("failed", { rid, conn: connPrefix, status: 504, why: "fallback-deadline", ...saverFields });
      return withSaverHeaders(createErrorResult(504, error.message, null, { safeToReplay: false }, rid), saverMeta);
    }
    const isAntigravity = provider === "antigravity";
    const sinkError = isAntigravity ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : (error.message || String(error));
    if (callerSignal?.aborted && (isCallerAbortError(error) || error.name === "AbortError")) {
      recordContextAttempt(contextTelemetry, { provider, model, connectionId, status: "aborted", latency: { total: Date.now() - requestStartTime } });
      trackPendingRequest(model, provider, connectionId, false);
      return withSaverHeaders(createCallerAbortResult(), saverMeta);
    }
    trackPendingRequest(model, provider, connectionId, false, true);
    appendRequestLog({
      model,
      provider,
      connectionId,
      status: `FAILED ${error.name === "AbortError" ? 499 : HTTP_STATUS.BAD_GATEWAY}`,
    }).catch(() => {});
    saveRequestDetail(
      buildRequestDetail({
        contextTelemetry,
        provider,
        model,
        connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: null,
        request: extractRequestConfig(body, stream),
        providerRequest: translatedBody || null,
        response: {
          error: sinkError,
          status: error.name === "AbortError" ? 499 : 502,
          thinking: null,
        },
        pxpipe: pxpipeSummary,
        status: "error",
        rid,
      }),
    ).catch(() => {});

    if (error.name === "AbortError") {
      streamController.handleError(isAntigravity ? new Error(ANTIGRAVITY_SAFE_ERROR_MESSAGE) : error);
      reqSummary("failed", { rid, conn: connPrefix, status: 499, why: "aborted", ...saverFields });
      return withSaverHeaders(createErrorResult(499, isAntigravity ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : "Request aborted", null, { safeToReplay: false }, rid), saverMeta);
    }
    const errMsg = isAntigravity
      ? ANTIGRAVITY_SAFE_ERROR_MESSAGE
      : formatProviderError(error, HTTP_STATUS.BAD_GATEWAY);
    if (isBodyReadTimeoutError(error)) {
      reqSummary("failed", { rid, conn: connPrefix, status: HTTP_STATUS.GATEWAY_TIMEOUT, why: "body-timeout", ...saverFields });
      return withSaverHeaders(createErrorResult(
        HTTP_STATUS.GATEWAY_TIMEOUT,
        isAntigravity ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : "Upstream response body timed out",
        null,
        { safeToReplay: false },
        rid,
      ), saverMeta);
    }
    if (log?.errorLine) {
      log.errorLine(
        reqTag,
        "✗",
        `ERROR 502 · ${provider}/${model} · ${Date.now() - requestStartTime}ms\n    ${errMsg}${!isAntigravity && error.stack ? `\n    ${error.stack}` : ""}`,
      );
    }
    reqSummary("failed", { rid, conn: connPrefix, status: HTTP_STATUS.BAD_GATEWAY, why: "transport", ...saverFields });
    return withSaverHeaders(createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg, null, { safeToReplay: false }, rid), saverMeta);
  };
  const executeAttempt = async (args) => {
    executionSignal.throwIfAborted();
    connectTimeout?.fallbackDeadline?.throwIfExpired(executionSignal);
    await requireBudgetDispatchCoverage(apiKey, executor.supportsBudgetDispatch === true);
    executionSignal.throwIfAborted();
    connectTimeout?.fallbackDeadline?.throwIfExpired(executionSignal);
    let dispatches = 0;
    releaseFallbackPreparation?.();
    const execute = async (signal, releaseHeaderBudget) => {
      const endDispatch = contextIdentity.startSpan?.('dispatch');
      try {
      const result = await executor.execute({ ...args, signal, beforeDispatch: async (wire = {}) => {
      signal?.throwIfAborted();
      connectTimeout?.fallbackDeadline?.throwIfExpired(executionSignal);
      if (dispatches++ > 0) {
        contextTelemetry = await nextContextAttempt(contextTelemetry, { provider, model, connectionId, requestStartTime, dispatchCoverage: "executor-invocation" });
      }
      if (!contextTelemetry.pricingSnapshot) await recordContextAttempt(contextTelemetry, { provider, model, connectionId });
      await beginBudgetDispatch(contextTelemetry, apiKey, wire);
      const structure = contextCapture.capture(wire.body, "physical-dispatch", wire.serialized);
      contextTelemetry.structures = contextTelemetry.structures.filter((value) => value.boundary !== "physical-dispatch");
      if (structure) contextTelemetry.structures.push(structure);
      contextTelemetry.dispatchCoverage = "physical-dispatch";
      await recordContextAttempt(contextTelemetry, { provider, model, connectionId });
      connectTimeout?.fallbackDeadline?.throwIfExpired(executionSignal);
    }, afterDispatch: (response) => observeBudgetResponse(contextTelemetry, response) });
      // Internal rejected responses can precede another executor dispatch.
      // Only the executor's final result transfers ownership to the stream.
      releaseHeaderBudget?.();
      endDispatch?.('succeeded', contextTelemetry.requestId);
      return result;
      } finally { endDispatch?.('unknown', contextTelemetry.requestId); }
    };
    return connectTimeout?.fallbackDeadline
      ? connectTimeout.fallbackDeadline.run(execute, { signal: executionSignal, onLateResult: discardLateResponse })
      : execute(executionSignal);
  };
  try {
    const result = await executeAttempt({
      model,
      body: translatedBody,
      stream,
      credentials,
      signal: executionSignal,
      log,
      proxyOptions,
      sourceFormat,
      targetFormat,
      toolNameMap,
      connectTimeout,
    });
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    providerResponseFormat = result.responseFormat || targetFormat;
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
  } catch (error) {
    return mapTransportError(error);
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (
    !executor.noAuth &&
    isReplaySafeRejection(providerResponse) &&
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
    try {
      // Issued rotating-token redemption belongs to an independent owner.
      // Its durable acknowledgement must complete even after this caller leaves.
      const refresh = () => withRequestLifetime(undefined, () => refreshWithRetry(
        async () => {
          executionSignal.throwIfAborted();
          connectTimeout?.fallbackDeadline?.throwIfExpired(executionSignal);
          const result = await executor.refreshCredentials(credentials, log);
          if (!result) return result;
          if (!onCredentialsRefreshed) return result;
          try {
            const stored = await onCredentialsRefreshed(result);
            if (!stored || typeof stored !== "object") throw new Error('Missing credential acknowledgement');
            return stored;
          } catch {
            const error = new Error('Credential persistence was not confirmed');
            error.code = 'CREDENTIAL_PERSISTENCE_UNCONFIRMED';
            error.retryable = false;
            throw error;
          }
        },
        3,
        log,
      ));
      const newCredentials = connectTimeout?.fallbackDeadline
        ? await connectTimeout.fallbackDeadline.run(refresh, { signal: executionSignal })
        : await waitForPreparation(refresh(), executionSignal);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        if (log?.line)
          log.line(reqTag, "🔑", `TOKEN REFRESHED · ${provider}/${model}`);
        Object.assign(credentials, newCredentials);
        try {
          try { Promise.resolve(providerResponse.body?.cancel()).catch(() => {}); } catch {}
          contextTelemetry = await nextContextAttempt(contextTelemetry, { provider, model, connectionId, requestStartTime, dispatchCoverage: "executor-invocation" });
          const retryResult = await executeAttempt({
            model,
            body: translatedBody,
            stream,
            credentials,
            signal: executionSignal,
            log,
            proxyOptions,
            sourceFormat,
            targetFormat,
            toolNameMap,
            connectTimeout,
          });
          providerResponse = retryResult.response;
          providerUrl = retryResult.url;
          providerHeaders = retryResult.headers;
          finalBody = retryResult.transformedBody;
          providerResponseFormat = retryResult.responseFormat || targetFormat;
          reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
        } catch (error) {
          return mapTransportError(error);
        }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      if (isFallbackDeadlineError(e) || executionSignal.aborted) return mapTransportError(e);
      if (e?.code === 'CREDENTIAL_PERSISTENCE_UNCONFIRMED') {
        try { Promise.resolve(providerResponse.body?.cancel()).catch(() => {}); } catch {}
        log?.warn?.("TOKEN", "Credential persistence was not confirmed");
        return mapTransportError(e);
      }
      log?.warn?.(
        "TOKEN",
        `${provider.toUpperCase()} | refresh threw: ${provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : e.message}`,
      );
    }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    trackPendingRequest(model, provider, connectionId, false, true);
    let parsedError;
    try { parsedError = await parseUpstreamError(providerResponse, executor, { signal: executionSignal }); }
    catch (error) { return mapTransportError(error); }
    let { statusCode, message, resetsAtMs, validation, errorPayload } = parsedError;
    let safeStatusCode = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
      ? statusCode
      : HTTP_STATUS.BAD_GATEWAY;

    if (validation && typeof onValidationRequired === "function") {
      try {
        await onValidationRequired({
          validation,
          observationId: verificationContext?.observationId,
        });
      } catch {
        log?.warn?.("VERIFICATION", `validation callback failed for ${String(connectionId).slice(0, 8)}`);
      }
    }
    let failureMetadata = projectClientModelStatus({
      provider,
      requestedModel: model,
      status: statusCode,
      payload: errorPayload,
    });

    // Adaptive unsupported-parameter retry: on a 400 naming rejected fields,
    // record them per provider+model, strip, and retry once immediately.
    const rejectedOn400 =
      statusCode === HTTP_STATUS.BAD_REQUEST && isReplaySafeRejection(providerResponse)
        ? extractRejectedFieldNamesFromError(message).filter((f) => {
            const existing = getRejectedFields(provider, model);
            return !existing.has(f.toLowerCase());
          })
        : [];

    if (rejectedOn400.length > 0) {
      log?.debug?.(
        "FIELDSTRIP",
        `Parsed fields: ${JSON.stringify(rejectedOn400)} provider=${provider} model=${model}`,
      );
      addRejectedFields(provider, model, rejectedOn400);
      const stripped = stripRejectedFields(translatedBody, provider, model);
      if (stripped) {
        log?.debug?.(
          "FIELDSTRIP",
          `Stripped body sent. Fields blocked: ${rejectedOn400.join(", ")}`,
        );
        try {
          contextTelemetry = await nextContextAttempt(contextTelemetry, { provider, model, connectionId, requestStartTime, dispatchCoverage: "executor-invocation" });
          const retryResult = await executeAttempt({
            model,
            body: stripped,
            stream,
            credentials,
            signal: executionSignal,
            log,
            proxyOptions,
            sourceFormat,
            targetFormat,
            toolNameMap,
            connectTimeout,
          });
          providerResponse = retryResult.response;
          providerUrl = retryResult.url;
          providerHeaders = retryResult.headers;
          finalBody = retryResult.transformedBody || stripped;
          providerResponseFormat = retryResult.responseFormat || targetFormat;
          translatedBody = stripped;
          reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
          if (providerResponse.ok) {
            trackPendingRequest(model, provider, connectionId, false);
            appendRequestLog({
              model,
              provider,
              connectionId,
              status: "OK after field-strip",
            }).catch(() => {});
            log?.debug?.("FIELDSTRIP", `Retry succeeded for ${provider}/${model}`);
            const sharedCtx = {
              contextTelemetry,
              provider,
              model,
              body,
              stream,
              translatedBody,
              finalBody,
              requestStartTime,
              connectionId,
              rid,
              route: `${clientRawRequest?.body?.model || body?.model || "?"}>${provider}/${model}`,
              fmt: `${sourceFormat}>${targetFormat}`,
              sel: credentials?.selection?.verdict,
              apiKey,
              clientRawRequest,
              onRequestSuccess,
              verificationContext,
              onValidationRequired,
              notifyTerminalVerificationSuccess,
              pxpipe: pxpipeSummary,
              saverFields,
              saverMeta,
              privacyFilter,
              callerSignal,
              reqTag,
              log,
            };
            const appendLog = (extra) =>
              appendRequestLog({ model, provider, connectionId, ...extra }).catch(
                () => {},
              );
            const trackDone = () =>
              trackPendingRequest(model, provider, connectionId, false);
            if (!clientRequestedStreaming && providerRequiresStreaming) {
              const s2j = await handleForcedSSEToJson({
                ...sharedCtx,
                providerResponse,
                sourceFormat,
                targetFormat: providerResponseFormat,
                toolNameMap,
                customToolNames,
                responsesToolNameMap,
                trackDone,
                appendLog,
              });
              if (s2j) {
                if (s2j.success) streamController.handleComplete();
                return s2j;
              }
            }
            if (!stream) {
              const nr = await handleNonStreamingResponse({
                ...sharedCtx,
                providerResponse,
                sourceFormat,
                targetFormat: providerResponseFormat,
                reqLogger,
                toolNameMap,
                customToolNames,
                responsesToolNameMap,
                trackDone,
                appendLog,
              });
              if (nr.success) streamController.handleComplete();
              return nr;
            }
            const { onStreamComplete, onStreamAbandoned, streamDetailId, streamState } =
              buildOnStreamComplete({ ...sharedCtx });
            abandonStreamingDetail = onStreamAbandoned;
            return await deliverLoggedStream({
              ...sharedCtx,
              providerResponse,
              sourceFormat,
              targetFormat: providerResponseFormat,
              userAgent,
              reqLogger,
              toolNameMap,
              customToolNames,
              responsesToolNameMap,
              streamController,
              onStreamComplete,
              streamDetailId,
              streamState,
            });
          } else {
            // The last physical response owns status, reset and replay proof.
            // Parse it once, then finalize below without a third field edit.
            ({ statusCode, message, resetsAtMs, validation, errorPayload } = await parseUpstreamError(providerResponse, executor, { signal: executionSignal }));
            safeStatusCode = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : HTTP_STATUS.BAD_GATEWAY;
            failureMetadata = projectClientModelStatus({ provider, requestedModel: model, status: statusCode, payload: errorPayload });
            if (validation && typeof onValidationRequired === 'function') {
              try { await onValidationRequired({validation,observationId:verificationContext?.observationId}); }
              catch { log?.warn?.('VERIFICATION','Validation callback failed after field-strip rejection'); }
            }
            log?.warn?.(
              "FIELDSTRIP",
              `Retry still failed: ${retryResult.response.status} ${retryResult.response.statusText}`,
            );
          }
        } catch (e) {
          // The retry may have reached generation even though its response was
          // lost. The earlier 400 proves nothing about this later attempt.
          return mapTransportError(e);
        }
      } else {
        log?.warn?.(
          "FIELDSTRIP",
          "stripRejectedFields returned null — no fields to strip or body unchanged",
        );
      }
    } else if (statusCode !== HTTP_STATUS.BAD_REQUEST) {
      log?.debug?.(
        "FIELDSTRIP",
        `No rejected fields parsed from error (statusCode=${statusCode})`,
      );
    }

    appendRequestLog({
      model,
      provider,
      connectionId,
      status: `FAILED ${safeStatusCode}`,
    }).catch(() => {});
    const sinkMessage = provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : message;
    saveRequestDetail(
      buildRequestDetail({
        contextTelemetry,
        provider,
        model,
        connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: null,
        request: extractRequestConfig(body, stream),
        providerRequest: finalBody || translatedBody || null,
        response: { error: sinkMessage, status: safeStatusCode, thinking: null },
        pxpipe: pxpipeSummary,
        status: "error",
        rid,
      }, { terminalEvidence: classifyHttpTerminalEvidence(providerResponse) }),
    ).catch(() => {});

    const errMsg = provider === "antigravity"
      ? ANTIGRAVITY_SAFE_ERROR_MESSAGE
      : formatProviderError(new Error(message), safeStatusCode);
    if (log?.errorLine) {
      const urlStr = provider !== "antigravity" && providerUrl ? `\n    URL: ${providerUrl}` : "";
      log.errorLine(
        reqTag,
        "✗",
        `ERROR ${safeStatusCode} · ${provider}/${model} · ${Date.now() - requestStartTime}ms${urlStr}\n    ${errMsg}`,
      );
    }
    reqLogger.logError(new Error(sinkMessage), finalBody || translatedBody);
    reqSummary("failed", { rid, conn: connPrefix, status: safeStatusCode, why: "upstream", ...saverFields });
    // An executor may convert an accepted SSE failure to HTTP. Preserve its
    // explicit no-replay provenance instead of treating it as a rejection.
    let safeAcrossAccounts = isSafeQuotaAccountRejection(providerResponse, errorPayload);
    let safeToReplay = isReplaySafeRejection(providerResponse, errorPayload)
      && (providerResponse.status !== HTTP_STATUS.RATE_LIMITED || safeAcrossAccounts);
    // A complete body can prove rejection after BaseExecutor's bounded header
    // observation expired. Publish that later proof to the same reservation
    // before the coordinator is allowed to retry against another account.
    if (safeToReplay && contextTelemetry?.budgetReservationId) {
      try {
        await observeBudgetResponse(contextTelemetry, { response: providerResponse, nonacceptance: "verified-provider-nonacceptance" });
      } catch {
        safeToReplay = false;
        safeAcrossAccounts = false;
      }
    }
    return withSaverHeaders(createErrorResult(safeStatusCode, errMsg, resetsAtMs, { ...failureMetadata, safeToReplay, safeAcrossAccounts }, rid), saverMeta);
  }

  const sharedCtx = {
    contextTelemetry,
    provider,
    model,
    body,
    stream,
    translatedBody,
    finalBody,
    requestStartTime,
    connectionId,
    rid,
    route: `${clientRawRequest?.body?.model || body?.model || "?"}>${provider}/${model}`,
    fmt: `${sourceFormat}>${targetFormat}`,
    sel: credentials?.selection?.verdict,
    apiKey,
    clientRawRequest,
    onRequestSuccess,
    verificationContext,
    onValidationRequired,
    notifyTerminalVerificationSuccess,
    onEmptyStream,
    pxpipe: pxpipeSummary,
    saverFields,
    saverMeta,
    preSaverSerialized,
    sid,
    privacyFilter,
    callerSignal,
    reqTag,
    log,
  };
  const appendLog = (extra) =>
    appendRequestLog({ model, provider, connectionId, ...extra }).catch(
      () => {},
    );
  const trackDone = () =>
    trackPendingRequest(model, provider, connectionId, false);
  // Provider forced streaming but client wants JSON
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = await handleForcedSSEToJson({
      ...sharedCtx,
      providerResponse,
      sourceFormat,
      targetFormat: providerResponseFormat,
      toolNameMap,
      customToolNames,
      responsesToolNameMap,
      trackDone,
      appendLog,
    });
    if (result) {
      if (result.success) streamController.handleComplete();
      return result;
    }
  }

  // True non-streaming response
  if (!stream) {
    const result = await handleNonStreamingResponse({
      ...sharedCtx,
      providerResponse,
      sourceFormat,
      targetFormat: providerResponseFormat,
      reqLogger,
      toolNameMap,
      customToolNames,
      responsesToolNameMap,
      trackDone,
      appendLog,
    });
    if (result.success) streamController.handleComplete();
    return result;
  }

  // Streaming response
  const { onStreamComplete, onStreamAbandoned, streamDetailId, streamState } =
    buildOnStreamComplete({ ...sharedCtx });
  abandonStreamingDetail = onStreamAbandoned;
  return await deliverLoggedStream({
    ...sharedCtx,
    providerResponse,
    sourceFormat,
    targetFormat: providerResponseFormat,
    userAgent,
    reqLogger,
    toolNameMap,
    customToolNames,
    responsesToolNameMap,
    streamController,
    onStreamComplete,
    streamDetailId,
    streamState,
  });
  } finally {
    if (!loggerOwnsStream) closeRequestLog();
  }
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
