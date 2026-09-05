import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { resolveProviderCost } from "../../translator/response/openai-to-claude.js";
import { withGenerationIdHeader } from "../../utils/generationId.js";
import { rememberThoughtSignature } from "../../translator/concerns/thoughtSignature.js";
import { canonicalEchoModel } from "../../services/model.js";
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";
import { claudeUsageToOpenAI, filterUsageForFormat } from "../../utils/usageTracking.js";
import { createCallerAbortResult, createErrorResult, isCallerAbortError } from "../../utils/error.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import {
  consumeResponseBodyWithDeadline,
  isBodyReadTimeoutError,
  readResponseJsonWithDeadline,
  readResponseTextWithDeadline,
} from "../../utils/bodyTimeout.js";
import { EMPTY_CONTENT_COOLDOWN_MS } from "../../config/errorConfig.js";
import { detectUpstreamErrorContent } from "../../services/upstreamErrorContent.js";
import { extractPanelText } from "../../services/combo.js";
import { messageReasoningText, parseSSEToOpenAIResponse } from "./sseToJsonHandler.js";
import { saverTelemetryHeaders, withSaverHeaders } from "./saverHeaders.js";
import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats, formatDoneLine, doneFields } from "./requestDetail.js";
import { appendRequestLog, saveRequestDetail } from "../../../src/lib/usageDb.js";
import { decide, req, reqSummary, RID_HEADER } from "../../../src/shared/observability/decide.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";
import { unfenceJsonChoices } from "../../utils/jsonFence.js";
import { restoreResponseJson } from "../../utils/privacyFilter.js";
import { ROLE, RESPONSES_ITEM, OPENAI_FINISH } from "../../translator/schema/index.js";
import { openaiToAntigravityResponse } from "../../translator/response/openai-to-antigravity.js";
import { resolveResponsesToolCall } from "../../translator/response/openai-responses.js";
import {
  ANTIGRAVITY_SAFE_ERROR_MESSAGE,
  ANTIGRAVITY_VERIFICATION_REQUIRED_MESSAGE,
  classifyAntigravityValidation,
  isAntigravityErrorPayload,
  redactAntigravityValidationText,
} from "../../services/antigravityValidation.js";
import { classifyAntigravitySseValidation, createSseTextStream } from "./antigravitySseValidation.js";
import {
  CLAUDE_CLASSIFIER_ERROR_MESSAGE,
  ClaudeClassifierValidationError,
  isClaudeClassifierRequest,
  projectResponsesClassifierOutput,
  projectResponsesClassifierStream,
  validateClaudeClassifierMessage,
} from "./claudeClassifier.js";

/**
 * Whether a translated response actually contains something the client can use:
 * non-empty text, a tool call, or reasoning output. Providers occasionally answer
 * HTTP 200 with a fully empty body (upstream hiccup that isn't a real error status) —
 * treat that the same as an upstream failure so the account/combo fallback loop
 * moves on instead of handing the client nothing.
 */
// Exported for the regression test: this guard is the only thing standing
// between an upstream that answered with nothing and a client that gets HTTP
// 200 with `choices: null` and no way to retry (#2727). Its failure mode is
// silent, so it is pinned directly rather than through the handler.
export function hasUsefulContent(translatedResponse, isClaudeMessageResponse, isResponsesResponse) {
  if (isClaudeMessageResponse) {
    const blocks = Array.isArray(translatedResponse?.content) ? translatedResponse.content : [];
    return blocks.some((b) => (b?.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) || b?.type === "tool_use" || b?.type === "thinking");
  }
  if (isResponsesResponse) {
    return Array.isArray(translatedResponse?.output) && translatedResponse.output.length > 0;
  }
  // Gemini-family envelope (`{response:{candidates}}` or a bare `{candidates}`).
  // Reached both by the projection below and by a Gemini client on a Gemini
  // provider, where no translation runs at all (#2347).
  const parts = (translatedResponse?.response || translatedResponse)?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.some((p) => p?.functionCall
      || p?.inlineData || p?.inline_data
      || (typeof p?.text === "string" && p.text.trim().length > 0));
  }
  // Ollama envelope.
  const ollamaMsg = translatedResponse?.message;
  if (ollamaMsg && typeof ollamaMsg === "object" && !Array.isArray(translatedResponse?.choices)) {
    return (Array.isArray(ollamaMsg.tool_calls) && ollamaMsg.tool_calls.length > 0)
      || (typeof ollamaMsg.content === "string" && ollamaMsg.content.trim().length > 0)
      || (typeof ollamaMsg.thinking === "string" && ollamaMsg.thinking.trim().length > 0);
  }
  const msg = translatedResponse?.choices?.[0]?.message;
  const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
  const hasText = typeof msg?.content === "string"
    ? msg.content.trim().length > 0
    : Array.isArray(msg?.content) && msg.content.length > 0;
  const hasReasoning = messageReasoningText(msg).trim().length > 0;
  return hasToolCalls || hasText || hasReasoning;
}

