/**
 * Provider-specific refresh contracts in open-sse/services/tokenRefresh/providers.js.
 *
 * Wrong grant_type/client_id means the provider answers 400 and the connection
 * dies quietly; a malformed JSON success body must fail the refresh rather
 * than store garbage; a rotated refresh_token must replace the old one.
 *
 * proxyFetch captures globalThis.fetch, so the mock is installed before the
 * dynamic import of providers.js (same idiom as token-refresh-generic.test.js).
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

function mockFetchMalformedJson() {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    text: () => Promise.resolve('<html>upstream error page</html>'),
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
  global.fetch = originalFetch;
});

describe('refreshGoogleToken', () => {
  it('sends grant_type=refresh_token with the given client_id/client_secret as a form body', async () => {
    const fm = mockFetchOnce({ access_token: 'g-acc', expires_in: 3599 });
    const { refreshGoogleToken } = await loadProviders();

    const out = await refreshGoogleToken('g-old', 'cid-1', 'sec-1', console);

    const [url, init] = fm.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('g-old');
    expect(body.get('client_id')).toBe('cid-1');
    expect(body.get('client_secret')).toBe('sec-1');
    // Google does not rotate the refresh token: old one must survive
    expect(out).toEqual({ accessToken: 'g-acc', refreshToken: 'g-old', expiresIn: 3599 });
  });

  it('stores a rotated refresh_token when Google returns one', async () => {
    mockFetchOnce({ access_token: 'g-acc', refresh_token: 'g-new', expires_in: 3599 });
    const { refreshGoogleToken } = await loadProviders();
    const out = await refreshGoogleToken('g-old', 'cid-1', 'sec-1', console);
    expect(out.refreshToken).toBe('g-new');
  });

  it('returns null on a non-ok response instead of a half-empty token bag', async () => {
    mockFetchOnce({ error: 'invalid_grant' }, { ok: false, status: 400 });
    const { refreshGoogleToken } = await loadProviders();
    expect(await refreshGoogleToken('g-old', 'cid-1', 'sec-1', console)).toBeNull();
  });

  it('returns null and never throws when the success body is not JSON', async () => {
    mockFetchMalformedJson();
    const { refreshGoogleToken } = await loadProviders();
    expect(await refreshGoogleToken('g-old', 'cid-1', 'sec-1', console)).toBeNull();
  });

  it('returns null without a network call when refreshToken is missing', async () => {
    const fm = mockFetchOnce({});
    const { refreshGoogleToken } = await loadProviders();
    expect(await refreshGoogleToken('', 'cid-1', 'sec-1', console)).toBeNull();
    expect(fm).not.toHaveBeenCalled();
  });
});

describe('refreshCodexToken', () => {
  it('sends a JSON body with the codex client_id and grant_type=refresh_token', async () => {
    const fm = mockFetchOnce({
      access_token: 'cx-acc',
      refresh_token: 'cx-new',
      id_token: 'cx-id',
      expires_in: 600,
    });
    const { refreshCodexToken } = await loadProviders();

    const out = await refreshCodexToken('cx-old', console);

    const [, init] = fm.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('cx-old');
    expect(body.client_id).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(out).toEqual({
      accessToken: 'cx-acc',
      refreshToken: 'cx-new',
      idToken: 'cx-id',
      expiresIn: 600,
    });
  });

  it('malformed JSON on 200 fails the refresh with null, not stored garbage', async () => {
    mockFetchMalformedJson();
    const { refreshCodexToken } = await loadProviders();
    expect(await refreshCodexToken('cx-old', console)).toBeNull();
  });
});

describe('refreshCopilotToken', () => {
  it('GETs the copilot_internal token endpoint with token auth and returns {token, expiresAt}', async () => {
    const fm = mockFetchOnce({ token: 'cop-1', expires_at: 1770000000 });
    const { refreshCopilotToken } = await loadProviders();

    const out = await refreshCopilotToken('gh-acc', console);

    const [url, init] = fm.mock.calls[0];
    expect(url).toBe('https://api.github.com/copilot_internal/v2/token');
    expect(init.headers['Authorization']).toBe('token gh-acc');
    expect(out).toEqual({ token: 'cop-1', expiresAt: 1770000000 });
  });

  it('returns null without a call when the GitHub access token is missing', async () => {
    const fm = mockFetchOnce({});
    const { refreshCopilotToken } = await loadProviders();
    expect(await refreshCopilotToken(null, console)).toBeNull();
    expect(fm).not.toHaveBeenCalled();
  });
});

describe('refreshClineToken', () => {
  it("posts the JSON contract cline's endpoint requires and workos-prefixes the access token", async () => {
    const fm = mockFetchOnce({ data: { accessToken: 'raw-acc', refreshToken: 'cl-new' } });
    const { refreshClineToken } = await loadProviders();

    const out = await refreshClineToken('cl-old', null, console);

    const body = JSON.parse(fm.mock.calls[0][1].body);
    expect(body).toEqual({
      refreshToken: 'cl-old',
      grantType: 'refresh_token',
      clientType: 'extension',
    });
    expect(out.accessToken).toBe('workos:raw-acc');
    expect(out.refreshToken).toBe('cl-new');
  });

  it('does not double-prefix an already workos-prefixed token', async () => {
    mockFetchOnce({ data: { accessToken: 'workos:acc' } });
    const { refreshClineToken } = await loadProviders();
    const out = await refreshClineToken('cl-old', null, console);
    expect(out.accessToken).toBe('workos:acc');
    expect(out.refreshToken).toBe('cl-old'); // no rotation → keep old
  });

  it('derives a positive expiresIn from the ISO expiresAt', async () => {
    mockFetchOnce({
      data: { accessToken: 'a', expiresAt: new Date(Date.now() + 90_000).toISOString() },
    });
    const { refreshClineToken } = await loadProviders();
    const out = await refreshClineToken('cl-old', null, console);
    expect(out.expiresIn).toBeGreaterThan(80);
    expect(out.expiresIn).toBeLessThanOrEqual(90);
  });
});

describe('refreshKiroToken (social path)', () => {
  it('posts only the refreshToken and maps the camelCase reply', async () => {
    const fm = mockFetchOnce({ accessToken: 'k-acc', refreshToken: 'k-new', expiresIn: 3600 });
    const { refreshKiroToken } = await loadProviders();

    // profileArn present -> no secondary profile fetch fires
    const out = await refreshKiroToken('k-old', { profileArn: 'arn:aws:x' }, console);

    const body = JSON.parse(fm.mock.calls[0][1].body);
    expect(body).toEqual({ refreshToken: 'k-old' });
    expect(out.accessToken).toBe('k-acc');
    expect(out.refreshToken).toBe('k-new');
    expect(out.expiresIn).toBe(3600);
  });

  it('IDC path posts clientId/clientSecret/grantType and keeps the old token when none returned', async () => {
    const fm = mockFetchOnce({ accessToken: 'k-acc', expiresIn: 3600 });
    const { refreshKiroToken } = await loadProviders();

    const out = await refreshKiroToken(
      'k-old',
      {
        authMethod: 'idc',
        clientId: 'kc',
        clientSecret: 'ks',
        region: 'eu-west-1',
        profileArn: 'arn:x',
      },
      console
    );

    const [url, init] = fm.mock.calls[0];
    expect(url).toBe('https://oidc.eu-west-1.amazonaws.com/token');
    const body = JSON.parse(init.body);
    expect(body.grantType).toBe('refresh_token');
    expect(body.clientId).toBe('kc');
    expect(body.clientSecret).toBe('ks');
    expect(out.refreshToken).toBe('k-old');
  });
});

describe('refreshTraeToken', () => {
  // SUSPECTED DEAD PATH: registry/index.js:129 comments trae out of REGISTRY,
  // so PROVIDER_OAUTH.trae is undefined and refreshTraeToken bails with
  // "No Trae exchangeTokenUrl configured" before any fetch — yet the trae
  // handler is still wired in REFRESH_HANDLERS (tokenRefresh.js:213). Any
  // stored trae connection silently never refreshes. This pins the CURRENT
  // behavior; if trae is re-registered these assertions flip.
  it('currently returns null without a network call (trae absent from registry)', async () => {
    const fm = mockFetchOnce({
      Result: { AccessToken: 't-acc', RefreshToken: 't-new', ExpiresAt: 9999999999 },
    });
    const { refreshTraeToken } = await loadProviders();
    expect(await refreshTraeToken('t-old', {}, console)).toBeNull();
    expect(fm).not.toHaveBeenCalled();
  });
});

describe('null-refresh providers', () => {
  it('zed and windsurf refreshers return null (long-lived credential, re-login on expiry)', async () => {
    const { refreshZedToken, refreshWindsurfToken } = await loadProviders();
    expect(refreshZedToken()).toBeNull();
    expect(await refreshWindsurfToken({}, console)).toBeNull();
  });
});

describe('refreshWithRetry', () => {
  it('retries a throwing refresh and returns the first truthy result', async () => {
    vi.useFakeTimers();
    try {
      const { refreshWithRetry } = await import('open-sse/services/tokenRefresh.js');
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('net'))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ accessToken: 'a' });
      const p = refreshWithRetry(fn, 3, console);
      await vi.runAllTimersAsync();
      expect(await p).toEqual({ accessToken: 'a' });
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null after exhausting retries', async () => {
    vi.useFakeTimers();
    try {
      const { refreshWithRetry } = await import('open-sse/services/tokenRefresh.js');
      const fn = vi.fn().mockResolvedValue(null);
      const p = refreshWithRetry(fn, 2, console);
      await vi.runAllTimersAsync();
      expect(await p).toBeNull();
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
