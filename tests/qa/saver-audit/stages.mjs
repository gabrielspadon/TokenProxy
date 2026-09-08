// Stage table for the token-saver audit. Each stage wraps the SAME module
// chatCore calls, with the same options chatCore passes, so a permutation here
// is a faithful re-ordering of the production pipeline. The pipeline runner
// serializes the body after each stage to attribute byte deltas, computes
// the cache-order string (tools, system, messages: the order Anthropic hashes
// a prefix in) and the invariants a Claude request has to keep.

import { dedupeTools } from "../../../open-sse/utils/toolDeduper.js";
import { toolFilter } from "../../../open-sse/utils/toolFilter.js";
import { disclosureTools } from "../../../open-sse/utils/toolDisclosure.js";
import { distillToolSchemas } from "../../../open-sse/utils/schemaDistiller.js";
import { stripHistoricalThinking } from "../../../open-sse/utils/thinkingStrip.js";
import { compressPrefixByQuery } from "../../../open-sse/utils/queryAwareCompress.js";
import { dropOldestPairs } from "../../../open-sse/utils/pairDropper.js";
import { reorderByRelevance } from "../../../open-sse/utils/embedReorder.js";
import { injectBoundaryNote, composeBoundaryNote } from "../../../open-sse/utils/midPrefixInject.js";
import { compressWithHeadroom } from "../../../open-sse/rtk/headroom.js";
import { compressWithPxpipe } from "../../../open-sse/rtk/pxpipe.js";
import { pruneExpiredToolResults } from "../../../open-sse/utils/dietPrune.js";
import { compressBlobs } from "../../../open-sse/utils/linguaCompress.js";
import { microcompact, autocompact, placeholderEpochSummarizer } from "../../../open-sse/utils/epochCompact.js";
import { jsonCompact } from "../../../open-sse/rtk/filters/jsonCompact.js";
import { isErrorResult } from "../../../open-sse/rtk/errorFlags.js";
import { compressMessages } from "../../../open-sse/rtk/index.js";
import { injectCaveman } from "../../../open-sse/rtk/caveman.js";
import { injectPonytail } from "../../../open-sse/rtk/ponytail.js";
import { redactOutbound } from "../../../open-sse/utils/privacyFilter.js";
import { applyMemoryEnhancements } from "../../../open-sse/services/memory/index.js";
import { injectHandoffPackets } from "../../../open-sse/services/memory/handoffStore.js";
import { measureContextPressure, estimateRequestTokens } from "../../../open-sse/services/memory/contextBudget.js";
import { anchorClaudeCache } from "../../../open-sse/translator/formats/claude.js";
import { defaultClaudeToolType } from "../../../open-sse/translator/concerns/toolCall.js";
import { ELIDE_MARKER_RE } from "../../../open-sse/rtk/filters/elide.js";

// The production order after the audit: deterministic stages, then the
// pressure rungs least-loss first, then the tail note.
export const CANONICAL_ORDER = [
  "tools", "schema", "thinking", "rtk", "privacy", "inject", "pxpipe",
  "mem", "headroom", "qac", "pairs", "diet", "lingua", "epochMicro", "epochAuto", "reorder", "midinject", "handoff",
];

// Per-session memos, keyed the way chatCore keys them (one per session).
const QAC_MEMO = new Map();
const REORDER_MEMO = new Map();
function memoFor(map, key, init) {
  if (!map.has(key)) map.set(key, init());
  return map.get(key);
}

const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

function lastUserQuery(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
      if (text.trim()) return text;
    }
    return "";
  }
  return "";
}

// Deterministic bag-of-words "embedding" standing in for the local embed
// server reorder calls over HTTP. Same text -> same vector, always.
function mockEmbed(text) {
  const v = new Array(48).fill(0);
  for (const term of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
    let h = 2166136261;
    for (let i = 0; i < term.length; i++) h = Math.imul(h ^ term.charCodeAt(i), 16777619) >>> 0;
    v[h % 48] += 1;
  }
  if (v.every((x) => x === 0)) v[0] = 1;
  return v;
}

async function withMockFetch(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { input } = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: mockEmbed(t) })) }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

function pressureOf(body, ctx) {
  return measureContextPressure(body, { contextWindow: ctx.contextWindow, settings: ctx.settings });
}

// --- stages -----------------------------------------------------------------

