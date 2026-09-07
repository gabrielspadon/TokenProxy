import { recordContextFailure } from "./contextTelemetry.js";
import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createCallerAbortResult, createErrorResult, isCallerAbortError } from "../../utils/error.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import {
  consumeResponseBodyWithDeadline,
  isBodyReadTimeoutError,
  readResponseTextWithDeadline,
} from "../../utils/bodyTimeout.js";
import { FORMATS } from "../../translator/formats.js";
import { PROVIDERS } from "../../config/providers.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine, doneFields } from "./requestDetail.js";
import { ROLE, RESPONSES_ITEM } from "../../translator/schema/index.js";
import { resolveResponsesToolCall } from "../../translator/response/openai-responses.js";
import { stripJsonFence, unfenceJsonChoices, wantsJsonOutput } from "../../utils/jsonFence.js";
import { geminiToOpenAIResponse } from "../../translator/response/gemini-to-openai.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { mergeToolArguments } from "../../translator/concerns/toolCall.js";
import { extractReasoningText } from "../../translator/concerns/reasoning.js";
import { parseSSELine } from "../../utils/streamHelpers.js";
import { ANTIGRAVITY_SAFE_ERROR_MESSAGE, ANTIGRAVITY_VERIFICATION_REQUIRED_MESSAGE } from "../../services/antigravityValidation.js";
import { classifyAntigravitySseValidation, createSseTextStream } from "./antigravitySseValidation.js";
import {
  CLAUDE_CLASSIFIER_ERROR_MESSAGE,
  ClaudeClassifierValidationError,
  isClaudeClassifierRequest,
  projectResponsesClassifierStream,
  validateClaudeClassifierMessage,
} from "./claudeClassifier.js";

import { saverTelemetryHeaders, withSaverHeaders } from "./saverHeaders.js";

/**
 * Reasoning text carried by an OpenAI-shaped message or streaming delta.
 *
 * Wraps the translator's extractReasoningText — which already knows
 * `reasoning_content` (GLM/Qwen/DeepSeek/Kimi), `reasoning` (OpenRouter-shaped
 * gateways such as api.cline.bot) and `reasoning_details[]` (MiniMax) — and adds
 * the LiteLLM `provider_specific_fields` nesting the non-streaming projections
 * below already handled. The readers here each rolled their own narrower subset
 * and drifted apart, so a Cline reasoning-only turn read as an empty completion
 * (#3644). One reader, so they cannot drift again.
 */
export function messageReasoningText(message) {
  return extractReasoningText(message)
    || (typeof message?.provider_specific_fields?.reasoning_content === "string"
      ? message.provider_specific_fields.reasoning_content
      : "");
}

const CLASSIFIER_CHAT_DELTA_FIELDS = new Set([
  "role",
  "content",
  "reasoning_content",
  "tool_calls",
]);
const CLASSIFIER_GEMINI_PART_FIELDS = new Set([
  "text",
  "thought",
  "thoughtSignature",
  "thought_signature",
]);

// Responses-API providers (e.g. codex) may emit SSE without content-type + use Responses output shape
const isResponsesProvider = (p) => PROVIDERS[p]?.format === FORMATS.OPENAI_RESPONSES;
import { saveRequestDetail, appendRequestLog } from "../../../src/lib/usageDb.js";
import { decide, req, reqSummary, RID_HEADER } from "../../../src/shared/observability/decide.js";

function textFromResponsesMessageItem(item) {
  if (!item?.content || !Array.isArray(item.content)) return "";
  const byType = item.content.find((c) => c.type === "output_text");
  if (typeof byType?.text === "string") return byType.text;
  const anyText = item.content.find((c) => typeof c.text === "string");
  if (typeof anyText?.text === "string") return anyText.text;
  return "";
}

/**
 * Codex / Responses API may emit many alternating reasoning + message items.
 * Early message blocks often have empty output_text; the user-visible answer is usually in the last non-empty message.
 */
function pickAssistantMessageForChatCompletion(output) {
  if (!Array.isArray(output)) return { msgItem: null, textContent: null };
  const messages = output.filter((item) => item?.type === "message");
  if (messages.length === 0) return { msgItem: null, textContent: null };
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textFromResponsesMessageItem(messages[i]);
    if (text.length > 0) return { msgItem: messages[i], textContent: text };
  }
  const last = messages[messages.length - 1];
  return { msgItem: last, textContent: textFromResponsesMessageItem(last) };
}

