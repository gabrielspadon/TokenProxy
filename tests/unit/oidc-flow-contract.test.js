import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => '__jwks__'),
  jwtVerify: vi.fn(),
}));
vi.mock('@/lib/localDb', () => ({ getSettings: vi.fn() }));

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getSettings } from '@/lib/localDb';
import {
  normalizeScopes,
  getPublicOrigin,
  isOidcConfigured,
  isOidcAuthMode,
  getOidcRuntimeConfig,
  fetchOidcDiscovery,
  createPkcePair,
  createOidcState,
  createOidcNonce,
  buildOidcAuthorizationUrl,
  exchangeOidcCode,
  probeOidcClientSecret,
  verifyOidcIdToken,
  pickOidcDisplayName,
  pickOidcEmail,
} from '@/lib/auth/oidc.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('getPublicOrigin', () => {
  it('prefers configured BASE_URL and trims trailing slashes', () => {
    vi.stubEnv('BASE_URL', 'https://app.example.com///');
    expect(getPublicOrigin(null)).toBe('https://app.example.com');
  });

  it('derives origin from forwarded proto and host when unconfigured', () => {
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', '');
    const request = {
      url: 'http://internal:3000/api/auth',
      headers: new Headers({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'pub.example.com' }),
    };
    expect(getPublicOrigin(request)).toBe('https://pub.example.com');
  });

  it('falls back to the Host header with the request URL protocol', () => {
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', '');
    const request = {
      url: 'http://internal:3000/api/auth',
      headers: new Headers({ host: 'host.example.com' }),
    };
    expect(getPublicOrigin(request)).toBe('http://host.example.com');
  });

  it('falls back to the request URL origin when no host header exists', () => {
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', '');
    const request = { url: 'https://origin.example.com/cb', headers: new Headers() };
    expect(getPublicOrigin(request)).toBe('https://origin.example.com');
  });
});

describe('getOidcRuntimeConfig', () => {
  it('returns null when the auth mode is not an OIDC one', async () => {
    getSettings.mockResolvedValue({
      authMode: 'password',
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'c',
      oidcClientSecret: 's',
    });
    expect(await getOidcRuntimeConfig()).toBeNull();
  });

  it('returns null when the config is incomplete', async () => {
    getSettings.mockResolvedValue({ authMode: 'oidc', oidcIssuerUrl: 'https://idp.example.com' });
    expect(await getOidcRuntimeConfig()).toBeNull();
    expect(isOidcConfigured({ oidcIssuerUrl: 'https://x', oidcClientId: 'c' })).toBe(false);
    expect(isOidcAuthMode('password')).toBe(false);
  });

  it('normalizes issuer, scopes, and label', async () => {
    getSettings.mockResolvedValue({
      authMode: 'oidc',
      oidcIssuerUrl: 'https://idp.example.com/realm/',
      oidcClientId: ' client ',
      oidcClientSecret: ' secret ',
      oidcScopes: 'profile email',
      oidcLoginLabel: '  ',
    });
    const cfg = await getOidcRuntimeConfig();
    expect(cfg.issuerUrl).toBe('https://idp.example.com/realm');
    expect(cfg.clientId).toBe('client');
    expect(cfg.clientSecret).toBe('secret');
    // openid is re-added: the flow cannot work without an id_token
    expect(cfg.scopes.split(/\s+/)).toContain('openid');
    expect(cfg.loginLabel.length).toBeGreaterThan(0);
  });
});