export const STAGES = {
  handoff: {
    async run(body, ctx) {
      if (!ctx.settings.memoryHandoffEnabled) return;
      const result = injectHandoffPackets(body, [{ id: '12345678-1234-4234-9234-123456789abc', summary: 'Operator approved fixture summary.' }]);
      ctx.serviceFixtures.push({ stage: 'handoff', applied: result.injected, identity: 'explicit fixture packet; repository eligibility and capacity refusal have separate gateway tests' });
    },
  },
  pxpipe: {
    mock: true,
    async run(body, ctx) {
      const result = await compressWithPxpipe(body, { enabled: true, allowLossy: ctx.settings.pxpipeAllowLossy === true,
        format: 'claude', model: body.model, minChars: 1,
        transform: async ({ body: encoded }) => {
          const value = JSON.parse(new TextDecoder().decode(encoded));
          for (const message of value.messages.slice(0, -4)) for (const block of Array.isArray(message.content) ? message.content : []) {
            if (block.type !== 'tool_result' || isErrorResult(block) || typeof block.content !== 'string' || block.content.length < 2048) continue;
            const compressedChars = block.content.length;
            block.content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==' } }];
            return { applied: true, body: new TextEncoder().encode(JSON.stringify(value)), info: { imageCount: 1, compressedChars, imageTokens: 1 } };
          }
          return { applied: false, reason: 'no_eligible_fixture_content' };
        } });
      ctx.serviceFixtures.push({ stage: 'pxpipe', outcome: result.summary.outcome, applied: result.summary.applied, quality: 'unmeasured; stub image does not encode source content' });
      if (result.summary.outcome === 'failed') ctx.errors.push(`pxpipe:${result.summary.errorCode}`);
      if (result.body) Object.assign(body, result.body);
    },
  },
  diet: {
    async run(body, ctx) {
      if (!ctx.settings.epochConsent) return;
      const result = pruneExpiredToolResults(body, { epochCutIndex: Math.max(0, body.messages.length - 8), minAgeTurns: 8, minBlockChars: 2048, referenceScanTurns: 3 });
      if (result.applied) { body.messages = result.messages; ctx.prefixRewritten = true; ctx.note({ kind: 'diet', text: `pruned ${result.prunedBlocks} fixture blocks` }); }
    },
  },
  lingua: {
    mock: true,
    async run(body, ctx) {
      if (!ctx.settings.epochConsent) return;
      const result = await compressBlobs(body, { epochCutIndex: Math.max(0, body.messages.length - 8), endpoint: 'http://127.0.0.1:1',
        fetchImpl: async (_url, init) => Response.json({ text: JSON.parse(init.body).text.replace(/\s{2,}/g, ' ') }) });
      ctx.serviceFixtures.push({ stage: 'lingua', applied: result.applied, quality: 'unmeasured; deterministic whitespace stub' });
      if (result.outcome === 'failed') ctx.errors.push(`lingua:${result.errorCode}`);
      if (result.applied) { body.messages = result.messages; ctx.prefixRewritten = true; ctx.note({ kind: 'lingua', text: `compressed ${result.compressedBlocks} fixture blocks` }); }
    },
  },
  epochMicro: {
    async run(body, ctx) {
      if (!ctx.settings.epochConsent) return;
      const result = microcompact(body, { epochCutIndex: Math.max(0, body.messages.length - 8), keepLastTurns: 4 });
      if (result.applied) { body.messages = result.messages; ctx.prefixRewritten = true; ctx.note({ kind: 'epochMicro', text: `cleared ${result.clearedBlocks} fixture blocks` }); }
    },
  },
  epochAuto: {
    async run(body, ctx) {
      if (!ctx.settings.epochConsent) return;
      const result = await autocompact(body, { epochCutIndex: Math.max(0, body.messages.length - 8), keepRecentTurns: 6,
        windowTokens: ctx.contextWindow, usedTokens: estimateRequestTokens(body), summarizeFn: placeholderEpochSummarizer });
      if (result.outcome === 'failed') ctx.errors.push(`epochAuto:${result.errorCode}`);
      if (result.applied) { body.messages = result.messages; ctx.prefixRewritten = true; ctx.note({ kind: 'epochAuto', text: `compacted ${result.droppedTurns} fixture turns` }); }
    },
  },
  tools: {
    async run(body, ctx) {
      if (!Array.isArray(body.tools) || body.tools.length === 0) return;
      const { tools } = dedupeTools(body.tools, { clientTool: undefined, model: body.model });
      body.tools = tools;
      const td = ctx.settings.toolDisclosure;
      if (td?.filterEnabled) body.tools = toolFilter(body.tools, td);
      if (td?.disclosureEnabled) {
        const { tools: disclosed, stats } = disclosureTools(body.tools, body, ctx.connectionId, td);
        if (stats) body.tools = disclosed;
      }
    },
  },
  schema: {
    async run(body) {
      if (!Array.isArray(body.tools)) return;
      const d = distillToolSchemas(body.tools, { allowLossy: false });
      if (d.savedBytes > 0) body.tools = d.tools;
    },
  },
  thinking: {
    async run(body, ctx) {
      const res = stripHistoricalThinking(body.messages, { keepRecentTurns: 1 });
      if (res.stripped > 0) {
        body.messages = res.messages;
        for (const n of res.notes) if (typeof n?.turn === "number") ctx.prefixTurnIndices.push(n.turn);
        ctx.note({ kind: "thinking", text: `stripped ${res.stripped} reasoning block(s)` });
      }
    },
  },
  qac: {
    async run(body, ctx) {
      const memo = memoFor(QAC_MEMO, ctx.connectionId, () => new Set());
      const scoreNew = pressureOf(body, ctx).over && (!ctx.order.includes("mem") || ctx.memStats?.budget?.overAfter === true);
      const query = lastUserQuery(body.messages);
      if (!query.trim() && !memo.size) return;
      const res = compressPrefixByQuery(body.messages, { query, keepRecentTurns: 2, memo, scoreNew });
      if (res.compressed > 0) {
        body.messages = res.messages;
        if (res.added > 0) ctx.prefixRewritten = true;
        ctx.note({ kind: "qac", text: `compressed ${res.compressed} low-relevance turn(s)` });
      }
    },
  },
  reorder: {
    async run(body, ctx) {
      const memo = memoFor(REORDER_MEMO, ctx.connectionId, () => ({ order: [] }));
      const recompute = ctx.prefixRewritten;
      const query = lastUserQuery(body.messages);
      if (!((recompute && query.trim()) || (!recompute && memo.order.length > 0))) return;
      const res = await withMockFetch(() => reorderByRelevance(body.messages, {
        query, embedUrl: "http://mock/v1/embeddings", embedModel: "mock", keepRecentTurns: 2, memo, recompute,
      }));
      if (res.error) ctx.errors.push(`reorder:${res.error}`);
      if (res.moved > 0) {
        body.messages = res.messages;
        if (!res.replayed) ctx.note({ kind: "reorder", text: `reordered ${res.moved} pair(s) by relevance` });
      }
    },
  },
  rtk: {
    async run(body) {
      body.messages = structuredClone(body.messages);
      compressMessages(body, true, { allowLossy: false });
    },
  },
  privacy: {
    async run(body, ctx) {
      body.messages = structuredClone(body.messages);
      if (body.system && typeof body.system === "object") body.system = structuredClone(body.system);
      redactOutbound(body, ctx.settings.privacyTerms || []);
    },
  },
  // Exercise the real proxy wrapper using an in-process deterministic stub.
  // Only insignificant whitespace around valid JSON tokens is removed. This
  // validates wrapper behavior, never a remote compression model's quality.
  headroom: {
    mock: true,
    async run(body, ctx) {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (_url, init) => {
        const { messages } = JSON.parse(init.body);
        const before = bytes(messages);
        const visit = (node, tool = false) => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) { node.forEach((part) => visit(part, tool)); return; }
          const inTool = tool || node.role === "tool" || node.type === "tool_result";
          for (const [key, value] of Object.entries(node)) {
            if (inTool && (key === "text" || key === "content") && typeof value === "string") {
              node[key] = jsonCompact(value) ?? value;
            } else if (value && typeof value === "object") visit(value, inTool);
          }
        };
        visit(messages);
        const after = bytes(messages);
        return Response.json({ messages, tokens_before: before, tokens_after: after, tokens_saved: before - after,
          auditMetrics: "synthetic byte counts used only to exercise profitability gates" });
      };
      try {
        ctx.headroomStats = await compressWithHeadroom(body, {
          enabled: true, url: "http://offline.invalid", model: "offline", format: "claude",
          contextPressure: pressureOf(body, ctx), allowLossy: false,
        });
        if (ctx.headroomStats) ctx.prefixRewritten = true;
      } finally { globalThis.fetch = realFetch; }
    },
  },
  inject: {
    async run(body, ctx) {
      body.system = structuredClone(body.system);
      injectCaveman(body, "claude", ctx.settings.cavemanLevel || "full");
      injectPonytail(body, "claude", ctx.settings.ponytailLevel || "full");
    },
  },
  mem: {
    async run(body, ctx) {
      const res = await applyMemoryEnhancements(body, {
        settings: ctx.settings, targetFormat: "claude", contextWindow: ctx.contextWindow, handoffs: ctx.settings.handoffs || [],
      });
      ctx.memStats = res.stats;
      const st = res.stats || {};
      if (st.toolPruning?.applied || st.mediaPruning?.applied || st.compaction?.applied) ctx.prefixRewritten = true;
    },
  },
  pairs: {
    async run(body, ctx) {
      const p = pressureOf(body, ctx);
      if (p.deficitChars <= 0 || !(!ctx.order.includes("mem") || ctx.memStats?.budget?.overAfter === true)) return;
      const chunk = Math.max(1, Math.ceil((p.budget - p.target) * 3.8));
      const res = dropOldestPairs(body.messages, { deficitChars: Math.ceil(p.deficitChars / chunk) * chunk, keepRecentTurns: 6 });
      if (res.droppedPairs > 0) {
        body.messages = res.messages;
        ctx.prefixRewritten = true;
        ctx.note({ kind: "pairs", text: `dropped ${res.droppedPairs} pair(s) (~${res.savedChars} chars)` });
      }
    },
  },
  midinject: {
    async run(body, ctx) {
      if (ctx.prefixNotes.length === 0) return;
      const noteText = composeBoundaryNote(ctx.prefixNotes);
      let insertIndex = -1;
      for (let i = body.messages.length - 1; i >= 0; i--) {
        if (body.messages[i]?.role === "user") { insertIndex = i; break; }
      }
      const res = injectBoundaryNote(body.messages, insertIndex, noteText);
      if (res.injected) body.messages = res.messages;
    },
  },
};

