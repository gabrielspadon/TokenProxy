import { EXECUTOR_MANAGED_FORMATS, FORMATS } from "./formats.js";
import { assertTranslationContent, TranslationRouteError } from "./concerns/translationError.js";
import { isolateRequestBody } from "./concerns/requestIsolation.js";
import { ensureToolCallIds, fixMissingToolResponses, repairOrphanToolResults } from "./concerns/toolCall.js";
import { prepareClaudeRequest } from "./formats/claude.js";
import { cloakClaudeTools } from "../utils/claudeCloaking.js";
import { decloakClaudePassthroughToolUse } from "../utils/streamHelpers.js";
import { filterToOpenAIFormat } from "./formats/openai.js";
import { hoistAdditionalTools, normalizePassthroughToolSchemas, typeResponsesInputItems } from "./formats/responsesApi.js";
import { normalizeThinkingConfig } from "../services/provider.js";
import { applyThinking, captureThinking } from "./concerns/thinkingUnified.js";
import { captureSessionId } from "../utils/sessionManager.js";
import { AntigravityExecutor } from "../executors/antigravity.js";
import { PROVIDERS } from "../providers/index.js";

// Registry for translators. Lazy-init guards against circular-import order:
// translator modules call register() (side-effect) before this module's body runs.
// var (not let): hoisted as undefined so register() can run during circular import (no TDZ).
var requestRegistry;
var responseRegistry;

// Register translator
export function register(from, to, requestFn, responseFn) {
  requestRegistry ??= new Map();
  responseRegistry ??= new Map();
  const key = `${from}:${to}`;
  if (requestFn) {
    requestRegistry.set(key, requestFn);
  }
  if (responseFn) {
    responseRegistry.set(key, responseFn);
  }
}

// Describes registered conversion edges without executing a translator.
export function describeTranslationRoute(from, to, kind = "request") {
  const registry = kind === "request" ? requestRegistry : kind === "response" ? responseRegistry : null;
  const knownFormats = Object.values(FORMATS);
  const executorFormat = kind === "request" ? EXECUTOR_MANAGED_FORMATS[to] : EXECUTOR_MANAGED_FORMATS[from];
  const routeFrom = kind === "response" && executorFormat ? executorFormat.responseFormat : from;
  const routeTo = kind === "request" && executorFormat ? executorFormat.requestFormat : to;
  if (!registry || !knownFormats.includes(routeFrom) || !knownFormats.includes(routeTo)
      || (kind === "request" && !knownFormats.includes(from))
      || (kind === "response" && !knownFormats.includes(to))) {
    return { supported: false, kind, mode: "unavailable", edges: [] };
  }
  if (routeFrom === routeTo) {
    const edges = executorFormat ? [{ from, to, owner: "executor" }] : [];
    return { supported: true, kind, mode: executorFormat ? "executor" : "passthrough", edges, missing: [] };
  }
  if (registry.has(`${routeFrom}:${routeTo}`)) {
    const edge = { from: routeFrom, to: routeTo };
    const edges = executorFormat
      ? kind === "request" ? [edge, { from: routeTo, to, owner: "executor" }] : [{ from, to: routeFrom, owner: "executor" }, edge]
      : [edge];
    return { supported: true, kind, mode: executorFormat ? "executor" : "direct", edges, missing: [] };
  }
  const edges = [];
  if (routeFrom !== FORMATS.OPENAI) edges.push({ from: routeFrom, to: FORMATS.OPENAI });
  if (routeTo !== FORMATS.OPENAI) edges.push({ from: FORMATS.OPENAI, to: routeTo });
  const missing = edges.filter(edge => !registry.has(`${edge.from}:${edge.to}`));
  const reportedEdges = executorFormat
    ? kind === "request" ? [...edges, { from: routeTo, to, owner: "executor" }] : [{ from, to: routeFrom, owner: "executor" }, ...edges]
    : edges;
  return { supported: missing.length === 0, kind,
    mode: missing.length ? "unavailable" : executorFormat ? "executor" : "pivot",
    edges: reportedEdges, missing };
}

function requireTranslationRoute(from, to, kind) {
  const route = describeTranslationRoute(from, to, kind);
  if (!route.supported) throw new TranslationRouteError(kind, from, to, route.missing || []);
  return route;
}

// No-op: translators self-register via the static imports at the bottom of this file.
function ensureInitialized() {}

