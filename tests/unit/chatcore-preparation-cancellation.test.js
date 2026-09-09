import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ service: null, entered: null, execute: vi.fn(), signal: null }));
const waiting = vi.hoisted(() => (name, signal) => {
  if (state.service !== name) return null;
  state.signal = signal; state.entered();
  return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
});
vi.mock('../../open-sse/executors/index.js', () => ({ getExecutor: () => ({ noAuth: true, execute: state.execute }) }));
vi.mock('../../open-sse/translator/concerns/prefetch.js', async original => {
  const actual = await original();
  return { ...actual, prefetchRemoteImages: (_body, _source, _target, options) => {
    if (state.service === 'media_limit') throw new actual.MediaAggregateLimitError();
    return waiting('media', options.signal) ?? 0;
  } };
});
vi.mock('../../open-sse/rtk/headroom.js', async original => ({ ...(await original()), compressWithHeadroom: (_body, options) => options.enabled ? waiting('headroom', options.signal) : null }));
vi.mock('../../open-sse/utils/embedReorder.js', async original => ({ ...(await original()), reorderByRelevance: (messages, options) => waiting('embedding', options.signal) ?? { messages, moved: 0, notes: [] } }));
vi.mock('../../open-sse/rtk/pxpipe.js', async original => ({ ...(await original()), compressWithPxpipe: (_body, options) => waiting('pxpipe', options.signal) ?? { body: null, summary: {} } }));
vi.mock('../../open-sse/utils/requestLogger.js', () => ({ createRequestLogger: async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {}, logError() {} }) }));
vi.mock('@/lib/usageDb.js', () => ({ trackPendingRequest() {}, async appendRequestLog() {}, async saveRequestDetail() {}, async saveRequestUsage() {} }));
const { handleChatCore } = await import('../../open-sse/handlers/chatCore.js');
const { getAdapter } = await import('../../src/lib/db/driver.js');
beforeEach(() => { state.service = null; state.signal = null; state.execute.mockReset(); });
afterEach(() => vi.unstubAllGlobals());
describe('gateway preparation cancellation boundary', () => {
  for (const service of ['media', 'headroom', 'embedding', 'pxpipe']) it(`returns caller cancellation during ${service} without invoking a provider`, async () => {
    state.service = service;
    const entered = new Promise(resolve => { state.entered = resolve; });
    const caller = new AbortController();
    const body = service === 'media'
      ? { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://images.test/a' } }] }], stream: false }
      : { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'Earlier question context' }, { role: 'assistant', content: 'Earlier response' }, { role: 'user', content: 'Current question context' }], stream: false };
    const before = structuredClone(body);
    const task = handleChatCore({ body, modelInfo: { provider: service === 'media' ? 'gemini' : 'anthropic', model: body.model },
      credentials: { apiKey: 'fixture', providerSpecificData: {} }, connectionId: 'fixture', callerSignal: caller.signal,
      contextTelemetry: { logicalRequestId: `cancel-${service}`, attempt: 3 },
      contextStructureEnabled: false, headroomEnabled: service === 'headroom', embedReorderEnabled: service === 'embedding', pxpipeEnabled: service === 'pxpipe',
      headroomUrl: 'http://localhost:8787', embedReorderUrl: 'http://localhost:11434/v1/embeddings', embedReorderModel: 'fixture',
      clientRawRequest: { headers: { 'user-agent': 'fixture-harness' } }, log: { debug() {}, info() {}, warn() {} } });
    await entered;
    caller.abort();
    expect(await task).toMatchObject({ status: 499, clientAborted: true });
    expect(state.signal.aborted).toBe(true); expect(state.execute).not.toHaveBeenCalled(); expect(body).toEqual(before);
    if (service !== 'media') {
      const db = await getAdapter();
      const rows = db.all('SELECT * FROM requestStats WHERE logicalRequestId=?', [`cancel-${service}`]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ attempt: 3, status: 'aborted', dispatchCoverage: 'preparation-only', usageSource: 'missing' });
      const stages = db.all('SELECT * FROM contextStages WHERE requestId=? ORDER BY ordinal', [rows[0].id]);
      expect(stages.at(-1)).toMatchObject({ stage: service === 'embedding' ? 'reorder' : service,
        outcome: 'cancelled', outcomeSource: 'execution', errorCode: 'caller_cancelled', deltaBytes: 0 });
      expect(stages.some(stage => stage.outcome === 'failed')).toBe(false);
    }
  }, 1000);
  it('does no preparation or provider work for an already-aborted caller', async () => {
    const caller = new AbortController(); caller.abort();
    const result = await handleChatCore({ callerSignal: caller.signal, modelInfo: { provider: 'openai', model: 'fixture' }, body: {} });
    expect(result).toMatchObject({ status: 499, clientAborted: true }); expect(state.execute).not.toHaveBeenCalled();
  });
  it('returns an explicit size refusal before dispatch when aggregate media is too large', async () => {
    state.service = 'media_limit';
    const result = await handleChatCore({ body: { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Image request' }], stream: false },
      modelInfo: { provider: 'gemini', model: 'gemini-2.5-flash' }, credentials: { apiKey: 'fixture', providerSpecificData: {} },
      connectionId: 'fixture', contextStructureEnabled: false, clientRawRequest: { headers: { 'user-agent': 'fixture-harness' } } });
    expect(result.status).toBe(413); expect(state.execute).not.toHaveBeenCalled();
  });
});
