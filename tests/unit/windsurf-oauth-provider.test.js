// Windsurf OAuth provider: callback parsing, RegisterUser exchange, paste-token
// modes, best-effort user info, and token mapping. All fetch traffic mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import windsurf from '@/lib/oauth/providers/windsurf.js';

const cfg = windsurf.config;

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Route mocked fetch by which configured path the URL ends with.
function routeFetch(routes) {
  return vi.fn(async (url) => {
    for (const [path, res] of Object.entries(routes)) {
      if (String(url).includes(path)) return typeof res === 'function' ? res(url) : res;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('buildAuthUrl', () => {
  it('builds a sign-in URL on the configured auth base with state and redirect', () => {
    const url = windsurf.buildAuthUrl(cfg, 'http://127.0.0.1:1/cb', 'st4te');
    expect(url.startsWith(`${cfg.authBaseUrl}${cfg.signInPath}?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('client_id')).toBe(cfg.clientId);
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:1/cb');
    expect(params.get('state')).toBe('st4te');
    expect(params.get('response_type')).toBe('token');
  });
});

describe('exchangeToken — callback mode', () => {
  it('parses the callback, registers, and returns the apiKey as accessToken', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [cfg.registerPath]: jsonRes({
          apiKey: 'sk-ws-abc',
          apiServerUrl: 'https://api.example',
          name: 'n',
        }),
      })
    );
    const out = await windsurf.exchangeToken(
      cfg,
      `http://localhost/cb?access_token=eyJx&state=s1`,
      'http://localhost/cb',
      null,
      's1'
    );
    expect(out.accessToken).toBe('sk-ws-abc');
    expect(out.apiServerUrl).toBe('https://api.example');
    expect(out.firebaseIdToken).toBe('eyJx');
    expect(out._authMethod).toBe('oauth');
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe(`${cfg.registerApiBaseUrl}${cfg.registerPath}`);
    expect(JSON.parse(opts.body)).toEqual({ firebase_id_token: 'eyJx' });
    expect(opts.headers['User-Agent']).toBe(cfg.userAgent);
  });

  it('falls back to the default api server when RegisterUser omits it, accepts snake_case', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [cfg.registerPath]: jsonRes({ api_key: 'sk-ws-snake' }),
      })
    );
    const out = await windsurf.exchangeToken(cfg, '?access_token=eyJy', 'r', null, null);
    expect(out.accessToken).toBe('sk-ws-snake');
    expect(out.apiServerUrl).toBe(cfg.defaultApiServerUrl);
  });

  it('accepts a fragment-style callback', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [cfg.registerPath]: jsonRes({ apiKey: 'k' }),
      })
    );
    const out = await windsurf.exchangeToken(cfg, '#access_token=eyJz&other=?x', 'r', null, null);
    expect(out.firebaseIdToken).toBe('eyJz');
  });

  it('rejects an error callback with the description included', async () => {
    await expect(
      windsurf.exchangeToken(cfg, '?error=denied&error_description=nope', 'r', null, null)
    ).rejects.toThrow(/denied.*nope/);
  });

  it('rejects an error callback without description', async () => {
    await expect(windsurf.exchangeToken(cfg, '?error=denied', 'r', null, null)).rejects.toThrow(
      /denied/
    );
  });

  it('rejects a callback missing access_token', async () => {
    await expect(windsurf.exchangeToken(cfg, '?state=only', 'r', null, null)).rejects.toThrow(
      /access_token/
    );
  });

  it('rejects a state mismatch', async () => {
    await expect(
      windsurf.exchangeToken(cfg, '?access_token=t&state=bad', 'r', null, 'good')
    ).rejects.toThrow(/state/);
  });

  it('rejects when RegisterUser returns non-2xx with status in the message', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [cfg.registerPath]: new Response('boom', { status: 500 }),
      })
    );
    await expect(windsurf.exchangeToken(cfg, '?access_token=t', 'r', null, null)).rejects.toThrow(
      /500/
    );
  });

  it('rejects when RegisterUser returns invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [cfg.registerPath]: new Response('<html>', { status: 200 }),
      })
    );
    await expect(windsurf.exchangeToken(cfg, '?access_token=t', 'r', null, null)).rejects.toThrow(
      /invalid JSON/
    );
  });

  it('rejects when RegisterUser omits the apiKey', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [cfg.registerPath]: jsonRes({ name: 'no key' }),
      })
    );
    await expect(windsurf.exchangeToken(cfg, '?access_token=t', 'r', null, null)).rejects.toThrow(
      /apiKey/
    );
  });
});

