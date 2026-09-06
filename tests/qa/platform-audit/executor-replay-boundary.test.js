import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: mocks.fetch }));
const { BaseExecutor } = await import('../../../open-sse/executors/base.js');
const { parseUpstreamError, extractRetryAfterDeadline } = await import('../../../open-sse/utils/error.js');
const options = { model: 'fixture', body: { messages: [{ role: 'user', content: 'One generation only.' }] }, credentials: { apiKey: 'fixture' }, stream: false };
const executor = () => new BaseExecutor('fixture', { baseUrls: ['https://a.invalid', 'https://b.invalid'], retry: { 200: { attempts: 1, delayMs: 0 }, 502: { attempts: 2, delayMs: 0 }, 503: { attempts: 1, delayMs: 0 } } });
beforeEach(() => mocks.fetch.mockReset());

describe('independent executor POST replay boundary', () => {
  it.each([429, 503])('returns a %i provider deadline intact without retry or URL fallback', async (status) => {
    for (const retryAfter of ['30', new Date(Date.now() + 60_000).toUTCString()]) {
      mocks.fetch.mockReset();
      const rejected = Response.json({ error: { message: 'Explicit rejection with deadline' } }, { status, headers: { 'retry-after': retryAfter } });
      mocks.fetch.mockResolvedValueOnce(rejected).mockResolvedValue(Response.json({ answer: 'too early' }));
      const result = await executor().execute(options);
      expect(result.response).toBe(rejected);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      const parsed = await parseUpstreamError(result.response);
      expect(parsed.statusCode).toBe(status);
      expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + 29_000);
    }
  });

  it.each(['not-a-date', '-5', '0', 'Infinity', '1e308', 'Wed, 01 Jan 2020 00:00:00 GMT'])('ignores invalid or nonfuture Retry-After %s while retaining bounded explicit-rejection retries', async (retryAfter) => {
    const response = Response.json({ error: 'overloaded' }, { status: 503, headers: { 'retry-after': retryAfter } });
    expect(extractRetryAfterDeadline(response)).toBeNull();
    mocks.fetch.mockResolvedValueOnce(response).mockResolvedValue(Response.json({ answer: 'once' }));
    expect((await executor().execute(options)).response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['ECONNRESET after request write', 'fetch failed', 'upstream socket closed'])('never retries an uncertain transport failure %s', async (message) => {
    const error = new Error(message);
    mocks.fetch.mockRejectedValueOnce(error).mockResolvedValue(Response.json({ answer: 'duplicate' }));
    await expect(executor().execute(options)).rejects.toBe(error);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry accepted 200 even if retry configuration mistakenly includes it', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ answer: 'once' }));
    expect((await executor().execute(options)).response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('retains a bounded retry for an explicit rejected HTTP response', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: 'overloaded' }, { status: 503 })).mockResolvedValue(Response.json({ answer: 'once' }));
    expect((await executor().execute(options)).response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it('does not dispatch after the caller aborts during a rejected attempt', async () => {
    const abort = new AbortController();
    mocks.fetch.mockImplementationOnce(async () => { abort.abort(); return Response.json({ error: 'overloaded' }, { status: 503 }); }).mockResolvedValue(Response.json({ answer: 'duplicate' }));
    await expect(executor().execute({ ...options, signal: abort.signal })).rejects.toHaveProperty('name', 'AbortError');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
