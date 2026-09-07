/**
 * Epoch-aligned compaction cascade (context-tuning suite, task 2).
 *
 * The cache epoch `ce` is how many leading bytes of this request's final body
 * are byte-identical to the session's previous final body (the region the
 * provider serves from cache). Every mutation inside that region costs a full
 * re-cache, so these stages may only touch messages BELOW the epoch cut.
 *
 * Epoch-cut rule (computeEpochCutIndex):
 *   - ce or prevBytes missing/non-finite → cut 0 (nothing is known to be
 *     divergent, so nothing may be mutated).
 *   - ce >= prevBytes * 0.5 (stable epoch) → cut 0 (no mutation at all).
 *   - otherwise cut = the index of the FIRST message whose cumulative
 *     serialized byte length exceeds ce. Messages 0..cut are treated as inside
 *     the shared prefix and are never mutated.
 *   Approximation note: ce is measured over the whole serialized body
 *   (system + tools + messages) while the walk counts message bytes only.
 *   system/tools are identical across a session's requests, so the error
 *   lands inside the shared prefix and can only make the cut MORE
 *   conservative (later), never earlier.
 *
 * Shape handling: written against the Anthropic-style messages array
 * (role + content blocks with tool_use/tool_result), tolerant of
 * OpenAI-style (role + content string, tool results as role:"tool").
 * Anything unrecognized is returned unchanged. Neither function mutates its
 * input; on change a new array is returned and every untouched entry is
 * shared by reference (pairDropper contract).
 *
 * Invariants (both functions):
 *   - never touch a message at or before epochCutIndex
 *   - never touch paired tool_use/tool_result structure (block count, order,
 *     tool_use_id linkage), the latest assistant turn (covered by the
 *     keepLastTurns tail), or cache_control markers
 */

import { ROLE, CLAUDE_BLOCK } from "../translator/schema/index.js";

const DEFAULT_MIN_BLOCK_CHARS = 500;
const DEFAULT_KEEP_LAST_TURNS = 4;
const EPOCH_AUTO_TRIGGER = 0.75;
const MAX_DIGEST_TOOLS = 10;
const MAX_DIGEST_PATHS = 12;

function unchanged(messages) {
  return { applied: false, messages, clearedBlocks: 0, clearedChars: 0 };
}

function stubText(n) {
  return `[cleared ${n} chars — re-run the command if needed]`;
}

/**
 * Index of the first mutable message, from a cache-epoch peek.
 * Returns 0 when the epoch is stable/unknown (i.e. nothing may mutate).
 */
export function computeEpochCutIndex(messages, { ce, prevBytes } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const ceN = Number(ce);
  const prevN = Number(prevBytes);
  if (!Number.isFinite(ceN) || !Number.isFinite(prevN) || prevN <= 0) return 0;
  // Stable epoch: half or more of the previous body still shares its prefix,
  // so the session's cache is healthy and no epoch mutation is justified.
  if (ceN >= prevN * 0.5) return 0;
  let cumulative = 0;
  for (let i = 0; i < messages.length; i++) {
    cumulative += Buffer.byteLength(JSON.stringify(messages[i]));
    if (cumulative > ceN) return i;
  }
  return 0;
}

// Char count of a block's payload: text for text blocks, content (string or
// gathered text parts) for tool_result blocks.
function blockChars(block) {
  if (typeof block?.text === "string") return block.text.length;
  const content = block?.content;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      if (typeof part?.text === "string") n += part.text.length;
      else if (typeof part === "string") n += part.length;
    }
    return n;
  }
  return 0;
}

// One message: returns [newMessageOrNull, clearedChars].
function stubMessage(msg, minChars) {
  if (!msg || typeof msg !== "object") return [null, 0];
  const role = msg.role;
  // OpenAI-style tool result: whole content string is the payload.
  if (role === ROLE.TOOL && typeof msg.content === "string") {
    if (msg.content.length >= minChars) {
      return [{ ...msg, content: stubText(msg.content.length) }, msg.content.length];
    }
    return [null, 0];
  }
  if (role !== ROLE.USER) return [null, 0];
  // OpenAI-style user turn.
  if (typeof msg.content === "string") {
    if (msg.content.length >= minChars) {
      return [{ ...msg, content: stubText(msg.content.length) }, msg.content.length];
    }
    return [null, 0];
  }
  if (!Array.isArray(msg.content)) return [null, 0];
  // Anthropic-style block array. tool_use blocks are never touched; text and
  // tool_result blocks below minBlockChars keep their reference; a block
  // carrying cache_control is left alone so anchor markers survive.
  let changed = false;
  let cleared = 0;
  const blocks = msg.content.map((block) => {
    if (!block || typeof block !== "object") return block;
    if (block.cache_control) return block;
    const isText = block.type === CLAUDE_BLOCK.TEXT && typeof block.text === "string";
    const isToolResult = block.type === CLAUDE_BLOCK.TOOL_RESULT;
    if (!isText && !isToolResult) return block;
    const n = blockChars(block);
    if (n < minChars) return block;
    changed = true;
    cleared += n;
    if (isText) return { ...block, text: stubText(n) };
    // tool_result: content (string or array) collapses to the stub string;
    // type/tool_use_id and block order are preserved.
    return { ...block, content: stubText(n) };
  });
  if (!changed) return [null, 0];
  return [{ ...msg, content: blocks }, cleared];
}