export function anchor(body) {
  if (Array.isArray(body.tools)) body.tools = defaultClaudeToolType(body.tools);
  anchorClaudeCache(body);
}

// --- pipeline runner ----------------------------------------------------------

export function newCtx({ sid, connectionId, settings, contextWindow, order = [] }) {
  const ctx = {
    sid, connectionId, settings, contextWindow, order,
    prefixNotes: [], prefixTurnIndices: [], errors: [], memStats: null, prefixRewritten: false, serviceFixtures: [],
  };
  ctx.note = (n) => { if (ctx.prefixNotes.length < 12) ctx.prefixNotes.push(n); };
  return ctx;
}

/**
 * Run `order` over a deep copy of `entryBody`. Returns the final body, the
 * per-stage byte deltas, and the cache-order string.
 */
export async function runPipeline(entryBody, order, ctx) {
  const body = structuredClone(entryBody);
  const entryBytes = bytes(body);
  let prev = entryBytes;
  const deltas = {};
  const ledger = [];
  const t0 = performance.now();
  for (const name of order) {
    const stage = STAGES[name];
    if (!stage) throw new Error(`unknown stage ${name}`);
    await stage.run(body, ctx);
    const at = bytes(body);
    ledger.push({ stage: name, beforeBytes: prev, afterBytes: at, deltaBytes: at - prev, outcome: at === prev ? 'unchanged' : 'applied' });
    if (at !== prev) deltas[name] = at - prev;
    prev = at;
  }
  anchor(body);
  const finalBytes = bytes(body);
  return {
    body, entryBytes, finalBytes, deltas, ledger, anchorDeltaBytes: finalBytes - prev,
    cacheString: cacheString(body),
    ms: performance.now() - t0,
  };
}

