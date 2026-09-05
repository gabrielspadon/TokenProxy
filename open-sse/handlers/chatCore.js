import { createHash } from "node:crypto";
import { detectFormat } from "../services/provider.js";
import { resolveUpstreamRoute } from "./chatCore/upstreamRoute.js";
import { translateRequest } from "../translator/index.js";
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
import { prefetchRemoteImages } from "../translator/concerns/prefetch.js";
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

// Give the compressor its own copy of the items it rewrites in place, so a
// retry on another account starts from the caller's original text rather than
// from the previous attempt's output. Only the compressible collections are
// copied, never the whole body: the body carries streams and abort signals that
// structuredClone would reject, and the rest of it is not touched by the
// compressor anyway. Falls back to leaving the body alone, which is the
// pre-existing behaviour, if the clone is refused.
function isolateCompressibleItems(body) {
  if (!body) return;
  for (const key of ["messages", "input"]) {
    if (!Array.isArray(body[key])) continue;
    try {
      body[key] = structuredClone(body[key]);
    } catch {
      // A non-cloneable item means this collection stays shared. Compression is
      // idempotent-ish rather than exact, so a shared array is a worse result,
      // not a broken one.
    }
  }
  if (body.conversationState) {
    try {
      body.conversationState = structuredClone(body.conversationState);
    } catch { /* as above */ }
  }
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
function rememberRidSession(rid, sid, estimatedTokens) {
  if (!rid || !sid) return;
  boundedSet(ridSessions, rid, { sid, estimatedTokens });
}
export function sessionCalibrationFor(sid) {
  return (sid && sessionCalibration.get(sid)) || 1;
}
onReqSummary((verdict, fields) => {
  const rid = typeof fields?.rid === "string" ? fields.rid : null;
  if (!rid) return;
  const entry = ridSessions.get(rid);
  if (!entry) return;
  ridSessions.delete(rid);
  if (verdict !== "ok") return;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const actual = n(fields.in) + n(fields.cr) + n(fields.cw);
  if (actual <= 0) return;
  writeContextStatus(entry.sid, { rid, ctxTokensActual: actual });
  if (entry.estimatedTokens > 0) {
    const ratio = actual / entry.estimatedTokens;
    const prev = sessionCalibration.get(entry.sid);
    boundedSet(sessionCalibration, entry.sid, prev ? prev * 0.5 + ratio * 0.5 : ratio);
  }
});

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
    out = { ce: Math.min(ce, prev.len, byteLen), prevBytes: prev.len, bytes: byteLen };
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

export async function handleChatCore({
  requestId,
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
  memorySettings,
  toolDisclosure,
  codexFastMode,
}) {
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
  );
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
        signal: undefined,
      });
      if (n > 0)
        log?.debug?.(
          "MODALITY",
          `prefetched ${n} remote image(s) for ${targetFormat}`,
        );
    } catch (e) {
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
  let toolsBeforeBytes = null;
  if (Array.isArray(translatedBody.tools) && translatedBody.tools.length > 0) {
    toolsBeforeBytes = Buffer.byteLength(JSON.stringify(translatedBody.tools));
  }
  if (Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools, { clientTool, model });
    if (stripped.length > 0) {
      toolsStripped = true;
      translatedBody.tools = deduped;
      log?.debug?.(
        "TOOLDEDUP",
        `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`,
      );
    }
  }

  // Per-request opt-out: computed early so token savers (including disclosure) can respect it.
  const tokenSaverEnabled =
    clientRawRequest?.headers?.[TOKEN_SAVER_HEADER]?.toLowerCase?.() !== "off";

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
    if (toolsBeforeBytes !== null) {
      const toolsAfterBytes = Buffer.byteLength(JSON.stringify(translatedBody.tools));
      if (toolsAfterBytes !== toolsBeforeBytes) {
        toolsStageDelta = {
          delta: toolsAfterBytes - toolsBeforeBytes,
          in: toolsBeforeBytes,
          out: toolsAfterBytes,
        };
      }
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(
      (msg) => msg.role !== "tool",
    );
    delete translatedBody.tools;
  }

  // Token-saver byte ledger: whole-body per-stage deltas serialized once per
  // stage boundary. Feeds REQ save=/save_tok=, the XFORM.saver-guard anomaly
  // line, bytesSaved on the saver event rows, and the honest growth check.
  // Off entirely when no saver will run, so a saver-free request pays nothing.
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
          headroomEnabled ||
          cavemanEnabled ||
          ponytailEnabled ||
          memorySettings)),
  );
  const saverStages = [];
  // The tools-normalization block above ran before this ledger existed; fold
  // its measured delta in as the first stage so save= attributes the strip.
  if (toolsStageDelta) saverStages.push({ stage: "tools", ...toolsStageDelta });
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
  const saverPrev = saverWillRun
    ? { bytes: Buffer.byteLength(JSON.stringify(translatedBody)) }
    : null;
  const saverEntryBytes = saverPrev ? saverPrev.bytes : 0;
  const measureSaverStage = (stage, ran) => {
    if (!saverPrev || !ran) return;
    const at = Buffer.byteLength(JSON.stringify(translatedBody));
    if (at !== saverPrev.bytes) {
      saverStages.push({
        stage,
        delta: at - saverPrev.bytes,
        in: saverPrev.bytes,
        out: at,
      });
    }
    saverPrev.bytes = at;
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
  if (schemaDistillRan) {
    const distilled = distillToolSchemas(translatedBody.tools);
    if (distilled.savedBytes > 0) {
      translatedBody.tools = distilled.tools;
      notePath(rid, "XFORM.tool-distill");
    }
  }
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
  if (thinkingWillRun) {
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
  }
  measureSaverStage("thinking", thinkingWillRun);

  // RTK: compress tool_result content.
  //
  // compressMessages rewrites message content IN PLACE, and on the passthrough
  // path translatedBody is a shallow spread of the caller's body, so the array
  // and the message objects inside it are the caller's. Account fallback calls
  // this handler again with that same body, which meant attempt two compressed
  // the already-compressed text and each further attempt compressed it again
  // (#3566). Isolate the messages first, and only when the stage will actually
  // run, so a request with the saver off pays nothing.
  const rtkWillRun = tokenSaverEnabled && rtkEnabled;
  if (rtkWillRun) isolateCompressibleItems(translatedBody);
  const rtkStats = compressMessages(
    translatedBody,
    rtkWillRun,
  );
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
  if (privacyEnabled && !(providerRequiresStreaming && !clientRequestedStreaming)) {
    privacyRan = true;
    // Same in-place hazard RTK has (#3566): on passthrough these are the
    // caller's own objects, and an account-fallback retry would hand a fresh
    // filter a body that is already aliased, leaving it with an empty mapping
    // and nothing to restore.
    if (!rtkWillRun) isolateCompressibleItems(translatedBody);
    if (translatedBody.system && typeof translatedBody.system === "object") {
      try {
        translatedBody.system = structuredClone(translatedBody.system);
      } catch {
        /* shared is a worse result, not a broken one */
      }
    }
    privacyFilter = redactOutbound(translatedBody, privacyTerms);
    if (privacyFilter) {
      log?.debug?.("PRIVACY", `pseudonymised ${privacyFilter.size} value(s)`);
      if (privacyFilter.size > 0) notePath(rid, "XFORM.privacy-applied");
    }
  }
  measureSaverStage("privacy", privacyRan);

  // Token-saver flags accumulator for the single "⚙" log line below.
  const xf = [];

  // Caveman: inject terse-style system prompt. injectCaveman reports whether
  // the body actually changed; an unknown level or an already-injected prompt
  // must not claim XFORM.injected.
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
  measureSaverStage(
    "inject",
    tokenSaverEnabled &&
      ((cavemanEnabled && cavemanLevel) || (ponytailEnabled && ponytailLevel)),
  );

  // PXPIPE: image bulky context (Claude-format bodies only), last saver before dispatch
  let pxpipeSummary = null;
  if (pxpipeEnabled) {
    const pxpipeResult = await compressWithPxpipe(translatedBody, {
      enabled: tokenSaverEnabled,
      format: finalFormat,
      model: upstreamModel,
      minChars: pxpipeMinChars,
      timeoutMs: pxpipeTimeoutMs,
      transform: pxpipeTransform,
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
  }
  measureSaverStage("pxpipe", pxpipeEnabled);

  // Memory & Context Optimizer (Tool & Media Pruning, Compaction, Cache Anchoring, Handoffs)
  if (tokenSaverEnabled && memorySettings) {
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
      calibration: sessionCalibrationFor(sid),
      log,
    });
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
    if (memRes.stats?.handoff?.applied) {
      notePath(rid, "XFORM.mem-handoff");
    }
  }
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
      calibration: sessionCalibrationFor(sid),
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
  const headroomPressure = headroomEnabled ? measurePrefixPressure() : null;
  const headroomStats = await compressWithHeadroom(translatedBody, {
    enabled: tokenSaverEnabled && headroomEnabled,
    url: headroomUrl,
    model: upstreamModel,
    format: finalFormat,
    compressUserMessages: headroomCompressUserMessages,
    timeoutMs: headroomTimeoutMs,
    contextPressure: headroomPressure,
    diagnostics: headroomDiagnostics,
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
  if (qacWillRun) {
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
    }
  }
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
  if (pairsWillRun) {
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
    }
  }
  measureSaverStage("pairs", pairsWillRun);

  // Embedding reorder: moves the most relevant historical pairs next to the
  // recent tail via local OpenAI-compatible embeddings. A permutation of the
  // prefix is a full cache rewrite, so a fresh embedding pass runs only on a
  // request whose prefix a rung above already rewrote; every other request
  // replays the order memoised for this session, and a session without a
  // memo is left in chronological order. Fail-open: an embed failure logs one
  // debug line and leaves the prefix in order.
  const reorderWillRun =
    tokenSaverEnabled && embedReorderEnabled && claudePrefixTarget && !!prefixMessages();
  if (reorderWillRun) {
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
      });
      if (res.error) {
        log?.debug?.("REORDER", `skipped: ${String(res.error).slice(0, 80)}`);
        // DEBUG is dark in production; the failure must still be visible.
        decide("XFORM", "reorder-degraded", {
          rid,
          why: String(res.error).slice(0, 40),
        });
      }
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
    }
  }
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
  if (midinjectWillRun) {
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
      measureSaverStage("midinject", true);
      notePath(rid, "XFORM.midinject-applied");
    }
  }

  if (xf.length && log?.line) log.line(reqTag, "⚙", xf.join(" · "));

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
    anchorClaudeCache(translatedBody);
    // Path codes (doc §2 XFORM rows): client multi-anchor plan survived
    // translation vs the re-anchor fallback.
    const anchorsAfter = countCacheAnchors(translatedBody);
    notePath(rid, anchorsBefore >= 2 && anchorsAfter >= anchorsBefore ? "XFORM.cache-keep" : "XFORM.cache-legacy");
  }

  // REQ save=/save_tok=/ce=: per-saver byte deltas (negative = saved, positive
  // growth reported honestly) plus the cache-epoch prefix this request shares
  // with its session's previous final pre-dispatch body. savers off -> silent.
  const saverFields = {};
  // T-F2: the final pre-dispatch body is serialized ONCE, only when a
  // consumer needs it (a saver ran, or ce tracking has a sid); the string
  // feeds the stage ledger's final measure, the ce tracking and the x-tp-*
  // response headers. With no saver and no sid, nothing is serialized.
  let finalBodyBytes = null;
  let compactHint = false;
  if (saverWillRun || sid) {
    const finalSerialized = JSON.stringify(translatedBody);
    finalBodyBytes = Buffer.byteLength(finalSerialized);
    measureSaverStage("final", true);
    if (sid) {
      const tracked = trackCacheEpoch(sid, finalSerialized);
      if (tracked) {
        saverFields.ce = tracked.ce;
        // HEADERS: the compact hint fires only on a known ce that dropped
        // more than 50% against the session's previous request.
        if (tracked.prevBytes > 0 && tracked.ce < tracked.prevBytes * 0.5) {
          compactHint = true;
        }
      }
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
  if (estTokens !== null) {
    // measureContextPressure.projected, arrived at by the same arithmetic:
    // the clamped calibration and the same rounding, so the header and the
    // ladder cannot report two different sizes for one body.
    saverMeta.ctxTokens = Math.ceil(estTokens * calibrationFactor(sessionCalibrationFor(sid)));
  }
  if (saverStages.length) {
    saverMeta.saveBytes = Math.round(
      saverStages.reduce((a, st) => a + st.delta, 0),
    );
  }
  if (saverFields.ce !== undefined) saverMeta.ce = saverFields.ce;
  if (compactHint) saverMeta.compactHint = true;
  // MCP context_status state: sid-keyed self-sizing snapshot for the
  // /api/v1/mcp tool. Written before dispatch so an upstream failure still
  // leaves fresh telemetry. The store swallows its own errors; this catch is
  // the belt on the same contract, telemetry never breaks the request.
  if (sid) {
    rememberRidSession(rid, sid, estTokens);
    try {
      writeContextStatus(sid, {
        rid,
        ctxTokens: saverMeta.ctxTokens,
        saveBytes: saverMeta.saveBytes,
        ceBytes: saverMeta.ce,
        compactHint: saverMeta.compactHint,
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
      "reorder",
      "midinject",
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
      trackPendingRequest(model, provider, connectionId, false);
      abandonStreamingDetail?.(typeof reason?.reason === "string" ? reason.reason : "client_disconnected");
      if (onDisconnect) onDisconnect(reason);
    },
    onError: (err) => {
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
  const mapTransportError = (error) => {
    const isAntigravity = provider === "antigravity";
    const sinkError = isAntigravity ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : (error.message || String(error));
    if (callerSignal?.aborted && (isCallerAbortError(error) || error.name === "AbortError")) {
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
        provider,
        model,
        connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
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
      return withSaverHeaders(createErrorResult(499, isAntigravity ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : "Request aborted", null, null, rid), saverMeta);
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
        null,
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
    return withSaverHeaders(createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg, null, null, rid), saverMeta);
  };
  try {
    const result = await executor.execute({
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
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
    try {
      // Mutate credentials after each successful refresh: rotating refresh_token
      // providers (xAI/grok-cli) issue a new RT on every refresh; without this,
      // refreshWithRetry's 2nd/3rd attempt reuses the already-consumed RT →
      // invalid_grant → auth_failed retryable=false.
      const newCredentials = await refreshWithRetry(
        async () => {
          const result = await executor.refreshCredentials(credentials, log);
          if (
            result?.refreshToken &&
            result.refreshToken !== credentials.refreshToken
          ) {
            if (result.accessToken)
              credentials.accessToken = result.accessToken;
            credentials.refreshToken = result.refreshToken;
          }
          return result;
        },
        3,
        log,
      );
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        if (log?.line)
          log.line(reqTag, "🔑", `TOKEN REFRESHED · ${provider}/${model}`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try {
            await onCredentialsRefreshed(newCredentials);
          } catch (e) {
            log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`);
          }
        }
        try {
          const retryResult = await executor.execute({
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
      log?.warn?.(
        "TOKEN",
        `${provider.toUpperCase()} | refresh threw: ${provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : e.message}`,
      );
    }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    trackPendingRequest(model, provider, connectionId, false, true);
    const { statusCode, message, resetsAtMs, validation, errorPayload } = await parseUpstreamError(
      providerResponse,
      executor,
    );
    const safeStatusCode = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
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
    const failureMetadata = projectClientModelStatus({
      provider,
      requestedModel: model,
      status: statusCode,
      payload: errorPayload,
    });

    // Adaptive unsupported-parameter retry: on a 400 naming rejected fields,
    // record them per provider+model, strip, and retry once immediately.
    const rejectedOn400 =
      statusCode === HTTP_STATUS.BAD_REQUEST
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
          const retryResult = await executor.execute({
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
          if (retryResult.response.ok) {
            providerResponse = retryResult.response;
            providerUrl = retryResult.url;
            providerResponseFormat = retryResult.responseFormat || targetFormat;
            translatedBody = stripped;
            trackPendingRequest(model, provider, connectionId, false);
            appendRequestLog({
              model,
              provider,
              connectionId,
              status: "OK after field-strip",
            }).catch(() => {});
            log?.debug?.("FIELDSTRIP", `Retry succeeded for ${provider}/${model}`);
            const sharedCtx = {
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
            return handleStreamingResponse({
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
            log?.warn?.(
              "FIELDSTRIP",
              `Retry still failed: ${retryResult.response.status} ${retryResult.response.statusText}`,
            );
          }
        } catch (e) {
          if (e.name === "AbortError" || isConnectTimeoutError(e)) {
            return mapTransportError(e);
          }
          log?.warn?.("FIELDSTRIP", `Retry threw: ${provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : e.message}`);
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
        provider,
        model,
        connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        providerRequest: finalBody || translatedBody || null,
        response: { error: sinkMessage, status: safeStatusCode, thinking: null },
        pxpipe: pxpipeSummary,
        status: "error",
        rid,
      }),
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
    return withSaverHeaders(createErrorResult(safeStatusCode, errMsg, resetsAtMs, failureMetadata, rid), saverMeta);
  }

  const sharedCtx = {
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
  return handleStreamingResponse({
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
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
