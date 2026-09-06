// Anti-revert guard for the cache-economics directive: maximize cache reads,
// minimize cache writes. The judging criterion for every token saver is
// CACHE-PREFIX STABILITY, not raw token savings — a saver that rewrites bytes
// before the cache anchor busts the cached prefix and multiplies cost.
//
// Three invariants pinned here, on the pure stage functions chatCore composes
// (schema distill → rtk → inject → anchorClaudeCache, the deterministic half
// of the pipeline):
//   1. Identical input on two consecutive requests produces byte-identical
//      transformed bodies (determinism ⇒ the provider's cached prefix matches
//      turn to turn).
//   2. On the cache-keep path (valid client anchor plan), no stage mutates
//      content before an existing anchor, and history-prefix bytes stay
//      identical across turns as the conversation grows.
//   3. anchorClaudeCache never reduces the anchor count of a valid client
//      plan — the condition chatCore classifies as XFORM.cache-keep
//      (anchorsBefore >= 2 && anchorsAfter >= anchorsBefore).
//
// Sibling coverage (not duplicated here): schema-distiller.test.js pins
// distill idempotence and the 8KB floor; tool-pruner-prefix-stability.test.js
// pins the pressure ladder's monotone prefix; claude-client-cache-anchors
// pins plan preservation shapes; defer-loading-cache-anchor-3567 pins the
// deferred-tool exclusion.
import { describe, it, expect } from 'vitest';
import { distillToolSchemas } from '../../open-sse/utils/schemaDistiller.js';
import { compressMessages } from '../../open-sse/rtk/index.js';
import { injectCaveman } from '../../open-sse/rtk/caveman.js';
import { CAVEMAN_PROMPTS, CAVEMAN_LEVELS } from '../../open-sse/rtk/cavemanPrompts.js';
import { injectPonytail } from '../../open-sse/rtk/ponytail.js';
import { anchorClaudeCache, countCacheAnchors } from '../../open-sse/translator/formats/claude.js';
import { FORMATS } from '../../open-sse/translator/formats.js';

const ANCHOR_1H = { type: 'ephemeral', ttl: '1h' };
const ANCHOR_5M = { type: 'ephemeral' };

// Deterministic filler, no RNG: rtk only engages above MIN_COMPRESS_SIZE and
// distill above its 8KB floor, so payloads must be big and byte-reproducible.
const filler = (n) =>
  Array.from({ length: n }, (_, i) => `row-${Math.floor(i / 50)} status=ok latency=7ms`).join('\n');

const bigSchema = () => ({
  type: 'object',
  title: 'noise',
  $schema: 'http://json-schema.org/draft-07/schema#',
  properties: Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [
      `field_${i}`,
      {
        type: 'string',
        description: `the ${i}th field    with   runs`,
        default: 'x',
        examples: ['a', 'b'],
      },
    ])
  ),
});

// A turn-N Claude-format body the way chatCore sees it: client anchor plan
// within the 4-breakpoint limit (system tail + last assistant), fat tools,
// compressible tool_results in history.
function turnBody(extraTurns = []) {
  return {
    model: 'claude-sonnet-5',
    max_tokens: 64,
    system: [
      { type: 'text', text: 'policy preamble' },
      { type: 'text', text: 'system tail', cache_control: { ...ANCHOR_1H } },
    ],
    tools: [
      { name: 'run_query', description: 'runs a query', input_schema: bigSchema() },
      { name: 'read_file', description: 'reads a file', input_schema: bigSchema() },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'start the audit' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'run_query', input: { q: 'select 1' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: filler(250) }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'audit summary', cache_control: { ...ANCHOR_5M } }],
      },
      ...extraTurns,
    ],
  };
}

// The deterministic saver chain in chatCore order. Mutates `body` like the
// real pipeline does; callers pass an isolated clone.
function runSaverChain(body) {
  const distilled = distillToolSchemas(body.tools);
  if (distilled.savedBytes > 0) body.tools = distilled.tools;
  compressMessages(body, true);
  injectCaveman(body, FORMATS.CLAUDE, 'full');
  injectPonytail(body, FORMATS.CLAUDE, 'full');
  anchorClaudeCache(body);
  return body;
}

function longestCommonPrefixLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

