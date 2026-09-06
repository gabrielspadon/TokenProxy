import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { semanticFixture, preservationViolations, jsonLexemes } from './semantic-fixture.mjs';
import { pressureFixture, pressureViolations, mockVisualTransform } from './pressure-fixture.mjs';
import { jsonCompact } from '../../../open-sse/rtk/filters/jsonCompact.js';

const audit = vi.hoisted(() => ({
  dispatched: null, order: [], fetches: 0, measure: false, events: [],
  wrap(module, name, stage) { return { ...module, [name]: function (...args) {
    audit.order.push(stage);
    const before = audit.measure ? JSON.stringify(args[0]) : null;
    const record = (result) => {
      if (audit.measure) {
        const after = Array.isArray(result) ? result : result?.messages ?? result?.tools ?? result?.body ?? args[0];
        audit.events.push({ stage, function: name, changed: before !== JSON.stringify(after), outcome: result?.summary?.reason || args[1]?.diagnostics?.reason || (result == null ? 'no-result' : 'returned') });
      }
      return result;
    };
    const result = module[name](...args);
    return result?.then ? result.then(record) : record(result);
  } }; },
}));

// Observation wrappers always call the actual implementation. Only the final
// provider executor and persistence boundary are substituted with fixtures.
vi.mock('../../../open-sse/utils/toolDeduper.js', async (original) => audit.wrap(await original(), 'dedupeTools', 'tools'));
vi.mock('../../../open-sse/utils/toolFilter.js', async (original) => audit.wrap(await original(), 'toolFilter', 'tools'));
vi.mock('../../../open-sse/utils/toolDisclosure.js', async (original) => audit.wrap(await original(), 'disclosureTools', 'tools'));
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

async function run(mask, body = semanticFixture(), window, extra = {}) {
  audit.order = []; audit.events = []; audit.dispatched = null;
  const result = await handleChatCore({
    requestId: `subset-${mask}`, body, modelInfo: { provider: 'anthropic', model: body.model },
    credentials: { apiKey: 'fixture-only', providerSpecificData: {} }, connectionId: 'fixture-account', sid: `independent-subset-${mask}`,
    clientRawRequest: { endpoint: '/v1/messages', headers: { 'user-agent': 'claude-cli/1.0.0 (external, cli)' } }, log,
    ...options(mask, window),
    ...extra,
  });
  await result.response.text();
  return { status: result.response.status, output: audit.dispatched, order: [...audit.order], events: [...audit.events] };
}

