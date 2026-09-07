/**
 * AgentDiet-style expired tool-result pruning (context-tuning suite, task 3).
 *
 * Old tool_result payloads are the fattest dead weight in a long agent
 * session: the model already acted on them, and nothing below the recent tail
 * re-reads them. This stage stubs qualifying tool_result payloads while
 * leaving the tool_use/tool_result pair structure (block count, order, id
 * linkage) untouched, so no provider validation can fail on a missing partner.
 *
 * A block is PRUNABLE only when every gate passes:
 *   epoch        message index > epochCutIndex (never at or before the cut;
 *                cut 0 = stable/unknown epoch = skip the stage entirely)
 *   age          at least minAgeTurns assistant turns have passed since the
 *                block (assistant turns counted, not raw messages)
 *   size         payload >= minBlockChars
 *   reference    no verbatim reuse: none of the last referenceScanTurns
 *                assistant turns (all of which are, per construction, within
 *                the global last referenceScanTurns assistant turns) contains
 *                a >=64-char verbatim substring of the payload or mentions the
 *                block's tool_use id
 *   trace        not an error trace (payload matches /error|traceback|
 *                exception|failed/i while the tool reported is_error)
 *   diff         payload carries no diff hunks (line starting @@ or
 *                "diff --git") — hunks are how the model re-reads old edits
 *   recency      not owned by the most recent assistant turn
 *   marker       block carries no cache_control anchor
 *
 * Redundancy: identical payloads (sha256 of extracted text) form a group;
 * the newest member is the retained copy, older members are prunable with a
 * stub that names the turn keeping the verbatim copy. A singleton group
 * prunes with the plain expired stub.
 *
 * Shape handling: Anthropic-style block arrays and OpenAI-style role:"tool"
 * string messages; anything unrecognized is left alone. Input is never
 * mutated; untouched entries are shared by reference.
 */

import { createHash } from "node:crypto";
import { ROLE, CLAUDE_BLOCK } from "../translator/schema/index.js";

const DEFAULT_MIN_AGE_TURNS = 8;
const DEFAULT_MIN_BLOCK_CHARS = 2048;
const DEFAULT_REFERENCE_SCAN_TURNS = 3;
const VERBATIM_MIN_CHARS = 64;
const ERROR_TRACE_RE = /error|traceback|exception|failed/i;
const DIFF_HUNK_RE = /^(?:@@|diff --git)/m;

function unchanged(messages, skip) {
  const out = { applied: false, messages, prunedBlocks: 0, prunedChars: 0 };
  if (skip) out.skip = skip;
  return out;
}

function expiredStub(n) {
  return `[pruned: ${n} chars — expired]`;
}

function duplicateStub(n, turn) {
  return `[pruned: ${n} chars, identical copy retained in turn ${turn}]`;
}

// Extracted payload text of a tool_result block / tool message: string
// content, or concatenated text parts of an array content.
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (typeof part === "string") text += part;
    else if (typeof part?.text === "string") text += part.text;
  }
  return text;
}

function contentChars(content) {
  return extractText(content).length;
}

// Text of an assistant message for the reference scan: string content or
// concatenated text blocks. tool_use inputs are not scanned (the verbatim
// gate targets prose the model wrote about a result, not the call args).
function assistantText(msg) {
  return extractText(msg?.content);
}

// Assistant-turn ordinal at message index i (1-based): the count of assistant
// messages up to and including i, plus one. Used only for the duplicate stub.
function turnOrdinal(messages, i) {
  let n = 1;
  for (let j = 0; j <= i; j++) {
    if (messages[j]?.role === ROLE.ASSISTANT) n++;
  }
  return n;
}

/**
 * Prune expired tool_result payloads to stubs. Deterministic, no LLM call.
 *
 * Options:
 *   epochCutIndex        number  REQUIRED-ish; messages at or before this
 *                        index are never mutated. 0 (the default) skips the
 *                        stage: nothing is known to be outside the shared
 *                        prefix, so nothing may mutate.
 *   minAgeTurns          number  default 8; assistant turns that must have
 *                        passed after the block's message before it qualifies.
 *   minBlockChars        number  default 2048; payloads shorter than this
 *                        survive (small results are cheaper kept than stubbed).
 *   referenceScanTurns   number  default 3; how many trailing assistant turns
 *                        the verbatim/id reference scan covers.
 *
 * Returns { applied, messages, prunedBlocks, prunedChars }. messages is the
 * input reference when nothing was pruned.
 */
