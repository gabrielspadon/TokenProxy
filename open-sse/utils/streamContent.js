import { createSseDecoder } from "./sseDecoder.js";
import { STREAM_FIRST_CHUNK_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { detectUpstreamErrorContent } from "../services/upstreamErrorContent.js";

const SSE_CONTENT_TYPE = "text/event-stream";
const PEEK_MAX_BYTES = 256 * 1024;

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function frameCarriesActionableGeminiOutput(payload) {
  const response = payload?.response || payload;
  const candidates = response?.candidates;
  if (!Array.isArray(candidates)) return payload?.response ? false : null;

  return candidates.some(candidate => candidate?.content?.parts?.some(part => (
    (nonEmptyString(part?.text) && part.thought !== true)
    || !!part?.functionCall
    || !!part?.inlineData?.data
  )));
}

export function hasOutputTokens(usage) {
  if (!usage || typeof usage !== "object") return false;
  const value = Number(
    usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? 0
  );
  return Number.isFinite(value) && value > 0;
}

// Role/usage envelopes must not make a zero-output response look successful.
// Native Claude message_stop is opt-in because it is itself client-visible.
export function frameCarriesContent(line, { includeClaudeTerminal = false, requireActionableGeminiOutput = false } = {}) {
  if (!line.startsWith("data:")) return false;
  const parsed = parseDataPayload(line.slice(5));
  return parsed !== null && payloadCarriesContent(parsed, { includeClaudeTerminal, requireActionableGeminiOutput });
}

function parseDataPayload(data) {
  const payload = data.trim();
  if (!payload || payload === "[DONE]") return null;
  try { return JSON.parse(payload); } catch { return null; }
}

function payloadCarriesContent(parsed, { includeClaudeTerminal, requireActionableGeminiOutput }) {
  // Antigravity can finish with only internal thought parts and token metadata.
  // Those are not an answer or tool action. Waiting for a visible Gemini part
  // keeps this pre-client gate fail-safe and leaves account/combo fallback to
  // the outer request loop.
  if (requireActionableGeminiOutput) {
    const actionableGeminiOutput = frameCarriesActionableGeminiOutput(parsed);
    if (actionableGeminiOutput !== null) return actionableGeminiOutput;
  }

  if (hasOutputTokens(parsed.usage) || hasOutputTokens(parsed.response?.usage)) return true;

  const delta = parsed.choices?.[0]?.delta;
  if (nonEmptyString(delta?.content)) return true;
  if (nonEmptyString(delta?.reasoning_content) || nonEmptyString(delta?.reasoning)) return true;
  if (delta?.tool_calls?.length || delta?.function_call) return true;

  if (parsed.type === "content_block_delta") {
    const contentDelta = parsed.delta;
    if (nonEmptyString(contentDelta?.text) || nonEmptyString(contentDelta?.partial_json) || nonEmptyString(contentDelta?.thinking)) return true;
  }
  if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") return true;
  if (includeClaudeTerminal && parsed.type === "message_stop") return true;

  if (typeof parsed.type === "string" && parsed.type.endsWith(".delta") && nonEmptyString(parsed.delta)) return true;

  const parts = parsed.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.some(part => nonEmptyString(part?.text) || part?.functionCall || part?.inlineData)) return true;

  if (nonEmptyString(parsed.message?.content) || nonEmptyString(parsed.response)) return true;
  if (parsed.message?.tool_calls?.length) return true;

  return false;
}

// The text a content frame carries, for the shapes an upstream error actually
// arrives in. Used only to test that text against detectUpstreamErrorContent;
// it is never the transcript, so partial coverage is fine.
export function frameContentText(line) {
  if (!line.startsWith("data:")) return "";
  const parsed = parseDataPayload(line.slice(5));
  return parsed === null ? "" : payloadContentText(parsed);
}

function payloadContentText(parsed) {
  const delta = parsed.choices?.[0]?.delta;
  if (nonEmptyString(delta?.content)) return delta.content;
  if (parsed.type === "content_block_delta" && nonEmptyString(parsed.delta?.text)) return parsed.delta.text;
  if (nonEmptyString(parsed.message?.content)) return parsed.message.content;
  if (nonEmptyString(parsed.response)) return parsed.response;
  return "";
}

