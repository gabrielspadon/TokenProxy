import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { restoreResponseStream } from "../../utils/privacyFilter.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { createSseTerminalObserver } from "../../utils/streamTerminal.js";
import { createCallerAbortResult } from "../../utils/error.js";
import { saverTelemetryHeaders, withSaverHeaders } from "./saverHeaders.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { peekStreamForContent } from "../../utils/streamContent.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine, doneFields } from "./requestDetail.js";
import { hasValidUsage, estimateUsage } from "../../utils/usageTracking.js";
import { saveRequestDetail } from "../../../src/lib/usageDb.js";
import { decide, req, reqSummary, RID_HEADER } from "../../../src/shared/observability/decide.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { withGenerationIdHeader } from "../../utils/generationId.js";
import {
  classifyAntigravityJsonValidation,
  classifyAntigravitySseOutcome,
  createAntigravitySseValidationGate,
  createSseTextStream,
  readBoundedAntigravityJson,
} from "./antigravitySseValidation.js";
import {
  ANTIGRAVITY_SAFE_ERROR_MESSAGE,
  ANTIGRAVITY_VERIFICATION_REQUIRED_MESSAGE,
  isAntigravityErrorPayload,
} from "../../services/antigravityValidation.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, responsesToolNameMap, model, connectionId, body, onStreamComplete, apiKey, streamState }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return {
      transformStream: createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, streamState, responsesToolNameMap),
      emittedFormat: codexTarget,
    };
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return {
      transformStream: createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, streamState, responsesToolNameMap),
      emittedFormat: sourceFormat,
    };
  }

  return {
    transformStream: createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, streamState, toolNameMap, sourceFormat),
    emittedFormat: sourceFormat,
  };
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, verificationContext, onValidationRequired, reqLogger, toolNameMap, customToolNames, responsesToolNameMap, streamController, onStreamComplete, streamDetailId, streamState, pxpipe, privacyFilter, reqTag, log, callerSignal, rid, saverMeta = {} }) {
  if (callerSignal?.aborted) return withSaverHeaders(createCallerAbortResult(), saverMeta);

  // HEADERS finding: caller-abort results carry the same x-tp-* saver
  // telemetry as every other gateway-built response.
  const abortResult = () => withSaverHeaders(createCallerAbortResult(), saverMeta);

  const getConnPrefix = () => (connectionId ? String(connectionId).slice(0, 8) : undefined);

  // Every failure below rejects the stream BEFORE the placeholder detail row is
  // written, and chatCore's own error sinks only see a transport throw or a non-2xx
  // status — so these, the 200-OK-but-unusable cases (an HTML error page, an empty
  // body, a JSON error payload, a stream carrying no content), left the user an error
  // in the client and nothing in Recent Requests to open (#2221). Recording one row in
  // the shape chatCore already uses makes the failed request inspectable like any other.
  const failStream = (status, message, why) => {
    // 200-OK-but-unusable classification forks: one STREAM.non-sse line.
    decide("STREAM", "non-sse", { rid, conn: getConnPrefix(), why: why || "unknown" });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: message,
      response: { error: message, status, thinking: null },
      pxpipe,
      status: "error",
      rid,
    }, { id: streamDetailId })).catch(() => {});
    return {
      success: false,
      status,
      error: message,
      response: new Response(JSON.stringify({ error: { message: `[${status}]: ${message}` } }), {
        status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...(rid ? { [RID_HEADER]: rid } : {}), ...saverTelemetryHeaders(saverMeta) },
      }),
    };
  };

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers?.get?.('content-type') || '').toLowerCase();
  if (
    upstreamContentType &&
    !upstreamContentType.includes('text/event-stream') &&
    !upstreamContentType.includes('application/json') &&
    !upstreamContentType.includes('application/x-ndjson') &&
    !upstreamContentType.includes('application/stream+json')
  ) {
    let bodyText = '';
    try {
      bodyText = await providerResponse.text();
    } catch {
      if (callerSignal?.aborted) return abortResult();
    }
    if (callerSignal?.aborted) return abortResult();
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const upstreamMessage = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const shortMsg = provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : upstreamMessage;
    const status = Number.isInteger(providerResponse.status) && providerResponse.status >= 400 && providerResponse.status < 600
      ? providerResponse.status
      : 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(shortMsg));
    return failStream(status, shortMsg, "non-sse-content-type");
  }

  // First-valid-event gate: buffer the first chunk from upstream before confirming success.
  // This prevents empty streams (0 bytes) or immediate error objects disguised as 200 OK
  // from falsely clearing account errors or committing an unusable stream to the client.
  if (!providerResponse.body) {
    const status = 502;
    const shortMsg = provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : "Upstream returned no response body";
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · ${shortMsg}`);
    streamController?.handleError?.(new Error(shortMsg));
    return failStream(status, shortMsg, "no-body");
  }

  let hasMeaningfulSseContent = true;
  if (upstreamContentType.includes("text/event-stream")) {
    const contentPeek = await peekStreamForContent(providerResponse, undefined, {
      preserveOnNoContent: true,
      includeClaudeTerminal: true,
      requireActionableGeminiOutput: provider === "antigravity",
    });
    if (callerSignal?.aborted) return createCallerAbortResult();
    if (contentPeek.error) {
      const status = 502;
      const shortMsg = provider === "antigravity"
        ? ANTIGRAVITY_SAFE_ERROR_MESSAGE
        : `Upstream stream read error: ${contentPeek.error?.message || contentPeek.error}`;
      if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · ${shortMsg}`);
      streamController?.handleError?.(provider === "antigravity" ? new Error(shortMsg) : contentPeek.error);
      return failStream(status, shortMsg, "peek-read-error");
    }
    if (contentPeek.upstreamError) {
      // The peek detects an upstream that answers 200 and puts its error in the
      // content (qoder's `[qoder error 413: ...]` for an oversized request,
      // #1640). Logging it and piping on hands the client an assistant message
      // whose text is the error, which no fallback ever sees. Fail it here, the
      // way combo.js already treats the same class of in-band error, so the
      // account/combo loop can move on or the caller gets a real status.
      try { contentPeek.body?.cancel?.()?.catch?.(() => {}); } catch {}
      const status = contentPeek.upstreamError.status || 502;
      const shortMsg = provider === "antigravity"
        ? ANTIGRAVITY_SAFE_ERROR_MESSAGE
        : contentPeek.upstreamError.reason;
      if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · upstream error as content\n    ${shortMsg}`);
      else log?.warn?.("CHATCORE", `${provider}/${model} streamed HTTP 200 carrying an upstream error — treating as failure. ${contentPeek.upstreamError.reason}`);
      streamController?.handleError?.(new Error(shortMsg));
      return failStream(status, shortMsg, "upstream-error-as-content");
    }
    hasMeaningfulSseContent = contentPeek.hasContent;
    providerResponse = { ...providerResponse, body: contentPeek.body };
  }

  let reader = null;
  let firstChunk = null;
  try {
    reader = providerResponse.body.getReader();
    const { done, value } = await reader.read();
    if (callerSignal?.aborted) {
      try { reader.releaseLock?.(); } catch {}
      return abortResult();
    }
    if (done || !value || value.length === 0) {
      try { reader.releaseLock?.(); } catch {}
      const status = 502;
      const shortMsg = provider === "antigravity"
        ? ANTIGRAVITY_SAFE_ERROR_MESSAGE
        : "Upstream stream ended before a valid event (empty stream)";
      if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · ${shortMsg}`);
      streamController?.handleError?.(new Error(shortMsg));
      return failStream(status, shortMsg, "empty-stream");
    }
    firstChunk = value;
  } catch (readErr) {
    try { await reader?.cancel?.(); } catch {}
    try { reader?.releaseLock?.(); } catch {}
    if (callerSignal?.aborted) {
      return abortResult();
    }
    const status = 502;
    const shortMsg = provider === "antigravity"
      ? ANTIGRAVITY_SAFE_ERROR_MESSAGE
      : `Upstream stream read error: ${readErr?.message || readErr}`;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · ${shortMsg}`);
    streamController?.handleError?.(provider === "antigravity" ? new Error(shortMsg) : readErr);
    return failStream(status, shortMsg, "read-error");
  }

  const reportValidation = async (validation) => {
    try {
      await onValidationRequired?.({
        validation,
        observationId: verificationContext?.observationId,
      });
    } catch {
      log?.warn?.("VERIFICATION", `validation callback failed for ${String(connectionId).slice(0, 8)}`);
    }
  };
  const isAntigravityJsonRpc = provider === "antigravity" && upstreamContentType.includes("application/json");
  let bufferedAntigravityJson = null;
  if (isAntigravityJsonRpc) {
    let jsonCapture;
    try {
      jsonCapture = await readBoundedAntigravityJson({ reader, initialChunk: firstChunk });
    } catch {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock?.(); } catch {}
      const status = 502;
      if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · ${ANTIGRAVITY_SAFE_ERROR_MESSAGE}`);
      streamController?.handleError?.(new Error(ANTIGRAVITY_SAFE_ERROR_MESSAGE));
      return failStream(status, ANTIGRAVITY_SAFE_ERROR_MESSAGE, "antigravity-json-error");
    }
    if (jsonCapture.exceeded) {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock?.(); } catch {}
      const status = 502;
      if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · ${ANTIGRAVITY_SAFE_ERROR_MESSAGE}`);
      streamController?.handleError?.(new Error(ANTIGRAVITY_SAFE_ERROR_MESSAGE));
      return failStream(status, ANTIGRAVITY_SAFE_ERROR_MESSAGE, "antigravity-json-error");
    }
    bufferedAntigravityJson = jsonCapture.text;
  }

  const initialSseOutcome = provider === "antigravity" && !isAntigravityJsonRpc
    ? classifyAntigravitySseOutcome(new TextDecoder().decode(firstChunk), { includeTrailing: false })
    : null;
  const initialValidation = provider === "antigravity"
    ? isAntigravityJsonRpc
      ? classifyAntigravityJsonValidation(bufferedAntigravityJson, providerResponse.status)
      : initialSseOutcome?.validation ?? null
    : null;
  if (initialValidation) {
    await reportValidation(initialValidation);
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock?.(); } catch {}
    const status = 403;
    const message = ANTIGRAVITY_VERIFICATION_REQUIRED_MESSAGE;
    streamController?.handleError?.(new Error(message));
    return failStream(status, message, "verification-required");
  }

  if (initialSseOutcome?.kind === "error") {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock?.(); } catch {}
    const status = 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `ERROR ${status} · ${provider}/${model} · ${ANTIGRAVITY_SAFE_ERROR_MESSAGE}`);
    streamController?.handleError?.(new Error(ANTIGRAVITY_SAFE_ERROR_MESSAGE));
    return failStream(status, ANTIGRAVITY_SAFE_ERROR_MESSAGE, "antigravity-sse-error");
  }

  // Check if first chunk contains a structured JSON error object returned as 200 OK
  if (firstChunk) {
    const chunkStr = bufferedAntigravityJson ?? new TextDecoder().decode(firstChunk);
    const trimmed = chunkStr.trim();
    if (trimmed.startsWith("{") && (trimmed.includes('"error"') || trimmed.includes('"error_code"') || trimmed.includes('"detail"'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isAntigravityJsonRpc ? isAntigravityErrorPayload(parsed) : (parsed.error || parsed.error_code || (parsed.detail && !parsed.choices && !parsed.delta))) {
          const errMsg = typeof parsed.error === "string"
            ? parsed.error
            : parsed.error?.message || parsed.error_msg || parsed.detail || JSON.stringify(parsed);
          const safeErrMsg = provider === "antigravity"
            ? ANTIGRAVITY_SAFE_ERROR_MESSAGE
            : errMsg;
          const rawStatus = parsed.error?.status || parsed.status || 502;
          const status = typeof rawStatus === "number" && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 502;
          if (log?.errorLine) log.errorLine(reqTag, "✗", `ERROR ${status} · ${provider}/${model} · ${safeErrMsg}`);
          streamController?.handleError?.(new Error(safeErrMsg));
          try { await reader?.cancel?.(); } catch {}
          try { reader?.releaseLock?.(); } catch {}
          return failStream(status, safeErrMsg, "upstream-error-object");
        }
      } catch {
        // Not a pure JSON error object, treat as valid streaming content
      }
    }
  }

  if (!hasMeaningfulSseContent) {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock?.(); } catch {}
    const status = 502;
    const shortMsg = provider === "antigravity"
      ? ANTIGRAVITY_SAFE_ERROR_MESSAGE
      : "Upstream stream ended before meaningful content";
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · ${shortMsg}`);
    streamController?.handleError?.(new Error(shortMsg));
    return failStream(status, shortMsg, "no-meaningful-content");
  }

  if (bufferedAntigravityJson != null) {
    try { reader.releaseLock?.(); } catch {}
    reader = null;
    firstChunk = new TextEncoder().encode(bufferedAntigravityJson);
  }

  // Non-Antigravity streams can clear account health after their first valid
  // event. Antigravity must wait for terminal completion because a later SSE
  // frame can still be a validation challenge.
  if (onRequestSuccess && provider !== "antigravity") {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // Reconstruct the upstream stream with the buffered first chunk prepended.
  // Antigravity frames are parsed before every downstream sink, not only once.
  let responseBodyStream = bufferedAntigravityJson == null
    ? providerResponse.body
    : createSseTextStream(bufferedAntigravityJson);
  if (reader && firstChunk) {
    if (provider === "antigravity") {
      responseBodyStream = createAntigravitySseValidationGate({
        reader,
        initialChunk: firstChunk,
        onValidationRequired: async (validation) => {
          await reportValidation(validation);
          streamController?.handleError?.(new Error(ANTIGRAVITY_VERIFICATION_REQUIRED_MESSAGE));
        },
        onUpstreamError: () => {
          streamController?.handleError?.(new Error(ANTIGRAVITY_SAFE_ERROR_MESSAGE));
        },
      });
    } else {
      let yieldedFirst = false;
      responseBodyStream = new ReadableStream({
        async pull(controller) {
          if (!yieldedFirst) {
            yieldedFirst = true;
            controller.enqueue(firstChunk);
            return;
          }
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
          } catch (err) {
            controller.error(err);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        }
      });
    }
  }

  let antigravityRequestSuccessNotified = false;
  let pendingCompletion = null;
  let completionDelivered = false;
  const notifyAntigravitySuccess = (...args) => {
    if (provider !== "antigravity" || antigravityRequestSuccessNotified || typeof onRequestSuccess !== "function") return;
    const [contentObj, usage, , { aborted = false } = {}] = args;
    if (aborted || !(contentObj?.content?.trim?.() || contentObj?.thinking?.trim?.() || hasOutputTokens(usage))) return;
    antigravityRequestSuccessNotified = true;
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(() => {
        console.error("[ChatCore] onRequestSuccess failed:", ANTIGRAVITY_SAFE_ERROR_MESSAGE);
      });
  };
  const captureTransformCompletion = (...args) => {
    if (args[3]?.aborted) {
      onStreamComplete?.(...args);
      return;
    }
    pendingCompletion = args;
  };
  const deliverNormalCompletion = () => {
    if (completionDelivered || !pendingCompletion) return;
    completionDelivered = true;
    onStreamComplete?.(...pendingCompletion);
    notifyAntigravitySuccess(...pendingCompletion);
  };
  const completionAwareController = {
    ...streamController,
    handleComplete: () => {
      streamController?.handleComplete?.();
      deliverNormalCompletion();
    },
  };
  const { transformStream, emittedFormat } = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, responsesToolNameMap, model, connectionId, body, onStreamComplete: captureTransformCompletion, apiKey, streamState });

  // Responses passthrough: synthesize response.failed + [DONE] if the stream aborts/stalls before a terminal event
  const isResponsesPassthrough = emittedFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough
    ? () => {
        decide("STREAM", "terminal-synthesized", { rid, why: "abort" });
        return buildAbortedResponsesTerminalBytes();
      }
    : null;
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const wrappedResponse = {
    ...providerResponse,
    body: responseBodyStream,
    headers: providerResponse.headers,
  };
  const transformedBody = pipeWithDisconnect(wrappedResponse, transformStream, completionAwareController, {
    onAbortTerminal,
    stallTimeoutMs,
    terminalObserver: createSseTerminalObserver(emittedFormat),
    callerSignal,
  });

  // If completion (or abandonment) fired synchronously during pipe setup, the
  // one-shot finalizer in buildOnStreamComplete already ran and cannot rewrite
  // this row — the placeholder would stay "pending" forever (doc row 65).
  if (completionDelivered) decide("STREAM", "detail-pending", { rid });
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    // Not "success": this row is written when the stream is handed to the
    // client, long before its outcome is known, and onStreamComplete /
    // onStreamAbandoned overwrite it with success, aborted or cancelled. When
    // that second write never lands (process death, an upstream that errors the
    // readable before either path runs) the placeholder survives, and claiming
    // success made it report a successful request whose content is the
    // placeholder string (#1625). "pending" is what it actually is.
    //
    // Nothing selects on status = 'success': the only status predicate in the
    // read path is requestStatsRepo's errors count (status = 'error'), so a
    // pending row is still counted as a request and is not miscounted as an
    // error. The UI renders whatever string it finds — StatisticsContent's
    // StatusBadge, RequestDetailsTab's icon and UsageStats' dot all test for
    // success and fall through to the failure tone otherwise — so the row stays
    // visible and reads as not-yet-succeeded rather than as a good response.
    status: "pending",
    rid,
  }, { id: streamDetailId })).catch(() => {
    decide("ACCT", "detail-write-failed", { rid, phase: "save-stream" });
  });

  // Privacy filter (#2728): last transform before the client, so an alias is
  // restored even when it straddles two SSE chunks or sits inside a tool
  // call's `arguments`. No filter (the default) returns the same stream.
  return {
    success: true,
    response: new Response(restoreResponseStream(privacyFilter, transformedBody), {
      // The upstream's own generation id, when it sent one that passes the
      // allowlist in utils/generationId.js. It is the only handle a user or an
      // operator has for correlating this turn against the upstream's billing
      // and logs.
      headers: withGenerationIdHeader(
        {
          ...(rid ? { [RID_HEADER]: rid } : {}),
          ...SSE_HEADERS,
          ...saverTelemetryHeaders(saverMeta),
        },
        providerResponse,
      )
    })
  };
}

