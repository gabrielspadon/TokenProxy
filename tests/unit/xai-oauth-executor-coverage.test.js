import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { XAI_CONFIG } from '@/lib/oauth/constants/xai.js';

// Behavior contracts for the xAI OAuth service. All network via a stubbed
// global fetch; browser open and the loopback server are module-mocked.
// Expectations derive from XAI_CONFIG and input→output relationships.

vi.mock('open', () => ({ default: vi.fn(async () => {}) }));
vi.mock('@/lib/oauth/utils/server.js', () => ({
  startLocalServer: vi.fn(),
  waitForCallbackParams: vi.fn(),
}));

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const makeJwt = (payload) => `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;

function fakeFetch(...responses) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = responses.length > 1 ? responses.shift() : responses[0];
    if (r.reject) throw new Error('network down');
    return {
      ok: r.ok ?? true,
      status: r.status ?? (r.ok === false ? 400 : 200),
      json: async () => r.json ?? {},
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const loadXai = () => import('@/lib/oauth/services/xai.js');

describe('validateOAuthEndpoint', () => {
  it('rejects empty and unparseable values with the field name in the error', async () => {
    const { validateOAuthEndpoint } = await loadXai();
    expect(() => validateOAuthEndpoint('', 'token_endpoint')).toThrow(/token_endpoint is empty/);
    expect(() => validateOAuthEndpoint('   ', 'token_endpoint')).toThrow(/is empty/);
    expect(() => validateOAuthEndpoint('not a url', 'token_endpoint')).toThrow(/is invalid/);
  });
});

describe('discoverEndpoints', () => {
  it('falls back to the static config endpoints on a non-ok discovery response, and caches', async () => {
    const { fn } = fakeFetch({ ok: false, text: 'nope' });
    const { discoverEndpoints } = await loadXai();
    await expect(discoverEndpoints()).resolves.toEqual({
      authorizeUrl: XAI_CONFIG.authorizeUrl,
      tokenUrl: XAI_CONFIG.tokenUrl,
    });
    await discoverEndpoints();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('falls back to the static config endpoints when discovery throws', async () => {
    fakeFetch({ reject: true });
    const { discoverEndpoints } = await loadXai();
    await expect(discoverEndpoints()).resolves.toEqual({
      authorizeUrl: XAI_CONFIG.authorizeUrl,
      tokenUrl: XAI_CONFIG.tokenUrl,
    });
  });
});

describe('decodeIdTokenEmail', () => {
  it('returns undefined for non-JWT input', async () => {
    const { decodeIdTokenEmail } = await loadXai();
    expect(decodeIdTokenEmail(undefined)).toBeUndefined();
    expect(decodeIdTokenEmail(42)).toBeUndefined();
    expect(decodeIdTokenEmail('one.two')).toBeUndefined();
    expect(decodeIdTokenEmail('a.%%%.c')).toBeUndefined();
  });

  it('prefers email, then preferred_username, then sub', async () => {
    const { decodeIdTokenEmail } = await loadXai();
    expect(decodeIdTokenEmail(makeJwt({ email: 'e@x', preferred_username: 'p', sub: 's' }))).toBe(
      'e@x'
    );
    expect(decodeIdTokenEmail(makeJwt({ preferred_username: 'p', sub: 's' }))).toBe('p');
    expect(decodeIdTokenEmail(makeJwt({ sub: 's' }))).toBe('s');
    expect(decodeIdTokenEmail(makeJwt({}))).toBeUndefined();
  });
});

describe('exchangeXaiCode', () => {
  it('posts a form-encoded PKCE exchange without a client secret and returns the token JSON', async () => {
    const { calls } = fakeFetch({ json: { access_token: 'at' } });
    const { XaiService } = await loadXai();
    const out = await new XaiService().exchangeXaiCode({
      tokenUrl: XAI_CONFIG.tokenUrl,
      code: 'code-1',
      redirectUri: XAI_CONFIG.redirectUri,
      codeVerifier: 'verifier-1',
    });
    expect(out).toEqual({ access_token: 'at' });
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe(XAI_CONFIG.clientId);
    expect(body.get('code')).toBe('code-1');
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('client_secret')).toBeNull();
  });

  it('propagates the upstream error body on non-ok exchange', async () => {
    fakeFetch({ ok: false, text: 'bad code' });
    const { XaiService } = await loadXai();
    await expect(
      new XaiService().exchangeXaiCode({
        tokenUrl: XAI_CONFIG.tokenUrl,
        code: 'c',
        redirectUri: XAI_CONFIG.redirectUri,
        codeVerifier: 'v',
      })
    ).rejects.toThrow(/token exchange failed: bad code/);
  });
});

describe('refreshAccessToken', () => {
  it('refreshes against the (fallback) token endpoint with a refresh_token grant', async () => {
    const { calls } = fakeFetch(
      { ok: false, text: 'no discovery' }, // discovery → static fallback
      { json: { access_token: 'new-at' } }
    );
    const { XaiService } = await loadXai();
    const out = await new XaiService().refreshAccessToken('rt-1');
    expect(out).toEqual({ access_token: 'new-at' });
    expect(calls[1].url).toBe(XAI_CONFIG.tokenUrl);
    const body = new URLSearchParams(String(calls[1].init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-1');
    expect(body.get('client_id')).toBe(XAI_CONFIG.clientId);
  });

  it('throws with the upstream body on refresh failure', async () => {
    fakeFetch({ ok: false, text: 'expired' });
    const { XaiService } = await loadXai();
    await expect(new XaiService().refreshAccessToken('rt')).rejects.toThrow(/token refresh failed/);
  });
});

describe('connect', () => {
  async function wireFlow(callbackFromAuthUrl) {
    const { startLocalServer } = await import('@/lib/oauth/utils/server.js');
    const close = vi.fn();
    let onCallback;
    startLocalServer.mockImplementation(async (cb) => {
      onCallback = cb;
      return { port: 45678, close };
    });
    const open = (await import('open')).default;
    open.mockImplementation(async (authUrl) => {
      onCallback(callbackFromAuthUrl(new URL(authUrl)));
    });
    return { close, open };
  }

  it('runs the full PKCE round-trip: challenge matches verifier, tokens and email returned', async () => {
    const idToken = makeJwt({ email: 'user@example.test' });
    const { calls } = fakeFetch(
      { reject: true }, // discovery fails → static endpoints branch
      { json: { access_token: 'at', id_token: idToken } }
    );
    const { close, open } = await wireFlow((u) => ({
      code: 'auth-code-1',
      state: u.searchParams.get('state'),
    }));
    const { XaiService } = await loadXai();
    const result = await new XaiService().connect();

    expect(result.tokens.access_token).toBe('at');
    expect(result.email).toBe('user@example.test');
    expect(close).toHaveBeenCalledTimes(1);

    const authUrl = new URL(open.mock.calls[0][0]);
    const body = new URLSearchParams(String(calls[1].init.body));
    const verifier = body.get('code_verifier');
    const expectedChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(authUrl.searchParams.get('code_challenge')).toBe(expectedChallenge);
    expect(body.get('redirect_uri')).toBe(`http://127.0.0.1:45678${XAI_CONFIG.callbackPath}`);
    expect(body.get('code')).toBe('auth-code-1');
  }, 15_000);

  it('rejects with the provider error_description when the callback carries an error', async () => {
    fakeFetch({ reject: true });
    await wireFlow(() => ({ error: 'access_denied', error_description: 'user said no' }));
    const { XaiService } = await loadXai();
    await expect(new XaiService().connect()).rejects.toThrow('user said no');
  }, 15_000);

  it('rejects on a state mismatch before any token exchange', async () => {
    const { fn } = fakeFetch({ reject: true });
    await wireFlow(() => ({ code: 'c', state: 'wrong-state' }));
    const { XaiService } = await loadXai();
    await expect(new XaiService().connect()).rejects.toThrow(/Invalid state parameter/);
    expect(fn).toHaveBeenCalledTimes(1); // discovery only, no exchange
  }, 15_000);
});
