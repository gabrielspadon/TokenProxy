// Issue #2722: "API call failed after 4 retries: Internal server error" — a
// thin report, but the upstream's own words are still the spec once you trace
// where that generic phrase comes from. It is DEFAULT_ERROR_MESSAGES[500] in
// utils/error.js, which only fires when parseUpstreamError sees an empty
// response body. The retry loop in BaseExecutor.execute can retry a status
// several times before giving up, and it is common for an upstream's earlier
// attempts to carry a real error body while the final, exhausted attempt
// comes back empty — losing the only useful message the client ever saw.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import('../../open-sse/executors/base.js');
const { parseUpstreamError } = await import('../../open-sse/utils/error.js');

function realRes(status, body = '') {
  return new Response(body, { status, headers: { 'x-tokenproxy-replay-safe': 'true' } });
}

// Minimal fake matching the existing retry-behavior test suite (no clone()).
function fakeRes(status) {
  return { status, headers: new Headers({ 'x-tokenproxy-replay-safe': 'true' }) };
}

const creds = { apiKey: 'k' };

beforeEach(() => fetchMock.mockReset());

describe('BaseExecutor.execute — last useful retry error survives exhaustion (#2722)', () => {
  it("keeps an earlier attempt's error body when the final retry comes back empty", async () => {
    const ex = new BaseExecutor('test', {
      baseUrl: 'https://x/api',
      retry: { 500: { attempts: 2, delayMs: 0 } },
    });
    fetchMock
      .mockResolvedValueOnce(
        realRes(500, JSON.stringify({ error: { message: 'model overloaded, try another region' } }))
      )
      .mockResolvedValueOnce(
        realRes(500, JSON.stringify({ error: { message: 'model overloaded, try another region' } }))
      )
      .mockResolvedValueOnce(realRes(500, '')); // exhausted: empty body

    const out = await ex.execute({ model: 'm', body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(500);

    const parsed = await parseUpstreamError(out.response);
    expect(parsed.message).toBe('model overloaded, try another region');
    expect(parsed.message).not.toBe('Internal server error');
  });

  it('leaves a final response with its own body untouched', async () => {
    const ex = new BaseExecutor('test', {
      baseUrl: 'https://x/api',
      retry: { 500: { attempts: 1, delayMs: 0 } },
    });
    fetchMock
      .mockResolvedValueOnce(
        realRes(500, JSON.stringify({ error: { message: 'transient glitch' } }))
      )
      .mockResolvedValueOnce(
        realRes(500, JSON.stringify({ error: { message: 'quota exceeded for today' } }))
      );

    const out = await ex.execute({ model: 'm', body: {}, stream: false, credentials: creds });
    const parsed = await parseUpstreamError(out.response);
    expect(parsed.message).toBe('quota exceeded for today');
  });

  it('does not touch response doubles that lack clone() (existing retry tests)', async () => {
    const ex = new BaseExecutor('test', {
      baseUrl: 'https://x/api',
      retry: { 502: { attempts: 2, delayMs: 0 } },
    });
    fetchMock.mockResolvedValue(fakeRes(502));
    const out = await ex.execute({ model: 'm', body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