function redactAntigravitySinkValue(value) {
  try {
    return JSON.parse(redactAntigravityValidationText(JSON.stringify(value)));
  } catch {
    return redactAntigravityValidationText(String(value ?? ""));
  }
}

async function notifyTerminalVerificationSuccess(callback, connectionId, log) {
  if (typeof callback !== "function") return;
  try {
    await callback();
  } catch {
    log?.warn?.("VERIFICATION", `success callback failed for ${String(connectionId).slice(0, 8)}`);
  }
}

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
 * Tokens this turn read from the upstream's prompt cache. Every spelling a
 * gateway may use, in the order the streaming translators already read them.
 */
function cachedInputTokens(usage) {
  const raw = usage?.input_tokens_details?.cached_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.cached_tokens
    ?? usage?.cache_read_input_tokens;
  return typeof raw === "number" ? raw : 0;
}

/**
 * The Claude-shaped cache and cost fields for a turn, or an empty object when
 * the upstream reported neither. Emitting zeros instead would assert a measured
 * cache miss on every provider that simply does not report cache activity.
 */
function claudeCacheUsage(usage) {
  const read = cachedInputTokens(usage);
  const createdRaw = usage?.cache_creation_input_tokens
    ?? usage?.prompt_tokens_details?.cache_creation_tokens;
  const created = typeof createdRaw === "number" ? createdRaw : 0;
  const cost = resolveProviderCost(usage);
  return {
    ...(read > 0 ? { cache_read_input_tokens: read } : {}),
    ...(created > 0 ? { cache_creation_input_tokens: created } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

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
  // prompt_tokens is INCLUSIVE of cached tokens (OpenAI convention), so an
  // exclusive input_tokens must subtract the cache read/creation back out;
  // counting the full prompt_tokens on top of the cache fields double-counts
  // every cached token. When only input_tokens is present it is already
  // exclusive and kept as-is.
  const cache = claudeCacheUsage(usage);
  const cacheRead = cache.cache_read_input_tokens ?? 0;
  const cacheCreation = cache.cache_creation_input_tokens ?? 0;
  const claudeUsage = {
    input_tokens: usage?.prompt_tokens != null
      ? Math.max(0, usage.prompt_tokens - cacheRead - cacheCreation)
      : usage?.input_tokens || 0,
    output_tokens: usage?.completion_tokens || usage?.output_tokens || 0,
    // Present only when there is something to report, matching the streaming
    // translator: a turn with no cache activity emits no cache fields at all,
    // rather than a pair of zeros that reads as a measured cache miss.
    ...cache,
  };
  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: "assistant",
    model: responseBody.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: claudeUsage,
  };
}

/**
 * Convert an OpenAI Chat Completions non-streaming response body into the
 * OpenAI Responses API shape. Used when a Responses-format client (e.g. Codex)
 * is routed to a Chat Completions upstream and `stream:false` — the streaming
 * path already emits Responses events, but the JSON path returned a raw
 * `chat.completion` body, so tool_calls were invisible to Responses clients.
 */
function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

function openAICompletionToResponses(responseBody, customToolNames = null, responsesToolNameMap = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  // The request translator exports the collected custom tool names as an array
  // (translator/request/openai-responses.js) and chatCore.js forwards that value
  // verbatim, while direct callers pass a Set. Accept either, without mutating
  // the caller's collection.
  const customToolNameSet = customToolNames instanceof Set ? customToolNames : new Set(customToolNames || []);

  // Reasoning → a reasoning item (summary text), mirroring the streaming path.
  const reasoning = messageReasoningText(message);
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  // Assistant text → a message item with output_text content.
  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  // tool_calls → function_call/custom_tool_call items (Responses-native tool shape).
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
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
    ?? usage.output_tokens_details?.reasoning_tokens
    ?? usage.reasoning_tokens;
  const status = choice.finish_reason === "tool_calls" ? "completed" : (choice.finish_reason === "stop" ? "completed" : (choice.finish_reason || "completed"));

  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status,
    background: false,
    error: null,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      // Same asymmetry as the Claude conversion above: the streaming Responses
      // translator emits input_tokens_details.cached_tokens and this one did
      // not, so a Codex-shaped client saw a cache hit rate of zero on every
      // non-streaming turn. Omitted entirely when nothing was cached, so the
      // absence of a cache stays distinguishable from a measured zero.
      ...(cachedInputTokens(usage) > 0
        ? { input_tokens_details: { cached_tokens: cachedInputTokens(usage) } }
        : {}),
      ...(typeof reasoningTokens === "number" && reasoningTokens > 0
        ? { output_tokens_details: { reasoning_tokens: reasoningTokens } }
        : {}),
    },
  };
}

