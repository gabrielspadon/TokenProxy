import { stageErrorCode } from "./stageOutcome.js";
// Embedding-based reordering of historical chat turns (#token-savers).
//
// Within the movable region before the kept-recent tail, whole text-only
// user/assistant turns are reordered by cosine similarity to the current
// user query, most relevant nearest to the tail boundary. Tool-bearing
// entries are pinned anchors: they split the historical region into
// independent segments that are each reordered on their own.
//
// Fail-open, same contract as open-sse/rtk: any embedding failure returns
// the input untouched with an error reason rather than breaking the request.

import { createHash } from "node:crypto";
import { textKey } from "../services/memory/sessionMemo.js";
import { preparationSignal, waitForPreparation } from "./preparationAbort.js";

const CACHE_MAX = 512;
const internalCache = new Map(); // module-level LRU, first-key eviction

const BLOCKED_KEYS = new Set([
  "tool_use",
  "tool_result",
  "function_call",
  "function_call_output",
]);
const ALLOWED_BLOCK_TYPES = new Set(["text", "thinking", "redacted_thinking"]);
const ALNUM_RE = /[a-z0-9]+/gi;

// The endpoint is part of the key, not just the model name: two services can
// answer to the same model identifier with different weights, and an operator
// who repoints the embedding URL must not be served vectors the previous
// service produced.
function cacheKey(embedUrl, model, text) {
  return createHash("sha256").update(`${embedUrl}\u0000${model}\u0000${text}`).digest("hex");
}

function cacheGet(cache, key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  // refresh LRU order
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function isTextOnly(entry) {
  const role = entry && entry.role;
  if (role !== "user" && role !== "assistant") return false;
  const content = entry.content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (!block || typeof block !== "object") return false;
    if (BLOCKED_KEYS.has(block.type)) return false;
    if (!ALLOWED_BLOCK_TYPES.has(block.type)) return false;
  }
  return true;
}

function extractText(entry) {
  const content = entry.content;
  if (typeof content === "string") return content;
  const parts = [];
  for (const block of content) {
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function failOpen(messages, reason) {
  return { messages, moved: 0, notes: [], error: reason, outcome: "skipped", errorCode: null };
}

async function fetchEmbeddings({ embedUrl, embedModel, input, timeoutMs, signal }) {
  signal?.throwIfAborted();
  const deadline = preparationSignal(signal, timeoutMs);
  const res = await waitForPreparation(fetch(embedUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: embedModel, input }),
    signal: deadline,
  }), deadline, late => late.body?.cancel());
  let body;
  try {
    if (!res.ok) throw Object.assign(new Error("embed http error"), { code: "service_http_error" });
    body = await waitForPreparation(res.json(), deadline);
    deadline.throwIfAborted();
  } finally {
    try { await res.body?.cancel(); } catch { /* already consumed or aborted */ }
  }
  if (!body || !Array.isArray(body.data)) throw Object.assign(new Error("embed malformed response"), { code: "invalid_response" });
  const sorted = [...body.data];
  if (sorted.some((d) => d && typeof d.index === "number")) {
    sorted.sort((x, y) => (x.index || 0) - (y.index || 0));
  }
  const out = sorted.map((d) => {
    if (!d || !Array.isArray(d.embedding)) throw Object.assign(new Error("embed malformed entry"), { code: "invalid_response" });
    return d.embedding;
  });
  if (out.length !== input.length) throw Object.assign(new Error("embed count mismatch"), { code: "invalid_response" });
  const dim = out[0] ? out[0].length : 0;
  if (out.some((e) => !e.length || e.length !== dim || e.some(value => typeof value !== "number" || !Number.isFinite(value)))) {
    throw Object.assign(new Error("embed dimension mismatch"), { code: "invalid_response" });
  }
  if (out.some((e) => e.every((v) => v === 0))) {
    throw Object.assign(new Error("embed zero vector"), { code: "invalid_response" });
  }
  return out;
}

// A movable unit is a user entry followed by the assistant entry that
// answered it, both text-only. Reordering whole pairs keeps the roles
// alternating and every question next to its answer; reordering single
// entries did neither (measured: consecutive same-role entries at three
// positions of an eight-turn history, and a user turn placed after its own
// answer).
function collectPairs(messages, histLen) {
  const pairs = [];
  for (let i = 0; i + 1 < histLen; i++) {
    if (messages[i]?.role !== "user" || messages[i + 1]?.role !== "assistant") continue;
    if (!isTextOnly(messages[i]) || !isTextOnly(messages[i + 1])) continue;
    pairs.push({ start: i, key: textKey(extractText(messages[i]) + "\u0000" + extractText(messages[i + 1])) });
    i += 1;
  }
  return pairs;
}

// Runs of consecutive pairs (a run breaks at any entry that is not part of a
// movable pair). Each run is permuted on its own.
function runsOf(pairs) {
  const runs = [];
  let run = null;
  for (const p of pairs) {
    if (run && run[run.length - 1].start + 2 === p.start) run.push(p);
    else { run = [p]; runs.push(run); }
  }
  return runs.filter((r) => r.length >= 2);
}

function applyOrder(messages, runs, orderFor) {
  const out = messages.slice();
  let moved = 0;
  for (const run of runs) {
    const ordered = orderFor(run);
    for (let p = 0; p < run.length; p++) {
      const slot = run[p];
      const src = ordered[p];
      out[slot.start] = messages[src.start];
      out[slot.start + 1] = messages[src.start + 1];
      if (src.start !== slot.start) moved += 1;
    }
  }
  return { out, moved };
}

