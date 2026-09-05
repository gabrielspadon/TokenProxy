// BaseExecutor request-construction and error-propagation contract.
// Complements base-executor-retry.test.js (retry/fallback) and
// base-executor-connect-timeout.test.js (deadlines): this file locks
// buildUrl/buildHeaders/parseError, the pieces that decide which host gets
// the auth token and whether an upstream error body reaches the caller.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import('../../open-sse/executors/base.js');
const { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } =
  await import('../../open-sse/providers/shared.js');

beforeEach(() => fetchMock.mockReset());

describe('BaseExecutor.buildUrl', () => {
  it('openai-compatible: appends /chat/completions to the stored base, trailing slash normalized', () => {
    const ex = new BaseExecutor('openai-compatible-x', {});
    const url = ex.buildUrl('m', true, 0, {
      providerSpecificData: { baseUrl: 'https://my-gw.example/v1/' },
    });
    expect(url).toBe('https://my-gw.example/v1/chat/completions');
  });

  it('openai-compatible: falls back to OPENAI_COMPAT_BASE without a stored base', () => {
    const ex = new BaseExecutor('openai-compatible-x', {});
    expect(ex.buildUrl('m', true, 0, {})).toBe(`${OPENAI_COMPAT_BASE}/chat/completions`);
  });

  it('anthropic-compatible: appends /messages', () => {
    const ex = new BaseExecutor('anthropic-compatible-x', {});
    expect(
      ex.buildUrl('m', true, 0, { providerSpecificData: { baseUrl: 'https://a.example/v1/' } })
    ).toBe('https://a.example/v1/messages');
    expect(ex.buildUrl('m', true, 0, {})).toBe(`${ANTHROPIC_COMPAT_BASE}/messages`);
  });

  it('plain provider: urlIndex selects among baseUrls, out-of-range falls back to [0]', () => {
    const ex = new BaseExecutor('p', { baseUrls: ['https://a/x', 'https://b/x'] });
    expect(ex.buildUrl('m', true, 0)).toBe('https://a/x');
    expect(ex.buildUrl('m', true, 1)).toBe('https://b/x');
    expect(ex.buildUrl('m', true, 5)).toBe('https://a/x');
    expect(ex.getFallbackCount()).toBe(2);
  });
});

