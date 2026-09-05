/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

import { copyNonnegativeExactCosts } from "../utils/usageTracking.js";

/**
 * Apply a terminal event's usage onto the accumulating state. Called for every
 * terminal event including response.failed: a stream that failed still consumed
 * tokens upstream, and returning a zeroed usage makes the client's running total
 * silently diverge from what was actually spent.
 */
function applyTerminalUsage(parsed, state) {
  if (!parsed.response?.usage) return;
  const u = parsed.response.usage;
  state.usage.input_tokens = u.input_tokens || u.prompt_tokens || 0;
  state.usage.output_tokens = u.output_tokens || u.completion_tokens || 0;
  state.usage.total_tokens = u.total_tokens || (state.usage.input_tokens + state.usage.output_tokens);
  // Preserve cache + reasoning breakdowns so cost calc and the client see
  // cached_tokens (a subset of input_tokens) instead of a cache-blind total.
  const inputDetails = u.input_tokens_details
    || (u.cached_tokens !== undefined ? { cached_tokens: u.cached_tokens }
    : u.cache_read_input_tokens !== undefined ? { cached_tokens: u.cache_read_input_tokens } : null);
  if (inputDetails && typeof inputDetails === "object") {
    state.usage.input_tokens_details = inputDetails;
  }
  const outputDetails = u.output_tokens_details
    || (u.reasoning_tokens !== undefined ? { reasoning_tokens: u.reasoning_tokens } : null);
  if (outputDetails && typeof outputDetails === "object") {
    state.usage.output_tokens_details = outputDetails;
  }
  copyNonnegativeExactCosts(u, state.usage, { enumerable: false });
}

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!dataMatch) return;

  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  // Some OpenAI-compatible providers (e.g. SLG/singularityapi) send data-only
  // SSE with no `event:` line, relying on the JSON payload's own `type` field
  // instead — fall back to that so their streams aren't silently dropped.
  const eventType = eventMatch ? eventMatch[1].trim() : (parsed.type || "");

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
    // Terminal events carry the REAL upstream status: OpenAI emits
    // response.completed with status:"incomplete" + incomplete_details when
    // max_output_tokens truncates the output. Hardcoding "completed" turned
    // truncation into a normal stop for non-streaming clients.
    if (parsed.response?.status) {
      state.status = parsed.response.status;
      if (parsed.response?.incomplete_details != null) {
        state.incomplete_details = parsed.response.incomplete_details;
      }
    }
    applyTerminalUsage(parsed, state);
  } else if (eventType === "response.failed") {
    state.status = "failed";
    applyTerminalUsage(parsed, state);
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @param {{reader?: ReadableStreamDefaultReader}} options - Optional outer-owned reader
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream, { reader: suppliedReader } = {}) {
  if (!suppliedReader && (!stream || typeof stream.getReader !== "function")) {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = suppliedReader || stream.getReader();
  const ownsReader = !suppliedReader;
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    incomplete_details: undefined,
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    if (ownsReader) reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    ...(state.incomplete_details ? { incomplete_details: state.incomplete_details } : {}),
    output,
    usage: state.usage
  };
}