describe('exchangeToken — paste-token mode', () => {
  it('accepts a pasted sk-ws- apiKey without any network call', async () => {
    const out = await windsurf.exchangeToken(cfg, ' Bearer sk-ws-direct ', 'r', null, null);
    expect(out.accessToken).toBe('sk-ws-direct');
    expect(out.firebaseIdToken).toBeNull();
    expect(out._authMethod).toBe('imported');
    expect(out.apiServerUrl).toBe(cfg.defaultApiServerUrl);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('registers a pasted firebase JWT', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [cfg.registerPath]: jsonRes({ apiKey: 'sk-ws-fromjwt', apiServerUrl: 'https://srv' }),
      })
    );
    const out = await windsurf.exchangeToken(cfg, 'eyJhbGci.payload.sig', 'r', null, null);
    expect(out.accessToken).toBe('sk-ws-fromjwt');
    expect(out.firebaseIdToken).toBe('eyJhbGci.payload.sig');
    expect(out._authMethod).toBe('imported');
  });
});

describe('postExchange', () => {
  it('returns null user info when no firebaseIdToken is present', async () => {
    const out = await windsurf.postExchange({ firebaseIdToken: null });
    expect(out).toEqual({ userInfo: { email: null, name: null } });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fetches email/name via GetOneTimeAuthToken → GetCurrentUser', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [cfg.oneTimeAuthPath]: jsonRes({ authToken: 'ott' }),
        [cfg.currentUserPath]: jsonRes({ user: { email: 'a@b.c', name: 'A' } }),
      })
    );
    const out = await windsurf.postExchange({ firebaseIdToken: 'f', apiServerUrl: 'https://srv/' });
    expect(out.userInfo).toEqual({ email: 'a@b.c', name: 'A' });
  });

  it('reads a flat GetCurrentUser response (no user wrapper)', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [cfg.oneTimeAuthPath]: jsonRes({ auth_token: 'ott' }),
        [cfg.currentUserPath]: jsonRes({ email: 'flat@x.y', name: 'Flat' }),
      })
    );
    const out = await windsurf.postExchange({ firebaseIdToken: 'f', apiServerUrl: 'https://srv' });
    expect(out.userInfo.email).toBe('flat@x.y');
  });

  it('returns nulls when no authToken comes back', async () => {
    vi.stubGlobal('fetch', routeFetch({ [cfg.oneTimeAuthPath]: jsonRes({}) }));
    const out = await windsurf.postExchange({ firebaseIdToken: 'f', apiServerUrl: 'https://srv' });
    expect(out.userInfo).toEqual({ email: null, name: null });
  });

  it('swallows network failures into null user info', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net down')));
    const out = await windsurf.postExchange({ firebaseIdToken: 'f', apiServerUrl: 'https://srv' });
    expect(out.userInfo).toEqual({ email: null, name: null });
  });
});

describe('mapTokens', () => {
  it('maps tokens and provider-specific data, defaulting authMethod to oauth', () => {
    const mapped = windsurf.mapTokens(
      { accessToken: 'sk-ws-1', apiServerUrl: 'https://srv', firebaseIdToken: 'f' },
      { userInfo: { email: 'e@x', name: 'N' } }
    );
    expect(mapped.accessToken).toBe('sk-ws-1');
    expect(mapped.refreshToken).toBeNull();
    expect(mapped.email).toBe('e@x');
    expect(mapped.displayName).toBe('N');
    expect(mapped.providerSpecificData).toEqual({
      authMethod: 'oauth',
      apiServerUrl: 'https://srv',
      firebaseIdToken: 'f',
    });
  });

  it('omits email/displayName when user info is absent', () => {
    const mapped = windsurf.mapTokens({ accessToken: 'k', _authMethod: 'imported' }, undefined);
    expect(mapped.email).toBeUndefined();
    expect(mapped.displayName).toBeUndefined();
    expect(mapped.providerSpecificData.authMethod).toBe('imported');
  });
});