export function pruneExpiredToolResults(body, options = {}) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return unchanged(messages, "invalid_input");
  const cut = Math.max(0, Math.floor(Number(options.epochCutIndex) || 0));
  if (cut === 0) return unchanged(messages, "epoch_boundary");
  const minAgeTurns = Math.max(0, Math.floor(Number(options.minAgeTurns) || DEFAULT_MIN_AGE_TURNS));
  const minBlockChars = Math.max(1, Math.floor(Number(options.minBlockChars) || DEFAULT_MIN_BLOCK_CHARS));
  const scanTurns = Math.max(1, Math.floor(Number(options.referenceScanTurns) || DEFAULT_REFERENCE_SCAN_TURNS));

  // tool_use ids owned by the most recent assistant turn: their tool_results
  // are the live working set, never pruned.
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === ROLE.ASSISTANT) {
      lastAssistantIndex = i;
      break;
    }
  }
  const recentToolUseIds = new Set();
  if (lastAssistantIndex >= 0) {
    const tail = messages[lastAssistantIndex];
    if (Array.isArray(tail.tool_calls)) {
      for (const call of tail.tool_calls) {
        if (typeof call?.id === "string") recentToolUseIds.add(call.id);
      }
    }
    if (Array.isArray(tail.content)) {
      for (const block of tail.content) {
        if (block?.type === CLAUDE_BLOCK.TOOL_USE && typeof block.id === "string") {
          recentToolUseIds.add(block.id);
        }
      }
    }
  }

  // Reference context: the last scanTurns assistant turns of the whole array.
  // Any per-candidate "assistant turns after the block" window is a subset of
  // this (its k-th largest element cannot fall outside the global top-k), so
  // one shared context is exact, not an approximation.
  const contextTexts = [];
  for (let i = messages.length - 1; i >= 0 && contextTexts.length < scanTurns; i--) {
    if (messages[i]?.role !== ROLE.ASSISTANT) continue;
    contextTexts.push(assistantText(messages[i]));
  }
  const contextAll = contextTexts.join("\n");
  const contextWindows = new Set();
  if (contextAll.length >= VERBATIM_MIN_CHARS) {
    for (let i = 0; i + VERBATIM_MIN_CHARS <= contextAll.length; i++) {
      contextWindows.add(contextAll.slice(i, i + VERBATIM_MIN_CHARS));
    }
  }
  const isReferenced = (text, toolUseId) => {
    if (typeof toolUseId === "string" && toolUseId && contextAll.includes(toolUseId)) return true;
    if (text.length < VERBATIM_MIN_CHARS || contextWindows.size === 0) return false;
    for (let i = 0; i + VERBATIM_MIN_CHARS <= text.length; i++) {
      if (contextWindows.has(text.slice(i, i + VERBATIM_MIN_CHARS))) return true;
    }
    return false;
  };

  // Candidate collection. A candidate is {i, blockIndex|null, toolUseId,
  // text, chars, isError, hash}; blockIndex null = whole-message OpenAI tool.
  const candidates = [];
  messages.forEach((msg, i) => {
    if (i <= cut || !msg || typeof msg !== "object") return;
    if (msg.role === ROLE.TOOL && typeof msg.content === "string") {
      const text = msg.content;
      if (text.length >= minBlockChars) {
        candidates.push({
          i, blockIndex: null, toolUseId: msg.tool_call_id, text,
          chars: text.length, isError: msg.is_error === true,
        });
      }
      return;
    }
    if (msg.role !== ROLE.USER || !Array.isArray(msg.content)) return;
    msg.content.forEach((block, blockIndex) => {
      if (!block || typeof block !== "object") return;
      if (block.type !== CLAUDE_BLOCK.TOOL_RESULT) return;
      if (block.cache_control) return;
      const text = extractText(block.content);
      if (text.length < minBlockChars) return;
      candidates.push({
        i, blockIndex, toolUseId: block.tool_use_id, text,
        chars: text.length, isError: block.is_error === true,
      });
    });
  });

  // Eligibility gates (epoch/age/size already applied during collection).
  const eligible = candidates.filter((c) => {
    if (recentToolUseIds.has(c.toolUseId)) return false;
    if (c.isError && ERROR_TRACE_RE.test(c.text)) return false;
    if (DIFF_HUNK_RE.test(c.text)) return false;
    if (isReferenced(c.text, c.toolUseId)) return false;
    // Age: at least minAgeTurns assistant turns after the block's message.
    let after = 0;
    for (let j = c.i + 1; j < messages.length; j++) {
      if (messages[j]?.role === ROLE.ASSISTANT) after++;
    }
    return after >= minAgeTurns;
  });

  // Redundancy grouping by content hash. Singletons prune as expired; groups
  // keep the newest member verbatim and prune the rest as duplicates.
  const groups = new Map();
  for (const c of eligible) {
    const hash = createHash("sha256").update(c.text).digest("base64");
    const group = groups.get(hash);
    if (group) group.push(c);
    else groups.set(hash, [c]);
  }
  const prunable = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      prunable.push({ c: group[0], stub: expiredStub(group[0].chars) });
      continue;
    }
    let newest = group[0];
    for (const c of group) {
      if (c.i > newest.i || (c.i === newest.i && (c.blockIndex ?? -1) > (newest.blockIndex ?? -1))) newest = c;
    }
    const turn = turnOrdinal(messages, newest.i);
    for (const c of group) {
      if (c === newest) continue;
      prunable.push({ c, stub: duplicateStub(c.chars, turn) });
    }
  }
  if (prunable.length === 0) return unchanged(messages);

  // Apply: stub payloads in place; pair structure (message count, block count,
  // order, ids) is never altered, only tool_result payload content.
  const stubByKey = new Map();
  for (const { c, stub } of prunable) stubByKey.set(`${c.i}:${c.blockIndex ?? -1}`, stub);
  let prunedBlocks = 0;
  let prunedChars = 0;
  const out = messages.map((msg, i) => {
    if (i <= cut || !msg || typeof msg !== "object") return msg;
    if (msg.role === ROLE.TOOL && typeof msg.content === "string") {
      const stub = stubByKey.get(`${i}:-1`);
      if (!stub) return msg;
      prunedBlocks += 1;
      prunedChars += msg.content.length;
      return { ...msg, content: stub };
    }
    if (msg.role !== ROLE.USER || !Array.isArray(msg.content)) return msg;
    let changed = false;
    const blocks = msg.content.map((block, blockIndex) => {
      const stub = stubByKey.get(`${i}:${blockIndex}`);
      if (!stub || !block || typeof block !== "object") return block;
      changed = true;
      prunedBlocks += 1;
      prunedChars += extractText(block.content).length;
      return { ...block, content: stub };
    });
    return changed ? { ...msg, content: blocks } : msg;
  });
  return { applied: true, messages: out, prunedBlocks, prunedChars };
}