/**
 * Deterministic micro-compaction: replace eligible tool_result/user text
 * payloads with stub strings. No LLM call.
 *
 * Options:
 *   epochCutIndex  number  REQUIRED-ish; messages at or before this index
 *                  are never mutated. 0 (the default) leaves nothing mutable.
 *   minBlockChars  number  default 500; payloads shorter than this survive.
 *   keepLastTurns  number  default 4; the last N messages (including the
 *                  latest assistant turn) are never mutated.
 *
 * Returns { applied, messages, clearedBlocks, clearedChars }. messages is
 * the input reference when nothing was cleared.
 */
export function microcompact(body, options = {}) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return unchanged(messages);
  const cut = Math.max(0, Math.floor(Number(options.epochCutIndex) || 0));
  const minChars = Math.max(1, Math.floor(Number(options.minBlockChars) || DEFAULT_MIN_BLOCK_CHARS));
  const tail = Math.max(0, Math.floor(Number(options.keepLastTurns) || 0));
  // Mutable window: indices (cut, messages.length - tail). At/before the cut
  // is the cached epoch; the tail is the live recent turn.
  const lastMutable = messages.length - tail;
  if (cut + 1 >= lastMutable) return unchanged(messages);

  let clearedBlocks = 0;
  let clearedChars = 0;
  let any = false;
  const out = messages.map((msg, i) => {
    if (i <= cut || i >= lastMutable) return msg;
    const [stubbed, cleared] = stubMessage(msg, minChars);
    if (!stubbed) return msg;
    any = true;
    clearedBlocks += 1;
    clearedChars += cleared;
    return stubbed;
  });
  if (!any) return unchanged(messages);
  return { applied: true, messages: out, clearedBlocks, clearedChars };
}

/**
 * Window-triggered auto-compaction: at >= 75% of the model's context window,
 * the history between the epoch cut and the recent tail is dropped and
 * replaced by ONE synthetic user message carrying summarizeFn's summary.
 *
 * Options:
 *   windowTokens    number  REQUIRED; context window in tokens. Non-finite
 *                   or <= 0 disables the stage.
 *   usedTokens      number  REQUIRED; current occupancy estimate.
 *   summarizeFn     async (droppedMessages) => string. Injected in tests.
 *                   Production default (placeholderEpochSummarizer) makes NO
 *                   network call: it returns a deterministic digest.
 *   keepRecentTurns number  default 6; tail kept verbatim.
 *   epochCutIndex   number  default 0; messages at or before it survive.
 *
 * Returns { applied, messages, droppedTurns, summary }. messages is the
 * input reference when the trigger is not met or there is nothing to drop.
 */
export async function autocompact(body, options = {}) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return unchanged(messages);
  const window = Number(options.windowTokens);
  if (!Number.isFinite(window) || window <= 0) return unchanged(messages);
  const used = Number(options.usedTokens);
  if (!Number.isFinite(used) || used < window * EPOCH_AUTO_TRIGGER) return unchanged(messages);

  const cut = Math.max(0, Math.floor(Number(options.epochCutIndex) || 0));
  const keep = Math.max(1, Math.floor(Number(options.keepRecentTurns) || 6));
  const tailStart = Math.max(cut + 1, messages.length - keep);
  const droppedTurns = tailStart - (cut + 1);
  if (droppedTurns <= 0) return unchanged(messages);

  const dropped = messages.slice(cut + 1, tailStart);
  const summarizeFn = options.summarizeFn || placeholderEpochSummarizer;
  let summary;
  try {
    summary = await summarizeFn(dropped);
  } catch {
    return unchanged(messages); // fail closed: never drop turns without a summary
  }
  if (typeof summary !== "string" || !summary.trim()) return unchanged(messages);

  const note = {
    role: ROLE.USER,
    content: `## Session summary (auto-compacted)\n${summary}`,
  };
  const out = [...messages.slice(0, cut + 1), note, ...messages.slice(tailStart)];
  return { applied: true, messages: out, droppedTurns, summary };
}

/**
 * Production default summarizer — deterministic digest, NO network call.
 * Extracts turn count, tool names, and file paths seen from the dropped
 * turns. FOLLOW-UP SEAM: replace the body of this function with a cheap-model
 * provider call (batched, timeout-bounded, fail-closed to "no summary") when
 * quota-aware wiring lands; the signature (messages) => string is the seam.
 */
export function placeholderEpochSummarizer(droppedMessages) {
  let turns = 0;
  const toolNames = new Set();
  const paths = new Set();
  const PATH_RE = /\b[\w][\w./-]*\.[A-Za-z0-9]{1,8}\b/g;
  const MAX_DEPTH = 24;
  const walk = (value, depth) => {
    if (value === null || value === undefined || depth > MAX_DEPTH) return;
    if (typeof value === "string") {
      for (const m of value.matchAll(PATH_RE)) {
        if (paths.size < MAX_DIGEST_PATHS) paths.add(m[0]);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      if (value.type === CLAUDE_BLOCK.TOOL_USE && typeof value.name === "string") {
        if (toolNames.size < MAX_DIGEST_TOOLS) toolNames.add(value.name);
      }
      for (const key of Object.keys(value)) walk(value[key], depth + 1);
    }
  };
  for (const msg of droppedMessages || []) {
    turns += 1;
    walk(msg?.content, 0);
  }
  const lines = [`Turns dropped: ${turns}`];
  if (toolNames.size > 0) lines.push(`Tools used: ${[...toolNames].sort().join(", ")}`);
  if (paths.size > 0) lines.push(`Files seen: ${[...paths].sort().join(", ")}`);
  return lines.join("\n");
}