/**
 * Convert an OpenAI Chat Completions JSON body into the Responses API shape.
 * Inlined here (not imported from nonStreamingHandler.js) to avoid a circular
 * import. Mirrors openAICompletionToResponses in nonStreamingHandler.js.
 */
function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

function chatCompletionToResponses(responseBody, customToolNames = null, responsesToolNameMap = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  // The request translator exports the collected custom tool names as an array
  // (translator/request/openai-responses.js) and chatCore.js forwards that value
  // verbatim, while direct callers pass a Set. Accept either, without mutating
  // the caller's collection.
  const customToolNameSet = customToolNames instanceof Set ? customToolNames : new Set(customToolNames || []);

  const reasoning = messageReasoningText(message);
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const resolved = resolveResponsesToolCall(fn.name, responsesToolNameMap);
    const custom = customToolNameSet.has(fn.name) || resolved.custom;
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      name: resolved.name,
      ...(resolved.namespace ? { namespace: resolved.namespace } : {}),
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }),
    });
  }

  const usage = responseBody.usage || {};
  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status: "completed",
    background: false,
    error: null,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}

/**
 * Parse tool arguments (string or object) to a plain object.
 * Inlined to avoid a circular import with nonStreamingHandler.js.
 */
function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Convert an OpenAI Chat Completions non-streaming body to an Anthropic Message.
 * Used when a Claude-format client (e.g. Claude Code) hits a forceStream provider
 * and the SDK retries non-streaming — we get back OpenAI format and must convert.
 * Inlined (not imported from nonStreamingHandler.js) to avoid a circular import:
 * nonStreamingHandler already imports parseSSEToOpenAIResponse from this module.
 * Mirrors openAICompletionToClaudeMessage in nonStreamingHandler.js.
 */
function openAICompletionToClaudeMessage(responseBody) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  const reasoning = messageReasoningText(message);
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments || toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = responseBody.usage || {};
  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: "assistant",
    model: responseBody.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
  };
}

/**
 * Parse OpenAI-style SSE text into a single chat completion JSON.
 * Used when provider forces streaming but client wants non-streaming.
 */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel) {
  const chunks = [];
  let streamError = null;

  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk?.error) streamError = chunk.error;
      else chunks.push(chunk);
    } catch { /* ignore malformed lines */ }
  }

  if (streamError) return { error: streamError };
  if (chunks.length === 0) return null;

  const first = chunks[0];
  const contentParts = [];
  const reasoningParts = [];
  const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let finishReason = "stop";
  let usage = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content.length > 0) contentParts.push(delta.content);
    const deltaReasoning = messageReasoningText(delta);
    if (deltaReasoning) reasoningParts.push(deltaReasoning);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;

    // Accumulate tool_calls from streaming deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        }
        const existing = toolCallMap.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments)
          existing.function.arguments = mergeToolArguments(existing.function.arguments, tc.function.arguments);
      }
    }
  }

  const message = { role: "assistant", content: contentParts.join("") || (toolCallMap.size > 0 ? null : "") };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  }

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }]
  };
  if (usage) result.usage = usage;
  return result;
}

function parseGeminiSSEToOpenAIResponse(rawSSE, fallbackModel, targetFormat, provider) {
  const state = { provider };
  const chunks = [];
  let streamError = null;

  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    const parsed = parseSSELine(trimmed, targetFormat);
    if (!parsed || parsed.done) continue;
    if (parsed.error) streamError = parsed.error;
    else chunks.push(...(geminiToOpenAIResponse(parsed, state) || []));
  }

  if (streamError) return { error: streamError };
  if (chunks.length === 0) return null;
  return parseSSEToOpenAIResponse(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n"),
    fallbackModel
  );
}

function hasUsefulForcedSseOutput(value) {
  const usage = value?.usage || {};
  if (Number(usage.completion_tokens ?? usage.output_tokens ?? 0) > 0) return true;
  if (Array.isArray(value?.output) && value.output.length > 0) return true;
  const message = value?.choices?.[0]?.message;
  return Boolean(
    (typeof message?.content === "string" && message.content.trim())
    || (typeof message?.reasoning_content === "string" && message.reasoning_content.trim())
    || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0),
  );
}