describe('invariant 1: identical input ⇒ byte-identical transformed body', () => {
  it('two consecutive requests with the same body transform to the same bytes', () => {
    const a = runSaverChain(turnBody());
    const b = runSaverChain(turnBody());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('each stage alone is deterministic (a flaky stage is a cache-buster on its own)', () => {
    const mk = () => turnBody();
    // schema distill
    expect(JSON.stringify(distillToolSchemas(mk().tools).tools)).toBe(
      JSON.stringify(distillToolSchemas(mk().tools).tools)
    );
    // rtk
    const r1 = mk();
    const r2 = mk();
    compressMessages(r1, true);
    compressMessages(r2, true);
    expect(JSON.stringify(r2.messages)).toBe(JSON.stringify(r1.messages));
    // inject
    const i1 = mk();
    const i2 = mk();
    injectCaveman(i1, FORMATS.CLAUDE, 'full');
    injectCaveman(i2, FORMATS.CLAUDE, 'full');
    expect(JSON.stringify(i2.system)).toBe(JSON.stringify(i1.system));
    // anchor
    expect(JSON.stringify(anchorClaudeCache(mk()))).toBe(JSON.stringify(anchorClaudeCache(mk())));
  });

  it('rtk actually engaged on the fixture (a silent no-op would vacuously pass)', () => {
    const body = turnBody();
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBeGreaterThan(0);
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
  });
});

describe('invariant 2: nothing before an existing cache anchor moves', () => {
  it('anchorClaudeCache on a valid client plan leaves every pre-anchor byte alone', () => {
    const before = turnBody();
    const after = anchorClaudeCache(structuredClone(before));
    // The client plan (system tail 1h + last assistant 5m) is complete, so
    // keep-path applies: system, tools, and every message must be byte-equal.
    expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
    expect(JSON.stringify(after.messages)).toBe(JSON.stringify(before.messages));
    // tools may only GAIN the backfilled tail anchor, never lose or reorder
    expect(after.tools.length).toBe(before.tools.length);
    expect(after.tools.map((t) => t.name)).toEqual(before.tools.map((t) => t.name));
    expect(JSON.stringify(after.tools.slice(0, -1))).toBe(
      JSON.stringify(before.tools.slice(0, -1))
    );
  });

  it('system injection replayed on the next turn is a no-op (dedup guard holds the prefix)', () => {
    const turnN = turnBody();
    injectCaveman(turnN, FORMATS.CLAUDE, 'full');
    const systemAfterN = JSON.stringify(turnN.system);
    // Turn N+1: the client replays the (already injected) system verbatim.
    const turnN1 = { ...turnBody(), system: structuredClone(turnN.system) };
    expect(injectCaveman(turnN1, FORMATS.CLAUDE, 'full')).toBe(false);
    expect(JSON.stringify(turnN1.system)).toBe(systemAfterN);
  });

  it('injection lands INSIDE the cached region, before the last system anchor, at a stable index', () => {
    const a = turnBody();
    const b = turnBody();
    injectCaveman(a, FORMATS.CLAUDE, 'full');
    injectCaveman(b, FORMATS.CLAUDE, 'full');
    // Locate the injected block by the production prompt constant itself, so a
    // reworded prompt cannot silently turn this into a vacuous -1 lookup.
    const idxA = a.system.findIndex((s) => s.text?.includes(CAVEMAN_PROMPTS[CAVEMAN_LEVELS.FULL]));
    expect(idxA).toBeGreaterThanOrEqual(0);
    // anchored tail stays last, so the injected block sits before the anchor
    expect(a.system[a.system.length - 1].cache_control).toEqual(ANCHOR_1H);
    expect(b.system.findIndex((s) => s.text === a.system[idxA].text)).toBe(idxA);
  });

  it('growing the conversation keeps the transformed history prefix byte-identical', () => {
    const outN = runSaverChain(turnBody());
    const outN1 = runSaverChain(
      turnBody([
        { role: 'user', content: [{ type: 'text', text: 'next question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'next answer' }] },
      ])
    );
    // System and tools (the deepest cached prefix) are byte-identical.
    expect(JSON.stringify(outN1.system)).toBe(JSON.stringify(outN.system));
    expect(JSON.stringify(outN1.tools)).toBe(JSON.stringify(outN.tools));
    // Every turn-N message survives verbatim at the same position in turn N+1
    // (the client's 5m anchor on the old last-assistant is part of the plan,
    // so the keep path may not strip or re-anchor it).
    const histN = JSON.stringify(outN.messages);
    const histN1 = JSON.stringify(outN1.messages.slice(0, outN.messages.length));
    expect(histN1).toBe(histN);
    // And the serialized bodies diverge only inside the new live turn.
    const lcp = longestCommonPrefixLength(JSON.stringify(outN), JSON.stringify(outN1));
    const anchorPos = JSON.stringify(outN).lastIndexOf('cache_control');
    expect(lcp).toBeGreaterThan(anchorPos);
  });
});

describe('invariant 3: cache-keep classification never regresses', () => {
  // chatCore emits XFORM.cache-keep iff anchorsBefore >= 2 && anchorsAfter >=
  // anchorsBefore (handlers/chatCore.js ~L1362). Pin the count algebra so a
  // future anchorClaudeCache change that strips client anchors flips these.
  it('a valid 2-anchor client plan keeps at least its anchors through anchoring', () => {
    const body = turnBody();
    const before = countCacheAnchors(body);
    expect(before).toBe(2);
    anchorClaudeCache(body);
    expect(countCacheAnchors(body)).toBeGreaterThanOrEqual(before);
  });

  it('a full 4-anchor plan survives with exactly 4 (no fifth breakpoint minted)', () => {
    const body = turnBody();
    body.tools[1].cache_control = { ...ANCHOR_5M };
    body.messages[0].content[0].cache_control = { ...ANCHOR_5M };
    expect(countCacheAnchors(body)).toBe(4);
    anchorClaudeCache(body);
    expect(countCacheAnchors(body)).toBe(4);
    // Anthropic hard limit — a 5th breakpoint 400s the request upstream.
    expect(countCacheAnchors(body)).toBeLessThanOrEqual(4);
  });

  it('an anchorless body takes the legacy path and still ends fully anchored', () => {
    const body = turnBody();
    delete body.system[1].cache_control;
    delete body.messages[3].content[0].cache_control;
    expect(countCacheAnchors(body)).toBe(0);
    anchorClaudeCache(body);
    const after = countCacheAnchors(body);
    expect(after).toBeGreaterThanOrEqual(3); // system tail + tool tail + last assistant
    expect(after).toBeLessThanOrEqual(4);
  });
});
