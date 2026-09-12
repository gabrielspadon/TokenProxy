import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  TOKEN_EXPIRY_BUFFER_MS,
  MAX_CONNECTION_REFRESH_LEAD_MS,
  isUnrecoverableRefreshError,
  getRefreshLeadMs,
  getEffectiveRefreshLeadMs,
  parseVertexSaJson,
  validateVertexSaKey,
  refreshVertexToken,
  mergeRefreshedProviderSpecificData,
  getAccessToken,
  refreshTokenByProvider,
  formatProviderCredentials,
  refreshWithRetry,
} from 'open-sse/services/tokenRefresh.js';
import { REFRESH_LEAD_MS } from 'open-sse/config/appConstants.js';

// Provider refresh implementations are network code; fake the two the routing
// tests below exercise, keep everything else real (they are only re-exported).
vi.mock('open-sse/services/tokenRefresh/providers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    refreshKiroToken: vi.fn(async () => ({
      accessToken: 'kiro-a',
      providerSpecificData: { refreshedField: 'new' },
    })),
    refreshAccessToken: vi.fn(async () => ({ accessToken: 'generic-a' })),
  };
});
import { refreshKiroToken, refreshAccessToken } from 'open-sse/services/tokenRefresh/providers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('isUnrecoverableRefreshError', () => {
  it.each([
    'unrecoverable_refresh_error',
    'refresh_token_reused',
    'invalid_request',
    'invalid_grant',
  ])('flags %s as unrecoverable', (error) => {
    expect(isUnrecoverableRefreshError({ error })).toBeTruthy();
  });

  it('is falsy for transient errors, non-objects, and null', () => {
    expect(isUnrecoverableRefreshError({ error: 'server_error' })).toBeFalsy();
    expect(isUnrecoverableRefreshError('invalid_grant')).toBeFalsy();
    expect(isUnrecoverableRefreshError(null)).toBeFalsy();
  });
});

describe('getRefreshLeadMs', () => {
  it('a valid per-connection override wins over everything', () => {
    expect(getRefreshLeadMs('claude', { refreshLeadMs: 42_000 })).toBe(42_000);
  });

  it.each([0, -1, NaN, Infinity, MAX_CONNECTION_REFRESH_LEAD_MS + 1, '60000'])(
    'rejects invalid override %p and falls back',
    (bad) => {
      expect(getRefreshLeadMs('no-such-provider', { refreshLeadMs: bad })).toBe(
        TOKEN_EXPIRY_BUFFER_MS
      );
    }
  );

  it('uses the registry-derived lead for a configured provider', () => {
    for (const [provider, lead] of Object.entries(REFRESH_LEAD_MS)) {
      expect(getRefreshLeadMs(provider)).toBe(lead);
    }
  });

  it('routes the legacy kimi-coding id to the kimi lead', () => {
    expect(getRefreshLeadMs('kimi-coding')).toBe(REFRESH_LEAD_MS.kimi ?? TOKEN_EXPIRY_BUFFER_MS);
  });

  it('defaults to TOKEN_EXPIRY_BUFFER_MS for unknown providers', () => {
    expect(getRefreshLeadMs('no-such-provider')).toBe(TOKEN_EXPIRY_BUFFER_MS);
  });
});

