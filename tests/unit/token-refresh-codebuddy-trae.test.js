/**
 * CodeBuddy CN/Intl refresh request shape and failure paths, plus Trae's
 * real HTTP-calling logic (dead in production because PROVIDER_OAUTH.trae
 * is absent, exercised here by mocking the registry that supplies it) and
 * classifyOAuthRefreshError's permanent-vs-transient marker matching.
 *
 * Same fetch-capture idiom as token-refresh-provider-bodies.test.js:
 * proxyFetch captures globalThis.fetch at module load, so it must be set
 * before the dynamic import of providers.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalFetch = global.fetch;

function mockFetchOnce(payload, { ok = true, status = 200 } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
  global.fetch = fn;
  return fn;
}

const loadProviders = () => import('open-sse/services/tokenRefresh/providers.js');

beforeEach(() => {
  vi.resetModules();
  global.fetch = originalFetch;
});
afterEach(() => {
  vi.doUnmock('open-sse/config/providers.js');
  global.fetch = originalFetch;
});

describe('refreshCodebuddyToken (codebuddy-cn)', () => {
  it('posts an empty JSON body with the Tencent-specific headers', async () => {
    const fm = mockFetchOnce({
      code: 0,
      data: { accessToken: 'cb-acc', refreshToken: 'cb-new', expiresIn: 3600 },
    });
    const { refreshCodebuddyToken } = await loadProviders();

    const out = await refreshCodebuddyToken('cb-old', console);

    const [url, init] = fm.mock.calls[0];
    expect(url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh');
    expect(init.body).toBe('{}');
    expect(init.headers['X-Domain']).toBe('copilot.tencent.com');
    expect(init.headers['X-Refresh-Token']).toBe('cb-old');
    expect(out).toEqual({ accessToken: 'cb-acc', refreshToken: 'cb-new', expiresIn: 3600 });
  });

  it('does not persist a bad expiresAt: a non-zero code fails the refresh with null', async () => {
    mockFetchOnce({ code: 1, msg: 'refresh token expired' });
    const { refreshCodebuddyToken } = await loadProviders();
    expect(await refreshCodebuddyToken('cb-old', console)).toBeNull();
  });

  it('fails closed when code is 0 but accessToken is missing', async () => {
    mockFetchOnce({ code: 0, data: {} });
    const { refreshCodebuddyToken } = await loadProviders();
    expect(await refreshCodebuddyToken('cb-old', console)).toBeNull();
  });

  it('a thrown transport error is caught and returns null rather than escaping', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const { refreshCodebuddyToken } = await loadProviders();
    await expect(refreshCodebuddyToken('cb-old', console)).resolves.toBeNull();
  });

  it('keeps the old refresh token when the response does not rotate one', async () => {
    mockFetchOnce({ code: 0, data: { accessToken: 'cb-acc' } });
    const { refreshCodebuddyToken } = await loadProviders();
    const out = await refreshCodebuddyToken('cb-old', console);
    expect(out.refreshToken).toBe('cb-old');
  });
});

describe('refreshCodebuddyIntlToken (codebuddy-intl)', () => {
  it('uses the www.codebuddy.ai domain header and its own refresh URL', async () => {
    const fm = mockFetchOnce({ code: 0, data: { accessToken: 'intl-acc' } });
    const { refreshCodebuddyIntlToken } = await loadProviders();

    await refreshCodebuddyIntlToken('intl-old', console);

    const [url, init] = fm.mock.calls[0];
    expect(url).toContain('codebuddy.ai');
    expect(init.headers['X-Domain']).toBe('www.codebuddy.ai');
  });

  it('failure path does not persist a bad expiresAt', async () => {
    mockFetchOnce({ code: 2, msg: 'bad' });
    const { refreshCodebuddyIntlToken } = await loadProviders();
    expect(await refreshCodebuddyIntlToken('intl-old', console)).toBeNull();
  });
});

describe('refreshTraeToken — real request shape via an injected registry entry', () => {
  it('posts ClientID/RefreshToken/ClientSecret/UserID and normalizes a numeric ExpiresAt', async () => {
    vi.doMock('open-sse/config/providers.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        PROVIDER_OAUTH: {
          ...actual.PROVIDER_OAUTH,
          trae: {
            exchangeTokenUrl: 'https://trae.example/exchange',
            clientId: 'cid',
            clientSecret: 'csecret',
          },
        },
      };
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const fm = mockFetchOnce({
      Result: { AccessToken: 't-acc', RefreshToken: 't-new', ExpiresAt: nowSec + 120 },
    });
    const { refreshTraeToken } = await loadProviders();

    const out = await refreshTraeToken('t-old', {}, console);

    const [url, init] = fm.mock.calls[0];
    expect(url).toBe('https://trae.example/exchange');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      ClientID: 'cid',
      RefreshToken: 't-old',
      ClientSecret: 'csecret',
      UserID: '',
    });
    expect(out.accessToken).toBe('t-acc');
    expect(out.refreshToken).toBe('t-new');
    expect(out.expiresIn).toBeGreaterThan(100);
    expect(out.expiresIn).toBeLessThanOrEqual(120);
  });

  it('normalizes a string ISO ExpiresAt into a positive expiresIn', async () => {
    vi.doMock('open-sse/config/providers.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        PROVIDER_OAUTH: {
          ...actual.PROVIDER_OAUTH,
          trae: { exchangeTokenUrl: 'https://trae.example/exchange' },
        },
      };
    });
    mockFetchOnce({
      Result: { AccessToken: 't-acc', ExpiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    const { refreshTraeToken } = await loadProviders();

    const out = await refreshTraeToken('t-old', {}, console);
    expect(out.expiresIn).toBeGreaterThan(0);
    expect(out.expiresIn).toBeLessThanOrEqual(60);
    // no rotation in the payload -> the old refresh token survives
    expect(out.refreshToken).toBe('t-old');
  });

  it('fails without persisting a token when the response carries no AccessToken', async () => {
    vi.doMock('open-sse/config/providers.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        PROVIDER_OAUTH: {
          ...actual.PROVIDER_OAUTH,
          trae: { exchangeTokenUrl: 'https://trae.example/exchange' },
        },
      };
    });
    mockFetchOnce({ Result: {} });
    const { refreshTraeToken } = await loadProviders();
    expect(await refreshTraeToken('t-old', {}, console)).toBeNull();
  });

  it('returns null on a non-ok upstream response', async () => {
    vi.doMock('open-sse/config/providers.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        PROVIDER_OAUTH: {
          ...actual.PROVIDER_OAUTH,
          trae: { exchangeTokenUrl: 'https://trae.example/exchange' },
        },
      };
    });
    mockFetchOnce({ error: 'denied' }, { ok: false, status: 401 });
    const { refreshTraeToken } = await loadProviders();
    expect(await refreshTraeToken('t-old', {}, console)).toBeNull();
  });
});

describe('classifyOAuthRefreshError', () => {
  it('flags invalid_grant as permanent', async () => {
    const { classifyOAuthRefreshError } = await loadProviders();
    const out = classifyOAuthRefreshError(JSON.stringify({ error: 'invalid_grant' }), 400);
    expect(out.permanent).toBe(true);
  });

  it('flags refresh_token_reused and refresh_token_invalidated as permanent', async () => {
    const { classifyOAuthRefreshError } = await loadProviders();
    expect(
      classifyOAuthRefreshError(JSON.stringify({ error: { code: 'refresh_token_reused' } }), 401)
        .permanent
    ).toBe(true);
    expect(
      classifyOAuthRefreshError(
        JSON.stringify({ error: { code: 'refresh_token_invalidated' } }),
        401
      ).permanent
    ).toBe(true);
  });

  it('treats an unrecognized error as transient (retryable)', async () => {
    const { classifyOAuthRefreshError } = await loadProviders();
    const out = classifyOAuthRefreshError(JSON.stringify({ error: 'server_error' }), 500);
    expect(out.permanent).toBe(false);
  });

  it('tolerates non-JSON error text without throwing', async () => {
    const { classifyOAuthRefreshError } = await loadProviders();
    const out = classifyOAuthRefreshError('<html>gateway timeout</html>', 504);
    expect(out.permanent).toBe(false);
    expect(out.status).toBe(504);
  });
});