describe('fetchOidcDiscovery', () => {
  it('fetches the well-known document from the trimmed issuer', async () => {
    const doc = { issuer: 'https://idp.example.com', jwks_uri: 'https://idp.example.com/jwks' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(doc));
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchOidcDiscovery('https://idp.example.com/');
    expect(out).toEqual(doc);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://idp.example.com/.well-known/openid-configuration',
      { cache: 'no-store' }
    );
  });

  it('throws when the discovery endpoint does not answer 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 404)));
    await expect(fetchOidcDiscovery('https://idp.example.com')).rejects.toThrow(/discovery/i);
  });

  it('blocks non-public issuers before any fetch fires (SSRF boundary)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchOidcDiscovery('http://localhost:8080')).rejects.toThrow();
    await expect(fetchOidcDiscovery('http://169.254.169.254')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PKCE, state, and nonce material', () => {
  it('derives the challenge as base64url SHA-256 of the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unpredictable, distinct state and nonce values', () => {
    expect(createOidcState()).not.toBe(createOidcState());
    expect(createOidcNonce()).not.toBe(createOidcNonce());
    expect(createOidcState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('buildOidcAuthorizationUrl', () => {
  it('carries the full authorization-code + PKCE parameter set', () => {
    const url = new URL(
      buildOidcAuthorizationUrl({
        authorizationEndpoint: 'https://idp.example.com/authorize',
        clientId: 'client-1',
        redirectUri: 'https://app.example.com/cb',
        scopes: 'profile',
        state: 'st',
        nonce: 'no',
        codeChallenge: 'ch',
      })
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb');
    expect(url.searchParams.get('scope').split(/\s+/)).toContain('openid');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('nonce')).toBe('no');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(normalizeScopes('')).toContain('openid');
  });
});

describe('exchangeOidcCode', () => {
  const base = {
    tokenEndpoint: 'https://idp.example.com/token',
    clientId: 'c',
    code: 'code-1',
    redirectUri: 'https://app.example.com/cb',
    codeVerifier: 'v',
  };

  it('posts urlencoded grant and includes client_secret only when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id_token: 't' }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await exchangeOidcCode({ ...base, clientSecret: 'sec' });
    expect(out).toEqual({ id_token: 't' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    const body = init.body;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('v');
    expect(body.get('client_secret')).toBe('sec');

    fetchMock.mockResolvedValue(jsonResponse({}));
    await exchangeOidcCode({ ...base, clientSecret: '' });
    expect(fetchMock.mock.calls[1][1].body.has('client_secret')).toBe(false);
  });

  it('surfaces the provider error_description on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: 'invalid_grant', error_description: 'code expired' }, false, 400)
        )
    );
    await expect(exchangeOidcCode({ ...base, clientSecret: 's' })).rejects.toThrow('code expired');
  });

  it('falls back to a status-coded message when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('bad json');
        },
      })
    );
    await expect(exchangeOidcCode({ ...base, clientSecret: 's' })).rejects.toThrow(/502/);
  });
});

describe('probeOidcClientSecret', () => {
  const base = {
    tokenEndpoint: 'https://idp.example.com/token',
    clientId: 'c',
    redirectUri: 'https://app.example.com/cb',
  };

  it('skips when no secret is provided', async () => {
    const out = await probeOidcClientSecret({ ...base, clientSecret: '' });
    expect(out).toMatchObject({ tested: false, valid: null });
  });

  it('reports valid on a 2xx token response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: 1 })));
    const out = await probeOidcClientSecret({ ...base, clientSecret: 's' });
    expect(out).toMatchObject({ tested: true, valid: true });
  });

  it('reports invalid on invalid_client', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: 'invalid_client', error_description: 'bad secret' }, false, 401)
        )
    );
    const out = await probeOidcClientSecret({ ...base, clientSecret: 's' });
    expect(out).toMatchObject({ tested: true, valid: false, message: 'bad secret' });
  });

  it('treats invalid_grant as secret accepted (only the test code is bogus)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, false, 400))
    );
    const out = await probeOidcClientSecret({ ...base, clientSecret: 's' });
    expect(out).toMatchObject({ tested: true, valid: true });
  });

  it('returns indeterminate on an unrecognized error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'server_error' }, false, 500))
    );
    const out = await probeOidcClientSecret({ ...base, clientSecret: 's' });
    expect(out).toMatchObject({ tested: true, valid: null });
  });
});

describe('verifyOidcIdToken', () => {
  it('verifies against the remote JWKS with issuer, audience, and nonce enforced', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'user-1' } });
    const payload = await verifyOidcIdToken({
      idToken: 'tok',
      issuer: 'https://idp.example.com',
      audience: 'client-1',
      jwksUri: 'https://idp.example.com/jwks',
      nonce: 'n1',
    });
    expect(payload).toEqual({ sub: 'user-1' });
    expect(createRemoteJWKSet).toHaveBeenCalledWith(new URL('https://idp.example.com/jwks'));
    expect(jwtVerify).toHaveBeenCalledWith('tok', '__jwks__', {
      issuer: 'https://idp.example.com',
      audience: 'client-1',
      nonce: 'n1',
    });
  });

  it('propagates a verification failure instead of returning a payload', async () => {
    jwtVerify.mockRejectedValue(new Error('signature verification failed'));
    await expect(
      verifyOidcIdToken({
        idToken: 'bad',
        issuer: 'i',
        audience: 'a',
        jwksUri: 'https://idp.example.com/jwks',
      })
    ).rejects.toThrow(/signature/);
  });
});

describe('claim pickers', () => {
  it('pickOidcDisplayName follows the documented precedence', () => {
    expect(pickOidcDisplayName({ preferred_username: 'pu', email: 'e' })).toBe('pu');
    expect(pickOidcDisplayName({ email: 'e', name: 'n' })).toBe('e');
    expect(pickOidcDisplayName({ name: 'n' })).toBe('n');
    expect(pickOidcDisplayName({ given_name: 'g' })).toBe('g');
    expect(pickOidcDisplayName({ sub: 's' })).toBe('s');
    expect(pickOidcDisplayName()).toBeTruthy();
  });

  it('pickOidcEmail returns empty string when absent', () => {
    expect(pickOidcEmail({ email: 'a@b' })).toBe('a@b');
    expect(pickOidcEmail({})).toBe('');
    expect(pickOidcEmail()).toBe('');
  });
});