// Remove malformed null blocks before any normalization walks `part.type`.
// This is deliberately independent of the optional provider media stripping.
function dropNullContentParts(body) {
  if (!Array.isArray(body?.messages)) return;
  for (const msg of body.messages) {
    if (!Array.isArray(msg?.content)) continue;
    msg.content = msg.content.filter(part => part != null);
  }
}

// Strip specific content types from messages (explicit opt-in via strip[] in PROVIDER_MODELS)
function stripContentTypes(body, stripList = []) {
  if (!stripList.length || !body.messages || !Array.isArray(body.messages)) return;
  const imageTypes = new Set(["image_url", "image"]);
  const audioTypes = new Set(["audio_url", "input_audio"]);
  const shouldStrip = (type) => {
    if (imageTypes.has(type)) return stripList.includes("image");
    if (audioTypes.has(type)) return stripList.includes("audio");
    return false;
  };
  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.filter(part => !shouldStrip(part.type));
    if (msg.content.length === 0) msg.content = "";
  }
}

// Translate request: source -> openai -> target
export function translateRequest(sourceFormat, targetFormat, model, body, stream = true, credentials = null, provider = null, reqLogger = null, stripList = [], connectionId = null, clientTool = null) {
  ensureInitialized();
  requireTranslationRoute(sourceFormat, targetFormat, "request");
  assertTranslationContent(sourceFormat, targetFormat, body);
  // Translation normalizes tool transactions and provider-specific envelopes.
  // Work on a private copy so routing probes, logs and fallback policy can
  // still inspect the exact client request after a successful conversion.
  // isolateRequestBody, not structuredClone: a direct engine caller may attach
  // an AbortSignal or a callback alongside the JSON, and structuredClone throws
  // DataCloneError on those instead of translating the request.
  let result = isolateRequestBody(body);

  // Null blocks are malformed, but must not abort routes with no media strip configured.
  // Do this before generic normalization walks content blocks for tool IDs.
  dropNullContentParts(result);

  // Strip explicit content types (opt-in via strip[] in PROVIDER_MODELS entry)
  stripContentTypes(result, stripList);

  // Normalize thinking config: remove if lastMessage is not user
  normalizeThinkingConfig(result);

  // Always ensure tool_calls have id (some providers require it)
  ensureToolCallIds(result);
  
  // Kiro performs stricter source-aware reconciliation after session replay.
  // The generic helper inserts OpenAI `role: tool` messages, which a direct
  // Claude→Kiro translator cannot consume and which cannot repair partial
  // parallel tool results.
  if (targetFormat !== FORMATS.KIRO) {
    // Both halves of the pairing invariant, in order: a result whose call is
    // gone is salvaged to text first (#2236), then a call with no result gets
    // an empty one. Reversed, the repair would answer a call that the orphan
    // sweep was about to remove the answer for.
    repairOrphanToolResults(result);
    fixMissingToolResponses(result);
  }

  // Capture thinking intent from the original (pre-translation) body, before any
  // format conversion strips/renames the fields. Applied after translation.
  const thinkingIntent = captureThinking(result);

  // Capture session id from the original body (envelope still intact, e.g. antigravity request.sessionId)
  const clientSessionId = captureSessionId(result, credentials, connectionId, targetFormat);
  // Expose to downstream translators (gemini-cli/antigravity envelopes) that run after envelope is stripped
  if (credentials) credentials._clientSessionId = clientSessionId;

  // A same-format Responses passthrough skips every translator, so the Codex-only
  // `additional_tools` input item would reach a standard Responses upstream verbatim
  // and fail the whole request. Normalize it here, where the passthrough is decided.
  // The tool schemas that item carries (and any already declared at top level) also
  // need the same unsupported-keyword strip a cross-format translation gets, since
  // no translator runs on this path to apply it otherwise (#1758).
  if (sourceFormat === targetFormat && targetFormat === FORMATS.OPENAI_RESPONSES) {
    hoistAdditionalTools(result);
    normalizePassthroughToolSchemas(result);
  }

  // If same format, skip translation steps
  if (sourceFormat !== targetFormat) {
    // Direct route: if a translator is registered for this exact source:target
    // pair, use it instead of pivoting through OpenAI. This is lossless for
    // pairs like claude:kiro (avoids the claude->openai->kiro double-hop).
    const directFn = requestRegistry.get(`${sourceFormat}:${targetFormat}`);
    if (directFn) {
      result = directFn(model, result, stream, credentials);
    } else {
      // Step 1: source -> openai (if source is not openai)
      if (sourceFormat !== FORMATS.OPENAI) {
        const toOpenAI = requestRegistry.get(`${sourceFormat}:${FORMATS.OPENAI}`);
        if (toOpenAI) {
          result = toOpenAI(model, result, stream, credentials);
          // Log OpenAI intermediate format
          reqLogger?.logOpenAIRequest?.(result);
        }
      }

      // Step 2: openai -> target (if target is not openai)
      if (targetFormat !== FORMATS.OPENAI) {
        const fromOpenAI = requestRegistry.get(`${FORMATS.OPENAI}:${targetFormat}`);
        if (fromOpenAI) {
          assertTranslationContent(FORMATS.OPENAI, targetFormat, result);
          result = fromOpenAI(model, result, stream, credentials);
        }
      }
    }
  }

  // Whatever built this body, every item it hands a Responses upstream needs its
  // `type`: the item union is matched on that field, and an untyped
  // { role, content } is rejected as "Unknown parameter: 'input[0].content'"
  // (#3390). Placed after translation so it covers the same-format passthrough
  // and the chat-shaped caller that already carries input[] alike.
  if (targetFormat === FORMATS.OPENAI_RESPONSES) typeResponsesInputItems(result);

  // Normalize thinking to the target provider-native format (config-driven, capability-aware).
  // Kiro's GenerateAssistantResponse request does not accept the generic top-level
  // `thinking` field; its translators map thinking intent to KAS-compatible
  // systemPrompt/additionalModelRequestFields instead.
  const kiroThinkingMappedByTranslator =
    targetFormat === FORMATS.KIRO &&
    (sourceFormat === FORMATS.OPENAI || sourceFormat === FORMATS.CLAUDE);
  if (!kiroThinkingMappedByTranslator) {
    applyThinking(targetFormat, model, result, provider, thinkingIntent);
  }

  // Always normalize to clean OpenAI format when target is OpenAI
  // This handles hybrid requests (e.g., OpenAI messages + Claude tools)
  if (targetFormat === FORMATS.OPENAI) {
    result = filterToOpenAIFormat(result, {
      preserveCacheControl: !!PROVIDERS[provider]?.quirks?.preserveCacheControl,
    });
  }

  // Final step: prepare request for Claude format endpoints
  if (targetFormat === FORMATS.CLAUDE) {
    const apiKey = credentials?.accessToken || credentials?.apiKey || null;
    result = prepareClaudeRequest(result, provider, apiKey, connectionId, credentials?.rawHeaders, clientSessionId);
  }

  // Claude cloaking: rename client tools with _cc suffix (anti-ban)
  // quirk: only providers flagged cloakToolsOnOAuth, and only with an OAuth token
  if (PROVIDERS[provider]?.quirks?.cloakToolsOnOAuth) {
    const apiKey = credentials?.accessToken || credentials?.apiKey || null;
    if (apiKey?.includes("sk-ant-oat")) {
      const { body: cloakedBody, toolNameMap } = cloakClaudeTools(result);
      result = cloakedBody;
      if (toolNameMap?.size > 0) {
        result._toolNameMap = toolNameMap;
      }
    }
  }

  // Antigravity cloaking disabled
  // if (provider === FORMATS.ANTIGRAVITY && body.userAgent !== FORMATS.ANTIGRAVITY) {
  //   const { cloakedBody, toolNameMap } = AntigravityExecutor.cloakTools(result);
  //   result = cloakedBody;
  //   if (toolNameMap?.size > 0) {
  //     result._toolNameMap = toolNameMap;
  //   }
  // }

  return result;
}