/**
 * Convert an OpenAI Chat Completions non-streaming body into the Gemini-family
 * `{ response: { candidates: [...] } }` envelope.
 *
 * Delegates to the streaming projector (translator/response/openai-to-antigravity.js,
 * which openai-to-gemini.js registers for gemini / gemini-cli / vertex alike) by
 * handing it ONE synthetic chunk carrying the whole message plus its
 * finish_reason, so the streaming and non-streaming paths cannot drift apart.
 * The inverse is the Gemini branch of translateNonStreamingResponse below,
 * which reads `responseBody.response || responseBody`.
 */
function openAICompletionToGemini(responseBody) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const delta = {};
  const reasoning = messageReasoningText(message);
  if (typeof reasoning === "string" && reasoning.length > 0) delta.reasoning_content = reasoning;
  if (typeof message.content === "string" && message.content.length > 0) delta.content = message.content;
  // A non-streaming message.tool_calls[] carries no `index`, but the projector
  // keys its accumulator on one — without this every call collapses into a
  // single functionCall part.
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    delta.tool_calls = message.tool_calls.map((tc, i) => ({ ...tc, index: tc.index ?? i }));
  }

  return openaiToAntigravityResponse({
    id: responseBody.id,
    model: responseBody.model,
    usage: responseBody.usage,
    choices: [{ index: 0, delta, finish_reason: choice.finish_reason || OPENAI_FINISH.STOP }],
  }, {});
}

/**
 * Convert an OpenAI Chat Completions non-streaming body into Ollama's /api/chat
 * non-streaming shape — the inverse of ollamaBodyToOpenAI
 * (translator/response/ollama-to-openai.js). Two asymmetries matter: Ollama
 * carries tool arguments as an OBJECT where OpenAI uses a JSON string, and it
 * reports tokens as prompt_eval_count / eval_count.
 */
function openAICompletionToOllama(responseBody) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const src = choice.message || {};
  const message = { role: ROLE.ASSISTANT, content: typeof src.content === "string" ? src.content : "" };
  const reasoning = messageReasoningText(src);
  if (typeof reasoning === "string" && reasoning.length > 0) message.thinking = reasoning;
  if (Array.isArray(src.tool_calls) && src.tool_calls.length > 0) {
    message.tool_calls = src.tool_calls.map((tc) => ({
      function: {
        name: tc.function?.name || tc.name || "",
        arguments: parseToolArguments(tc.function?.arguments ?? tc.arguments),
      },
    }));
  }

  const usage = responseBody.usage || {};
  return {
    model: responseBody.model || "ollama",
    created_at: new Date((responseBody.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    message,
    done: true,
    // Ollama has no "tool_calls" done_reason on the wire: the tool_calls array
    // is the signal, and ollamaBodyToOpenAI re-derives finish_reason from it.
    done_reason: choice.finish_reason === OPENAI_FINISH.LENGTH ? OPENAI_FINISH.LENGTH : OPENAI_FINISH.STOP,
    prompt_eval_count: usage.prompt_tokens || usage.input_tokens || 0,
    eval_count: usage.completion_tokens || usage.output_tokens || 0,
  };
}

const GEMINI_FAMILY_FORMATS = new Set([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY]);

/**
 * Project an OpenAI chat.completion body into whatever envelope the CLIENT
 * speaks. Every client format is covered here; anything left returning the raw
 * body hands a non-OpenAI client `choices[]`, whose tool_calls it never reads
 * (#2347).
 */
function fromOpenAICompletion(responseBody, sourceFormat, customToolNames = null, responsesToolNameMap = null) {
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    return openAICompletionToResponses(responseBody, customToolNames, responsesToolNameMap);
  }
  if (sourceFormat === FORMATS.CLAUDE) {
    return openAICompletionToClaudeMessage(responseBody);
  }
  if (GEMINI_FAMILY_FORMATS.has(sourceFormat)) {
    return openAICompletionToGemini(responseBody);
  }
  if (sourceFormat === FORMATS.OLLAMA) {
    return openAICompletionToOllama(responseBody);
  }
  return responseBody;
}

