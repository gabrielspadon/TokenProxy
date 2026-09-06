// Tool call helper functions for translator
import { TOOL_TYPE } from "../schema/toolTypes.js";

// Anthropic tool_use.id must match: ^[a-zA-Z0-9_-]+$
const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Fallback streaming tool_call id when provider omits one (index optional)
export function fallbackToolCallId(index) {
  return index === undefined ? `call_${Date.now()}` : `call_${index}_${Date.now()}`;
}

// Generate deterministic tool call ID from position + tool name (cache-friendly)
export function generateToolCallId(msgIndex = 0, tcIndex = 0, toolName = "") {
  const name = toolName ? `_${toolName.replace(/[^a-zA-Z0-9_-]/g, "")}` : "";
  return `call_msg${msgIndex}_tc${tcIndex}${name}`;
}

// Sanitize ID to match Anthropic pattern: keep only alphanumeric, underscore, hyphen
function sanitizeToolId(id) {
  if (!id || typeof id !== "string") return null;
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

// Resolve the id a tool result should carry.
//
// A missing id cannot be sanitized into existence, and Anthropic rejects the
// whole request when one is absent ("tool_result.tool_use_id: Field required").
// Pair it instead with the oldest tool call from the preceding assistant turn
// that nothing has answered yet — that is the id upstream is expecting, and
// OpenAI-format clients that drop tool_call_id on a turn are the reason this
// path exists (#3362). Only if there is nothing to pair with do we generate an
// id, which at least keeps the request well-formed.
function resolveToolResultId(rawId, unanswered, makeFallbackId) {
  const usable =
    typeof rawId === "string" && rawId
      ? (TOOL_ID_PATTERN.test(rawId) ? rawId : sanitizeToolId(rawId))
      : null;

  if (usable) {
    const at = unanswered.indexOf(usable);
    if (at >= 0) unanswered.splice(at, 1);
    return usable;
  }

  return unanswered.shift() || makeFallbackId();
}

// Ensure all tool_calls have valid id field and arguments is string (some providers require it)
export function ensureToolCallIds(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  // Tool call ids from the most recent assistant turn that no result has
  // claimed yet, oldest first.
  let unanswered = [];

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (let j = 0; j < msg.tool_calls.length; j++) {
        const tc = msg.tool_calls[j];
        // Validate or regenerate ID for Anthropic compatibility
        if (!tc.id || !TOOL_ID_PATTERN.test(tc.id)) {
          const sanitized = sanitizeToolId(tc.id);
          tc.id = sanitized || generateToolCallId(i, j, tc.function?.name);
        }
        if (!tc.type) {
          tc.type = "function";
        }
        // OpenAI-compatible history requires function.arguments to be a JSON
        // string even when the tool takes no arguments. Some clients replay an
        // empty call as missing/null/"", which strict upstreams reject.
        if (tc.function && typeof tc.function === "object") {
          if (tc.function.arguments == null || tc.function.arguments === "") {
            tc.function.arguments = "{}";
          } else if (typeof tc.function.arguments !== "string") {
            tc.function.arguments = JSON.stringify(tc.function.arguments);
          }
        }
      }
    }

    // Validate tool_use blocks in content (Claude format) before the ids are
    // read back out below.
    if (Array.isArray(msg.content)) {
      for (let k = 0; k < msg.content.length; k++) {
        const block = msg.content[k];
        if (block.type === "tool_use" && block.id && !TOOL_ID_PATTERN.test(block.id)) {
          const sanitized = sanitizeToolId(block.id);
          block.id = sanitized || generateToolCallId(i, k, block.name);
        }
      }
    }

    // An assistant turn opens a new set of tool calls waiting for results, and
    // ends whatever the previous one left open.
    if (msg.role === "assistant") {
      unanswered = getToolCallIds(msg);
      continue;
    }

    // Tool result, OpenAI shape (role: "tool")
    if (msg.role === "tool") {
      msg.tool_call_id = resolveToolResultId(msg.tool_call_id, unanswered, () => generateToolCallId(i, 0));
    }

    // Tool result, Claude shape (tool_result block in user content)
    if (Array.isArray(msg.content)) {
      for (let k = 0; k < msg.content.length; k++) {
        const block = msg.content[k];
        if (block.type === "tool_result") {
          block.tool_use_id = resolveToolResultId(block.tool_use_id, unanswered, () => generateToolCallId(i, k));
        }
      }
    }
  }

  return body;
}

// Get tool_call ids from assistant message (OpenAI format: tool_calls, Claude format: tool_use in content)
export function getToolCallIds(msg) {
  if (msg.role !== "assistant") return [];

  const ids = [];

  // OpenAI format: tool_calls array
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.id) ids.push(tc.id);
    }
  }

  // Claude format: tool_use blocks in content
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        ids.push(block.id);
      }
    }
  }

  return ids;
}