// Translate response chunk: target -> openai -> source
export function translateResponse(targetFormat, sourceFormat, chunk, state) {
  ensureInitialized();
  requireTranslationRoute(targetFormat, sourceFormat, "response");
  const sourceChunk = chunk == null ? chunk : structuredClone(chunk);
  // If same format, return as-is — except the tool name may still be cloaked:
  // translateRequest() suffixes client tools for OAuth-cloaked Claude providers
  // even when no format conversion is needed, so a streamed tool_use block must
  // be decloaked here or the client sees an unknown ("_ide"-suffixed) tool.
  if (sourceFormat === targetFormat) {
    if (sourceChunk == null) return [];
    decloakClaudePassthroughToolUse(sourceChunk, sourceFormat, state?.toolNameMap);
    return [sourceChunk];
  }

  let results = [sourceChunk];
  let openaiResults = null; // Store OpenAI intermediate results

  // Direct route: if a response translator is registered for this exact
  // target:source pair, use it instead of pivoting through OpenAI. Mirrors the
  // request-side direct route (e.g. kiro:claude — KiroExecutor already emits
  // OpenAI-shaped chunks, so this converts them straight to Claude SSE).
  const directFn = responseRegistry.get(`${targetFormat}:${sourceFormat}`);
  if (directFn) {
    const converted = directFn(sourceChunk, state);
    return converted ? (Array.isArray(converted) ? converted : [converted]) : [];
  }

  // Step 1: target -> openai (if target is not openai)
  if (targetFormat !== FORMATS.OPENAI) {
    const toOpenAI = responseRegistry.get(`${targetFormat}:${FORMATS.OPENAI}`);
    if (toOpenAI) {
      results = [];
      const converted = toOpenAI(sourceChunk, state);
      if (converted) {
        results = Array.isArray(converted) ? converted : [converted];
        openaiResults = results; // Store OpenAI intermediate
      }
    }
  }

  // Step 2: openai -> source (if source is not openai)
  if (sourceFormat !== FORMATS.OPENAI) {
    const fromOpenAI = responseRegistry.get(`${FORMATS.OPENAI}:${sourceFormat}`);
    if (fromOpenAI) {
      const finalResults = [];
      // On flush (chunk === null) a pivot step that produced nothing must still hand the
      // null to step 2, so terminal-event translators (e.g. openai -> openai-responses)
      // get to emit their response.completed.
      if (chunk === null && results.length === 0) {
        const converted = fromOpenAI(null, state);
        if (converted) {
          finalResults.push(...(Array.isArray(converted) ? converted : [converted]));
        }
      }
      for (const r of results) {
        const converted = fromOpenAI(r, state);
        if (converted) {
          finalResults.push(...(Array.isArray(converted) ? converted : [converted]));
        }
      }
      results = finalResults;
    }
  }

  // Attach OpenAI intermediate results for logging
  if (openaiResults && sourceFormat !== FORMATS.OPENAI && targetFormat !== FORMATS.OPENAI) {
    results._openaiIntermediate = openaiResults;
  }

  return results;
}