async function notifyTerminalVerificationSuccess(callback, connectionId, log) {
  if (typeof callback !== "function") return;
  try {
    await callback();
  } catch {
    log?.warn?.("VERIFICATION", `success callback failed for ${String(connectionId).slice(0, 8)}`);
  }
}

function assertClassifierChatSseLossless(rawSSE) {
  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new ClaudeClassifierValidationError();
    }
    const choices = parsed?.choices;
    if (Array.isArray(choices) && choices.length > 1) {
      throw new ClaudeClassifierValidationError();
    }
    for (const choice of choices || []) {
      const delta = choice?.delta;
      if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue;
      if (Object.keys(delta).some((field) => !CLASSIFIER_CHAT_DELTA_FIELDS.has(field))) {
        throw new ClaudeClassifierValidationError();
      }
    }
  }
}

function assertClassifierGeminiSseLossless(rawSSE) {
  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new ClaudeClassifierValidationError();
    }
    const response = parsed?.response || parsed;
    const candidates = response?.candidates;
    if (Array.isArray(candidates) && candidates.length > 1) {
      throw new ClaudeClassifierValidationError();
    }
    for (const candidate of candidates || []) {
      const parts = candidate?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part || typeof part !== "object" || Array.isArray(part)
            || Object.keys(part).some((field) => !CLASSIFIER_GEMINI_PART_FIELDS.has(field))) {
          throw new ClaudeClassifierValidationError();
        }
      }
    }
  }
}

/**
 * Handle case: provider forced streaming but client wants JSON.
 * Supports both Codex/Responses API SSE and standard Chat Completions SSE.
 */