// Read only SSE bodies until output appears, then replay every buffered byte.
// The handler can preserve an empty buffer briefly for its legacy error parser.
export async function peekStreamForContent(response, timeoutMs = STREAM_FIRST_CHUNK_TIMEOUT_MS, { preserveOnNoContent = false, includeClaudeTerminal = false, requireActionableGeminiOutput = false } = {}) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes(SSE_CONTENT_TYPE) || !response.body) {
    return { hasContent: true, body: null };
  }

  const reader = response.body.getReader();
  let readerReleased = false;
  const releaseReader = () => {
    if (readerReleased) return;
    try { reader.releaseLock?.(); readerReleased = true; } catch {}
  };
  const cancelReader = async reason => {
    try { await reader.cancel?.(reason); } catch {}
    finally { releaseReader(); }
  };
  const rawChunks = [];
  let rawBytes = 0;
  let hasContent = false;
  let upstreamError = null;
  let upstreamDone = false;
  let readError = null;
  let timedOut = false;
  let pendingRead = null;

  const decoder = createSseDecoder(event => {
    if (hasContent || upstreamError) return;
    const parsed = parseDataPayload(event.data);
    if (parsed !== null && payloadCarriesContent(parsed, { includeClaudeTerminal, requireActionableGeminiOutput })) {
      upstreamError = detectUpstreamErrorContent(payloadContentText(parsed));
      if (!upstreamError) hasContent = true;
    }
  });

  const deadline = Date.now() + timeoutMs;
  let timer = null;
  const expiry = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  try {
    while (!hasContent) {
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      pendingRead = reader.read();
      const next = await Promise.race([pendingRead, expiry]);
      if (next?.timedOut) {
        timedOut = true;
        break;
      }
      pendingRead = null;

      const { done, value } = next;
      if (done) {
        upstreamDone = true;
        decoder.finish();
        break;
      }

      rawChunks.push(value);
      rawBytes += value.byteLength;
      decoder.feed(value);
      if (hasContent || upstreamError) break;

      if (rawBytes >= PEEK_MAX_BYTES) {
        hasContent = true;
        break;
      }
    }
  } catch (error) {
    readError = error;
    hasContent = false;
  } finally {
    decoder.release();
    if (upstreamDone) releaseReader();
    if (timer) clearTimeout(timer);
  }

  // A raced read remains live after the timeout wins. Leaving it attached to
  // the reader makes the replay body's first pull issue a second read: the
  // late frame can go to the abandoned read while the replay hangs or sees EOF.
  // Cancel and settle that read first, then replay only bytes already buffered.
  if (timedOut) {
    const cancellation = cancelReader();
    await Promise.allSettled([cancellation, pendingRead].filter(Boolean));
    pendingRead = null;
    upstreamDone = true;
    releaseReader();
  }

  const createReplayBody = () => new ReadableStream({
    start(controller) {
      for (const chunk of rawChunks) controller.enqueue(chunk);
      rawChunks.length = 0;
      if (upstreamDone) controller.close();
    },
    async pull(controller) {
      if (upstreamDone) return;
      try {
        const { done, value } = await reader.read();
        if (done) { upstreamDone = true; releaseReader(); controller.close(); return; }
        controller.enqueue(value);
      } catch (error) {
        upstreamDone = true;
        releaseReader();
        controller.error(error);
      }
    },
    cancel(reason) {
      upstreamDone = true;
      return cancelReader(reason);
    }
  });

  if (!hasContent) {
    if (readError && preserveOnNoContent) {
      await cancelReader();
      return { hasContent: false, body: null, error: readError, upstreamError };
    }
    if (!preserveOnNoContent) {
      await cancelReader();
      return { hasContent: false, body: null, error: readError, upstreamError };
    }
    return { hasContent: false, body: createReplayBody(), error: null, upstreamError };
  }

  return { hasContent: true, body: createReplayBody(), error: null, upstreamError: null };
}
