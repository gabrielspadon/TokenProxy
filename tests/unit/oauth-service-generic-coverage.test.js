// Coverage for src/lib/oauth/services/oauth.js — the generic PKCE
// authorization-code flow. Fully provider-agnostic: the config is a
// constructor input, so every expectation derives from the config object the
// test itself passes in. Browser open, the loopback server, and the spinner
// are module-mocked; token exchange goes through a stubbed global fetch, so
// nothing here can reach the wire.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('open', () => ({ default: vi.fn(async () => {}) }));
vi.mock('@/lib/oauth/utils/server.js', () => ({
  startLocalServer: vi.fn(),
  waitForCallbackParams: vi.fn(),
}));
vi.mock('@/lib/oauth/utils/ui.js', () => {
  const spinnerStub = {
    start: vi.fn(() => spinnerStub),
    succeed: vi.fn(() => spinnerStub),
    stop: vi.fn(() => spinnerStub),
  };
  return { spinner: vi.fn(() => spinnerStub) };
});

const CONFIG = {
  clientId: 'test-client-id',
  codeChallengeMethod: 'S256',
  authorizeUrl: 'https://auth.example.invalid/authorize',
  tokenUrl: 'https://auth.example.invalid/token',
};

let OAuthService;
let server;

beforeEach(async () => {
  vi.resetModules();
  ({ OAuthService } = await import('@/lib/oauth/services/oauth.js'));
  server = await import('@/lib/oauth/utils/server.js');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function stubFetch(response) {
  const fn = vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.json ?? {},
    text: async () => response.text ?? JSON.stringify(response.json ?? {}),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

// Wire the mocked local server: captures the callback setter so a test can
// deliver params, and resolves/rejects the wait according to `params`.
function wireServer({ params, waitError = null, port = 43210 }) {
  const close = vi.fn();
  let deliver;
  server.startLocalServer.mockImplementation(async (onCallback) => {
    deliver = onCallback;
    return { port, close };
  });
  server.waitForCallbackParams.mockImplementation(async () => {
    if (waitError) throw waitError;
    deliver(params);
  });
  return { close, port };
}

describe('buildAuthUrl', () => {
  it('carries every PKCE field from the config plus extra params', () => {
    const svc = new OAuthService(CONFIG);
    const url = new URL(
      svc.buildAuthUrl('http://localhost:1/callback', 'st4te', 'ch4llenge', { scope: 'a b' })
    );
    expect(`${url.origin}${url.pathname}`).toBe(CONFIG.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1/callback');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('code_challenge')).toBe('ch4llenge');
    expect(url.searchParams.get('code_challenge_method')).toBe(CONFIG.codeChallengeMethod);
    expect(url.searchParams.get('scope')).toBe('a b');
  });
});

describe('startAuthFlow', () => {
  it('returns the redirect URI for the allocated port and delivers callback params', async () => {
    const { close, port } = wireServer({ params: { code: 'c0de', state: 's' } });
    const svc = new OAuthService(CONFIG);
    const flow = await svc.startAuthFlow(null, 'provider-x');
    expect(flow.redirectUri).toBe(`http://localhost:${port}/callback`);
    const params = await flow.waitForCallback();
    expect(params).toEqual({ code: 'c0de', state: 's' });
    expect(close).toHaveBeenCalled();
  });

  it('throws the error_description when the callback carries an error', async () => {
    wireServer({ params: { error: 'access_denied', error_description: 'user said no' } });
    const svc = new OAuthService(CONFIG);
    const flow = await svc.startAuthFlow(null, 'provider-x');
    await expect(flow.waitForCallback()).rejects.toThrow('user said no');
  });

  it('falls back to the error code when no description is present', async () => {
    wireServer({ params: { error: 'access_denied' } });
    const svc = new OAuthService(CONFIG);
    const flow = await svc.startAuthFlow(null, 'provider-x');
    await expect(flow.waitForCallback()).rejects.toThrow('access_denied');
  });

  it('throws when the callback has no authorization code', async () => {
    wireServer({ params: { state: 'only' } });
    const svc = new OAuthService(CONFIG);
    const flow = await svc.startAuthFlow(null, 'provider-x');
    await expect(flow.waitForCallback()).rejects.toThrow('No authorization code received');
  });

  it('closes the callback server even when the wait times out', async () => {
    const { close } = wireServer({
      params: null,
      waitError: new Error('Timeout waiting for callback'),
    });
    const svc = new OAuthService(CONFIG);
    const flow = await svc.startAuthFlow(null, 'provider-x');
    await expect(flow.waitForCallback()).rejects.toThrow('Timeout');
    expect(close).toHaveBeenCalled();
  });
});

describe('exchangeCode', () => {
  it('POSTs a form body to the config token URL by default', async () => {
    const fn = stubFetch({ json: { access_token: 'acc' } });
    const svc = new OAuthService(CONFIG);
    const out = await svc.exchangeCode('c0de', 'http://localhost:1/cb', 'ver1fier');
    expect(out).toEqual({ access_token: 'acc' });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe(CONFIG.tokenUrl);
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect(init.body.get('grant_type')).toBe('authorization_code');
    expect(init.body.get('client_id')).toBe(CONFIG.clientId);
    expect(init.body.get('code')).toBe('c0de');
    expect(init.body.get('code_verifier')).toBe('ver1fier');
  });

  it('serializes a JSON body when asked for application/json', async () => {
    const fn = stubFetch({ json: { access_token: 'acc' } });
    const svc = new OAuthService(CONFIG);
    await svc.exchangeCode('c0de', 'http://localhost:1/cb', 'v', 'application/json');
    const [, init] = fn.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toMatchObject({
      grant_type: 'authorization_code',
      client_id: CONFIG.clientId,
      code: 'c0de',
      code_verifier: 'v',
    });
  });

  it('throws with the upstream body text on a non-ok response', async () => {
    stubFetch({ ok: false, status: 400, text: 'bad_verifier' });
    const svc = new OAuthService(CONFIG);
    await expect(svc.exchangeCode('c', 'r', 'v')).rejects.toThrow(
      'Token exchange failed: bad_verifier'
    );
  });
});

describe('authenticate', () => {
  it('runs the full flow and returns code, matching state, verifier and redirect URI', async () => {
    const svc = new OAuthService(CONFIG);
    let sentState;
    const close = vi.fn();
    let deliver;
    server.startLocalServer.mockImplementation(async (onCallback) => {
      deliver = onCallback;
      return { port: 45678, close };
    });
    server.waitForCallbackParams.mockImplementation(async () => {
      deliver({ code: 'authc0de', state: sentState });
    });
    const buildAuthUrlFn = vi.fn((redirectUri, state) => {
      sentState = state;
      return `${CONFIG.authorizeUrl}?state=${state}`;
    });
    const out = await svc.authenticate('provider-x', buildAuthUrlFn);
    expect(out.code).toBe('authc0de');
    expect(out.state).toBe(sentState);
    expect(out.redirectUri).toBe('http://localhost:45678/callback');
    expect(typeof out.codeVerifier).toBe('string');
    expect(out.codeVerifier.length).toBeGreaterThanOrEqual(43);
    const open = (await import('open')).default;
    expect(open).toHaveBeenCalledWith(buildAuthUrlFn.mock.results[0].value);
  });

  it('rejects a callback whose state does not match the one issued', async () => {
    const svc = new OAuthService(CONFIG);
    wireServer({ params: { code: 'c', state: 'forged-state' } });
    await expect(svc.authenticate('provider-x', () => 'https://x.invalid/a')).rejects.toThrow(
      'Invalid state parameter'
    );
  });
});
