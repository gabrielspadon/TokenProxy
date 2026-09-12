// Closes the remaining gaps in open-sse/services/tokenRefresh/providers.js
// left by the earlier error-path wave: xai success + singleton reuse, the
// generic path's URL fallback, network catch, chain-diverged and issue-record
// eviction, the exported classifier helpers, codex permanent/success paths,
// kiro profileArn resolution and IDC region refusal, cline/trae payload
// fallbacks, and the codebuddy-intl catch. Same seam as
// token-refresh-providers-error-paths.test.js: proxyFetch is module-mocked,
// so nothing here can reach the wire. Tokens are unique per test so the
// module's 10s dedup cache never crosses cases.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS, PROVIDER_OAUTH } from '../../open-sse/config/providers.js';
import { tokenFingerprint } from '../../open-sse/services/tokenRefresh/dedup.js';

vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: vi.fn(),
  installGlobalProxyFetch: () => {},
}));

let mod;
let proxyFetch;

beforeEach(async () => {
  mod = await import('../../open-sse/services/tokenRefresh/providers.js');
  ({ proxyAwareFetch: proxyFetch } = await import('../../open-sse/utils/proxyFetch.js'));
  proxyFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function respondWith(payload, { ok = true, status = 200 } = {}) {
  proxyFetch.mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
}

// A provider with no REFRESH_PROFILES entry whose URL resolves through the
// registry fallback (config.refreshUrl || PROVIDER_OAUTH[p].tokenUrl).
const genericProvider = Object.keys(PROVIDERS).find(
  (p) =>
    !['claude', 'iflow', 'github', 'kimi'].includes(p) &&
    PROVIDERS[p]?.clientId &&
    (PROVIDERS[p]?.refreshUrl || PROVIDER_OAUTH[p]?.tokenUrl)
);

describe('refreshXaiToken success path', () => {
  it('returns the mapped token pair and reuses the service singleton', async () => {
    vi.resetModules();
    let constructed = 0;
    vi.doMock('../../src/lib/oauth/services/xai.js', () => ({
      XaiService: class {
        constructor() {
          constructed += 1;
        }
        async refreshAccessToken() {
          return { access_token: 'xa', refresh_token: 'xr', expires_in: 60, id_token: 'xid' };
        }
      },
    }));
    const fresh = await import('../../open-sse/services/tokenRefresh/providers.js');
    const out = await fresh.refreshXaiToken(`xai-ok-${Date.now()}`, null);
    expect(out).toEqual({ accessToken: 'xa', refreshToken: 'xr', expiresIn: 60, idToken: 'xid' });
    await fresh.refreshXaiToken(`xai-ok2-${Date.now()}`, null);
    expect(constructed).toBe(1);
    vi.doUnmock('../../src/lib/oauth/services/xai.js');
    vi.resetModules();
  });

  it('keeps the input refresh token when the service returns none', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/oauth/services/xai.js', () => ({
      XaiService: class {
        async refreshAccessToken() {
          return { access_token: 'xa', expires_in: 60 };
        }
      },
    }));
    const fresh = await import('../../open-sse/services/tokenRefresh/providers.js');
    const token = `xai-keep-${Date.now()}`;
    const out = await fresh.refreshXaiToken(token, null);
    expect(out.refreshToken).toBe(token);
    vi.doUnmock('../../src/lib/oauth/services/xai.js');
    vi.resetModules();
  });
});

describe('exported classifier helpers', () => {
  it('formatIssueAge renders minutes, hours and days', () => {
    const now = Date.now();
    expect(mod.formatIssueAge(now - 5 * 60000, now)).toBe('5m');
    expect(mod.formatIssueAge(now - 3 * 3600000, now)).toBe('3h');
    expect(mod.formatIssueAge(now - 49 * 3600000, now)).toBe('2d');
  });

  it('refreshFailureWhy returns the closed enum, never the payload', () => {
    expect(mod.refreshFailureWhy(JSON.stringify({ error: 'invalid_grant' }))).toBe('invalid_grant');
    expect(mod.refreshFailureWhy(JSON.stringify('invalid_client'))).toBe('invalid_client');
    expect(mod.refreshFailureWhy(JSON.stringify({ error: 'server_error' }))).toBe('http');
    expect(mod.refreshFailureWhy('not json at all')).toBe('http');
  });

  it('classifyOAuthRefreshError handles empty, plain-text and nested-code bodies', () => {
    expect(mod.classifyOAuthRefreshError()).toEqual({
      status: 0,
      code: '',
      description: '',
      permanent: false,
    });
    const plain = mod.classifyOAuthRefreshError('refresh_token_reused elsewhere', 400);
    expect(plain.permanent).toBe(true);
    expect(plain.description).toBe('refresh_token_reused elsewhere');
    const nested = mod.classifyOAuthRefreshError(
      JSON.stringify({ error: { code: 'token_expired' } }),
      401
    );
    expect(nested).toMatchObject({ status: 401, code: 'token_expired', permanent: true });
    const msg = mod.classifyOAuthRefreshError(JSON.stringify({ message: 'try later' }), 503);
    expect(msg).toMatchObject({ description: 'try later', permanent: false });
  });
});

