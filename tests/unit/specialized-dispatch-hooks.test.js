import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ wire: vi.fn() }));
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: (...args) => mocks.wire(...args) }));
vi.mock('../../open-sse/services/qoderModels.js', () => ({
  getQoderModelConfig: async () => ({ key: 'auto', source: 'system', display_name: 'Auto' }),
  resolveQoderModels: async () => ({ rawConfigs: new Map() }),
  isQoderPat: () => false,
  resolveQoderCredentials: async c => c,
}));
import PerplexityWebExecutor from '../../open-sse/executors/perplexity-web.js';
import GrokWebExecutor from '../../open-sse/executors/grok-web.js';
import { WindsurfExecutor } from '../../open-sse/executors/windsurf.js';
import { DevinExecutor } from '../../open-sse/executors/devin.js';
import QoderExecutor from '../../open-sse/executors/qoder.js';
import ZenmuxFreeExecutor from '../../open-sse/executors/zenmux-free.js';
const rows = [
  ['perplexity', PerplexityWebExecutor, 'sonar-pro', { apiKey: 'test' }, 'json'],
  ['grok-web', GrokWebExecutor, 'grok-4.1-fast', { apiKey: 'test' }, 'json'],
  ['windsurf', WindsurfExecutor, 'swe-1', { apiKey: 'test' }, 'protobuf'],
  ['devin', DevinExecutor, 'swe-1-7', { accessToken: 'test' }, 'protobuf'],
  ['qoder', QoderExecutor, 'auto', { accessToken: 'dt-test', providerSpecificData: { userId: 'u', machineId: 'm' } }, 'binary'],
  ['zenmux-free', ZenmuxFreeExecutor, 'deepseek-v4-pro', { apiKey: 'ctoken=test' }, 'json'],
];
const generation = url => !/GetUserJwt|addRound|updateRound/.test(String(url));
let upstream;
beforeEach(() => {
  upstream = new Response('rejected', { status: 401 });
  mocks.wire.mockReset().mockImplementation(async url => {
    if (String(url).includes('GetUserJwt')) return new Response(Buffer.from([10, 3, 106, 119, 116]));
    if (String(url).includes('addRound')) return new Response('{}');
    return upstream;
  });
  vi.stubGlobal('fetch', mocks.wire);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const [name, Executor, model, credentials, encoding] of rows) {
  const options = extra => ({ model, credentials, body: { messages: [{ role: 'user', content: 'prepare α exactly' }] }, stream: true, ...extra });
  describe(name, () => {
    it('admits the exact prepared wire once and observes actual headers before translation', async () => {
      const events = [], beforeDispatch = vi.fn(async info => events.push(['before', info]));
      const afterDispatch = vi.fn(async info => { expect(info.response).toBe(upstream); events.push(['after']); });
      const actualWire = mocks.wire.getMockImplementation();
      mocks.wire.mockImplementation(async (...args) => { if (generation(args[0])) events.push(['wire']); return actualWire(...args); });
      const executor = new Executor();
      const result = await executor.execute(options({ beforeDispatch, afterDispatch }));
      expect(executor.supportsBudgetDispatch).toBe(true);
      expect(events.map(e => e[0])).toEqual(['before', 'wire', 'after']);
      const info = beforeDispatch.mock.calls[0][0];
      const [url, init] = mocks.wire.mock.calls.find(([u]) => generation(u));
      expect(info.url).toBe(url);
      expect(info.serialized).toBe(init.body);
      if (encoding === 'json') expect(JSON.parse(info.serialized)).toEqual(info.body);
      else {
        expect(info).toMatchObject({ body: null, structuralEncoding: encoding, byteLength: init.body.byteLength });
        expect(ArrayBuffer.isView(info.serialized)).toBe(true);
      }
      expect(afterDispatch).toHaveBeenCalledTimes(1);
      expect(result.response.status).toBe(401);
    });
    it('propagates admission refusal unchanged with no paid send', async () => {
      const refusal = Object.freeze(Object.assign(new Error('cap refused'), { code: 'budget_exhausted' }));
      await expect(new Executor().execute(options({ beforeDispatch: async () => { throw refusal; } }))).rejects.toBe(refusal);
      expect(mocks.wire.mock.calls.filter(([url]) => generation(url))).toHaveLength(0);
    });
    it('cancels an unused response and preserves an accounting exception', async () => {
      const cancel = vi.fn();
      upstream = new Response(new ReadableStream({ cancel }), { status: 200 });
      const refusal = Object.freeze(new Error('accounting unavailable'));
      await expect(new Executor().execute(options({ beforeDispatch: async () => {}, afterDispatch: async () => { throw refusal; } }))).rejects.toBe(refusal);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(mocks.wire.mock.calls.filter(([url]) => generation(url))).toHaveLength(1);
    });
    it('does not send generation if cancelled while admission is pending', async () => {
      const controller = new AbortController();
      const reason = new DOMException('cancelled', 'AbortError');
      await expect(new Executor().execute(options({ signal: controller.signal, beforeDispatch: async () => controller.abort(reason) }))).rejects.toBe(reason);
      expect(mocks.wire.mock.calls.filter(([url]) => generation(url))).toHaveLength(0);
    });
    it('does not replay an uncertain transport failure or fabricate response headers', async () => {
      const actualWire = mocks.wire.getMockImplementation();
      mocks.wire.mockImplementation(async (...args) => { if (generation(args[0])) throw new TypeError('connection reset'); return actualWire(...args); });
      const beforeDispatch = vi.fn(), afterDispatch = vi.fn();
      try {
        const result = await new Executor().execute(options({ beforeDispatch, afterDispatch }));
        expect(result.response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
      }
      expect(beforeDispatch).toHaveBeenCalledTimes(1);
      expect(afterDispatch).not.toHaveBeenCalled();
      expect(mocks.wire.mock.calls.filter(([url]) => generation(url))).toHaveLength(1);
    });
  });
}

for (const [name, Executor, model, credentials] of rows.filter(r => ['perplexity', 'grok-web', 'zenmux-free'].includes(r[0]))) {
  it(`${name} normalization retains replay denial and cooldown without forwarding private cookies`, async () => {
    upstream = new Response('rejected', { status: 401, headers: { 'x-tokenproxy-replay-safe': 'false', 'retry-after': '17', 'set-cookie': 'private-session=test' } });
    const result = await new Executor().execute({ model, credentials, body: { messages: [{ role: 'user', content: 'hi' }] }, stream: true, beforeDispatch: async () => {}, afterDispatch: async () => {} });
    expect(result.response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect(result.response.headers.get('retry-after')).toBe('17');
    expect(result.response.headers.get('set-cookie')).toBeNull();
  });
}