export function cacheString(body) {
  return JSON.stringify(body.tools ?? null) + " " + JSON.stringify(body.system ?? null) + " " + JSON.stringify(body.messages ?? null);
}

export function commonPrefix(a, b) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  const n = Math.min(left.length, right.length);
  let i = 0;
  while (i < n && left[i] === right[i]) i++;
  return i;
}

// --- invariants ---------------------------------------------------------------

function toolResultsOf(messages) {
  const out = new Map();
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) if (b?.type === "tool_result") out.set(b.tool_use_id, b);
  }
  return out;
}

function toolUsesOf(messages) {
  const out = new Map();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) if (b?.type === "tool_use") out.set(b.id, i);
  }
  return out;
}

function textOfBlocks(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

/**
 * Violations of what a Claude request must keep, comparing the pipeline
 * output against what the client sent. Codes, not prose, so the enumerator
 * can aggregate them.
 */
export function invariants(entry, out, ctx) {
  const v = [];
  const em = entry.messages;
  const om = out.messages;
  if (!Array.isArray(om) || om.length === 0) return ["no-messages"];

  // Roles alternate and the conversation starts and ends with the user.
  if (om[0].role !== "user") v.push("first-not-user");
  if (om[om.length - 1].role !== "user") v.push("last-not-user");
  for (let i = 1; i < om.length; i++) if (om[i].role === om[i - 1].role) { v.push("role-repeat"); break; }
  if (om.some((m) => m.role === "system")) v.push("system-role-in-messages");
  if (om.some((m) => (Array.isArray(m.content) && m.content.length === 0) || m.content === "")) v.push("empty-message");

  // tool_use / tool_result pairing: every result has its use before it and
  // every use has exactly one result after it (Anthropic rejects otherwise).
  const uses = toolUsesOf(om);
  const results = toolResultsOf(om);
  for (const [id] of results) if (!uses.has(id)) { v.push("orphan-tool-result"); break; }
  for (const [id, idx] of uses) {
    if (!results.has(id)) {
      // The live turn may legitimately hold an unanswered tool_use only when
      // it is the last assistant message and the last message is user text.
      if (idx !== om.length - 2) { v.push("orphan-tool-use"); break; }
    }
  }

  // Error results are evidence: byte-identical to what the client sent.
  const entryResults = toolResultsOf(em);
  for (const [id, b] of entryResults) {
    if (!isErrorResult(b)) continue;
    const o = results.get(id);
    if (!o || JSON.stringify(o.content) !== JSON.stringify(b.content)) { v.push("error-result-modified"); break; }
  }

  // The live query (last user message text) is never rewritten.
  const lastEntry = em[em.length - 1];
  const lastOut = om[om.length - 1];
  const strip = (m) => textOfBlocks(m.content).replace(/\n\[tokenproxy context note\][\s\S]*$/, "");
  if (!ctx?.privacy && strip(lastOut) !== textOfBlocks(lastEntry.content) && !(textOfBlocks(lastOut.content).startsWith(textOfBlocks(lastEntry.content)))) {
    v.push("live-turn-modified");
  }

  // The last assistant turn keeps its thinking (Anthropic requires it on the
  // turn that carries the pending tool_use).
  for (let i = em.length - 1; i >= 0; i--) {
    if (em[i].role !== "assistant") continue;
    const hadThinking = Array.isArray(em[i].content) && em[i].content.some((b) => b?.type === "thinking");
    if (!hadThinking) break;
    let j = om.length - 1;
    while (j >= 0 && om[j].role !== "assistant") j--;
    const has = j >= 0 && Array.isArray(om[j].content) && om[j].content.some((b) => b?.type === "thinking");
    if (!has) v.push("last-assistant-thinking-lost");
    break;
  }

  // An rtk elide marker, once written, is never destroyed by a later stage.
  const markers = (msgs) => JSON.stringify(msgs).match(new RegExp(ELIDE_MARKER_RE.source, "g"))?.length || 0;
  if (ctx?.elideMarkersMid !== undefined && markers(om) < ctx.elideMarkersMid) v.push("elide-marker-lost");

  // Growth: only inject/midinject may grow the body, and by little.
  const growth = bytes(out) - bytes(entry);
  if (growth > Math.max(6000, bytes(entry) * 0.05)) v.push("grew");

  // Never above the model window after everything ran.
  if (ctx?.contextWindow && estimateRequestTokens(out) > ctx.contextWindow) v.push("over-window");

  // Tool schemas: a tool the history already called should stay disclosed
  // (the model otherwise sees a call to a tool it cannot see).
  if (Array.isArray(out.tools)) {
    const names = new Set(out.tools.map((t) => t.name));
    for (const m of om) {
      if (!Array.isArray(m.content)) continue;
      if (m.content.some((b) => b?.type === "tool_use" && !names.has(b.name))) { v.push("used-tool-not-disclosed"); break; }
    }
  }
  return v;
}

export { bytes };
