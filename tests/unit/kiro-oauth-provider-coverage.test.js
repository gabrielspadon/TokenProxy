// Coverage for src/lib/oauth/providers/kiro.js. Every URL and payload
// expectation derives from the provider's own `config` export or from the
// values the flow itself returns, never a hardcoded provider literal. All
// network goes through a stubbed global fetch; nothing reaches the wire.
import { afterEach, describe, expect, it, vi } from 'vitest';
import kiro from '@/lib/oauth/providers/kiro.js';

const cfg = kiro.config;

// The provider builds its endpoints from the region; the default-region
// endpoints in the config are the reference for the default path.
const defaultRegion = new URL(cfg.registerClientUrl).hostname.split('.')[1];
const oidcHost = (region) => `oidc.${region}.amazonaws.com`;

function stubFetch(responders) {
  const calls = [];
  let i = 0;
  const fn = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = responders[Math.min(i++, responders.length - 1)];
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => {
        if (r.jsonError) throw new Error('bad json');
        return r.json ?? {};
      },
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('requestDeviceCode', () => {
  const clientInfo = { clientId: 'cid-1', clientSecret: 'csec-1' };
  const deviceData = {
    deviceCode: 'dc-1',
    userCode: 'UC-1',
    verificationUri: 'https://verify.example.invalid',
    verificationUriComplete: 'https://verify.example.invalid?u=UC-1',
    expiresIn: 600,
    interval: 7,
  };

  it('registers a client from the config then requests device authorization', async () => {
    const { calls } = stubFetch([{ json: clientInfo }, { json: deviceData }]);
    const out = await kiro.requestDeviceCode(cfg, 'unused-challenge', {});

    expect(calls[0].url).toBe(cfg.registerClientUrl);
    const regBody = JSON.parse(calls[0].init.body);
    expect(regBody).toEqual({
      clientName: cfg.clientName,
      clientType: cfg.clientType,
      scopes: cfg.scopes,
      grantTypes: cfg.grantTypes,
      issuerUrl: cfg.issuerUrl,
    });

    expect(calls[1].url).toBe(cfg.deviceAuthUrl);
    const devBody = JSON.parse(calls[1].init.body);
    expect(devBody).toEqual({
      clientId: clientInfo.clientId,
      clientSecret: clientInfo.clientSecret,
      startUrl: cfg.startUrl,
    });

    expect(out).toEqual({
      device_code: deviceData.deviceCode,
      user_code: deviceData.userCode,
      verification_uri: deviceData.verificationUri,
      verification_uri_complete: deviceData.verificationUriComplete,
      expires_in: deviceData.expiresIn,
      interval: deviceData.interval,
      _clientId: clientInfo.clientId,
      _clientSecret: clientInfo.clientSecret,
      _region: defaultRegion,
      _authMethod: 'builder-id',
      _startUrl: cfg.startUrl,
    });
    // The endpoints hit match the region the flow reports back.
    expect(new URL(calls[0].url).hostname).toBe(oidcHost(out._region));
  });

  it('honors a custom region, startUrl and idc auth method', async () => {
    const region = 'eu-west-2';
    const { calls } = stubFetch([{ json: clientInfo }, { json: deviceData }]);
    const out = await kiro.requestDeviceCode(cfg, 'ch', {
      region: `  ${region}  `,
      startUrl: '  https://corp.example.invalid/start  ',
      authMethod: 'idc',
    });
    expect(new URL(calls[0].url).hostname).toBe(oidcHost(region));
    expect(new URL(calls[1].url).hostname).toBe(oidcHost(region));
    expect(JSON.parse(calls[1].init.body).startUrl).toBe('https://corp.example.invalid/start');
    expect(out._region).toBe(region);
    expect(out._authMethod).toBe('idc');
    expect(out._startUrl).toBe('https://corp.example.invalid/start');
  });

  it('defaults the poll interval when the upstream omits it', async () => {
    stubFetch([{ json: clientInfo }, { json: { ...deviceData, interval: undefined } }]);
    const out = await kiro.requestDeviceCode(cfg, 'ch', {});
    expect(out.interval).toBe(5);
  });

  it('rejects an invalid region before any network call', async () => {
    const { fn } = stubFetch([{ json: clientInfo }]);
    await expect(kiro.requestDeviceCode(cfg, 'ch', { region: 'evil.host/x' })).rejects.toThrow(
      'Invalid region'
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws with the upstream text when client registration fails', async () => {
    stubFetch([{ ok: false, status: 400, text: 'reg-denied' }]);
    await expect(kiro.requestDeviceCode(cfg, 'ch', {})).rejects.toThrow(
      'Client registration failed: reg-denied'
    );
  });

  it('throws with the upstream text when device authorization fails', async () => {
    stubFetch([{ json: clientInfo }, { ok: false, status: 400, text: 'dev-denied' }]);
    await expect(kiro.requestDeviceCode(cfg, 'ch', {})).rejects.toThrow(
      'Device authorization failed: dev-denied'
    );
  });
});

describe('pollToken', () => {
  const extra = {
    _clientId: 'cid-2',
    _clientSecret: 'csec-2',
    _region: 'ap-southeast-1',
    _authMethod: 'idc',
    _startUrl: 'https://corp.example.invalid/start',
  };

  it('POSTs the device code with stored client credentials and maps camelCase tokens', async () => {
    const { calls } = stubFetch([
      { json: { accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, profileArn: 'arn:x' } },
    ]);
    const out = await kiro.pollToken(cfg, 'dc-2', 'unused-verifier', extra);

    expect(new URL(calls[0].url).hostname).toBe(oidcHost(extra._region));
    expect(JSON.parse(calls[0].init.body)).toEqual({
      clientId: extra._clientId,
      clientSecret: extra._clientSecret,
      deviceCode: 'dc-2',
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    expect(out).toEqual({
      ok: true,
      data: {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        profile_arn: 'arn:x',
        _clientId: extra._clientId,
        _clientSecret: extra._clientSecret,
        _region: extra._region,
        _authMethod: extra._authMethod,
        _startUrl: extra._startUrl,
      },
    });
  });

  it('falls back to the default-region token URL with no extraData', async () => {
    const { calls } = stubFetch([{ json: { error: 'authorization_pending' } }]);
    await kiro.pollToken(cfg, 'dc', 'cv', undefined);
    expect(calls[0].url).toBe(cfg.tokenUrl);
  });

  it('returns pending errors with the upstream description or message', async () => {
    stubFetch([{ json: { error: 'slow_down', message: 'wait more' } }]);
    const out = await kiro.pollToken(cfg, 'dc', 'cv', extra);
    expect(out).toEqual({
      ok: false,
      data: { error: 'slow_down', error_description: 'wait more' },
    });
  });

  it('defaults to authorization_pending when the body carries no error field', async () => {
    stubFetch([{ json: {} }]);
    const out = await kiro.pollToken(cfg, 'dc', 'cv', extra);
    expect(out.ok).toBe(false);
    expect(out.data.error).toBe('authorization_pending');
  });

  it('wraps a non-JSON response as invalid_response with the raw text', async () => {
    stubFetch([{ jsonError: true, text: '<html>gateway</html>' }]);
    const out = await kiro.pollToken(cfg, 'dc', 'cv', extra);
    expect(out).toEqual({
      ok: false,
      data: { error: 'invalid_response', error_description: '<html>gateway</html>' },
    });
  });

  it('rejects an invalid stored region before any network call', async () => {
    const { fn } = stubFetch([{ json: {} }]);
    await expect(kiro.pollToken(cfg, 'dc', 'cv', { _region: 'not a region' })).rejects.toThrow(
      'Invalid region'
    );
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('mapTokens', () => {
  it('maps snake_case tokens, extracts the JWT email, and keeps provider data', () => {
    const tokens = {
      access_token: fakeJwt({ email: 'user@example.invalid' }),
      refresh_token: 'rt',
      expires_in: 3600,
      profile_arn: 'arn:y',
      _clientId: 'cid',
      _clientSecret: 'csec',
      _region: 'eu-central-1',
      _authMethod: 'idc',
      _startUrl: 'https://corp.example.invalid/start',
    };
    const out = kiro.mapTokens(tokens);
    expect(out.accessToken).toBe(tokens.access_token);
    expect(out.refreshToken).toBe('rt');
    expect(out.expiresIn).toBe(3600);
    expect(out.email).toBe('user@example.invalid');
    expect(out.providerSpecificData).toEqual({
      profileArn: 'arn:y',
      clientId: 'cid',
      clientSecret: 'csec',
      region: 'eu-central-1',
      authMethod: 'idc',
      startUrl: 'https://corp.example.invalid/start',
    });
  });

  it('applies config defaults for missing region, authMethod, startUrl and profileArn', () => {
    const out = kiro.mapTokens({ access_token: 'not-a-jwt', _clientId: 'c', _clientSecret: 's' });
    expect(out.email).toBeUndefined();
    expect(out.providerSpecificData.profileArn).toBeNull();
    expect(out.providerSpecificData.region).toBe(defaultRegion);
    expect(out.providerSpecificData.authMethod).toBe('builder-id');
    expect(out.providerSpecificData.startUrl).toBe(cfg.startUrl);
  });
});
