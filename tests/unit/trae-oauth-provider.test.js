/**
 * Trae (ByteDance marscode) OAuth provider: dormant in production (registry
 * entry commented out, see token-refresh-provider-bodies.test.js) but its
 * refresh/exchange handlers are kept and exercised here directly against the
 * default export. mapTokens is pure; exchangeToken/prepareConfig/postExchange
 * hit global.fetch, mocked below. ZERO real network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import trae from '@/lib/oauth/providers/trae.js';

const originalFetch = global.fetch;

function mockResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

beforeEach(() => {
  global.fetch = originalFetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('mapTokens — expiry normalization and region scope', () => {
  it('uses an explicit expiresIn verbatim', () => {
    const out = trae.mapTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }, {});
    expect(out.expiresIn).toBe(3600);
  });

  it('derives expiresIn from a relative expiresAt (absolute epoch seconds)', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 120;
    const out = trae.mapTokens({ accessToken: 'a', expiresAt }, {});
    expect(out.expiresIn).toBeGreaterThan(100);
    expect(out.expiresIn).toBeLessThanOrEqual(120);
  });

  it('floors a past/near expiresAt at 60s rather than going negative', () => {
    const out = trae.mapTokens({ accessToken: 'a', expiresAt: Math.floor(Date.now() / 1000) - 999 }, {});
    expect(out.expiresIn).toBe(60);
  });

  it('falls back to TRAE_CONFIG.tokenLifetimeDays when neither is present', () => {
    const out = trae.mapTokens({ accessToken: 'a' }, {});
    expect(out.expiresIn).toBe(14 * 24 * 60 * 60);
  });

  it.each([
    ['SG', 'marscode-sg'],
    ['Singapore', 'marscode-sg'],
    ['CN', 'marscode-cn'],
    ['China', 'marscode-cn'],
    ['US-East', 'marscode-us'],
    [undefined, 'marscode-us'],
  ])('maps aiRegion %s to scope %s', (aiRegion, scope) => {
    const out = trae.mapTokens({ accessToken: 'a' }, { userInfo: { aiRegion } });
    expect(out.providerSpecificData.scope).toBe(scope);
  });

  it('email/displayName are undefined rather than null when GetUserInfo has none', () => {
    const out = trae.mapTokens({ accessToken: 'a' }, { userInfo: {} });
    expect(out.email).toBeUndefined();
    expect(out.displayName).toBeUndefined();
  });
});

describe('buildAuthUrl', () => {
  it('builds a verification URL carrying client_id and the login trace id', () => {
    const url = new URL(trae.buildAuthUrl(
      { loginHost: 'api.trae.ai', loginTraceID: 'trace-1' },
      'http://127.0.0.1:1234/callback',
      'state-1',
    ));
    expect(url.pathname).toBe('/authorization');
    expect(url.searchParams.get('client_id')).toBe('ono9krqynydwx5');
    expect(url.searchParams.get('login_trace_id')).toBe('trace-1');
    expect(url.searchParams.get('auth_callback_url')).toBe('http://127.0.0.1:1234/callback');
  });

  it('falls back to state as the trace id when loginTraceID is absent', () => {
    const url = new URL(trae.buildAuthUrl({ loginHost: 'api.trae.ai' }, 'http://cb', 'state-2'));
    expect(url.searchParams.get('login_trace_id')).toBe('state-2');
  });
});

describe('exchangeToken — paste-token (imported) mode, no network', () => {
  it('accepts a raw pasted token and strips a Cloud-IDE-JWT prefix', async () => {
    const fm = vi.fn();
    global.fetch = fm;
    const out = await trae.exchangeToken({}, 'Cloud-IDE-JWT abc123');
    expect(fm).not.toHaveBeenCalled();
    expect(out).toEqual({
      accessToken: 'abc123',
      refreshToken: null,
      expiresIn: 14 * 24 * 60 * 60,
      _authMethod: 'imported',
    });
  });

  it('strips a Bearer prefix', async () => {
    const out = await trae.exchangeToken({}, 'Bearer xyz');
    expect(out.accessToken).toBe('xyz');
  });
});

describe('exchangeToken — callback (oauth) mode, ExchangeToken over fetch', () => {
  it('parses the callback, then posts ClientID/RefreshToken/ClientSecret to the first API origin', async () => {
    const fm = vi.fn().mockResolvedValue(mockResponse({
      Result: { AccessToken: 'acc-1', RefreshToken: 'ref-1', ExpiresAt: 9999999999 },
    }));
    global.fetch = fm;

    const out = await trae.exchangeToken({}, '?refreshToken=r-1&loginHost=ignored.example');

    const [url, init] = fm.mock.calls[0];
    expect(url).toBe('https://api.marscode.com/cloudide/api/v3/trae/oauth/ExchangeToken');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ ClientID: 'ono9krqynydwx5', RefreshToken: 'r-1', ClientSecret: '-', UserID: '' });
    expect(out.accessToken).toBe('acc-1');
    expect(out.refreshToken).toBe('ref-1');
    expect(out._authMethod).toBe('oauth');
    // loginHost from the callback is never dialed (SSRF guard): only the
    // hardcoded apiOrigins allowlist is ever fetched.
    expect(fm).toHaveBeenCalledTimes(1);
  });

  it('falls through to the next allowlisted origin when the first 404s', async () => {
    const fm = vi.fn()
      .mockResolvedValueOnce(mockResponse({}, { ok: false, status: 404 }))
      .mockResolvedValueOnce(mockResponse({ Result: { AccessToken: 'acc-2' } }));
    global.fetch = fm;
    const out = await trae.exchangeToken({}, '?refreshToken=r-2&loginHost=x');
    expect(out.accessToken).toBe('acc-2');
    expect(fm).toHaveBeenCalledTimes(2);
  });

  it('throws when every origin fails rather than returning a half-empty token', async () => {
    global.fetch = vi.fn().mockResolvedValue(mockResponse({}, { ok: false, status: 500 }));
    await expect(trae.exchangeToken({}, '?refreshToken=r-3&loginHost=x')).rejects.toThrow(
      /Trae ExchangeToken failed/,
    );
  });

  it('rejects a callback with no refreshToken before ever calling fetch', async () => {
    const fm = vi.fn();
    global.fetch = fm;
    await expect(trae.exchangeToken({}, '?refreshToken=&loginHost=x')).rejects.toThrow(/refreshToken/);
    expect(fm).not.toHaveBeenCalled();
  });
});

describe('prepareConfig — GetLoginGuidance', () => {
  it('returns loginHost and a generated loginTraceID from the first successful url', async () => {
    global.fetch = vi.fn().mockResolvedValue(mockResponse({ Result: { LoginHost: 'api.trae.ai' } }));
    const out = await trae.prepareConfig({ scope: 'x' });
    expect(out.loginHost).toBe('api.trae.ai');
    expect(out.scope).toBe('x');
    expect(typeof out.loginTraceID).toBe('string');
  });

  it('throws when every guidance url fails', async () => {
    global.fetch = vi.fn().mockResolvedValue(mockResponse({}, { ok: false, status: 500 }));
    await expect(trae.prepareConfig({})).rejects.toThrow(/GetLoginGuidance failed/);
  });
});

describe('postExchange — GetUserInfo', () => {
  it('returns identity fields from the first successful origin', async () => {
    global.fetch = vi.fn().mockResolvedValue(mockResponse({
      Result: { Email: 'user@trae.ai', ScreenName: 'User', AIRegion: 'SG' },
    }));
    const { userInfo } = await trae.postExchange({ accessToken: 'acc' });
    expect(userInfo.email).toBe('user@trae.ai');
    expect(userInfo.name).toBe('User');
    expect(userInfo.aiRegion).toBe('SG');
  });

  it('falls back to {email:null,name:null} rather than throwing when every origin fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const { userInfo } = await trae.postExchange({ accessToken: 'acc' });
    expect(userInfo).toEqual({ email: null, name: null });
  });
});