// Check if translation needed
export function needsTranslation(sourceFormat, targetFormat) {
  return sourceFormat !== targetFormat;
}

// Initialize state for streaming response based on format
export function initState(sourceFormat) {
  // Base state for all formats
  const base = {
    messageId: null,
    model: null,
    textBlockStarted: false,
    thinkingBlockStarted: false,
    inThinkingBlock: false,
    currentBlockIndex: null,
    toolCalls: new Map(),
    finishReason: null,
    finishReasonSent: false,
    usage: null,
    contentBlockIndex: -1
  };

  // Add openai-responses specific fields
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    return {
      ...base,
      seq: 0,
      responseId: `resp_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      started: false,
      msgTextBuf: {},
      msgItemAdded: {},
      msgContentAdded: {},
      msgItemDone: {},
      reasoningId: "",
      reasoningIndex: -1,
      reasoningBuf: "",
      reasoningPartAdded: false,
      reasoningDone: false,
      inThinking: false,
      funcArgsBuf: {},
      funcNames: {},
      funcCallIds: {},
      funcItemAdded: {},
      funcArgsDone: {},
      funcItemDone: {},
      customToolNames: new Set(),
      completionPending: false,
      completedSent: false
    };
  }

  return base;
}

// Kept for backward compatibility; translators are already registered at import time.
export function initTranslators() {
  ensureInitialized();
}

// Static side-effect imports: each module calls register() at load (works in ESM + bundler).
import "./request/claude-to-openai.js";
import "./request/openai-to-claude.js";
import "./request/gemini-to-openai.js";
import "./request/openai-to-gemini.js";
import "./request/openai-to-vertex.js";
import "./request/antigravity-to-openai.js";
import "./request/openai-responses.js";
import "./request/openai-to-kiro.js";
import "./request/openai-to-cursor.js";
import "./request/openai-to-ollama.js";
import "./request/openai-to-commandcode.js";
import "./request/claude-to-kiro.js";
import "./response/claude-to-openai.js";
import "./response/openai-to-claude.js";
import "./response/gemini-to-openai.js";
import "./response/openai-to-antigravity.js";
import "./response/openai-to-gemini.js";
import "./response/openai-responses.js";
import "./response/kiro-to-openai.js";
import "./response/cursor-to-openai.js";
import "./response/ollama-to-openai.js";
import "./response/commandcode-to-openai.js";
import "./response/kiro-to-claude.js";