describe('generic refreshAccessToken edges', () => {
  it('returns null for a provider with no config or refresh URL', async () => {
    const log = { warn: vi.fn() };
    expect(await mod.refreshAccessToken('no-such-provider', 'tok', {}, log)).toBeNull();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('resolves the URL through the registry fallback for an unprofiled provider', async () => {
    expect(genericProvider).toBeTruthy();
    respondWith({ access_token: 'ga', refresh_token: 'gr', expires_in: 60 });
    const out = await mod.refreshAccessToken(genericProvider, `gen-${Date.now()}`, {}, null);
    expect(out).toMatchObject({ accessToken: 'ga', refreshToken: 'gr', expiresIn: 60 });
    const expectedUrl =
      PROVIDERS[genericProvider].refreshUrl || PROVIDER_OAUTH[genericProvider].tokenUrl;
    expect(proxyFetch.mock.calls[0][0]).toBe(expectedUrl);
    expect(proxyFetch.mock.calls[0][1].body.get('client_id')).toBe(
      PROVIDERS[genericProvider].clientId
    );
  });

  it('returns null and logs on a thrown transport error', async () => {
    proxyFetch.mockRejectedValue(new Error('ECONNRESET'));
    const log = { error: vi.fn() };
    expect(
      await mod.refreshAccessToken(genericProvider, `gen-net-${Date.now()}`, {}, log)
    ).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it('sends the profile extraHeaders on the wire', async () => {
    respondWith({ access_token: 'ia', expires_in: 60 });
    await mod.refreshIflowToken(`iflow-hdr-${Date.now()}`, null);
    const iflow = PROVIDERS.iflow;
    expect(proxyFetch.mock.calls[0][1].headers.Authorization).toBe(
      `Basic ${btoa(`${iflow.clientId}:${iflow.clientSecret}`)}`
    );
  });

  it('fires chain-diverged once when the issuer rejects the exact held token', async () => {
    respondWith({ error: 'invalid_grant' }, { ok: false, status: 400 });
    const token = `diverged-${Date.now()}`;
    const creds = {
      connectionId: `dv-${Date.now()}`,
      refreshTokenFp: tokenFingerprint(token),
      refreshTokenIssuedAt: new Date().toISOString(),
    };
    const log = { error: vi.fn() };
    expect(await mod.refreshAccessToken(genericProvider, token, creds, log)).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it('evicts the oldest issue record past the registry bound', async () => {
    respondWith({ access_token: 'ea', expires_in: 60 });
    const base = Date.now();
    vi.useFakeTimers();
    for (let i = 0; i < 513; i++) {
      if (i % 100 === 0) await vi.advanceTimersByTimeAsync(11000);
      await mod.refreshAccessToken(
        genericProvider,
        `evict-${base}-${i}`,
        { connectionId: `evict-conn-${base}-${i}` },
        null
      );
    }
    await vi.advanceTimersByTimeAsync(11000);
    vi.useRealTimers();
    expect(proxyFetch).toHaveBeenCalledTimes(513);
  });
});

describe('refreshCodexToken outcomes', () => {
  it('returns null with no token', async () => {
    expect(await mod.refreshCodexToken('', null)).toBeNull();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('returns the unrecoverable shape on a permanent failure', async () => {
    respondWith({ error: { code: 'token_expired' } }, { ok: false, status: 401 });
    const out = await mod.refreshCodexToken(`codex-perm-${Date.now()}`, null);
    expect(out).toEqual({ error: 'unrecoverable_refresh_error', code: 'token_expired' });
  });

  it('keeps the input refresh token on a success without rotation', async () => {
    respondWith({ access_token: 'ca', id_token: 'cid', expires_in: 60 });
    const token = `codex-ok-${Date.now()}`;
    const out = await mod.refreshCodexToken(token, null);
    expect(out).toEqual({ accessToken: 'ca', refreshToken: token, idToken: 'cid', expiresIn: 60 });
  });

  it('returns null on a thrown transport error', async () => {
    proxyFetch.mockRejectedValue(new Error('down'));
    expect(await mod.refreshCodexToken(`codex-net-${Date.now()}`, null)).toBeNull();
  });
});

describe('refreshKiroToken profileArn resolution and region guard', () => {
  it('returns null with no token', async () => {
    expect(await mod.refreshKiroToken('', {}, null)).toBeNull();
  });

  it('social success keeps an existing profileArn without patching', async () => {
    respondWith({ accessToken: 'ka', expiresIn: 60 });
    const psd = { profileArn: 'arn:aws:codewhisperer:::profile/existing' };
    const token = `kiro-soc-${Date.now()}`;
    const out = await mod.refreshKiroToken(token, psd, null);
    expect(out).toMatchObject({ accessToken: 'ka', refreshToken: token, expiresIn: 60 });
    expect(out.providerSpecificData).toBeUndefined();
  });

  it('social success adopts the refreshed profileArn from the response', async () => {
    respondWith({ accessToken: 'ka2', profileArn: ' arn:aws:refreshed ' });
    const out = await mod.refreshKiroToken(`kiro-arn-${Date.now()}`, {}, null);
    expect(out.providerSpecificData).toEqual({ profileArn: 'arn:aws:refreshed' });
  });

  it('social success fetches the profileArn when the response omits it', async () => {
    vi.doMock('../../src/lib/oauth/providers.js', () => ({
      fetchKiroProfileArn: vi.fn(async () => 'arn:aws:fetched'),
    }));
    respondWith({ accessToken: 'ka3' });
    const out = await mod.refreshKiroToken(`kiro-fetch-${Date.now()}`, {}, null);
    expect(out.providerSpecificData).toEqual({ profileArn: 'arn:aws:fetched' });
    vi.doUnmock('../../src/lib/oauth/providers.js');
  });

  it('AWS-credential success keeps the input refresh token', async () => {
    respondWith({ accessToken: 'kaws' });
    const token = `kiro-aws-${Date.now()}`;
    const out = await mod.refreshKiroToken(
      token,
      { clientId: 'cid', clientSecret: 'sec', profileArn: 'arn:kept' },
      null
    );
    expect(out).toMatchObject({ accessToken: 'kaws', refreshToken: token });
  });

  it('refuses an IDC refresh with an invalid stored region', async () => {
    const log = { warn: vi.fn() };
    const out = await mod.refreshKiroToken(
      `kiro-region-${Date.now()}`,
      { authMethod: 'idc', clientId: 'cid', clientSecret: 'sec', region: 'evil/../nope' },
      log
    );
    expect(out).toBeNull();
    expect(proxyFetch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'TOKEN_REFRESH',
      expect.stringMatching(/invalid stored region/)
    );
  });
});

describe('trae payload fallbacks', () => {
  it('trae returns null with no token and with no configured exchange URL', async () => {
    expect(await mod.refreshTraeToken('', {}, null)).toBeNull();
    // The live registry carries no PROVIDER_OAUTH.trae entry, so the URL
    // guard exits before any fetch.
    const log = { warn: vi.fn() };
    expect(await mod.refreshTraeToken(`trae-nourl-${Date.now()}`, {}, log)).toBeNull();
    expect(proxyFetch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('TOKEN_REFRESH', expect.stringMatching(/exchangeTokenUrl/));
  });

  // Trae's URL comes only from PROVIDER_OAUTH.trae, absent in the live
  // registry, so these paths need an injected entry (same seam as
  // token-refresh-codebuddy-trae.test.js).
  async function loadTraeWithRegistry() {
    vi.resetModules();
    vi.doMock('open-sse/config/providers.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        PROVIDER_OAUTH: {
          ...actual.PROVIDER_OAUTH,
          trae: { exchangeTokenUrl: 'https://trae.example.invalid/exchange' },
        },
      };
    });
    const fresh = await import('../../open-sse/services/tokenRefresh/providers.js');
    const { proxyAwareFetch: pf } = await import('../../open-sse/utils/proxyFetch.js');
    return { fresh, pf };
  }

  afterEach(() => {
    vi.doUnmock('open-sse/config/providers.js');
    vi.resetModules();
  });

  it('trae accepts an unwrapped lowercase payload with a future ISO expiry', async () => {
    const { fresh, pf } = await loadTraeWithRegistry();
    const future = new Date(Date.now() + 120000).toISOString();
    pf.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ accessToken: 'ta', refreshToken: 'tr', expiresAt: future }),
      text: () => Promise.resolve('{}'),
    });
    const out = await fresh.refreshTraeToken(`trae-flat-${Date.now()}`, {}, null);
    expect(out).toMatchObject({ accessToken: 'ta', refreshToken: 'tr' });
    expect(out.expiresIn).toBeGreaterThan(0);
  });

  it('trae leaves expiresIn undefined for a past ISO expiry and nulls a missing AccessToken', async () => {
    const { fresh, pf } = await loadTraeWithRegistry();
    const past = new Date(Date.now() - 120000).toISOString();
    pf.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ Result: { AccessToken: 'ta2', ExpiresAt: past } }),
      text: () => Promise.resolve('{}'),
    });
    const token = `trae-past-${Date.now()}`;
    const out = await fresh.refreshTraeToken(token, {}, null);
    expect(out).toMatchObject({ accessToken: 'ta2', refreshToken: token });
    expect(out.expiresIn).toBeUndefined();

    pf.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ Result: {} }),
      text: () => Promise.resolve('{}'),
    });
    const log = { error: vi.fn() };
    expect(await fresh.refreshTraeToken(`trae-noacc-${Date.now()}`, {}, log)).toBeNull();
  });

});

describe('codebuddy intl guards', () => {
  it('returns null with no token and on a thrown transport error', async () => {
    expect(await mod.refreshCodebuddyIntlToken('', null)).toBeNull();
    proxyFetch.mockRejectedValue(new Error('down'));
    const log = { error: vi.fn() };
    expect(await mod.refreshCodebuddyIntlToken(`cbi-net-${Date.now()}`, log)).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it('cn variant returns null with no token', async () => {
    expect(await mod.refreshCodebuddyToken('', null)).toBeNull();
    expect(proxyFetch).not.toHaveBeenCalled();
  });
});