/**
 * Convert a non-streaming OpenAI Responses API body (`output: [...]`) into an
 * OpenAI Chat Completions shape (`choices: [{ message, finish_reason }]`).
 * Mirrors the item types the streaming translator already understands
 * (openaiResponsesToOpenAIResponse in translator/response/openai-responses.js)
 * so both paths agree on what counts as text/reasoning/tool-call content.
 */
function openAIResponsesBodyToChatCompletion(responseBody) {
  const output = Array.isArray(responseBody?.output) ? responseBody.output : [];
  let textContent = "", reasoningContent = "";
  const toolCalls = [];

  for (const item of output) {
    if (item?.type === RESPONSES_ITEM.MESSAGE) {
      for (const block of item.content || []) {
        if (block?.type === RESPONSES_ITEM.OUTPUT_TEXT && typeof block.text === "string") {
          textContent += block.text;
        }
      }
    } else if (item?.type === RESPONSES_ITEM.REASONING) {
      for (const summary of item.summary || []) {
        if (summary?.type === RESPONSES_ITEM.SUMMARY_TEXT && typeof summary.text === "string") {
          reasoningContent += summary.text;
        }
      }
    } else if (item?.type === RESPONSES_ITEM.FUNCTION_CALL || item?.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
      const isCustom = item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL;
      toolCalls.push({
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: item.name || "",
          arguments: isCustom
            ? JSON.stringify({ input: item.input || "" })
            : (typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})),
        },
      });
    }
  }

  const message = { role: "assistant" };
  if (textContent) message.content = textContent;
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (!message.content && !message.tool_calls) message.content = "";

  const usage = responseBody?.usage || {};
  const cachedTokens = usage.input_tokens_details?.cached_tokens;
  return {
    id: String(responseBody?.id || `chatcmpl-${Date.now()}`).replace(/^resp_/, "chatcmpl-"),
    object: "chat.completion",
    created: responseBody?.created_at || Math.floor(Date.now() / 1000),
    model: responseBody?.model || "unknown",
    choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      completion_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0),
      ...(cachedTokens !== undefined ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
    },
  };
}

/**
 * Translate non-streaming response body from provider format → OpenAI format.
 */