// Which of the given tool_call ids this message answers. Returns the ids
// rather than a boolean, because a turn with six calls answered by one result
// is not answered, and a boolean cannot say so.
export function toolResultIdsIn(msg, toolCallIds) {
  if (!msg || !toolCallIds.length) return [];

  // OpenAI format: role = "tool" with tool_call_id
  if (msg.role === "tool" && msg.tool_call_id) {
    return toolCallIds.includes(msg.tool_call_id) ? [msg.tool_call_id] : [];
  }

  // Claude format: tool_result blocks in user message content
  if (msg.role === "user" && Array.isArray(msg.content)) {
    const found = [];
    for (const block of msg.content) {
      if (block?.type === "tool_result" && toolCallIds.includes(block.tool_use_id)) {
        found.push(block.tool_use_id);
      }
    }
    return found;
  }

  return [];
}

// Check if a message answers ANY of the given ids. Kept for callers that only
// need the weaker question; the repair below asks the stronger one.
export function hasToolResults(msg, toolCallIds) {
  return toolResultIdsIn(msg, toolCallIds).length > 0;
}

// Fix missing tool responses - insert empty tool_result if assistant has tool_use but next message has no tool_result
export function fixMissingToolResponses(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  const newMessages = [];

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];

    newMessages.push(msg);

    // Check if this is assistant with tool_calls/tool_use
    const toolCallIds = getToolCallIds(msg);
    if (toolCallIds.length === 0) continue;

    // Results for one turn commonly span several consecutive messages, one per
    // call, so the whole run is scanned. Looking only at messages[i + 1] both
    // missed answers that came later and, when the first answer was not
    // adjacent, injected duplicates for calls that were already answered.
    const answered = new Set();
    for (let j = i + 1; j < body.messages.length; j++) {
      const ids = toolResultIdsIn(body.messages[j], toolCallIds);
      if (ids.length === 0) break;
      for (const id of ids) answered.add(id);
    }

    // Every call needs its own answer. Stopping at the first match left an
    // assistant turn with six calls and one result looking satisfied, and the
    // upstream rejected the request for the five that were never answered.
    const missing = toolCallIds.filter((id) => !answered.has(id));
    if (missing.length === 0) continue;
    if (answered.size === 0 && !body.messages[i + 1]) continue;

    // Repair in the turn's own shape. Splicing an OpenAI role:"tool" message
    // into a Claude body produced something formats/claude.js drops on the
    // floor, leaving the tool_use as unanswered as before.
    const usesClaudeBlocks = Array.isArray(msg.content)
      && msg.content.some((block) => block?.type === "tool_use");

    if (usesClaudeBlocks) {
      const blocks = missing.map((id) => ({ type: "tool_result", tool_use_id: id, content: "" }));
      // Claude wants the results of one turn in a single user message, so they
      // join the existing one rather than opening a second user turn beside it.
      const existing = body.messages[i + 1];
      if (existing?.role === "user" && Array.isArray(existing.content)
          && toolResultIdsIn(existing, toolCallIds).length > 0) {
        existing.content.unshift(...blocks);
      } else {
        newMessages.push({ role: "user", content: blocks });
      }
    } else {
      for (const id of missing) {
        newMessages.push({ role: "tool", tool_call_id: id, content: "" });
      }
    }
  }

  body.messages = newMessages;
  return body;
}


// A tool result carries the id of the call it answers. History truncation and
// context compaction routinely drop the assistant turn that asked, leaving the
// answer behind, and a replayed history can carry the same answer twice. Every
// upstream rejects both: OpenAI with "messages with role 'tool' must be a
// response to a preceding message with 'tool_calls'", Anthropic with
// "unexpected `tool_result` block(s)". Gemini is worse — openai-to-gemini.js
// emits functionResponse only from the assistant's tool_calls, so an orphan is
// dropped on the floor and the content is simply gone.
//
// Salvage rather than delete. What the tool returned is real context the model
// still needs, so it becomes `[Tool result: ...]` text on a user turn, which
// every target format can carry. Kiro already does this in its own shape
// (concerns/kiroConversation.js), and this is the same contract for the
// message-shaped formats.
const SALVAGE_TEXT = "text";

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part?.type === SALVAGE_TEXT ? part.text : "")))
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

// An image-only result has nothing a user text turn can carry, so it is the one
// case that is dropped rather than salvaged (#2122 owns the matched-image case).
function salvageText(content) {
  const text = toolResultText(content).trim();
  return text ? `[Tool result: ${text}]` : "";
}

function asBlocks(content) {
  if (Array.isArray(content)) return content;
  const text = typeof content === "string" ? content : toolResultText(content);
  return text ? [{ type: SALVAGE_TEXT, text }] : [];
}