export async function handleForcedSSEToJson({ providerResponse, sourceFormat, targetFormat, provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, verificationContext, onValidationRequired, notifyTerminalVerificationSuccess: notifyTerminal, toolNameMap, customToolNames, responsesToolNameMap, trackDone, appendLog, reqTag, log, callerSignal, rid, route, fmt, sel, saverFields = {}, saverMeta = {}, contextTelemetry, preSaverSerialized, sid }) {
  const contentType = providerResponse.headers.get("content-type") || "";
  const isSSE = contentType.includes("text/event-stream") || (contentType === "" && isResponsesProvider(provider));
  if (!isSSE) return null; // not handled here

  let antigravitySseText = null;
  const classifierMode = sourceFormat === FORMATS.CLAUDE
    && isClaudeClassifierRequest(body);

  let pendingCleared = false;
  const trackDoneOnce = () => {
    if (pendingCleared) return;
    pendingCleared = true;
    trackDone();
  };
  const connPrefix = connectionId ? String(connectionId).slice(0, 8) : undefined;
  // HEADERS finding: gateway-built error responses carry the same x-tp-*
  // saver telemetry as successes.
  let contextFailureTokens = null;
  const saverErrorResult = (...args) => {
    recordContextFailure(contextTelemetry, { provider, model, connectionId, requestStartTime, tokens: contextFailureTokens });
    args[3] = { ...args[3], safeToReplay: false };
    return withSaverHeaders(createErrorResult(...args), saverMeta);
  };
  const bodyReadFailure = (error, context = "convert-sse-json") => {
    trackDoneOnce();
    if (callerSignal?.aborted && isCallerAbortError(error)) {
      recordContextFailure(contextTelemetry, { provider, model, connectionId, requestStartTime, status: "aborted", tokens: contextFailureTokens });
      return withSaverHeaders(createCallerAbortResult(), saverMeta);
    }
    if (isBodyReadTimeoutError(error)) {
      reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.GATEWAY_TIMEOUT, why: "body-timeout" });
      return saverErrorResult(HTTP_STATUS.GATEWAY_TIMEOUT, `Upstream response body timed out for ${provider}`, null, null, rid);
    }
    reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.BAD_GATEWAY, why: context.slice(0, 40) });
    return saverErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : "Failed to convert streaming response to JSON",
      null,
      null,
      rid,
    );
  };

  if (provider === "antigravity") {
    try {
      antigravitySseText = await readResponseTextWithDeadline({ body: providerResponse.body, callerSignal });
    } catch (err) {
      const result = bodyReadFailure(err);
      appendLog({ status: `FAILED ${result.status}` });
      return result;
    }
    const validation = classifyAntigravitySseValidation(antigravitySseText);
    if (validation) {
      try {
        await onValidationRequired?.({ validation, observationId: verificationContext?.observationId });
      } catch {
        log?.warn?.("VERIFICATION", `validation callback failed for ${String(connectionId).slice(0, 8)}`);
      }
      return saverErrorResult(HTTP_STATUS.FORBIDDEN, ANTIGRAVITY_VERIFICATION_REQUIRED_MESSAGE);
    }
  }

  const ctx = {
    provider, model, connectionId, rid,
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null
  };

  // Codex/Responses API SSE path
  // Branch on the UPSTREAM format (targetFormat = format we spoke to the provider in),
  // not the client format: a Responses-API client behind a chat-native forced-streaming
  // provider still receives chat SSE chunks, which must go through the standard path.
  const isGeminiSse = [
    FORMATS.ANTIGRAVITY,
    FORMATS.GEMINI,
    FORMATS.GEMINI_CLI,
    FORMATS.VERTEX,
  ].includes(targetFormat);
  const isCodexResponsesApi = isResponsesProvider(provider) || targetFormat === FORMATS.OPENAI_RESPONSES;
  if (isCodexResponsesApi || isGeminiSse) {
    try {
      let jsonResponse;
      let classifierProjection = null;
      if (isGeminiSse) {
        const sseText = antigravitySseText ?? await readResponseTextWithDeadline({ body: providerResponse.body, callerSignal });
        if (classifierMode) assertClassifierGeminiSseLossless(sseText);
        const parsed = parseGeminiSSEToOpenAIResponse(sseText, model, targetFormat, provider);
        if (!parsed) {
          trackDoneOnce();
          return saverErrorResult(
            HTTP_STATUS.BAD_GATEWAY,
            provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : "Invalid Gemini SSE response for non-streaming request",
          );
        }
        contextFailureTokens = parsed.usage ?? null;
        if (parsed.error) {
          trackDoneOnce();
          return saverErrorResult(
            HTTP_STATUS.BAD_GATEWAY,
            provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : parsed.error.message || "Upstream SSE stream failed",
          );
        }
        jsonResponse = chatCompletionToResponses(parsed, customToolNames, responsesToolNameMap);
      } else if (antigravitySseText !== null) {
        jsonResponse = await convertResponsesStreamToJson(createSseTextStream(antigravitySseText));
      } else if (classifierMode && typeof providerResponse.body?.tee === "function") {
        const [conversionStream, projectionStream] = providerResponse.body.tee();
        [jsonResponse, classifierProjection] = await Promise.all([
          consumeResponseBodyWithDeadline({
            body: conversionStream,
            callerSignal,
            consume: (reader) => convertResponsesStreamToJson(conversionStream, { reader }),
          }),
          consumeResponseBodyWithDeadline({
            body: projectionStream,
            callerSignal,
            consume: (reader) => projectResponsesClassifierStream(
              body,
              projectionStream,
              { reader },
            ),
          }),
        ]);
      } else {
        jsonResponse = await consumeResponseBodyWithDeadline({
          body: providerResponse.body,
          callerSignal,
          consume: (reader) => convertResponsesStreamToJson(providerResponse.body, { reader }),
        });
      }
      contextFailureTokens = jsonResponse?.usage ?? null;
      if (jsonResponse?.status === "failed" || jsonResponse?.error) {
        trackDoneOnce();
        return saverErrorResult(HTTP_STATUS.BAD_GATEWAY, "Upstream generation failed", null, { safeToReplay: false }, rid);
      }
      // Client tools are cloaked with a suffix on the way out and restored on
      // the way back. The non-streaming handler does that; this path never did,
      // so a client that declared `exec` was handed `exec_ide` and rejected its
      // own tool call (#2693). Restore before anything reads the names.
      jsonResponse = decloakToolNames(jsonResponse, toolNameMap);
      const hasUsefulOutput = hasUsefulForcedSseOutput(jsonResponse);
      if (provider === "antigravity" && !hasUsefulOutput) {
        trackDoneOnce();
        appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY} (empty content)` });
        decide("STREAM", "empty", { rid, conn: connPrefix, why: "no-content", lock: true });
        reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.BAD_GATEWAY, why: "empty-content" });
        return saverErrorResult(HTTP_STATUS.BAD_GATEWAY, ANTIGRAVITY_SAFE_ERROR_MESSAGE, null, null, rid);
      }
      trackDoneOnce();
      if (onRequestSuccess) await onRequestSuccess();

      const usage = jsonResponse.usage || {};
      appendLog({ tokens: usage, status: "200 OK" });
      saveUsageStats({ contextTelemetry, provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, requestedModel: clientRawRequest?.body?.model, translatedBody, silent: true, rid, preSaverSerialized, sid });

      const { msgItem, textContent: rawTextContent } = pickAssistantMessageForChatCompletion(jsonResponse.output);
      // JSON mode: drop a ```json fence the provider added around the object
      const textContent = wantsJsonOutput(body) ? stripJsonFence(rawTextContent) : rawTextContent;
      const totalLatency = Date.now() - requestStartTime;

      const doneDetail = buildRequestDetail({
      contextTelemetry,
        ...ctx,
        latency: { ttft: totalLatency, total: totalLatency },
        tokens: jsonResponse.usage ?? null,
        response: { content: textContent, thinking: null, finish_reason: jsonResponse.status || "unknown" },
        status: "success",
        rid,
      }, { endpoint: clientRawRequest?.endpoint || null });
      // saveRequestDetail mints detail.id synchronously (before its first await).
      saveRequestDetail(doneDetail).catch(() => {
        decide("ACCT", "detail-write-failed", { rid, phase: "save-json" });
      });

      if (provider === "antigravity") {
        await notifyTerminalVerificationSuccess(notifyTerminal, connectionId, log);
      }

      // Client is Responses API → return as-is
      if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
        reqSummary("ok", { ...saverFields, rid,
          conn: connPrefix,
          route,
          fmt,
          sel,
          row: doneDetail.id,
          ...doneFields({ usage, latency: { ttft: totalLatency, total: totalLatency } }),
        });
        return {
          success: true,
          response: new Response(JSON.stringify(jsonResponse), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              ...(rid ? { [RID_HEADER]: rid } : {}),
              ...saverTelemetryHeaders(saverMeta),
            },
          }),
        };
      }

      // Build client-format response.
      // input_tokens EXCLUDES cached tokens on cache-capable upstreams, so summing
      // only input+output under-reports prompt_tokens — measured: 2012 reported
      // where the real prompt was ~5344 with 5332 served from cache. Fold the cache
      // counters in, and keep them visible in prompt_tokens_details so a client can
      // tell a cache hit from a small prompt.
      const cacheRead = usage.cache_read_input_tokens || usage.cached_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;
      const inTokens = (usage.input_tokens || 0) + cacheRead + cacheCreate;
      const outTokens = usage.output_tokens || 0;
      const cacheDetails = (cacheRead > 0 || cacheCreate > 0)
        ? { prompt_tokens_details: {
              ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
              ...(cacheCreate > 0 ? { cache_creation_tokens: cacheCreate } : {}) } }
        : {};
      let finalResp;

      // Extract tool calls from Responses API output (function_call items)
      const funcCallItems = (jsonResponse.output || []).filter(item => item.type === "function_call");
      const toolCalls = funcCallItems.map((item, idx) => ({
        id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        }
      }));
      const hasToolCalls = toolCalls.length > 0;

      if (sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) {
        finalResp = {
          response: {
            candidates: [{ content: { role: "model", parts: [{ text: textContent || "" }] }, finishReason: "STOP", index: 0 }],
            usageMetadata: { promptTokenCount: inTokens, candidatesTokenCount: outTokens, totalTokenCount: inTokens + outTokens },
            modelVersion: model,
            responseId: jsonResponse.id || `resp_${Date.now()}`
          }
        };
      } else if (sourceFormat === FORMATS.CLAUDE) {
        // Claude-format client (e.g. Claude Code) talking to a Responses-API provider
        // (codex, grok-cli). Build an Anthropic Message so the SDK does not see
        // "JSON but not a Message" when it retries non-streaming.
        const claudeContent = [];
        for (const item of (jsonResponse.output || []).filter(i => i?.type === "reasoning")) {
          const thinkText = (item.summary || []).map(s => s.text || "").join("");
          if (thinkText) claudeContent.push({ type: "thinking", thinking: thinkText });
        }
        if (textContent) claudeContent.push({ type: "text", text: textContent });
        for (const tc of toolCalls) {
          claudeContent.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parseToolArguments(tc.function.arguments),
          });
        }
        if (claudeContent.length === 0) claudeContent.push({ type: "text", text: "" });
        const responseDone = jsonResponse.status === "completed" || jsonResponse.status === "done";
        finalResp = {
          id: (jsonResponse.id || `msg_${Date.now()}`).replace(/^resp_/, ""),
          type: "message",
          role: "assistant",
          model: jsonResponse.model || model,
          content: claudeContent,
          // "incomplete" is not a valid Claude stop_reason — map max_output_tokens truncation to "max_tokens".
          stop_reason: hasToolCalls ? "tool_use"
            : (jsonResponse.status === "incomplete" && jsonResponse.incomplete_details?.reason === "max_output_tokens") ? "max_tokens"
            : responseDone ? "end_turn"
            : (jsonResponse.status || "end_turn"),
          stop_sequence: null,
          usage: { input_tokens: inTokens, output_tokens: outTokens },
        };
      } else {
        const message = { role: "assistant", content: textContent || (hasToolCalls ? null : "") };
        if (hasToolCalls) message.tool_calls = toolCalls;
        // Map the upstream Responses status to a VALID Chat Completions
        // finish_reason. "incomplete" is not one — emit "length" when
        // max_output_tokens truncated the output, else keep prior fallbacks.
        const responseDone = jsonResponse.status === "completed" || jsonResponse.status === "done";
        const truncatedByMaxTokens = jsonResponse.status === "incomplete"
          && jsonResponse.incomplete_details?.reason === "max_output_tokens";
        const finishReason = hasToolCalls ? "tool_calls"
          : truncatedByMaxTokens ? "length"
          : responseDone ? "stop"
          : (jsonResponse.status || "stop");
        finalResp = {
          id: jsonResponse.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
          model: jsonResponse.model || model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: inTokens + outTokens, ...cacheDetails }
        };
      }

      if (classifierMode) {
        finalResp = validateClaudeClassifierMessage(
          body,
          finalResp,
          classifierProjection,
        );
      }

      reqSummary("ok", { ...saverFields, rid,
        conn: connPrefix,
        route,
        fmt,
        sel,
        row: doneDetail.id,
        ...doneFields({ usage, latency: { ttft: totalLatency, total: totalLatency } }),
      });
      return {
        success: true,
        response: new Response(JSON.stringify(finalResp), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            ...(rid ? { [RID_HEADER]: rid } : {}),
            ...saverTelemetryHeaders(saverMeta),
          },
        }),
      };
    } catch (err) {
      if (err instanceof ClaudeClassifierValidationError) {
        reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.BAD_GATEWAY, why: "classifier-validation" });
        return saverErrorResult(
          HTTP_STATUS.BAD_GATEWAY,
          CLAUDE_CLASSIFIER_ERROR_MESSAGE,
          null,
          null,
          rid,
        );
      }
      console.error("[ChatCore] Responses API SSE→JSON failed:", provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : err);
      const result = bodyReadFailure(err);
      appendLog({ status: `FAILED ${result.status}` });
      return result;
    }
  }

  // Standard Chat Completions SSE path
  try {
    const sseText = antigravitySseText ?? await readResponseTextWithDeadline({ body: providerResponse.body, callerSignal });
    let parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) {
      trackDoneOnce();
      reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.BAD_GATEWAY, why: "invalid-sse" });
      return saverErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : "Invalid SSE response for non-streaming request",
        null,
        null,
        rid,
      );
    }
    contextFailureTokens = parsed.usage ?? null;
    if (parsed.error) {
      trackDoneOnce();
      reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.BAD_GATEWAY, why: "upstream-error-in-sse" });
      return saverErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        provider === "antigravity"
          ? ANTIGRAVITY_SAFE_ERROR_MESSAGE
          : parsed.error.message || "Upstream SSE stream failed",
        null,
        null,
        rid,
      );
    }

    parsed = decloakToolNames(parsed, toolNameMap);
    const hasUsefulOutput = hasUsefulForcedSseOutput(parsed);
    if (provider === "antigravity" && !hasUsefulOutput) {
      trackDoneOnce();
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY} (empty content)` });
      decide("STREAM", "empty", { rid, conn: connPrefix, why: "no-content", lock: true });
      reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.BAD_GATEWAY, why: "empty-content" });
      return saverErrorResult(HTTP_STATUS.BAD_GATEWAY, ANTIGRAVITY_SAFE_ERROR_MESSAGE, null, null, rid);
    }

    trackDoneOnce();
    if (onRequestSuccess) await onRequestSuccess();

    const usage = parsed.usage || {};
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({ contextTelemetry, provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, requestedModel: clientRawRequest?.body?.model, translatedBody, silent: true, rid, preSaverSerialized, sid });

    const totalLatency = Date.now() - requestStartTime;
    const doneDetail = buildRequestDetail({
      contextTelemetry,
      ...ctx,
      latency: { ttft: totalLatency, total: totalLatency },
      tokens: usage,
      response: {
        content: parsed.choices?.[0]?.message?.content || null,
        thinking: parsed.choices?.[0]?.message?.reasoning_content || null,
        finish_reason: parsed.choices?.[0]?.finish_reason || "unknown"
      },
      status: "success",
      rid,
    }, { endpoint: clientRawRequest?.endpoint || null });
    // saveRequestDetail mints detail.id synchronously (before its first await).
    saveRequestDetail(doneDetail).catch(() => {
      decide("ACCT", "detail-write-failed", { rid, phase: "save-json" });
    });

    // Re-attach usage explicitly. This handler already HAS the correct usage — it is
    // the same object written to the usage DB, and for a cached Claude request that DB
    // row reads cache_read_input_tokens: 11022 — yet the client was observed receiving
    // no usage field at all (verified 2026-08-04 with a fingerprinted payload matched
    // on both sides). Whatever drops it between assembly and serialisation, the client
    // must not be left unable to account for its own token spend: a caller cannot tell
    // a 90%-cached request from a cheap one without this.
    if (usage && Object.keys(usage).length > 0) parsed.usage = usage;

    // Strip reasoning_content only when content is non-empty.
    // When content is empty (e.g. thinking models that used all tokens for reasoning),
    // reasoning_content is the only useful output and must be preserved.
    // Previously this was unconditional, which broke Qwen3.5, Claude extended thinking, etc.
    if (parsed?.choices) {
      for (const choice of parsed.choices) {
        if (choice?.message?.reasoning_content && choice.message.content) {
          delete choice.message.reasoning_content;
        }
      }
    }

    // JSON mode: drop a ```json fence the provider added around the object
    unfenceJsonChoices(body, parsed);

    // The provider forced streaming but the client wants JSON. Convert the
    // parsed OpenAI Chat Completions body to the format the client speaks.
    // - Responses-format client: convert to Responses `output` shape (tool_calls intact).
    // - Claude-format client: convert to Anthropic Message (type:"message") so the
    //   Anthropic SDK (e.g. Claude Code) does not see "JSON but not a Message".
    // - All other formats: return the OpenAI body as-is (client already speaks OpenAI).
    let finalBody;
    if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
      finalBody = chatCompletionToResponses(parsed, customToolNames, responsesToolNameMap);
    } else if (sourceFormat === FORMATS.CLAUDE) {
      finalBody = openAICompletionToClaudeMessage(parsed);
    } else {
      finalBody = parsed;
    }

    if (classifierMode) {
      assertClassifierChatSseLossless(sseText);
      finalBody = validateClaudeClassifierMessage(body, finalBody, null);
    }

    if (provider === "antigravity") {
      await notifyTerminalVerificationSuccess(notifyTerminal, connectionId, log);
    }

    reqSummary("ok", { ...saverFields, rid,
      conn: connPrefix,
      route,
      fmt,
      sel,
      row: doneDetail.id,
      ...doneFields({ usage, latency: { ttft: totalLatency, total: totalLatency } }),
    });
    return {
      success: true,
      response: new Response(JSON.stringify(finalBody), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          ...(rid ? { [RID_HEADER]: rid } : {}),
          ...saverTelemetryHeaders(saverMeta),
        },
      }),
    };
  } catch (err) {
    if (err instanceof ClaudeClassifierValidationError) {
      reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.BAD_GATEWAY, why: "classifier-validation" });
      return saverErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        CLAUDE_CLASSIFIER_ERROR_MESSAGE,
        null,
        null,
        rid,
      );
    }
    console.error("[ChatCore] Chat Completions SSE→JSON failed:", provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : err);
    const result = bodyReadFailure(err);
    appendLog({ status: `FAILED ${result.status}` });
    return result;
  }
}
