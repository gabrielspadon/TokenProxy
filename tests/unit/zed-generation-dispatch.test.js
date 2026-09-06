import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from '../../open-sse/utils/proxyFetch.js';
import { zedLlmFetch, clearZedCaches, ZED_HEADERS } from '../../open-sse/shared/zedAuth.js';
import ZedExecutor from '../../open-sse/executors/zed.js';
const credentials = { accessToken: 'private-test', providerSpecificData: { userId: 'u', organizationId: 'o' } };
const document = { model: 'test', messages: [{ role: 'user', content: 'exact α' }] };
const serialized = JSON.stringify(document);
const options = extra => ({ dispatchBody: document, fetchOptions: { method: 'POST', body: serialized }, ...extra });
const paidCalls = () => proxyAwareFetch.mock.calls.filter(([url]) => String(url).endsWith('/completions'));
let replies;
beforeEach(() => {
  clearZedCaches(); replies = [];
  proxyAwareFetch.mockReset().mockImplementation(async url => {
    if (String(url).includes('/llm_tokens')) return Response.json({ token: 'short-test' });
    return replies.shift();
  });
});
afterEach(() => vi.restoreAllMocks());
it.each([ZED_HEADERS.expiredToken, ZED_HEADERS.outdatedToken])('never replays accepted200 carrying %s', async header => {
  replies.push(new Response('accepted-output', { headers: { [header]: 'true' } }), new Response('must-not-send'));
  const result = await zedLlmFetch(credentials, '/completions', options());
  expect(paidCalls()).toHaveLength(1);
  expect(await result.text()).toBe('accepted-output');
});
it.each([401, 403])('cancels explicit rejected %s then admits every fresh wire attempt in order', async status => {
  const cancel = vi.fn(), events = [];
  replies.push(new Response(new ReadableStream({ cancel }), { status }), new Response('answer'));
  const beforeDispatch = vi.fn(async info => { expect(info.serialized).toBe(serialized); expect(info.body).toEqual(document); events.push('before'); });
  const afterDispatch = vi.fn(async ({ response }) => events.push(`after${response.status}`));
  const original = proxyAwareFetch.getMockImplementation();
  proxyAwareFetch.mockImplementation(async (...args) => { if (String(args[0]).endsWith('/completions')) events.push('wire'); return original(...args); });
  const response = await zedLlmFetch(credentials, '/completions', options({ beforeDispatch, afterDispatch }));
  expect(await response.text()).toBe('answer');
  expect(events).toEqual(['before', 'wire', `after${status}`, 'before', 'wire', 'after200']);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(paidCalls().map(([, init]) => init.body)).toEqual([serialized, serialized]);
});
it.each([200, 401, 403, 429, 503])('preserves exposure when %s explicitly forbids replay', async status => {
  replies.push(new Response('intact', { status, headers: { [ZED_HEADERS.expiredToken]: 'true', 'x-tokenproxy-replay-safe': 'false' } }), new Response('duplicate'));
  const beforeDispatch = vi.fn(), afterDispatch = vi.fn();
  const response = await zedLlmFetch(credentials, '/completions', options({ beforeDispatch, afterDispatch }));
  expect(paidCalls()).toHaveLength(1);
  expect(afterDispatch).toHaveBeenCalledExactlyOnceWith({ response });
  expect(await response.text()).toBe('intact');
});
it('refuses a second admission after auth rejection before its paid transport', async () => {
  replies.push(new Response('expired', { status: 401 }), new Response('must-not-send'));
  const refusal = new Error('budget cap');
  const beforeDispatch = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(refusal);
  await expect(zedLlmFetch(credentials, '/completions', options({ beforeDispatch }))).rejects.toBe(refusal);
  expect(paidCalls()).toHaveLength(1);
});
it('preserves GET catalog refresh without generation hooks', async () => {
  replies.push(new Response('expired', { headers: { [ZED_HEADERS.outdatedToken]: 'true' } }), new Response('catalog'));
  const beforeDispatch = vi.fn(), afterDispatch = vi.fn();
  const response = await zedLlmFetch(credentials, '/models', { fetchOptions: { method: 'GET' }, beforeDispatch, afterDispatch });
  expect(await response.text()).toBe('catalog');
  expect(beforeDispatch).not.toHaveBeenCalled();
  expect(afterDispatch).not.toHaveBeenCalled();
});
it('real executor wires its prepared provider envelope through the actual token/retry helper', async () => {
  const executor = new ZedExecutor();
  vi.spyOn(executor, 'resolveModel').mockResolvedValue({ provider: 'XAi' });
  replies.push(new Response('rejected', { status: 403 }), new Response('rejected again', { status: 403 }));
  const beforeDispatch = vi.fn(), afterDispatch = vi.fn();
  const result = await executor.execute({ model: 'grok-4', body: document, credentials, stream: true, beforeDispatch, afterDispatch });
  expect(executor.supportsBudgetDispatch).toBe(true);
  expect(paidCalls()).toHaveLength(2);
  expect(beforeDispatch).toHaveBeenCalledTimes(2);
  expect(afterDispatch).toHaveBeenCalledTimes(2);
  const info = beforeDispatch.mock.calls[0][0];
  expect(JSON.parse(info.serialized)).toEqual(info.body);
  expect(info.body.provider).toBe('XAi');
  expect(result.response.status).toBe(403);
});
it('accounting failure at rejected headers cancels the body and prevents hidden retry', async () => {
  const cancel = vi.fn(), refusal = new Error('accounting unavailable');
  replies.push(new Response(new ReadableStream({ cancel }), { status: 401 }), new Response('duplicate'));
  await expect(zedLlmFetch(credentials, '/completions', options({ afterDispatch: async () => { throw refusal; } }))).rejects.toBe(refusal);
  expect(paidCalls()).toHaveLength(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('cancellation during admission prevents the generation transport', async () => {
  const controller = new AbortController(), reason = new DOMException('cancelled', 'AbortError');
  await expect(zedLlmFetch(credentials, '/completions', options({ signal: controller.signal, beforeDispatch: async () => controller.abort(reason) }))).rejects.toBe(reason);
  expect(paidCalls()).toHaveLength(0);
});