describe('getEffectiveRefreshLeadMs', () => {
  const NOW = 1_700_000_000_000;

  it('halves the token lifetime when the lead would consume it entirely', () => {
    // lifetime 10min < default 5min lead? no — make lifetime 4min < 5min buffer
    const lifetime = 4 * 60 * 1000;
    const creds = { expiresAt: NOW + lifetime, lastRefreshAt: NOW };
    expect(getEffectiveRefreshLeadMs('no-such-provider', creds, NOW)).toBe(
      Math.floor(lifetime / 2)
    );
  });

  it('keeps the configured lead when the lifetime comfortably exceeds it', () => {
    const creds = { expiresAt: NOW + 10 * TOKEN_EXPIRY_BUFFER_MS, lastRefreshAt: NOW };
    expect(getEffectiveRefreshLeadMs('no-such-provider', creds, NOW)).toBe(TOKEN_EXPIRY_BUFFER_MS);
  });

  it('treats epoch-seconds and ISO strings as the same instant', () => {
    const lifetime = 2 * 60 * 1000;
    const secs = { expiresAt: (NOW + lifetime) / 1000, lastRefreshAt: NOW / 1000 };
    const iso = {
      expiresAt: new Date(NOW + lifetime).toISOString(),
      lastRefreshAt: new Date(NOW).toISOString(),
    };
    expect(getEffectiveRefreshLeadMs('x', secs, NOW)).toBe(
      getEffectiveRefreshLeadMs('x', iso, NOW)
    );
    expect(getEffectiveRefreshLeadMs('x', secs, NOW)).toBe(Math.floor(lifetime / 2));
  });

  it('falls back to the plain lead when either timestamp is missing or unparseable', () => {
    expect(getEffectiveRefreshLeadMs('x', { expiresAt: NOW + 1000 }, NOW)).toBe(
      TOKEN_EXPIRY_BUFFER_MS
    );
    expect(getEffectiveRefreshLeadMs('x', { expiresAt: 'garbage', lastRefreshAt: NOW }, NOW)).toBe(
      TOKEN_EXPIRY_BUFFER_MS
    );
    expect(getEffectiveRefreshLeadMs('x', null, NOW)).toBe(TOKEN_EXPIRY_BUFFER_MS);
  });
});

describe('vertex service-account parsing and key validation', () => {
  const rsa = (bits) =>
    generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
  const sa = (key) => ({
    type: 'service_account',
    client_email: 'e@p.iam',
    private_key: key,
    project_id: 'p',
  });

  it('parses only a complete service_account JSON', () => {
    expect(parseVertexSaJson(JSON.stringify(sa('k')))).toMatchObject({ project_id: 'p' });
    expect(
      parseVertexSaJson(JSON.stringify({ type: 'service_account', client_email: 'e' }))
    ).toBeNull();
    expect(parseVertexSaJson('not json')).toBeNull();
    expect(parseVertexSaJson(42)).toBeNull();
  });

  it('accepts an RSA-2048 PKCS8 key, including with escaped newlines', () => {
    const pem = rsa(2048);
    expect(validateVertexSaKey(sa(pem))).toBeNull();
    expect(validateVertexSaKey(sa(pem.replace(/\n/g, '\\n')))).toBeNull();
  });

  it('names the failure for missing, malformed, non-RSA, and undersized keys', () => {
    expect(validateVertexSaKey({})).toMatch(/missing private_key/);
    expect(validateVertexSaKey(sa('not a pem'))).toMatch(/not a valid PEM/);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    expect(validateVertexSaKey(sa(ec))).toMatch(/must be RSA/);
    expect(validateVertexSaKey(sa(rsa(1024)))).toMatch(/2048/);
  });

  it('refreshVertexToken mints via faked fetch, then serves the cache without a second fetch', async () => {
    const pem = rsa(2048);
    const json = { ...sa(pem), client_email: 'cache-test@p.iam' };
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'at', expires_in: 3600 }),
    }));
    vi.stubGlobal('fetch', fetchFn);

    const first = await refreshVertexToken(json, null);
    expect(first.accessToken).toBe('at');
    expect(first.expiresAt).toBeGreaterThan(Date.now());
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const second = await refreshVertexToken(json, null);
    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledTimes(1); // cache hit
  });

  it('returns null (not throw) on an invalid key and on an upstream non-ok', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, text: async () => 'nope' }));
    vi.stubGlobal('fetch', fetchFn);
    expect(
      await refreshVertexToken({ ...sa('bad'), client_email: 'bad-key@p.iam' }, null)
    ).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(
      await refreshVertexToken({ ...sa(rsa(2048)), client_email: 'mint-fail@p.iam' }, null)
    ).toBeNull();
  });
});