export function translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames = null, responsesToolNameMap = null) {
  if (targetFormat === sourceFormat) return responseBody;

  // Provider responded in the Responses API shape (`output: []`) — every
  // client format below expects chat.completion-shaped input (`choices: []`),
  // so normalize once here instead of teaching each branch to parse `output[]`.
  if (targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat !== FORMATS.OPENAI_RESPONSES) {
    return fromOpenAICompletion(
      openAIResponsesBodyToChatCompletion(responseBody),
      sourceFormat,
      customToolNames,
      responsesToolNameMap,
    );
  }

  // Provider responded in OpenAI Chat Completions shape but the client speaks
  // Responses API — convert so tool_calls/text surface as Responses `output`.
  if (targetFormat === FORMATS.OPENAI) {
    return fromOpenAICompletion(responseBody, sourceFormat, customToolNames, responsesToolNameMap);
  }

  // Gemini / Antigravity
  if (targetFormat === FORMATS.GEMINI || targetFormat === FORMATS.ANTIGRAVITY || targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.VERTEX) {
    const response = responseBody.response || responseBody;
    if (!response?.candidates?.[0]) return responseBody;

    const candidate = response.candidates[0];
    const content = candidate.content;
    const usage = response.usageMetadata || responseBody.usageMetadata;
    let textContent = "", reasoningContent = "";
    const toolCalls = [];

    if (content?.parts) {
      for (const part of content.parts) {
        if (part.thought === true && part.text) reasoningContent += part.text;
        else if (part.text !== undefined) textContent += part.text;
        if (part.functionCall) {
          const toolCallId = `call_${part.functionCall.name}_${Date.now()}_${toolCalls.length}`;
          // Same hand-off as the streaming translator, or a non-streaming turn
          // replays this call under the placeholder signature alone (#3646).
          rememberThoughtSignature(toolCallId, part.thoughtSignature || part.thought_signature);
          toolCalls.push({
            id: toolCallId,
            type: "function",
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }
          });
        }
        // Handle inline image data (from image generation models)
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData?.data) {
          const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
          textContent += `\n![image](data:${mimeType};base64,${inlineData.data})\n`;
        }
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = (candidate.finishReason || "stop").toLowerCase();
    if (finishReason === "stop" && toolCalls.length > 0) finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${response.responseId || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(new Date(response.createTime || Date.now()).getTime() / 1000),
      model: response.modelVersion || "gemini",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (usage) {
      result.usage = {
        prompt_tokens: (usage.promptTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0
      };
      if (usage.thoughtsTokenCount > 0) {
        result.usage.completion_tokens_details = { reasoning_tokens: usage.thoughtsTokenCount };
      }
    }
    return fromOpenAICompletion(result, sourceFormat, customToolNames, responsesToolNameMap);
  }

  // Claude
  if (targetFormat === FORMATS.CLAUDE) {
    // Always translate a Claude-format body to OpenAI, even if `content` is
    // missing/null (e.g. M3 with max_tokens:1 spends the budget on thinking
    // and returns `content: null`). Returning the raw body would leave the
    // OpenAI client without a `choices` array and surface as a UI test error.
    // Early return if the response is already in OpenAI format (has choices array)
    // or if it has content as a non-array value (likely a different non-Claude format).
    // Some providers (e.g. xiaomi-tokenplan) return OpenAI-format responses even when
    // the request was translated to Claude format — the targetFormat is Claude but the
    // actual response is OpenAI-native and needs no further translation.
    if (responseBody.choices || (responseBody.content && !Array.isArray(responseBody.content))) return responseBody;

    let textContent = "", thinkingContent = "";
    const toolCalls = [];

    for (const block of (responseBody.content || [])) {
      if (block.type === "text") {
        // Strip markdown code block markers (e.g. kimi wraps JSON in ```json...```)
        const raw = block.text ?? "";
        const text = raw.replace(/^\s*```\s*json\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
        textContent += text;
      } else if (block.type === "thinking") thinkingContent += block.thinking || "";
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (thinkingContent) message.reasoning_content = thinkingContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = responseBody.stop_reason || "stop";
    if (finishReason === "end_turn") finishReason = "stop";
    if (finishReason === "tool_use") finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${responseBody.id || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseBody.model || "claude",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (responseBody.usage) {
      result.usage = claudeUsageToOpenAI(responseBody.usage);
    }
    // Same tail as the Gemini branch above. Without it a Responses-API client
    // behind a Claude provider received `choices[]`, and a client that maps
    // over `output` threw on undefined rather than reporting a bad response
    // (#2885).
    return fromOpenAICompletion(result, sourceFormat, customToolNames, responsesToolNameMap);
  }

  // Ollama
  if (targetFormat === FORMATS.OLLAMA) {
    const result = ollamaBodyToOpenAI(responseBody);
    return fromOpenAICompletion(result, sourceFormat, customToolNames, responsesToolNameMap);
  }

  if (Array.isArray(responseBody?.choices)) {
    return fromOpenAICompletion(responseBody, sourceFormat, customToolNames, responsesToolNameMap);
  }

  return responseBody;
}

function hasLegacyClassifierFunctionCall(responseBody) {
  return responseBody?.choices?.some((choice) =>
    Object.hasOwn(choice?.message || {}, "function_call"),
  );
}

function hasMultipleClassifierAlternatives(responseBody) {
  if (Array.isArray(responseBody?.choices) && responseBody.choices.length > 1) {
    return true;
  }
  const geminiResponse = responseBody?.response || responseBody;
  return Array.isArray(geminiResponse?.candidates)
    && geminiResponse.candidates.length > 1;
}

/**
 * Handle non-streaming response from provider.
 */
export async function handleNonStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, verificationContext, onValidationRequired, notifyTerminalVerificationSuccess: notifyTerminal, reqLogger, toolNameMap, customToolNames, responsesToolNameMap, trackDone, appendLog, pxpipe, privacyFilter, reqTag, log, callerSignal, rid, route, fmt, sel, saverFields = {}, saverMeta = {} }) {
  // HEADERS finding: gateway-built error responses carry the same x-tp-*
  // saver telemetry as successes.
  const saverErrorResult = (...args) => withSaverHeaders(createErrorResult(...args), saverMeta);
  const abortResult = () => withSaverHeaders(createCallerAbortResult(), saverMeta);
  const contentType = providerResponse.headers.get("content-type") || "";
  const classifierMode = sourceFormat === FORMATS.CLAUDE
    && isClaudeClassifierRequest(body);
  let responseBody;
  // The format responseBody is actually in by the time it reaches the
  // translation step. Starts as targetFormat and is corrected wherever a branch
  // below rewrites the body into another format.
  let effectiveTargetFormat = targetFormat;
  let antigravitySseText = null;
  let classifierProjection = null;
  let pendingCleared = false;
  const trackDoneOnce = () => {
    if (pendingCleared) return;
    pendingCleared = true;
    trackDone();
  };
  const connPrefix = connectionId ? String(connectionId).slice(0, 8) : undefined;
  const bodyReadFailure = (error, context) => {
    trackDoneOnce();
    if (callerSignal?.aborted && isCallerAbortError(error)) return abortResult();
    if (isBodyReadTimeoutError(error)) {
      reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.GATEWAY_TIMEOUT, why: "body-timeout" });
      return saverErrorResult(HTTP_STATUS.GATEWAY_TIMEOUT, `Upstream response body timed out for ${provider}`, null, null, rid);
    }
    console.error(`[ChatCore] Failed to ${context} from ${provider}:`, provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : error.message);
    reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.BAD_GATEWAY, why: String(context || "body-read").slice(0, 40) });
    return saverErrorResult(HTTP_STATUS.BAD_GATEWAY, provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : `Invalid response from ${provider}`, null, null, rid);
  };

  if (contentType.includes("text/event-stream")) {
    if (provider === "antigravity") {
      try {
        antigravitySseText = await readResponseTextWithDeadline({ body: providerResponse.body, callerSignal });
      } catch (err) {
        const result = bodyReadFailure(err, "read Antigravity SSE");
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
    // A provider not statically flagged forceStream (e.g. a dynamically-added
    // openai-compatible connection) can still force SSE at the HTTP level —
    // providerRequiresStreaming only catches known providers, so this branch
    // is reachable even for a "true non-streaming" request. When the upstream
    // speaks Responses API, its SSE uses response.output_text.delta-style
    // events, not choices[].delta — parseSSEToOpenAIResponse only understands
    // the latter and would silently yield empty content. Use the Responses-
    // aware converter (same one handleForcedSSEToJson uses) in that case.
    if (targetFormat === FORMATS.OPENAI_RESPONSES) {
      try {
        if (antigravitySseText !== null) {
          responseBody = await convertResponsesStreamToJson(createSseTextStream(antigravitySseText));
        } else if (classifierMode && typeof providerResponse.body?.tee === "function") {
          const [conversionStream, projectionStream] = providerResponse.body.tee();
          [responseBody, classifierProjection] = await Promise.all([
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
          responseBody = await consumeResponseBodyWithDeadline({
            body: providerResponse.body,
            callerSignal,
            consume: (reader) => convertResponsesStreamToJson(providerResponse.body, { reader }),
          });
        }
      } catch (err) {
        const result = bodyReadFailure(err, "convert Responses SSE");
        appendLog({ status: `FAILED ${result.status}` });
        return result;
      }
    } else {
      let sseText;
      if (antigravitySseText !== null) {
        sseText = antigravitySseText;
      } else try {
        sseText = await readResponseTextWithDeadline({ body: providerResponse.body, callerSignal });
      } catch (err) {
        const result = bodyReadFailure(err, "read SSE");
        appendLog({ status: `FAILED ${result.status}` });
        return result;
      }
      const parsed = parseSSEToOpenAIResponse(sseText, model);
      if (!parsed) {
        trackDoneOnce();
        appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
        return saverErrorResult(
          HTTP_STATUS.BAD_GATEWAY,
          provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : "Invalid SSE response for non-streaming request",
        );
      }
      responseBody = parsed;
      // parseSSEToOpenAIResponse just rewrote the body into an OpenAI chat
      // completion, so it is no longer in targetFormat. Translating it as though
      // it still were hands the target->source translator a body it cannot read:
      // a Claude-format client asking a kiro model for stream:false got the raw
      // OpenAI completion back instead of an Anthropic Message. Record the real
      // format so the translation step below uses it.
      effectiveTargetFormat = FORMATS.OPENAI;
    }
  } else {
    try {
      responseBody = await readResponseJsonWithDeadline({ body: providerResponse.body, callerSignal });
    } catch (err) {
      const result = bodyReadFailure(err, "parse JSON");
      appendLog({ status: `FAILED ${result.status}` });
      return result;
    }
  }

  if (provider === "antigravity") {
    const validation = classifyAntigravityValidation({
      status: responseBody?.error?.code ?? responseBody?.error?.status ?? responseBody?.status ?? providerResponse.status,
      payload: responseBody,
      source: "chat",
    });
    if (validation) {
      try {
        await onValidationRequired?.({ validation, observationId: verificationContext?.observationId });
      } catch {
        log?.warn?.("VERIFICATION", `validation callback failed for ${String(connectionId).slice(0, 8)}`);
      }
      return saverErrorResult(HTTP_STATUS.FORBIDDEN, ANTIGRAVITY_VERIFICATION_REQUIRED_MESSAGE);
    }
    if (isAntigravityErrorPayload(responseBody)) {
      trackDoneOnce();
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      return saverErrorResult(HTTP_STATUS.BAD_GATEWAY, ANTIGRAVITY_SAFE_ERROR_MESSAGE);
    }
  }

  if (classifierMode
      && targetFormat === FORMATS.OPENAI_RESPONSES
      && classifierProjection === null) {
    classifierProjection = projectResponsesClassifierOutput(body, responseBody);
  }

  trackDoneOnce();

  // Some OpenAI-compatible gateways (e.g. api.cline.bot) wrap the whole completion
  // in { data: {…}, success: true }. Unwrap so the client sees a top-level `choices`.
  if (responseBody && !Array.isArray(responseBody.choices) && Array.isArray(responseBody?.data?.choices)) {
    responseBody = responseBody.data;
  }

  reqLogger.logProviderResponse(
    providerResponse.status,
    providerResponse.statusText,
    providerResponse.headers,
    provider === "antigravity" ? redactAntigravitySinkValue(responseBody) : responseBody,
  );

  if (onRequestSuccess && provider !== "antigravity") {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // Decloak tool_use names once on raw Claude body, before any translation (INPUT side)
  responseBody = decloakToolNames(responseBody, toolNameMap);

  const usage = extractUsageFromResponse(responseBody);
  appendLog({ tokens: usage, status: "200 OK" });
  saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, requestedModel: clientRawRequest?.body?.model, translatedBody, silent: true, rid });

  if (classifierMode && (
    hasLegacyClassifierFunctionCall(responseBody)
    || hasMultipleClassifierAlternatives(responseBody)
  )) {
    return saverErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      CLAUDE_CLASSIFIER_ERROR_MESSAGE,
    );
  }

  let translatedResponse = needsTranslation(effectiveTargetFormat, sourceFormat)
    ? translateNonStreamingResponse(responseBody, effectiveTargetFormat, sourceFormat, customToolNames, responsesToolNameMap)
    : responseBody;
  if (classifierMode) {
    try {
      translatedResponse = validateClaudeClassifierMessage(
        body,
        translatedResponse,
        classifierProjection,
      );
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
      throw err;
    }
  }
  const isClaudeMessageResponse = sourceFormat === FORMATS.CLAUDE && translatedResponse?.type === "message";
  // Responses-format translation produces a `object:"response"` body with no
  // `choices`; skip the Chat-Completions-specific post-processing below for it.
  const isResponsesResponse = sourceFormat === FORMATS.OPENAI_RESPONSES && translatedResponse?.object === "response";
  // Everything gated on this is Chat-Completions-specific post-processing.
  // A Claude, Responses, Gemini-family or Ollama envelope has no `choices`, and
  // stamping `object: "chat.completion"` onto one would re-open the leak the
  // projections above exist to close (#2347).
  const isChatCompletionShaped = Array.isArray(translatedResponse?.choices);

  // Fix finish_reason for tool_calls: some providers return non-standard values (e.g. "other")
  if (translatedResponse?.choices?.[0]) {
    const choice = translatedResponse.choices[0];
    const msg = choice.message;
    const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
    if (hasToolCalls && choice.finish_reason !== "tool_calls") {
      choice.finish_reason = "tool_calls";
    }
  }

  // Ensure OpenAI-required fields
  if (isChatCompletionShaped) {
    if (!translatedResponse.object) translatedResponse.object = "chat.completion";
    if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000);
  }

  // Strip Azure-specific fields
  if (isChatCompletionShaped) {
    delete translatedResponse.prompt_filter_results;
    for (const choice of translatedResponse.choices) delete choice.content_filter_results;
  }

  if (translatedResponse?.usage) {
    translatedResponse.usage = filterUsageForFormat(translatedResponse.usage, sourceFormat);
  }

  // Strip reasoning_content only when content is non-empty.
  // When content is empty (e.g. thinking models that used all tokens for reasoning),
  // reasoning_content is the only useful output and must be preserved.
  // A choice carrying tool_calls is also exempt: the thinking block belongs to
  // the decision to call the tool, and clients that replay reasoning alongside
  // the call lose it otherwise (#1412).
  if (isChatCompletionShaped) {
    for (const choice of translatedResponse.choices) {
      if (choice?.message?.reasoning_content && choice.message.content && !choice.message.tool_calls?.length) {
        delete choice.message.reasoning_content;
      }
    }
  }

  // JSON mode: drop a ```json fence the provider added around the object
  unfenceJsonChoices(body, translatedResponse);

  reqLogger.logConvertedResponse(
    provider === "antigravity" ? redactAntigravitySinkValue(translatedResponse) : translatedResponse,
  );

  // Upstream answered 200 but produced nothing usable (null/empty content, no
  // tool_calls, no reasoning) — treat as a failure so the same fallback path as a
  // real error status kicks in: lock this account+model for EMPTY_CONTENT_COOLDOWN_MS
  // (skips it on the next request/combo attempt) and let the caller fall through to
  // the next account/combo member. The lock auto-expires, so it comes back into
  // rotation on its own once the upstream presumably recovers.
  // Upstream answered 200 and put its own error INTO the content, so the check
  // below sees a non-empty body and passes it through as the model's answer.
  // Route it to the same failure path: without this the error is written into
  // the conversation history and no fallback fires. See detectUpstreamErrorContent.
  const upstreamError = detectUpstreamErrorContent(extractPanelText(translatedResponse));
  if (upstreamError) {
    appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY} (upstream error in content)` });
    log?.warn?.("CHATCORE", `${provider}/${model} returned HTTP 200 carrying an upstream error — treating as failure. ${upstreamError.reason}`);
    reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.BAD_GATEWAY, why: "upstream-error-content" });
    return saverErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : upstreamError.reason,
      // A non-retryable upstream error still fails over: another account will not
      // fix a malformed request, but locking briefly costs one attempt while NOT
      // locking loops the same account. The lock auto-expires either way.
      Date.now() + EMPTY_CONTENT_COOLDOWN_MS,
    );
  }

  if (!hasUsefulContent(translatedResponse, isClaudeMessageResponse, isResponsesResponse)) {
    appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY} (empty content)` });
    if (log?.warn) {
      log.warn("CHATCORE", `${provider}/${model} returned HTTP 200 with empty content (finish_reason=${translatedResponse?.choices?.[0]?.finish_reason || "unknown"}) — treating as failure, locking for ${Math.round(EMPTY_CONTENT_COOLDOWN_MS / 1000)}s`);
    }
    decide("STREAM", "empty", { rid, conn: connPrefix, why: "no-content", lock: true });
    reqSummary("failed", { ...saverFields, rid, conn: connPrefix, route, fmt, sel, status: HTTP_STATUS.BAD_GATEWAY, why: "empty-content" });
    return saverErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : `Empty response content from ${provider}/${model}`,
      Date.now() + EMPTY_CONTENT_COOLDOWN_MS,
      null,
      rid,
    );
  }

  if (onRequestSuccess && provider === "antigravity") {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", provider === "antigravity" ? ANTIGRAVITY_SAFE_ERROR_MESSAGE : err?.message || err);
      });
  }

  // Echo a stable, listing-valid model name instead of the upstream id.
  // Passthrough providers (opencode free tier) return the bare resolved model
  // with the provider prefix stripped; clients that trust the echo re-send the
  // bare name, which then mis-routes on the next hop. Prefixed requests keep
  // their exact form; bare requests resolved to a connection-less catalog
  // provider get the listing form re-injected (OpenRouter-style proxy echo).
  const echoModel = canonicalEchoModel({ requestedModel: body?.model, provider, model });
  if (echoModel && translatedResponse && typeof translatedResponse === "object" && !Array.isArray(translatedResponse)) {
    translatedResponse.model = echoModel;
  }

  const totalLatency = Date.now() - requestStartTime;
  const doneDetail = buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: totalLatency, total: totalLatency },
    tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: responseBody || null,
    response: {
      content: translatedResponse?.choices?.[0]?.message?.content || translatedResponse?.content || null,
      thinking: translatedResponse?.choices?.[0]?.message?.reasoning_content || translatedResponse?.reasoning_content || null,
      finish_reason: translatedResponse?.choices?.[0]?.finish_reason || "unknown"
    },
    pxpipe,
    status: "success",
    rid,
  }, { endpoint: clientRawRequest?.endpoint || null });
  // saveRequestDetail mints detail.id synchronously (before its first await),
  // so the REQ line below can carry row=.
  saveRequestDetail(doneDetail).catch(() => {
    decide("ACCT", "detail-write-failed", { rid, phase: "save" });
  });

  if (provider === "antigravity") {
    await notifyTerminalVerificationSuccess(
      notifyTerminal,
      connectionId,
      log,
    );
  }

  // Privacy filter (#2728): put the caller's own values back, over the
  // serialised body so text inside a tool call's `arguments` is covered too.
  // No filter (the default) returns the same string untouched.
  // The one nominal per-request line (doc §3.3/3.4).
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
    response: new Response(restoreResponseJson(privacyFilter, JSON.stringify(translatedResponse)), {
      // Same generation-id forwarding as the streaming path, so the handle a
      // user needs for a billing dispute does not depend on whether they asked
      // for a stream.
      headers: withGenerationIdHeader(
        {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          ...(rid ? { [RID_HEADER]: rid } : {}),
          ...saverTelemetryHeaders(saverMeta),
        },
        providerResponse,
      )
    })
  };
}
