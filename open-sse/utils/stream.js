import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "../../src/lib/usageDb.js";
import { CLAUDE_BLOCK } from "../translator/schema/index.js";
import { PROVIDERS } from "../config/providers.js";
import { canonicalEchoModel } from "../services/model.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE, decloakClaudePassthroughToolUse } from "./streamHelpers.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

function withoutExactProviderCosts(usage) {
  if (!usage || typeof usage !== "object") return usage;
  const { cost_usd, cost_in_usd, cost_in_usd_ticks, ...publicUsage } = usage;
  return publicUsage;
}

// Tool-call bytes are model output too. Only visible text and reasoning fed
// totalContentLength, so a turn that is entirely tool calls estimated zero
// output tokens while the tool calls themselves arrived intact — an accounting
// hole, not lost content (#1382). Counted into the length counter only:
// accumulatedContent stays the visible transcript, so the empty-stream checks
// that read it are unchanged.
function toolCallOutputLength(parsed) {
  let length = 0;
  const add = (value) => {
    if (typeof value === "string") length += value.length;
    else if (value && typeof value === "object") length += JSON.stringify(value).length;
  };

  // OpenAI: streamed argument fragments, plus the legacy function_call shape.
  const delta = parsed?.choices?.[0]?.delta;
  if (Array.isArray(delta?.tool_calls)) {
    for (const call of delta.tool_calls) {
      add(call?.function?.name);
      add(call?.function?.arguments);
    }
  }
  add(delta?.function_call?.name);
  add(delta?.function_call?.arguments);

  // Claude: the name rides on the tool_use block start, the arguments arrive as
  // input_json_delta fragments.
  if (parsed?.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
    add(parsed.content_block.name);
  }
  add(parsed?.delta?.partial_json);

  // Gemini: one whole functionCall per part, args as an object.
  const parts = parsed?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!part?.functionCall) continue;
      add(part.functionCall.name);
      add(part.functionCall.args);
    }
  }

  // Ollama native NDJSON.
  if (Array.isArray(parsed?.message?.tool_calls)) {
    for (const call of parsed.message.tool_calls) {
      add(call?.function?.name);
      add(call?.function?.arguments);
    }
  }

  return length;
}

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    customToolNames = null,
    responsesToolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    streamState = null
  } = options;

  let buffer = "";
  let usage = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, customToolNames: new Set(customToolNames || []), responsesToolNameMap, model }
    : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  let passthroughFinishSeen = false;  // passthrough: duplicate finish chunks from upstream
  let passthroughDoneSent = false;    // passthrough: upstream already sent [DONE]

  // Keep streamState in sync so onStreamAbandoned can read partial usage on a
  // disconnect or a mid-stream upstream error (flush/cancel never run when the
  // upstream errors the readable before the client sees it).
  const syncState = () => {
    if (!streamState) return;
    streamState.content = accumulatedContent;
    streamState.thinking = accumulatedThinking;
    streamState.ttftAt = ttftAt;
    streamState.usage = mode === STREAM_MODE.PASSTHROUGH ? usage : state?.usage ?? null;
  };

  // The stream finishes exactly once. `flush` runs when the upstream ends, and
  // `cancel` when the client goes away mid-stream — the Streams spec calls one
  // or the other, never both. Recording lived only in `flush`, so an aborted
  // request left no usage row, no request detail and nothing in Recent
  // Requests, even though the provider had already generated (and charged for)
  // the partial answer (#3488).
  let streamFinished = false;
  const finishStream = (usage, { aborted = false } = {}) => {
    if (streamFinished) return;
    streamFinished = true;
    if (!onStreamComplete) return;
    onStreamComplete(
      { content: accumulatedContent, thinking: accumulatedThinking },
      usage,
      ttftAt,
      { aborted },
    );
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;

          // Dedup terminators: some upstreams (e.g. stealth/ox-alpha) send the
          // finish chunk twice and/or their own [DONE]; clients like AI SDK
          // treat anything after the first finish_reason as a protocol error.
          const isDoneLine = trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]";
          if (isDoneLine && passthroughDoneSent) continue;
          if (isDoneLine) passthroughDoneSent = true;

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());

              // Some Anthropic-compatible providers omit `signature` from the
              // thinking block start. Strict Messages clients deserialize that
              // field before later signature_delta events arrive.
              let fieldsInjected = false;
              const toolNameDecloaked = decloakClaudePassthroughToolUse(parsed, sourceFormat, toolNameMap);
              if (
                PROVIDERS[provider]?.quirks?.ensureThinkingSignature &&
                parsed.type === "content_block_start" &&
                parsed.content_block?.type === CLAUDE_BLOCK.THINKING &&
                parsed.content_block.signature === undefined
              ) {
                parsed.content_block.signature = "";
                fieldsInjected = true;
              }

              const idFixed = fixInvalidId(parsed);

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              // Echo a stable, listing-valid model name instead of the upstream
              // id. Passthrough providers (opencode free tier) echo the bare
              // resolved model with the provider prefix stripped; clients that
              // trust the echo re-send it on the next hop. Prefixed requests
              // keep their exact form; bare requests resolved to a
              // connection-less catalog provider get the listing form
              // re-injected (OpenRouter-style proxy echo).
              const echoModel = canonicalEchoModel({ requestedModel: body?.model, provider, model });
              if (typeof parsed.model === "string" && echoModel && parsed.model !== echoModel) {
                parsed.model = echoModel;
                fieldsInjected = true;
              }
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
              // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
              // every streaming delta. @ai-sdk/openai-compatible checks
              // `delta.tool_calls != null` — an empty array passes this check,
              // causing premature `reasoning-end` on every chunk.
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                    delete choice.delta.tool_calls;
                    fieldsInjected = true;
                  }
                }
              }

              // OpenRouter-style gateways (e.g. stealth/ox-alpha) stream reasoning
              // under `delta.reasoning`, but OpenAI-compatible clients (Cursor,
              // OpenCode, pi) expect `delta.reasoning_content`. Normalize so
              // clients render reasoning instead of an empty answer.
              const delta = parsed.choices?.[0]?.delta;
              if (delta && typeof delta.reasoning === "string" && delta.reasoning_content === undefined) {
                delta.reasoning_content = delta.reasoning;
                delete delta.reasoning;
                fieldsInjected = true; // force output from the mutated parsed
              }

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }
              const content = delta?.content;
              const reasoning = delta?.reasoning_content || delta?.reasoning;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }
              totalContentLength += toolCallOutputLength(parsed);

              syncState();

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = mergeUsage(usage, extracted);
              }
              syncState();

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && passthroughFinishSeen) {
                // Duplicate finish chunk (the second usually carries only
                // upstream-side usage) — drop it: two finish_reasons in one
                // stream break AI SDK clients ("content after finish reason").
                continue;
              }
              if (isFinishChunk) passthroughFinishSeen = true;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                parsed.usage = filterUsageForFormat(usage, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected || toolNameDecloaked) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch {
              // Skip non-JSON data lines silently — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML, rate-limit
              // messages) in the SSE stream that would break downstream JSON decoders.
              continue;
            }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          if (keepsOpenAIResponsesFormat && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
            streamDoneSent = true;
          }
          // `streamDoneSent` means SENT, not "seen". It used to be set here
          // unconditionally, so an upstream sentinel on a non-Responses translate
          // stream was swallowed by the `continue` below AND recorded as though it
          // had been forwarded — which then suppressed the flush's own emit and
          // left an OpenAI client with no terminator at all. Only the branch that
          // actually enqueues one may set it.
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          continue;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        } else if (parsed.choices?.[0]?.delta?.reasoning) {
          totalContentLength += parsed.choices[0].delta.reasoning.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning;
        }
        
        // Ollama native NDJSON: content rides on `message`, not on a delta or a
        // choices array, so without this branch every Ollama stream is logged
        // as an empty response no matter how much text the client received.
        // Gated on the target format because `message` is a common key.
        if (targetFormat === FORMATS.OLLAMA && parsed.message) {
          const ollamaContent = parsed.message.content;
          const ollamaThinking = parsed.message.thinking;
          if (typeof ollamaContent === "string" && ollamaContent) {
            totalContentLength += ollamaContent.length;
            accumulatedContent += ollamaContent;
          }
          if (typeof ollamaThinking === "string" && ollamaThinking) {
            totalContentLength += ollamaThinking.length;
            accumulatedThinking += ollamaThinking;
          }
        }

        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        totalContentLength += toolCallOutputLength(parsed);

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = mergeUsage(state.usage, extracted); // Keep original usage for logging
        syncState();

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const outbound = parsed.response?.usage
            ? {
                ...parsed,
                response: {
                  ...parsed.response,
                  usage: withoutExactProviderCosts(parsed.response.usage),
                },
              }
            : parsed;
          const output = formatSSE({ event: openAIResponsesEventName, data: outbound }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat);
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              item.usage = filterUsageForFormat(state.usage, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
          }
        }
      }
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            let output = buffer;
            if (buffer.startsWith("data:")) {
              try {
                const parsed = JSON.parse(buffer.slice(5).trim());
                if (parsed === null) {
                  output = "";
                } else if (decloakClaudePassthroughToolUse(parsed, sourceFormat, toolNameMap)) {
                  output = `data: ${JSON.stringify(parsed)}`;
                }
              } catch {
                // Preserve a malformed trailing frame exactly as received.
              }
            }
            if (output.startsWith("data:") && !output.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            // Ensure the trailing SSE frame ends with a newline before the
            // [DONE] sentinel — upstreams that close without a final \n would
            // glue "...}data: [DONE]" together and break client parsers.
            if (output) {
              if (!output.endsWith("\n")) output += "\n";
              reqLogger?.appendConvertedChunk?.(output);
              controller.enqueue(sharedEncoder.encode(output));
            }
          }

          if (!hasValidUsage(usage) && totalContentLength > 0) {
            usage = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
          }

          if (hasValidUsage(usage)) {
            logUsage(provider, usage, model, connectionId, apiKey);
          } else {
            appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
          }
          
          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          // Gemini-family clients (Antigravity, Vertex, Gemini) reject this sentinel with 400 syntax errors.
          //
          // So do Anthropic clients, and for a better reason: `data: [DONE]` is
          // not in the Anthropic wire protocol at all. That stream ends at
          // `event: message_stop`, and every event on it carries an `event:`
          // line, so a bare data-only frame arriving after the message has
          // ended is a frame the SDK has no state for. The sentinel is an
          // OpenAI convention and belongs only on streams whose CLIENT speaks
          // OpenAI, which is the source format, not the provider.
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
          const clientSpeaksClaude = sourceFormat === FORMATS.CLAUDE;
          if (!streamDoneSent && !passthroughDoneSent && !isGeminiFamily && !clientSpeaksClaude) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          syncState();
          finishStream(usage);
          return;
        }

        if (buffer.trim()) {
          // Same parse as the transform loop: without targetFormat this only
          // accepts "data: " lines, so an NDJSON provider (Ollama) lost whatever
          // arrived without its closing newline.
          const parsed = parseSSELine(buffer.trim(), targetFormat);
          // parseSSELine turns the SSE sentinel "data: [DONE]" into { done: true },
          // which must not be translated. An Ollama chunk also carries done:true,
          // but it is the real final chunk — it holds done_reason and the token
          // counts — so it has to go through.
          const isDoneSentinel = parsed?.done && targetFormat !== FORMATS.OLLAMA;
          if (parsed && !isDoneSentinel) {
            // Same accumulation the transform loop does, so the usage logged at
            // cancel()/finish time carries a tail chunk's tokens instead of null.
            const extracted = extractUsage(parsed);
            if (extracted) state.usage = mergeUsage(state.usage, extracted);

            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                if (item === null || item === undefined) continue;
                const output = formatSSE(item, sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          }
        }

        // Make fallback usage available before translators emit their terminal
        // event. Responses clients read usage from response.completed, so
        // estimating after flush leaves their context counters at zero.
        if (sourceFormat === FORMATS.OPENAI_RESPONSES &&
            !hasValidUsage(state?.usage) && totalContentLength > 0) {
          state.usage = estimateUsage(body, totalContentLength, sourceFormat);
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        // The sentinel belongs to the CLIENT protocol, which on the translate
        // path is `sourceFormat` — the same rule the passthrough flush states at
        // its own [DONE] gate above. An OpenAI-family client terminates on
        // `data: [DONE]`, so it has to arrive whatever the upstream spoke. This
        // used to fire only for the Responses sub-case, which left every stream
        // whose upstream format differed from the client's — i.e. every
        // claude-family model, the fleet's primary path — unterminated, and any
        // OpenAI-protocol client waiting on the sentinel hung until timeout.
        //
        // An ALLOWLIST, not a denylist: Claude has no [DONE] in its wire
        // protocol, Gemini rejects it with a 400, and Ollama speaks NDJSON, so a
        // format added later gets no sentinel until it is known to want one.
        const clientSpeaksOpenAI =
          sourceFormat === FORMATS.OPENAI || sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (clientSpeaksOpenAI && !openAIResponsesDoneSent && !streamDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          streamDoneSent = true;
        }

        // Preserve the existing post-translation estimation timing for every
        // other client format.
        if (!hasValidUsage(state?.usage) && totalContentLength > 0) {
          state.usage = estimateUsage(body, totalContentLength, sourceFormat);
        }

        if (hasValidUsage(state?.usage)) {
          logUsage(state.provider || targetFormat, state.usage, model, connectionId, apiKey);
        } else {
          appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
        }
        
        syncState();
        finishStream(state?.usage);
      } catch (error) {
        console.log("Error in flush:", error);
      }
    },

    // The client hung up. Nothing more can be written, but everything that was
    // already generated is worth recording — with whatever usage the provider
    // had reported by then.
    cancel() {
      try {
        // TRANSLATE keeps usage on `state`, PASSTHROUGH in the closure variable
        // — the same split the two flush paths above make.
        let reported = state ? state.usage : usage;
        if (!hasValidUsage(reported) && totalContentLength > 0) {
          reported = estimateUsage(body, totalContentLength, state ? sourceFormat : FORMATS.OPENAI);
        }
        syncState();
        finishStream(reported, { aborted: true });
      } catch (error) {
        console.log("Error in cancel:", error);
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, customToolNames = null, streamState = null, responsesToolNameMap = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    customToolNames,
    responsesToolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    streamState
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, streamState = null, toolNameMap = null, sourceFormat = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    streamState
  });
}
