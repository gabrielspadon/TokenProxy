import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { semanticFixture, preservationViolations, jsonLexemes } from './semantic-fixture.mjs';

const audit = vi.hoisted(() => ({
  dispatched: null, order: [], fetches: 0,
  wrap(module, name, stage) { return { ...module, [name]: function (...args) { audit.order.push(stage); return module[name](...args); } }; },
}));

// Observation wrappers always call the actual implementation. Only the final
// provider executor and persistence boundary are substituted with fixtures.
vi.mock('../../../open-sse/utils/toolDeduper.js', async (original) => audit.wrap(await original(), 'dedupeTools', 'tools'));
vi.mock('../../../open-sse/utils/schemaDistiller.js', async (original) => audit.wrap(await original(), 'distillToolSchemas', 'schema'));
vi.mock('../../../open-sse/utils/thinkingStrip.js', async (original) => audit.wrap(await original(), 'stripHistoricalThinking', 'thinking'));
vi.mock('../../../open-sse/rtk/index.js', async (original) => audit.wrap(await original(), 'compressMessages', 'rtk'));
vi.mock('../../../open-sse/utils/privacyFilter.js', async (original) => audit.wrap(await original(), 'redactOutbound', 'privacy'));
vi.mock('../../../open-sse/rtk/caveman.js', async (original) => audit.wrap(await original(), 'injectCaveman', 'caveman'));
vi.mock('../../../open-sse/rtk/ponytail.js', async (original) => audit.wrap(await original(), 'injectPonytail', 'ponytail'));
vi.mock('../../../open-sse/rtk/pxpipe.js', async (original) => audit.wrap(await original(), 'compressWithPxpipe', 'pxpipe'));
vi.mock('../../../open-sse/services/memory/index.js', async (original) => audit.wrap(await original(), 'applyMemoryEnhancements', 'memory'));
vi.mock('../../../open-sse/rtk/headroom.js', async (original) => audit.wrap(await original(), 'compressWithHeadroom', 'headroom'));
vi.mock('../../../open-sse/utils/queryAwareCompress.js', async (original) => audit.wrap(await original(), 'compressPrefixByQuery', 'qac'));
vi.mock('../../../open-sse/utils/pairDropper.js', async (original) => audit.wrap(await original(), 'dropOldestPairs', 'pairs'));
vi.mock('../../../open-sse/utils/embedReorder.js', async (original) => audit.wrap(await original(), 'reorderByRelevance', 'reorder'));
vi.mock('../../../open-sse/utils/midPrefixInject.js', async (original) => audit.wrap(await original(), 'injectBoundaryNote', 'boundary'));
vi.mock('../../../open-sse/executors/index.js', () => ({ getExecutor: () => ({ noAuth: true, async execute({ body }) {
  audit.dispatched = structuredClone(body);
  return { response: Response.json({ id: 'fixture', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: body.model, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), url: 'https://provider.invalid/fixture', headers: {} };
} }) }));
vi.mock('../../../open-sse/utils/requestLogger.js', () => ({ createRequestLogger: async () => ({ async logClientRawRequest() {}, async logRawRequest() {}, async logTargetRequest() {}, async logProviderResponse() {}, async logConvertedResponse() {}, async logError() {} }) }));
vi.mock('@/lib/usageDb.js', () => ({ trackPendingRequest() {}, async appendRequestLog() {}, async saveRequestDetail() {}, async saveRequestUsage() {} }));

const { handleChatCore } = await import('../../../open-sse/handlers/chatCore.js');
const { memoClear } = await import('../../../open-sse/services/memory/sessionMemo.js');
const ORDER = ['tools', 'schema', 'thinking', 'rtk', 'privacy', 'caveman', 'ponytail', 'pxpipe', 'memory', 'headroom', 'qac', 'pairs', 'reorder', 'boundary'];
const log = { debug() {}, info() {}, warn() {}, line() {}, tagForSession: () => 'AUDIT', nextTag: () => 'AUDIT', fmtThink: () => null };
const allMasks = 2 ** ORDER.length;

function options(mask, window = 1_000_000) {
  const enabled = Object.fromEntries(ORDER.map((name, bit) => [name, Boolean(mask & (1 << bit))]));
  return {
    rtkEnabled: enabled.rtk, rtkAllowLossy: false,
    schemaDistillEnabled: enabled.schema, schemaAllowLossy: false,
    thinkingStripEnabled: enabled.thinking,
    privacyEnabled: enabled.privacy, privacyTerms: [],
    cavemanEnabled: enabled.caveman, cavemanLevel: 'lite',
    ponytailEnabled: enabled.ponytail, ponytailLevel: 'lite',
    pxpipeEnabled: enabled.pxpipe, pxpipeAllowLossy: false, pxpipeMinChars: 1, pxpipeTransform: async () => ({ applied: false, reason: 'fixture-renderer-unavailable' }),
    memorySettings: enabled.memory ? { memoryContextWindowOverride: window, memoryToolPruningEnabled: true, memoryMediaPruningEnabled: true, memoryCompactionEnabled: true, memoryCompactionThresholdTokens: 500, memoryRecentTurnsToKeep: 4, memoryHandoffEnabled: false } : null,
    headroomEnabled: enabled.headroom, headroomAllowLossy: false, headroomUrl: 'http://audit.invalid',
    queryAwareCompressionEnabled: enabled.qac, pairDropEnabled: enabled.pairs,
    embedReorderEnabled: enabled.reorder, embedReorderUrl: 'http://audit.invalid', midPrefixInjectEnabled: enabled.boundary,
    toolDisclosure: { filterEnabled: enabled.tools, disclosureEnabled: enabled.tools, maxTools: 20 },
  };
}

async function run(mask, body = semanticFixture(), window) {
  audit.order = []; audit.dispatched = null;
  const result = await handleChatCore({
    requestId: `subset-${mask}`, body, modelInfo: { provider: 'anthropic', model: body.model },
    credentials: { apiKey: 'fixture-only', providerSpecificData: {} }, connectionId: 'fixture-account', sid: `independent-subset-${mask}`,
    clientRawRequest: { endpoint: '/v1/messages', headers: { 'user-agent': 'claude-cli/1.0.0 (external, cli)' } }, log,
    ...options(mask, window),
  });
  await result.response.text();
  return { status: result.response.status, output: audit.dispatched, order: [...audit.order] };
}

beforeEach(() => {
  memoClear(); audit.fetches = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', async (url) => { audit.fetches++; throw new Error(`Unexpected network boundary ${url}`); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('independent production saver subset coverage', () => {
  it('preserves semantics and fixed production order for every subset of fourteen stage families', async () => {
    const failures = [];
    const maskCounts = Array(ORDER.length).fill(0);
    const observedCalls = Object.fromEntries(ORDER.map((stage) => [stage, 0]));
    const seen = new Set();
    const digest = createHash('sha256');
    let invocations = 0;
    let failedMasks = 0;
    for (let mask = 0; mask < allMasks; mask++) {
      const entry = semanticFixture();
      const before = JSON.stringify(entry);
      const { status, output, order } = await run(mask, entry);
      seen.add(mask);
      for (let bit = 0; bit < ORDER.length; bit++) if (mask & (1 << bit)) maskCounts[bit]++;
      const issues = preservationViolations(JSON.parse(before), output);
      if (JSON.stringify(entry) !== before) issues.push('caller-mutated');
      if (status !== 200) issues.push(`status-${status}`);
      const indices = order.map((name) => ORDER.indexOf(name));
      if (indices.some((value, i) => i > 0 && value < indices[i - 1])) issues.push('stage-order');
      invocations += order.length;
      for (const stage of order) observedCalls[stage]++;
      digest.update(`${mask}:${order.join(',')}:${issues.join(',')}\n`);
      if (issues.length) {
        failedMasks++;
        if (failures.length < 30) failures.push({ mask, enabled: ORDER.filter((_, bit) => mask & (1 << bit)), issues });
      }
    }
    const receipt = {
      inventory: ORDER, memoryGrouping: 'tool pruning, media pruning, compaction; handoff external state excluded',
      masks: seen.size, expectedMasks: allMasks, nonemptyMasks: allMasks - 1, perStageEnabled: maskCounts,
      orderCoverage: 'Every subset in actual production order; no factorial permutation claim',
      invocationCount: invocations, observedCalls, externalNetworkAttempts: audit.fetches, providerCalls: 0,
      fixture: 'Claude native, wide context, long schema with literal keyword collisions, exact numeric lexemes and duplicate keys, error evidence and pending task',
      safetyProfile: 'RTK/schema/Headroom/PXPIPE loss consent false; additive Caveman/Ponytail explicitly enabled by mask; no pressure pruning in this matrix',
      bounds: 'Subset selection and production ordering are exhaustive for this fixture. No claim that all content-dependent branches apply, optional services run, or model behavior is equivalent. Pressure and cross-format contracts have separate tests.',
      digest: digest.digest('hex'), failedMasks, failures,
    };
    if (process.env.PLATFORM_AUDIT_RECEIPT) writeFileSync(process.env.PLATFORM_AUDIT_RECEIPT, JSON.stringify(receipt, null, 2));
    expect(receipt.masks).toBe(allMasks);
    expect(maskCounts.every((count) => count === allMasks / 2)).toBe(true);
    expect(audit.fetches).toBe(0);
    expect(failures).toEqual([]);
  }, 300_000);

  it('keeps a transformed prefix stable when the same caller appends a turn', async () => {
    const body = semanticFixture();
    const first = await run(allMasks - 1, structuredClone(body));
    body.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'The source is intact.' }] }, { role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
    const second = await run(allMasks - 1, body);
    const stripGeneratedCache = (value) => JSON.parse(JSON.stringify(value, (key, v) => key === 'cache_control' ? undefined : v));
    expect(stripGeneratedCache(second.output.tools)).toEqual(stripGeneratedCache(first.output.tools));
    expect(stripGeneratedCache(second.output.system)).toEqual(stripGeneratedCache(first.output.system));
    expect(stripGeneratedCache(second.output.messages.slice(0, first.output.messages.length))).toEqual(stripGeneratedCache(first.output.messages));
  });

  it('preserves 32 seeded full-pipeline variants of error aliases, JSON layouts and current instructions', async () => {
    let state = 0x4a17cafe;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
    const spaces = [' ', '\t', '\n  ', '\r\n'];
    for (let sample = 0; sample < 32; sample++) {
      const body = semanticFixture();
      const marker = `Exact sample ${sample}, calibration ${(random() % 1000) / 1000} Pa, preserve /fixture/${random()}.json.`;
      body.system[0].text += ` ${marker}`;
      body.messages.at(-1).content[0].text += ` ${marker}`;
      body.messages[2].content[0].content = jsonLexemes(body.messages[2].content[0].content).map((token) => token + spaces[random() % spaces.length]).join('');
      const error = body.messages[4].content[0];
      delete error.is_error;
      const alias = ['is_error', 'isError', 'error', 'status'][random() % 4];
      error[alias] = alias === 'status' ? 'failed' : true;
      const before = structuredClone(body);
      const result = await run(allMasks - 1, body);
      expect(result.status).toBe(200);
      expect(preservationViolations(before, result.output)).toEqual([]);
      expect(body).toEqual(before);
    }
    expect(audit.fetches).toBe(0);
  });
});