beforeEach(() => {
  memoClear(); audit.fetches = 0; audit.measure = false;
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

  it('preserves typed custom tool schemas and caller input across a compatible-provider translation', async () => {
    const body = semanticFixture();
    body.model = 'MiniMax-M3';
    const before = structuredClone(body);
    const result = await run(0, body, undefined, { modelInfo: { provider: 'minimax', model: body.model } });
    expect(result.status).toBe(200);
    expect(preservationViolations(before, result.output)).toEqual([]);
    expect(body).toEqual(before);
  });

  it('exercises active pressure combinations in both safe and explicit lossy profiles', async () => {
    audit.measure = true;
    const serviceCalls = { headroom: 0, embeddings: 0, visual: 0 };
    vi.stubGlobal('fetch', async (url, init) => {
      const payload = JSON.parse(init.body);
      if (String(url) === 'http://audit.invalid/embed') {
        serviceCalls.embeddings++;
        return Response.json({ data: payload.input.map((value, index) => {
          const number = /Historical pair (\d+)/.exec(value)?.[1];
          return { index, embedding: number === undefined ? [1, 0] : [20 - Number(number), 1] };
        }) });
      }
      if (String(url) === 'http://audit.invalid/v1/compress') {
        serviceCalls.headroom++;
        const before = JSON.stringify(payload.messages).length;
        for (const message of payload.messages) for (const block of message.content || []) {
          if (block.type === 'tool_result' && typeof block.content === 'string') block.content = jsonCompact(block.content) ?? block.content;
        }
        const after = JSON.stringify(payload.messages).length;
        return Response.json({ messages: payload.messages, tokens_before: before, tokens_after: after, tokens_saved: before - after });
      }
      audit.fetches++;
      throw new Error(`Unrecognized external service ${url}`);
    });
    const smoke = process.env.PLATFORM_AUDIT_PRESSURE_SMOKE === '1';
    const masks = smoke ? [...new Set([0, ...ORDER.map((_, bit) => 1 << bit), (1 << 10) | (1 << 12), (1 << 9) | (1 << 12), allMasks - 1])] : Array.from({ length: allMasks }, (_, mask) => mask);
    const profiles = [];
    for (const allowLossy of [false, true]) {
      const stages = Object.fromEntries(ORDER.map((stage) => [stage, { calls: 0, changed: 0, unchanged: 0, outcomes: {} }]));
      const functions = {};
      const failures = [];
      const issueCounts = {};
      const firstMaskByIssue = {};
      let failedMasks = 0;
      const digest = createHash('sha256');
      for (const mask of masks) {
        const body = pressureFixture();
        const before = structuredClone(body);
        const memory = Boolean(mask & (1 << ORDER.indexOf('memory')));
        const { status, output, order, events } = await run(mask, body, 4500, {
          modelInfo: { provider: 'minimax', model: body.model }, sid: `pressure-${allowLossy}-${mask}`,
          rtkAllowLossy: allowLossy, schemaAllowLossy: allowLossy, headroomAllowLossy: allowLossy, pxpipeAllowLossy: allowLossy,
          pxpipeTransform: (input) => { serviceCalls.visual++; return mockVisualTransform(input); },
          embedReorderUrl: 'http://audit.invalid/embed', embedReorderModel: 'fixture-embedding',
          toolDisclosure: { filterEnabled: Boolean(mask & 1), disclosureEnabled: Boolean(mask & 1), maxTools: 20, excludeTools: ['mcp__exa__web_fetch_exa'] },
          memorySettings: { memoryContextWindowOverride: 4500, memoryToolPruningEnabled: memory, memoryMediaPruningEnabled: memory, memoryCompactionEnabled: memory, memoryCompactionThresholdTokens: 100, memoryRecentTurnsToKeep: 8, memoryMaxToolTurnsKeepFull: 3 },
        });
        const issues = pressureViolations(before, output, { allowLossy });
        if (JSON.stringify(body) !== JSON.stringify(before)) issues.push('caller-mutated');
        if (status !== 200) issues.push(`status-${status}`);
        const positions = order.map((stage) => ORDER.indexOf(stage));
        if (positions.some((value, i) => i && value < positions[i - 1])) issues.push('stage-order');
        for (const event of events) {
          const entry = stages[event.stage];
          entry.calls++; entry[event.changed ? 'changed' : 'unchanged']++;
          entry.outcomes[event.outcome] = (entry.outcomes[event.outcome] || 0) + 1;
          functions[event.function] ??= { calls: 0, changed: 0 };
          functions[event.function].calls++;
          if (event.changed) functions[event.function].changed++;
        }
        digest.update(`${mask}:${order.join(',')}:${issues.join(',')}\n`);
        if (issues.length) {
          failedMasks++;
          for (const issue of issues) { issueCounts[issue] = (issueCounts[issue] || 0) + 1; firstMaskByIssue[issue] ??= mask; }
          if (failures.length < 25) failures.push({ mask, issues });
        }
      }
      profiles.push({ allowLossy, masks: masks.length, expectedMasks: smoke ? masks.length : allMasks, failedMasks, issueCounts, firstMaskByIssue, failures, stages, functions, digest: digest.digest('hex') });
    }
    const receipt = {
      inventory: ORDER, smoke, profiles, mockServiceCalls: serviceCalls, externalNetworkAttempts: audit.fetches, liveProviderCalls: 0,
      fixture: 'Claude-compatible Minimax format, 4500-token fixture window, historical thinking, JSON tools, visual tool output, mixed-relevance text pairs, schema literals, live tool evidence and signed live thinking',
      bounds: 'All wrappers execute production functions. Headroom/embedding responses and visual conversion are deterministic offline contract fixtures, not compression quality or billed-token evidence. Historical content changes only through explicit toggles; safe consent still permits separate historical pruning controls.',
    };
    if (process.env.PLATFORM_AUDIT_PRESSURE_RECEIPT) writeFileSync(process.env.PLATFORM_AUDIT_PRESSURE_RECEIPT, JSON.stringify(receipt, null, 2));
    expect(audit.fetches).toBe(0);
    expect(profiles.flatMap((profile) => profile.failures)).toEqual([]);
    if (!smoke) for (const stage of ORDER) expect(profiles.reduce((sum, profile) => sum + profile.stages[stage].changed, 0), `${stage} must have an observed production change`).toBeGreaterThan(0);
  }, 600_000);
});
