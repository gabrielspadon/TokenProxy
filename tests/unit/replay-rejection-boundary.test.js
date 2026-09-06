import { beforeEach, expect, it, vi } from 'vitest';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: fetchMock }));
import { BaseExecutor } from '../../open-sse/executors/base.js';
import { isReplaySafeRejection } from '../../open-sse/utils/replaySafety.js';
import { parseUpstreamError } from '../../open-sse/utils/error.js';
const options = { model: 'fixture', body: { messages: [] }, stream: false, credentials: { apiKey: 'mock' } };
const executor = retry => new BaseExecutor('fixture', { baseUrls: ['https://a.invalid', 'https://b.invalid'], retry });
beforeEach(() => fetchMock.mockReset());

it.each([408,409,500,502,503,504,507])('does not replay an ambiguous HTTP%s against another URL', async status => {
  const upstream = new Response('uncertain', { status });
  fetchMock.mockResolvedValueOnce(upstream).mockResolvedValue(new Response('unexpected'));
  const result = await executor({ [status]: { attempts: 3, delayMs: 0 } }).execute(options);
  expect(result.response).toBe(upstream); expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await result.response.text()).toBe('uncertain');
});

it.each(['x-tokenproxy-replay-safe','x-should-retry'])('honors %s denial before a configured retry or fallback', async header => {
  const upstream = new Response('already accepted', { status: 429, headers: { 'x-tokenproxy-replay-safe':'true', [header]:'false' } });
  fetchMock.mockResolvedValueOnce(upstream);
  const result = await executor({429:{attempts:3,delayMs:0}}).execute(options);
  expect(result.response).toBe(upstream); expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('requires an error rejection and never lets explicit true override a veto', () => {
  for (const status of [400,401,402,403,404,405,413,415,422,429]) expect(isReplaySafeRejection(new Response(null,{status}))).toBe(true);
  for (const status of [200,201,301,408,409,500,502,503]) expect(isReplaySafeRejection(new Response(null,{status}))).toBe(false);
  expect(isReplaySafeRejection(new Response(null,{status:503,headers:{'x-tokenproxy-replay-safe':'true'}}))).toBe(true);
  expect(isReplaySafeRejection(new Response(null,{status:503,headers:{'x-tokenproxy-replay-safe':'true','x-should-retry':'false'}}))).toBe(false);
});

it('cancels a rejected response before an abortable retry delay and makes no second dispatch', async () => {
  const upstream = new Response('rejected', {status:429});
  const controller = new AbortController();
  fetchMock.mockResolvedValueOnce(upstream);
  const run = executor({429:{attempts:1,delayMs:5000}}).execute({...options,signal:controller.signal});
  // Attach rejection handling before abort to avoid a floating rejection.
  const rejected = run.then(value=>({value}),error=>({error}));
  // Response.clone replaces the source with a tee branch. Its eventual
  // cancellation disturbs that branch, rather than the pre-clone stream.
  try { await vi.waitFor(()=>expect(upstream.bodyUsed).toBe(true)); }
  catch (error) { controller.abort(); await rejected; throw error; }
  const started = performance.now(); controller.abort();
  expect((await rejected).error).toMatchObject({name:'AbortError'});
  expect(performance.now()-started).toBeLessThan(500);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('cancels oversized discarded diagnostics before a permitted retry', async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({cancel(){cancelled=true;}}), {status:503,headers:{'content-length':'1048576','x-tokenproxy-replay-safe':'true'}});
  fetchMock.mockResolvedValueOnce(upstream).mockImplementationOnce(async()=>{expect(cancelled).toBe(true);return new Response('ok');});
  const result = await executor({503:{attempts:1,delayMs:0}}).execute(options);
  expect(await result.response.text()).toBe('ok'); expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('bounded final diagnostic inspection cancels the source and keeps unknown content unknown', async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({cancel(){cancelled=true;}}), {status:503,headers:{'content-length':'1048576'}});
  const parsed = await parseUpstreamError(upstream);
  expect(parsed.statusCode).toBe(503); expect(parsed.errorPayload).toBeNull(); expect(cancelled).toBe(true);
});

it('caller cancellation interrupts a stalled diagnostic body', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const upstream = new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:429});
  const run = parseUpstreamError(upstream,null,{signal:controller.signal});
  const rejected = expect(run).rejects.toMatchObject({name:'AbortError'});
  controller.abort(); await rejected;
  await vi.waitFor(()=>expect(cancelled).toBe(true));
});