/**
 * Reorder historical user/assistant pairs by relevance to the query.
 *
 * Any permutation of the prefix rewrites the provider's cached prompt, so
 * this is only ever cache-neutral when it is REPLAYED identically on later
 * turns. `options.memo` (an object the caller keeps per session) holds the
 * pair order chosen the last time an embedding pass ran; with `recompute`
 * false the memoised order is applied to the pairs that still exist and any
 * pair the memo does not know keeps its chronological place. With
 * `recompute` true (the caller passes it on a turn whose prefix is being
 * rewritten anyway) a fresh embedding pass decides the order and the memo is
 * replaced. Without a memo every call recomputes, as before.
 */
export async function reorderByRelevance(messages, options = {}) {
  options.signal?.throwIfAborted();
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, moved: 0, notes: [] };
  }
  const { query, embedUrl, embedModel } = options;
  const memo = options.memo && typeof options.memo === "object" ? options.memo : null;
  const recompute = memo ? options.recompute === true : true;
  const keepRecentTurns = Number.isFinite(options.keepRecentTurns)
    ? Math.max(0, Math.floor(options.keepRecentTurns))
    : 2;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 4000;
  const cache = options.cache instanceof Map ? options.cache : internalCache;

  const tailLen = Math.min(keepRecentTurns, messages.length);
  let histLen = messages.length - tailLen;
  // Never split a pair on the tail boundary: when the protected tail starts
  // at the assistant half of a text-only pair, that pair is whole and
  // historical. The final user turn is always in the tail regardless.
  if (
    histLen > 0 && histLen < messages.length - 1 &&
    messages[histLen]?.role === "assistant" && messages[histLen - 1]?.role === "user" &&
    isTextOnly(messages[histLen]) && isTextOnly(messages[histLen - 1])
  ) histLen += 1;
  const runs = runsOf(collectPairs(messages, histLen));
  if (runs.length === 0) return { messages, moved: 0, notes: [] };

  // Replay: the memoised rank of a pair decides its place; unknown pairs
  // rank after every known one, in their original order.
  if (!recompute) {
    const rank = new Map((memo.order || []).map((k, i) => [k, i]));
    if (rank.size === 0) return { messages, moved: 0, notes: [] };
    const { out, moved } = applyOrder(messages, runs, (run) =>
      run
        .map((p) => ({ p, r: rank.has(p.key) ? rank.get(p.key) : Infinity }))
        .sort((a, b) => a.r - b.r || a.p.start - b.p.start)
        .map((x) => x.p));
    return moved === 0 ? { messages, moved: 0, notes: [] } : { messages: out, moved, notes: [], replayed: true };
  }

  if (
    typeof query !== "string" ||
    !query.trim() ||
    typeof embedUrl !== "string" ||
    !embedUrl ||
    typeof embedModel !== "string" ||
    !embedModel
  ) {
    return failOpen(messages, "missing required options");
  }
  const terms = query.match(ALNUM_RE);
  if (!terms || terms.length < 3) {
    return { messages, moved: 0, notes: [] };
  }

  const allPairs = runs.flat();
  const texts = allPairs.map((p) => extractText(messages[p.start]) + "\n" + extractText(messages[p.start + 1]));

  const queryKey = cacheKey(embedUrl, embedModel, query);
  const textKeys = texts.map((t) => cacheKey(embedUrl, embedModel, t));
  let queryVec = cacheGet(cache, queryKey);
  const textVecs = textKeys.map((k) => cacheGet(cache, k));
  const missTextIdx = [];
  textVecs.forEach((v, i) => {
    if (v === undefined) missTextIdx.push(i);
  });
  if (queryVec === undefined || missTextIdx.length > 0) {
    const batch = [];
    const slots = [];
    if (queryVec === undefined) {
      slots.push({ key: queryKey, kind: "query" });
      batch.push(query);
    }
    for (const i of missTextIdx) {
      slots.push({ key: textKeys[i], kind: "text", idx: i });
      batch.push(texts[i]);
    }
    let embeddings;
    try {
      embeddings = await fetchEmbeddings({ embedUrl, embedModel, input: batch, timeoutMs, signal: options.signal });
    } catch (err) {
      options.signal?.throwIfAborted();
      return { ...failOpen(messages, stageErrorCode(err)), outcome: "failed", errorCode: stageErrorCode(err) };
    }
    options.signal?.throwIfAborted();
    for (let s = 0; s < slots.length; s++) {
      cacheSet(cache, slots[s].key, embeddings[s]);
      if (slots[s].kind === "query") queryVec = embeddings[s];
      else textVecs[slots[s].idx] = embeddings[s];
    }
  }

  const sim = new Map();
  for (let i = 0; i < allPairs.length; i++) sim.set(allPairs[i].key, cosine(queryVec, textVecs[i]));

  // Within a run, similarity is non-decreasing head to tail so the most
  // relevant pair ends nearest the tail boundary; ties keep original order.
  const movedInfo = [];
  const { out, moved } = applyOrder(messages, runs, (run) => {
    const ordered = run
      .map((p) => ({ p, s: sim.get(p.key) }))
      .sort((a, b) => a.s - b.s || a.p.start - b.p.start)
      .map((x) => x.p);
    for (let i = 0; i < run.length; i++) {
      if (ordered[i].start !== run[i].start) movedInfo.push({ idx: run[i].start, sim: sim.get(ordered[i].key) });
    }
    return ordered;
  });
  if (memo) memo.order = [...sim.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
  if (moved === 0) return { messages, moved: 0, notes: [] };

  movedInfo.sort((a, b) => b.sim - a.sim || a.idx - b.idx);
  const notes = movedInfo.slice(0, 5).map((m) => ({
    turn: m.idx,
    similarity: Math.round(m.sim * 10000) / 10000,
  }));
  if (movedInfo.length > 5) notes.push({ notesTruncated: true });
  return { messages: out, moved, notes };
}
