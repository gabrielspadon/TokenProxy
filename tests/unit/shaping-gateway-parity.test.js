import { expect, it, vi, afterEach } from 'vitest';
import { fixtureSet } from '../../src/lib/shaping/fixtures.mjs';
import { evaluateSettings } from '../../src/lib/shaping/evaluate.mjs';
import { mergeWithDefaults } from '../../src/lib/db/repos/settingsRepo.js';
const audit = vi.hoisted(() => ({ body: null, snapshot: null, entry: null, tools: null, messages: null }));
vi.mock('../../open-sse/utils/schemaDistiller.js', async original => { const implementation = await original(); return { ...implementation, distillToolSchemas(tools, ...args) { audit.tools = structuredClone(tools); return implementation.distillToolSchemas(tools, ...args); } }; });
vi.mock('../../open-sse/utils/thinkingStrip.js', async original => { const implementation = await original(); return { ...implementation, stripHistoricalThinking(messages, ...args) { audit.messages = structuredClone(messages); return implementation.stripHistoricalThinking(messages, ...args); } }; });
vi.mock('../../open-sse/rtk/index.js', async original => {
  const implementation = await original(); return { ...implementation, compressMessages(body, ...args) { audit.body = body; audit.entry = { ...structuredClone(body), tools: audit.tools, messages: audit.messages }; return implementation.compressMessages(body, ...args); } };
});
vi.mock('../../open-sse/utils/midPrefixInject.js', async original => {
  const implementation = await original(); return { ...implementation, injectBoundaryNote(...args) { const result = implementation.injectBoundaryNote(...args); audit.snapshot = { ...structuredClone(audit.body), messages: structuredClone(result.messages) }; return result; } };
});
vi.mock('../../open-sse/executors/index.js', () => ({ getExecutor: () => ({ noAuth: true, async execute({ body }) { return { response: Response.json({ id: 'offline-parity', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'fixture' }], model: body.model, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), url: 'https://provider.invalid/fixture', headers: {} }; } }) }));
vi.mock('../../open-sse/utils/requestLogger.js', () => ({ createRequestLogger: async () => ({ async logClientRawRequest() {}, async logRawRequest() {}, async logTargetRequest() {}, async logProviderResponse() {}, async logConvertedResponse() {}, async logError() {} }) }));
vi.mock('@/lib/usageDb.js', () => ({ trackPendingRequest() {}, async appendRequestLog() {}, async saveRequestDetail() {}, async saveRequestUsage() {} }));
const { handleChatCore } = await import('../../open-sse/handlers/chatCore.js');
const { memoClear } = await import('../../open-sse/services/memory/sessionMemo.js');
const log = { debug() {}, info() {}, warn() {}, line() {}, tagForSession: () => 'OFFLINE', nextTag: () => 'OFFLINE', fmtThink: () => null };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); memoClear(); });
it.each([false, true])('matches actual gateway stage output before final anchoring with lossy consent %s', async allowLossy => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', async () => { throw new Error('No provider or service calls allowed'); });
  const settings = mergeWithDefaults({ rtkEnabled: true, rtkAllowLossy: allowLossy, schemaDistillEnabled: true, schemaAllowLossy: allowLossy, thinkingStripEnabled: true, queryAwareCompressionEnabled: true, pairDropEnabled: true, memoryCompactionEnabled: allowLossy, cavemanEnabled: true, ponytailEnabled: true, midPrefixInjectEnabled: true });
  const fixtures = fixtureSet('context-integrity-v1');
  for (let i = 0; i < fixtures.length; i++) {
    memoClear(); audit.snapshot = null;
    const fixture = fixtures[i], body = structuredClone(fixture.body);
    const result = await handleChatCore({ requestId: `shaping-parity-${i}`, body, modelInfo: { provider: 'minimax', model: body.model }, credentials: { apiKey: 'fixture-only', providerSpecificData: {} }, connectionId: 'fixture-only', sid: `shaping-parity-${i}`, clientRawRequest: { endpoint: '/v1/messages', headers: { 'user-agent': 'claude-cli/1.0.0 (external, cli)' } }, log, ...settings, privacyEnabled: false, memorySettings: { ...settings, memoryContextWindowOverride: fixture.contextWindow } });
    await result.response.text();
    expect(result.response.status).toBe(200); expect(audit.snapshot).not.toBeNull();
    const gatewayOutput = structuredClone(audit.snapshot), entry = structuredClone(audit.entry);
    const offline = await evaluateSettings(settings, 'context-integrity-v1', { fixtures: [{ ...fixture, body: entry }] });
    for (const key of ['messages', 'system', 'tools']) expect(gatewayOutput[key], `${fixture.id} ${key}`).toEqual(offline.results[0].output[key]);
  }
});
