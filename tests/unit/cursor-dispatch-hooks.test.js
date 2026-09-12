import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), fetch: vi.fn() }));
vi.mock('node:http2', () => ({ connect: mocks.connect }));
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: mocks.fetch, resolveEffectiveProxyRoute: vi.fn() }));
vi.mock('../../open-sse/utils/http2Connect.js', () => ({ connectHttp2: vi.fn() }));
import { CursorExecutor } from '../../open-sse/executors/cursor.js';
import TraeExecutor from '../../open-sse/executors/trae.js';
import { DevinCliExecutor } from '../../open-sse/executors/devin-cli.js';
let client, req;
beforeEach(() => {
  mocks.connect.mockReset(); mocks.fetch.mockReset();
  client = new EventEmitter(); req = new EventEmitter();
  Object.assign(req, { write: vi.fn(), end: vi.fn(), destroy: vi.fn(), pause: vi.fn(), resume: vi.fn() });
  Object.assign(client, { close: vi.fn(), request: vi.fn(() => req) });
  mocks.connect.mockReturnValue(client);
});
afterEach(() => vi.restoreAllMocks());
const url = 'https://cursor.example/generate', wire = Buffer.from([0, 0, 0, 1, 8]);
it.each(['fetch', 'http2'])('denies %s admission before any transport and keeps binary encoding honest', async method => {
  const error = new Error('cap-refused'), beforeDispatch = vi.fn(async info => {
    expect(info).toEqual({ body: null, serialized: wire, url, structuralEncoding: 'protobuf', byteLength: wire.length });
    throw error;
  });
  const ex = new CursorExecutor();
  const result = method === 'fetch' ? ex.makeFetchRequest(url, {}, wire, null, null, null, { beforeDispatch }) : ex.makeHttp2Request(url, {}, wire, null, null, { beforeDispatch });
  await expect(result).rejects.toBe(error);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.connect).not.toHaveBeenCalled();
});
it('fetch observes headers before consuming binary response and cancels on hook failure', async () => {
  const cancel = vi.fn(), error = new Error('accounting-refused');
  const response = new Response(new ReadableStream({ cancel }), { status: 200 });
  mocks.fetch.mockResolvedValue(response);
  const afterDispatch = vi.fn(async info => { expect(info.response).toBe(response); throw error; });
  await expect(new CursorExecutor().makeFetchRequest(url, {}, wire, null, null, null, { afterDispatch })).rejects.toBe(error);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(mocks.fetch.mock.calls[0][1].body).toBe(wire);
});
it('HTTP2 observes actual header event and waits for accounting before returning buffered output', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const afterDispatch = vi.fn(async ({ response }) => {
    expect(response.status).toBe(403);
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    await gate;
  });
  let complete = false;
  const pending = new CursorExecutor().makeHttp2Request(url, {}, wire, null, null, { afterDispatch }).then(result => { complete = true; return result; });
  await Promise.resolve();
  expect(req.write).toHaveBeenCalledExactlyOnceWith(wire);
  req.emit('response', { ':status': 403, 'x-tokenproxy-replay-safe': 'false' });
  expect(afterDispatch).toHaveBeenCalledTimes(1);
  expect(req.pause).toHaveBeenCalledTimes(1);
  req.emit('data', Buffer.from('denied'));
  req.emit('end');
  await Promise.resolve();
  expect(complete).toBe(false);
  release();
  const result = await pending;
  expect(result.status).toBe(403);
  expect(result.body.toString()).toBe('denied');
});
it('HTTP2 accounting rejection closes the stream and remains the original exception', async () => {
  const failure = new Error('ledger down');
  const pending = new CursorExecutor().makeHttp2Request(url, {}, wire, null, null, { afterDispatch: async () => { throw failure; } });
  const rejected = expect(pending).rejects.toBe(failure);
  await Promise.resolve();
  req.emit('response', { ':status': 200 });
  await rejected;
  expect(req.destroy).toHaveBeenCalled();
  expect(client.close).toHaveBeenCalledTimes(1);
});
it('execute preserves legacy dispatch refusal and does not turn it into upstream500', async () => {
  const refusal = Object.freeze(new Error('budget refused'));
  await expect(new CursorExecutor().execute({
    model: 'gpt-5.2', stream: false,
    body: { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'run', arguments: '{}' } }] }] },
    credentials: { accessToken: 'test', providerSpecificData: { machineId: 'a'.repeat(64) } },
    proxyOptions: { enabled: true }, beforeDispatch: async () => { throw refusal; },
  })).rejects.toBe(refusal);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it.each([
  ['Cursor', CursorExecutor],
  ['Trae', TraeExecutor],
  ['Devin CLI', DevinCliExecutor],
])('keeps opaque service/subprocess coverage explicitly unsupported for %s', (_name, Executor) => {
  const executor = new Executor();
  expect(executor.supportsBudgetDispatch).toBe(false);
  expect(executor.budgetDispatchUnsupportedReason).toMatch(/opaque|Opaque/);
});
it('does not invent a physical boundary around opaque AgentService work', async () => {
  const executor = new CursorExecutor();
  vi.spyOn(executor, 'executeAgent').mockResolvedValue({ response: new Response('agent result') });
  const beforeDispatch = vi.fn(), afterDispatch = vi.fn();
  const result = await executor.execute({ model: 'gpt-5.2', body: { messages: [{ role: 'user', content: 'hi' }] }, credentials: {}, beforeDispatch, afterDispatch });
  expect(await result.response.text()).toBe('agent result');
  expect(beforeDispatch).not.toHaveBeenCalled();
  expect(afterDispatch).not.toHaveBeenCalled();
});