// Two user turns in a row are rejected by Claude and collapsed by Gemini, so a
// salvaged result merges into the user turn beside it instead of opening one.
function mergeUserTurns(messages, salvaged) {
  const out = [];
  for (const msg of messages) {
    const last = out[out.length - 1];
    const joinable = last?.role === "user" && msg.role === "user"
      && (salvaged.has(last) || salvaged.has(msg));
    if (!joinable) {
      out.push(msg);
      continue;
    }
    if (typeof last.content === "string" && typeof msg.content === "string") {
      last.content = last.content ? `${last.content}\n${msg.content}` : msg.content;
    } else {
      last.content = [...asBlocks(last.content), ...asBlocks(msg.content)];
    }
    if (salvaged.has(msg)) salvaged.add(last);
  }
  return out;
}

export function repairOrphanToolResults(body) {
  if (!Array.isArray(body?.messages)) return body;

  const callIds = new Set();
  for (const msg of body.messages) {
    for (const id of getToolCallIds(msg)) callIds.add(id);
  }

  const answered = new Set();
  // First real answer wins; a repeat of the same id is a duplicate, which is as
  // invalid as an orphan and is salvaged the same way.
  const claim = (id) => {
    if (!id || !callIds.has(id) || answered.has(id)) return false;
    answered.add(id);
    return true;
  };

  const salvaged = new Set();
  const out = [];
  let repaired = 0;

  for (const msg of body.messages) {
    // OpenAI shape: a whole message is the result.
    if (msg.role === "tool") {
      if (claim(msg.tool_call_id)) {
        out.push(msg);
        continue;
      }
      repaired++;
      const text = salvageText(msg.content);
      if (!text) continue;
      const turn = { role: "user", content: text };
      salvaged.add(turn);
      out.push(turn);
      continue;
    }

    // Claude shape: tool_result blocks inside a user turn, beside other content.
    if (Array.isArray(msg.content) && msg.content.some((b) => b?.type === "tool_result")) {
      const kept = [];
      const rescued = [];
      for (const block of msg.content) {
        if (block?.type !== "tool_result") {
          kept.push(block);
          continue;
        }
        if (claim(block.tool_use_id)) {
          kept.push(block);
          continue;
        }
        repaired++;
        const text = salvageText(block.content);
        if (text) rescued.push({ type: SALVAGE_TEXT, text });
      }
      if (kept.length === 0 && rescued.length === 0) continue;
      msg.content = [...kept, ...rescued];
      if (rescued.length > 0) salvaged.add(msg);
      out.push(msg);
      continue;
    }

    out.push(msg);
  }

  if (repaired === 0) return body;

  body.messages = mergeUserTurns(out, salvaged);
  return body;
}

// Anthropic's tool schema requires an explicit `type`; strict gateways (MiniMax's
// Anthropic-compatible endpoint, error 2013) reject a payload that omits it with
// HTTP 400. Tools carrying a truthy type (computer_20250124, bash_20250124,
// web_search_20250305, …) are returned by identity and never rewritten.
//
// Spread order is load-bearing: `{ ...tool, type: "custom" }` overrides a falsy
// `type: null` the client sent, where `{ type: "custom", ...tool }` would let it
// survive and 400 again.
export function defaultClaudeToolType(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => (tool?.type ? tool : { ...tool, type: TOOL_TYPE.CUSTOM }));
}

// Accumulate one tool call's `arguments` across streamed chunks.
//
// Three provider behaviours arrive on the same field and a blind `+=` is only
// correct for the first:
//
//   - DELTA      — each chunk carries the next slice. Append.
//   - CUMULATIVE — each chunk restates everything so far. A chunk that has the
//                  buffer as its own prefix is a restatement, so replace.
//   - REPLAY     — the terminal chunk repeats the complete object a second
//                  time, giving `{...}{...}`. Neither append nor prefix test
//                  catches it, because the restatement is not a prefix of the
//                  doubled string it produces.
//
// The replay case is the reason for the halving loop: an even-length buffer
// whose two halves are identical AND whose first half parses as JSON is one
// object sent twice, so keep one copy. Parsing is what makes it safe — two
// legitimately identical argument slices that do not form valid JSON on their
// own are left alone. Looped, because a provider that replays twice doubles
// twice.
//
// Without this a Claude client receives `{...}{...}` in the single
// input_json_delta, rejects the tool call as unparseable, and the turn is lost
// against an upstream that answered 200.
export function mergeToolArguments(previous, fragment) {
  const prev = previous || "";
  const next = typeof fragment === "string" ? fragment : "";
  let merged = prev && next.length > prev.length && next.startsWith(prev) ? next : prev + next;

  while (merged.length > 0 && merged.length % 2 === 0) {
    const half = merged.slice(0, merged.length / 2);
    if (half !== merged.slice(merged.length / 2)) break;
    try {
      JSON.parse(half);
    } catch {
      break;
    }
    merged = half;
  }

  return merged;
}
