// RTK port: compress tool_result content in LLM request bodies
// Injected at the top of translateRequest (before any format translation)
import { RAW_CAP, MIN_COMPRESS_SIZE, ELIDE_MIN_CHARS } from "./constants.js";
import { elide } from "./filters/elide.js";
import { autoDetectFilter } from "./autodetect.js";
import { safeApply } from "./applyFilter.js";

import { isErrorResult } from "./errorFlags.js";
import { jsonCompact } from "./filters/jsonCompact.js";

// Compute every replacement before writing anything. Parsed request bodies have
// writable data properties; accessors/frozen targets fail before the first write.
// No whole-body clone is needed, so the cost follows tool output bytes only.
function commitReplacements(patches) {
  for (const { node, key } of patches) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.writable) {
      throw new TypeError("compression target is not a writable data property");
    }
  }
  let committed = 0;
  try {
    for (const { node, key, value } of patches) {
      node[key] = value;
      committed++;
    }
  } catch (error) {
    for (let i = committed - 1; i >= 0; i--) {
      const { node, key, original } = patches[i];
      node[key] = original;
    }
    throw error;
  }
}

function newStats(allowLossy) {
  return {
    bytesBefore: 0, bytesAfter: 0, hits: [],
    mode: allowLossy ? "lossy-opt-in" : "semantic-preserving",
    semanticPreserving: true,
  };
}

function stageText(node, key, stats, shape, patches, allowLossy) {
  const original = node[key];
  const value = compressText(original, stats, shape, allowLossy);
  if (value !== original) patches.push({ node, key, value, original });
}

export function compressMessages(body, enabled, { allowLossy = false } = {}) {
  try {
    return compressBody(body, enabled, allowLossy);
  } catch (error) {
    console.warn("[RTK] request traversal failed:", error?.message);
    return null;
  }
}

function compressBody(body, enabled, allowLossy) {
  if (!enabled) return null;
  if (!body) return null;

  // Kiro format: conversationState.history + conversationState.currentMessage
  if (body.conversationState) {
    return compressKiroFormat(body, allowLossy);
  }

  // Support both OpenAI/Claude "messages" and OpenAI Responses "input"
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!items) return null;

  const stats = newStats(allowLossy);
  const patches = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const msg = items[i];
      if (!msg) continue;

      // Shape 4: OpenAI Responses — top-level { type:"function_call_output", output: string | [{type:"input_text", text}] }
      if (msg.type === "function_call_output") {
        if (isErrorResult(msg)) continue;
        if (typeof msg.output === "string") {
          stageText(msg, "output", stats, "openai-responses-string", patches, allowLossy);
        } else if (Array.isArray(msg.output)) {
          for (let k = 0; k < msg.output.length; k++) {
            const part = msg.output[k];
            if (part && part.type === "input_text" && typeof part.text === "string" && !isErrorResult(part)) {
              stageText(part, "text", stats, "openai-responses-array", patches, allowLossy);
            }
          }
        }
        continue;
      }

      // Shape 1: OpenAI tool message — { role:"tool", content: "string" }
      if (msg.role === "tool" && typeof msg.content === "string") {
        if (isErrorResult(msg)) continue;
        stageText(msg, "content", stats, "openai-tool", patches, allowLossy);
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      // Shape 1b: OpenAI tool message — { role:"tool", content:[{type:"text", text:"..."}] }
      if (msg.role === "tool") {
        if (isErrorResult(msg)) continue;
        for (let k = 0; k < msg.content.length; k++) {
          const part = msg.content[k];
          if (part && part.type === "text" && typeof part.text === "string" && !isErrorResult(part)) {
            stageText(part, "text", stats, "openai-tool-array", patches, allowLossy);
          }
        }
        continue;
      }

      // Shape 2/3: blocks array with tool_result entries
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!block || block.type !== "tool_result") continue;
        if (isErrorResult(block)) continue; // preserve error traces

        if (typeof block.content === "string") {
          // Shape 2: claude string form
          stageText(block, "content", stats, "claude-string", patches, allowLossy);
        } else if (Array.isArray(block.content)) {
          // Shape 3: claude array form — compress each text part
          for (let k = 0; k < block.content.length; k++) {
            const part = block.content[k];
            if (part && part.type === "text" && typeof part.text === "string" && !isErrorResult(part)) {
              stageText(part, "text", stats, "claude-array", patches, allowLossy);
            }
          }
        }
      }
    }
    commitReplacements(patches);
  } catch (e) {
    console.warn("[RTK] compressMessages error:", e.message);
    return null;
  }
  return stats;
}

// Compress Kiro format: conversationState.history[].userInputMessage.userInputMessageContext.toolResults[].content[].text
function compressKiroFormat(body, allowLossy) {
  const stats = newStats(allowLossy);
  const patches = [];
  try {
    const state = body.conversationState;
    const allMessages = [...(Array.isArray(state?.history) ? state.history : [])];
    if (state?.currentMessage) allMessages.push(state.currentMessage);

    for (const msg of allMessages) {
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults;
      if (!Array.isArray(toolResults)) continue;

      for (const tr of toolResults) {
        if (isErrorResult(tr)) continue; // preserve error traces
        if (!Array.isArray(tr.content)) continue;

        for (const part of tr.content) {
          if (part && typeof part.text === "string" && !isErrorResult(part)) {
            stageText(part, "text", stats, "kiro-tool-result", patches, allowLossy);
          }
        }
      }
    }
    commitReplacements(patches);
  } catch (e) {
    console.warn("[RTK] compressKiroFormat error:", e.message);
    return null;
  }
  return stats;
}

function compressText(text, stats, shape, allowLossy) {
  const bytesIn = Buffer.byteLength(text, "utf8");
  stats.bytesBefore += bytesIn;

  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const compact = jsonCompact(text);
  const fn = typeof compact === "string" ? jsonCompact : allowLossy
    ? autoDetectFilter(text) || (text.length > ELIDE_MIN_CHARS ? elide : null)
    : null;
  if (!fn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const out = fn === jsonCompact ? compact : safeApply(fn, text);
  const bytesOut = Buffer.byteLength(out, "utf8");

  // Safety: never return empty, never grow the input
  if (!out || out.length === 0 || bytesOut >= bytesIn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  stats.bytesAfter += bytesOut;
  const semanticPreserving = fn.semanticPreserving === true;
  stats.semanticPreserving &&= semanticPreserving;
  stats.hits.push({ shape, filter: fn.filterName || fn.name, saved: bytesIn - bytesOut, semanticPreserving });
  return out;
}

// Convenience: format a log line from stats
export function formatRtkLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}