describe('getAccessToken and refreshTokenByProvider routing', () => {
  it('returns null without calling any handler when the refresh token is absent or non-string', async () => {
    expect(await getAccessToken('kiro', null)).toBeNull();
    expect(await getAccessToken('kiro', { refreshToken: 42 })).toBeNull();
    expect(refreshKiroToken).not.toHaveBeenCalled();
  });

  it('routes a mapped provider to its handler with the connection credentials', async () => {
    const creds = { refreshToken: 'rt', providerSpecificData: { region: 'us-east-1' } };
    const out = await getAccessToken('kiro', creds);
    expect(out.accessToken).toBe('kiro-a');
    expect(refreshKiroToken).toHaveBeenCalledWith('rt', creds.providerSpecificData, undefined);
  });

  it('returns null for an unmapped provider via getAccessToken', async () => {
    expect(await getAccessToken('no-such-provider', { refreshToken: 'rt' })).toBeNull();
  });

  it('refreshTokenByProvider falls back to the generic refresh for unmapped providers', async () => {
    const out = await refreshTokenByProvider('no-such-provider', { refreshToken: 'rt' });
    expect(out.accessToken).toBe('generic-a');
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('merges refreshed providerSpecificData OVER the existing data, keeping untouched keys', async () => {
    const out = await refreshTokenByProvider('kiro', {
      refreshToken: 'rt',
      providerSpecificData: { keepMe: 'old', refreshedField: 'stale' },
    });
    expect(out.providerSpecificData).toEqual({ keepMe: 'old', refreshedField: 'new' });
  });

  it('mergeRefreshedProviderSpecificData survives one side missing', () => {
    expect(mergeRefreshedProviderSpecificData(null, { a: 1 })).toEqual({ a: 1 });
    expect(mergeRefreshedProviderSpecificData({ a: 1 }, null)).toEqual({ a: 1 });
    expect(mergeRefreshedProviderSpecificData({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });
});

describe('formatProviderCredentials', () => {
  const creds = { apiKey: 'k', accessToken: 'a', refreshToken: 'r', projectId: 'p' };

  it('returns null for an unknown provider', () => {
    expect(formatProviderCredentials('no-such-provider', creds)).toBeNull();
  });

  it('never leaks the refresh token for API-key-shaped providers, keeps it for OAuth-shaped ones', () => {
    expect(formatProviderCredentials('claude', creds)).not.toHaveProperty('refreshToken');
    expect(formatProviderCredentials('codex', creds)).not.toHaveProperty('refreshToken');
    expect(formatProviderCredentials('gemini-cli', creds)).toMatchObject({
      refreshToken: 'r',
      projectId: 'p',
    });
    expect(formatProviderCredentials('kiro', creds)).toMatchObject({ refreshToken: 'r' });
  });
});

describe('refreshWithRetry', () => {
  it('returns the first truthy result without retrying', async () => {
    const fn = vi.fn(async () => 'tok');
    expect(await refreshWithRetry(fn, 3)).toBe('tok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries through throws and falsy results, then succeeds', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('tok');
    const p = refreshWithRetry(fn, 3);
    await vi.runAllTimersAsync();
    expect(await p).toBe('tok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns null after exhausting every attempt', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      throw new Error('always');
    });
    const p = refreshWithRetry(fn, 2);
    await vi.runAllTimersAsync();
    expect(await p).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});


describe('refresh durability and cancellation are terminal', () => {
  it.each(['CREDENTIAL_PERSISTENCE_UNCONFIRMED', 'FALLBACK_DEADLINE_EXCEEDED', 'AbortError'])(
    'never retries %s', async kind => {
      vi.useFakeTimers();
      const error = new Error('credential secret canary');
      if (kind === 'AbortError') error.name = kind;
      else error.code = kind;
      if (kind === 'CREDENTIAL_PERSISTENCE_UNCONFIRMED') error.retryable = false;
      const refresh = vi.fn().mockRejectedValue(error);
      const log = { warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
      await expect(refreshWithRetry(refresh, 3, log)).rejects.toBe(error);
      expect(refresh).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('credential secret canary');
    },
  );
});