describe('BaseExecutor.buildHeaders — auth placement', () => {
  it('standard provider: accessToken wins over apiKey, Bearer scheme', () => {
    const ex = new BaseExecutor('p', { baseUrl: 'https://p/x' });
    const h = ex.buildHeaders({ accessToken: 'tok-a', apiKey: 'key-b' });
    expect(h['Authorization']).toBe('Bearer tok-a');
    expect(h['x-api-key']).toBeUndefined();
  });

  it('anthropic-compatible: apiKey goes to x-api-key, never Authorization, and version header is set', () => {
    const ex = new BaseExecutor('anthropic-compatible-x', { baseUrl: 'https://a/x' });
    const h = ex.buildHeaders({ apiKey: 'sk-ant' });
    expect(h['x-api-key']).toBe('sk-ant');
    expect(h['Authorization']).toBeUndefined();
    expect(h['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
  });

  it('anthropic-compatible: OAuth-only credentials fall back to Bearer', () => {
    const ex = new BaseExecutor('anthropic-compatible-x', { baseUrl: 'https://a/x' });
    const h = ex.buildHeaders({ accessToken: 'oat' });
    expect(h['Authorization']).toBe('Bearer oat');
    expect(h['x-api-key']).toBeUndefined();
  });

  it('Accept: text/event-stream only when streaming', () => {
    const ex = new BaseExecutor('p', { baseUrl: 'https://p/x' });
    expect(ex.buildHeaders({ apiKey: 'k' }, true)['Accept']).toBe('text/event-stream');
    expect(ex.buildHeaders({ apiKey: 'k' }, false)['Accept']).toBeUndefined();
  });

  it('config headers are merged but do not clobber Content-Type semantics', () => {
    const ex = new BaseExecutor('p', { baseUrl: 'https://p/x', headers: { 'X-Custom': '1' } });
    const h = ex.buildHeaders({ apiKey: 'k' });
    expect(h['X-Custom']).toBe('1');
    expect(h['Content-Type']).toBe('application/json');
  });
});

describe('BaseExecutor.parseError — status and body reach the caller', () => {
  const ex = new BaseExecutor('p', { baseUrl: 'https://p/x' });

  it('extracts error.message from a JSON body and keeps the status', () => {
    const out = ex.parseError({ status: 403 }, JSON.stringify({ error: { message: 'forbidden' } }));
    expect(out).toMatchObject({ status: 403, message: 'forbidden' });
  });

  it('falls back to raw text for a non-JSON body, and to HTTP <status> for an empty one', () => {
    expect(ex.parseError({ status: 500 }, '<html>oops</html>').message).toBe('<html>oops</html>');
    expect(ex.parseError({ status: 500 }, '').message).toBe('HTTP 500');
  });

  it('parses Google RPC ErrorInfo quotaResetDelay into resetsAtMs and appends the reason', () => {
    const body = JSON.stringify({
      error: {
        message: 'quota',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED',
            metadata: { quotaResetDelay: '10s' },
          },
        ],
      },
    });
    const before = Date.now();
    const out = ex.parseError({ status: 429 }, body);
    expect(out.message).toContain('RATE_LIMIT_EXCEEDED');
    expect(out.resetsAtMs).toBeGreaterThanOrEqual(before + 9_000);
    expect(out.resetsAtMs).toBeLessThanOrEqual(Date.now() + 11_000);
  });

  it('parses RetryInfo retryDelay in h/m/s composite form', () => {
    const body = JSON.stringify({
      error: {
        message: 'later',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1h2m3s' }],
      },
    });
    const before = Date.now();
    const out = ex.parseError({ status: 429 }, body);
    const expected = (3600 + 120 + 3) * 1000;
    expect(out.resetsAtMs).toBeGreaterThanOrEqual(before + expected - 1000);
    expect(out.resetsAtMs).toBeLessThanOrEqual(Date.now() + expected + 1000);
  });

  it('parses "Resets in ..." wording from a 429 message string only', () => {
    const body = JSON.stringify({ error: { message: 'Limit hit. Resets in 2h7m23s' } });
    const on429 = ex.parseError({ status: 429 }, body);
    expect(on429.resetsAtMs).toBeGreaterThan(Date.now());
    // Not a 429: same message must NOT invent a reset time.
    const on500 = ex.parseError({ status: 500 }, body);
    expect(on500.resetsAtMs).toBeUndefined();
  });

  it('a past quotaResetTimeStamp is ignored (no stale resetsAtMs)', () => {
    const body = JSON.stringify({
      error: {
        message: 'q',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            metadata: { quotaResetTimeStamp: '2000-01-01T00:00:00Z' },
          },
        ],
      },
    });
    expect(ex.parseError({ status: 429 }, body).resetsAtMs).toBeUndefined();
  });
});

describe('BaseExecutor.execute — non-2xx propagation, no silent success', () => {
  it('a 401 with a body is returned to the caller untouched (no retry, no swallow)', async () => {
    const ex = new BaseExecutor('p', { baseUrl: 'https://p/x', retry: {} });
    const upstream = new Response(JSON.stringify({ error: { message: 'bad key' } }), {
      status: 401,
    });
    fetchMock.mockResolvedValueOnce(upstream);
    const out = await ex.execute({
      model: 'm',
      body: {},
      stream: false,
      credentials: { apiKey: 'k' },
    });
    expect(out.response.status).toBe(401);
    expect(await out.response.text()).toContain('bad key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the serialized transformed body and the built headers to the provider URL', async () => {
    const ex = new BaseExecutor('p', { baseUrl: 'https://p/chat', retry: {} });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const body = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 7 };
    const out = await ex.execute({ model: 'm', body, stream: true, credentials: { apiKey: 'k' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://p/chat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(body); // usage-relevant fields untouched
    expect(init.headers['Authorization']).toBe('Bearer k');
    expect(out.transformedBody).toEqual(body);
  });
});