/**
 * Whether a completed stream actually produced anything: text, thinking, or
 * output tokens (covers tool-call-only turns, which have no text/thinking but
 * do spend completion tokens). Checking completion/output tokens specifically
 * — not just "any usage field" — avoids false-flagging a real tool-call
 * response as empty just because prompt tokens alone are non-zero.
 */
function hasOutputTokens(usage) {
  if (!usage || typeof usage !== "object") return false;
  const n = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? 0);
  return n > 0;
}

function notifyTerminalVerificationSuccess(callback, connectionId, log) {
  if (typeof callback !== "function") return;
  try {
    Promise.resolve(callback()).catch(() => {
      log?.warn?.("VERIFICATION", `success callback failed for ${String(connectionId).slice(0, 8)}`);
    });
  } catch {
    log?.warn?.("VERIFICATION", `success callback failed for ${String(connectionId).slice(0, 8)}`);
  }
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 * @param {Function} [onEmptyStream] - called (no args) once, after the stream
 *   finishes, if it produced no text/thinking/output tokens at all. The
 *   response has already been sent to the client by this point (streaming
 *   commits to `success: true` before the body is known), so this can't
 *   un-send it — it exists so the caller can lock the account/model out of
 *   rotation for the *next* request (see chat.js), which is what actually
 *   gets a retried request routed to a different backend.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log, onEmptyStream, sourceFormat, rid, route, fmt, sel, notifyTerminalVerificationSuccess: notifyTerminal,
  saverFields = {} }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  // One-shot finalization guard shared by onStreamComplete (flush/cancel paths)
  // and onStreamAbandoned (upstream error path): whoever fires first wins, so a
  // disconnect, a stall and a late EOF can never write two rows.
  let completed = false;

  // Mutable state the SSE transform stream populates on every chunk via syncState()
  const streamState = { usage: null, content: "", thinking: "", ttftAt: null };

  const connPrefix = () => (connectionId ? String(connectionId).slice(0, 8) : undefined);

  // Both finalization paths lock the account the same way; onEmptyStream is
  // async in chat.js, so a rejection here must not surface as an unhandled one.
  const lockForNextRequest = (why) => {
    if (!onEmptyStream) return;
    if (log?.warn) log.warn("CHATCORE", `${provider}/${model} ${why} — locking for next request`);
    try {
      Promise.resolve(onEmptyStream()).catch((e) => console.error("[Stream] onEmptyStream failed:", e?.message || e));
    } catch (e) {
      console.error("[Stream] onEmptyStream failed:", e?.message || e);
    }
  };

  const onStreamComplete = (contentObj, usage, ttftAt, { aborted = false } = {}) => {
    if (completed) return;
    completed = true;
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    // Estimate when the upstream completed the stream without ever sending a
    // usage block. The interrupted path below has always done this; the SUCCESS
    // path did not, so a provider that omits usage in stream mode recorded a
    // literal zero — "IN 0 · OUT 0" in the log and no usageHistory row — while
    // the same model over non-streaming JSON reported real numbers, because
    // there the counts come from the response body (#3017).
    //
    // Zero is not a smaller error than an estimate here, it is the wrong kind:
    // it silently under-reports spend and leaves the request invisible to the
    // usage dashboard. estimateUsage marks its result so downstream can tell
    // the two apart.
    // Gated on trimmed content so the `onEmptyStream` check below is untouched:
    // it only fires when the content is blank, and that is exactly when no
    // estimate is produced. A stream with nothing in it still records nothing.
    if (!hasValidUsage(usage) && contentObj?.content?.trim?.()) {
      usage = estimateUsage(body, contentObj.content.length, sourceFormat || FORMATS.OPENAI);
    }
    const safeContent =
      contentObj?.content || (aborted ? "[Aborted streaming response]" : "[Empty streaming response]");
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      pxpipe,
      status: aborted ? "aborted" : "success",
      rid,
    }, { id: streamDetailId })).catch(() => {
      decide("ACCT", "detail-write-failed", { rid, phase: "update" });
    });

    // Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, requestedModel: clientRawRequest?.body?.model, translatedBody, label: aborted ? "STREAM USAGE (aborted)" : "STREAM USAGE", silent: true, rid });
    // The one nominal per-request line (doc §3.3/3.4): success is REQ.ok,
    // an aborted/interrupted completion is REQ.failed — exactly one, never both.
    if (usage?.estimated) decide("STREAM", "usage-estimated", { rid, conn: connPrefix(), why: "provider-omitted-usage" });
    if (aborted) {
      reqSummary("failed", { ...saverFields, rid, conn: connPrefix(), route, fmt, sel, status: 499, why: "aborted" });
    } else {
      reqSummary("ok", { ...saverFields, rid, conn: connPrefix(), route, fmt, sel, row: streamDetailId, ...doneFields({ usage, latency }) });
    }

    if (!contentObj?.content?.trim?.() && !contentObj?.thinking?.trim?.() && !hasOutputTokens(usage)) {
      decide("STREAM", "empty", { rid, conn: connPrefix(), why: "no-content", lock: true });
      lockForNextRequest("stream completed with no content/thinking/output tokens");
    }

    if (
      provider === "antigravity"
      && !aborted
      && (contentObj?.content?.trim?.() || contentObj?.thinking?.trim?.() || hasOutputTokens(usage))
    ) {
      notifyTerminalVerificationSuccess(notifyTerminal, connectionId, log);
    }
  };

  // Finalize the placeholder row when the stream ends without flush() or
  // cancel() ever running: an upstream error (ECONNRESET, stall timeout) errors
  // the composite readable before the client sees it, which suppresses the
  // transform's cancel() per the Streams spec. Recovers the partial usage the
  // transform stream accumulated in streamState, then marks the row cancelled.
  const onStreamAbandoned = (reason) => {
    if (completed) return;
    completed = true;
    const detail = `[Streaming interrupted: ${reason || "unknown"}]`;

    let partialUsage = streamState.usage;
    if (!hasValidUsage(partialUsage) && streamState.content) {
      partialUsage = estimateUsage(body, streamState.content.length, sourceFormat || FORMATS.OPENAI);
    }
    const tokens = partialUsage
      ? { ...partialUsage, completion_tokens: partialUsage.completion_tokens ?? partialUsage.output_tokens ?? 0 }
      : { prompt_tokens: 0, completion_tokens: 0 };

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: streamState.ttftAt ? streamState.ttftAt - requestStartTime : 0, total: Date.now() - requestStartTime },
      tokens,
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: detail,
      response: { content: detail, thinking: null, type: "streaming" },
      pxpipe,
      status: "cancelled",
      rid,
    }, { id: streamDetailId })).catch(() => {
      decide("ACCT", "detail-write-failed", { rid, phase: "finalize" });
    });

    if (hasValidUsage(tokens)) {
      saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, requestedModel: clientRawRequest?.body?.model, translatedBody, label: "STREAM USAGE (interrupted)", silent: true });
    }
    if (log?.line) log.line(reqTag, "✗", `INTERRUPTED ${reason || "unknown"}`);
    reqSummary("failed", { ...saverFields, rid,
      conn: connPrefix(),
      route,
      fmt,
      sel,
      status: reason === "client_disconnect" || reason === "caller_abort" ? 499 : 502,
      why: String(reason || "unknown").slice(0, 40),
    });

    // A stall is the one interruption the client cannot route around: the
    // account answered 200 and then went silent, so the next request would be
    // sent straight back to it. Reuse the empty-stream lock so rotation moves
    // on (#3136). Gated on no assistant text having been emitted, because the
    // report asks for rotation when the model hangs in the reasoning phase and
    // explicitly not for a stall during a healthy final response.
    if (reason === "stall_timeout" && !streamState.content?.trim?.() && !hasOutputTokens(tokens)) {
      const stallLimit = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
      decide("STREAM", "stalled", { rid, conn: connPrefix(), idle: stallLimit, limit: stallLimit, action: "lock" });
      lockForNextRequest("stalled before producing any answer");
    }
  };

  return { onStreamComplete, onStreamAbandoned, streamDetailId, streamState };
}
