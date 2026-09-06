import { afterEach, describe, expect, it, vi } from 'vitest';
import { KiroService } from '@/lib/oauth/services/kiro.js';
import { KIRO_CONFIG } from '@/lib/oauth/constants/oauth.js';
import { AWS_REGION_PATTERN } from 'open-sse/config/awsRegions.js';

// Behavior contracts for the Kiro OAuth service, all network via an injected
// global fetch fake. Expectations derive from KIRO_CONFIG / AWS_REGION_PATTERN
// and input→output relationships, not provider literals.

function fakeFetch(...responses) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    let body = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(url), init, body });
    const r = responses.length > 1 ? responses.shift() : responses[0];
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

afterEach(() => vi.unstubAllGlobals());

const svc = new KiroService();

describe('registerClient', () => {
  it('sends the registration contract from KIRO_CONFIG and returns the client triple', async () => {
    const { calls } = fakeFetch({
      json: { clientId: 'cid', clientSecret: 'cs', clientSecretExpiresAt: 123 },
    });
    const out = await svc.registerClient('eu-west-1');
    expect(new URL(calls[0].url).hostname).toContain('eu-west-1');
    expect(calls[0].body.clientName).toBe(KIRO_CONFIG.clientName);
    expect(calls[0].body.scopes).toEqual(KIRO_CONFIG.scopes);
    expect(calls[0].body.grantTypes).toEqual(KIRO_CONFIG.grantTypes);
    expect(out).toEqual({ clientId: 'cid', clientSecret: 'cs', clientSecretExpiresAt: 123 });
  });

  it('rejects a region the shared AWS pattern rejects, before any fetch', async () => {
    const bad = 'us-east-1; rm -rf /';
    expect(AWS_REGION_PATTERN.test(bad)).toBe(false);
    const { fn } = fakeFetch({});
    await expect(svc.registerClient(bad)).rejects.toThrow('Invalid region');
    expect(fn).not.toHaveBeenCalled();
  });

  it('propagates the upstream error body on non-ok', async () => {
    fakeFetch({ ok: false, text: 'boom' });
    await expect(svc.registerClient()).rejects.toThrow(/Failed to register client: boom/);
  });
});

describe('startDeviceAuthorization', () => {
  it('passes the client triple through and defaults the poll interval to 5', async () => {
    const { calls } = fakeFetch({
      json: { deviceCode: 'd', userCode: 'u', verificationUri: 'v', expiresIn: 600 },
    });
    const out = await svc.startDeviceAuthorization('cid', 'cs', 'https://start');
    expect(calls[0].body).toEqual({
      clientId: 'cid',
      clientSecret: 'cs',
      startUrl: 'https://start',
    });
    expect(out.interval).toBe(5);
    expect(out.deviceCode).toBe('d');
  });

  it('keeps a provider-supplied interval', async () => {
    fakeFetch({ json: { interval: 9 } });
    const out = await svc.startDeviceAuthorization('cid', 'cs', 's');
    expect(out.interval).toBe(9);
  });

  it('throws with the upstream body on non-ok', async () => {
    fakeFetch({ ok: false, text: 'denied' });
    await expect(svc.startDeviceAuthorization('cid', 'cs', 's')).rejects.toThrow(/denied/);
  });
});

describe('pollDeviceToken', () => {
  it.each(['authorization_pending', 'slow_down'])(
    'reports %s as pending, not failure',
    async (code) => {
      fakeFetch({ ok: false, json: { error: code, error_description: 'wait' } });
      const out = await svc.pollDeviceToken('cid', 'cs', 'dc');
      expect(out).toMatchObject({
        success: false,
        pending: true,
        error: code,
        errorDescription: 'wait',
      });
    }
  );

  it('reports a terminal error as non-pending', async () => {
    fakeFetch({ ok: false, json: { error: 'expired_token' } });
    const out = await svc.pollDeviceToken('cid', 'cs', 'dc');
    expect(out.success).toBe(false);
    expect(out.pending).toBe(false);
  });

  it('returns the token bundle on success with the device-code grant', async () => {
    const tokens = { accessToken: 'a', refreshToken: 'r', expiresIn: 3600, tokenType: 'Bearer' };
    const { calls } = fakeFetch({ json: tokens });
    const out = await svc.pollDeviceToken('cid', 'cs', 'dc');
    expect(calls[0].body.grantType).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(out).toEqual({ success: true, tokens });
  });
});

describe('social login: build URL and code exchange agree on redirect_uri', () => {
  it('maps provider to idp and carries challenge/state through', () => {
    const url = new URL(svc.buildSocialLoginUrl('google', 'chal', 'st'));
    expect(url.searchParams.get('idp')).toBe('Google');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st');
    expect(new URL(svc.buildSocialLoginUrl('github', 'c', 's')).searchParams.get('idp')).toBe(
      'Github'
    );
  });

  it('exchanges the code with the SAME redirect_uri the login URL advertised', async () => {
    const advertised = new URL(svc.buildSocialLoginUrl('google', 'c', 's')).searchParams.get(
      'redirect_uri'
    );
    const { calls } = fakeFetch({ json: { accessToken: 'a', refreshToken: 'r', profileArn: 'p' } });
    const out = await svc.exchangeSocialCode('code', 'verifier');
    expect(calls[0].body.redirect_uri).toBe(advertised);
    expect(calls[0].body.code_verifier).toBe('verifier');
    expect(out.expiresIn).toBe(3600); // default when the provider omits it
    expect(out.accessToken).toBe('a');
  });

  it('throws with the upstream body when the exchange fails', async () => {
    fakeFetch({ ok: false, text: 'bad code' });
    await expect(svc.exchangeSocialCode('c', 'v')).rejects.toThrow(
      /Token exchange failed: bad code/
    );
  });
});

describe('refreshToken', () => {
  it('uses the AWS OIDC branch when clientId+clientSecret are present, in the stored region', async () => {
    const { calls } = fakeFetch({ json: { accessToken: 'a', expiresIn: 100 } });
    const out = await svc.refreshToken('rt', {
      clientId: 'cid',
      clientSecret: 'cs',
      region: 'ap-south-1',
    });
    expect(new URL(calls[0].url).hostname).toContain('ap-south-1');
    expect(calls[0].body).toMatchObject({
      clientId: 'cid',
      clientSecret: 'cs',
      refreshToken: 'rt',
      grantType: 'refresh_token',
    });
    // no rotation in the response → the caller's refresh token survives
    expect(out.refreshToken).toBe('rt');
    expect(out.accessToken).toBe('a');
  });

  it('rejects an invalid stored region before fetching (AWS branch)', async () => {
    const { fn } = fakeFetch({});
    await expect(
      svc.refreshToken('rt', { clientId: 'c', clientSecret: 's', region: 'evil/../host' })
    ).rejects.toThrow('Invalid region');
    expect(fn).not.toHaveBeenCalled();
  });

  it('uses the social branch without client credentials and defaults expiresIn', async () => {
    const { calls } = fakeFetch({
      json: { accessToken: 'a', refreshToken: 'r2', profileArn: 'p' },
    });
    const out = await svc.refreshToken('rt', {});
    expect(calls[0].body).toEqual({ refreshToken: 'rt' });
    expect(out).toEqual({ accessToken: 'a', refreshToken: 'r2', profileArn: 'p', expiresIn: 3600 });
  });

  it('propagates a refresh failure from either branch', async () => {
    fakeFetch({ ok: false, text: 'revoked' });
    await expect(svc.refreshToken('rt')).rejects.toThrow(/Token refresh failed: revoked/);
  });
});

describe('validateImportToken', () => {
  it('rejects a token missing the expected prefix without any network call', async () => {
    const { fn } = fakeFetch({});
    await expect(svc.validateImportToken('nope')).rejects.toThrow(/Invalid token format/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('validates by refreshing and tags the result as imported', async () => {
    fakeFetch({ json: { accessToken: 'a', expiresIn: 60 } });
    const out = await svc.validateImportToken('aorAAAAAGxyz');
    expect(out.authMethod).toBe('imported');
    expect(out.refreshToken).toBe('aorAAAAAGxyz'); // fallback when refresh returns none
  });

  it('wraps a refresh failure as a validation failure', async () => {
    fakeFetch({ ok: false, text: 'dead' });
    await expect(svc.validateImportToken('aorAAAAAGxyz')).rejects.toThrow(
      /Token validation failed: .*dead/
    );
  });
});

describe('profile and model listing', () => {
  const arn = (region) => `arn:aws:codewhisperer:${region}:123:profile/x`;

  it('prefers the profile whose ARN region matches the requested region', async () => {
    fakeFetch({
      json: { profiles: [{ arn: arn('us-east-1') }, { profileArn: arn('eu-west-1') }] },
    });
    expect(await svc.listAvailableProfiles('tok', 'eu-west-1')).toBe(arn('eu-west-1'));
  });

  it('falls back to the first profile when no region matches, null when empty', async () => {
    fakeFetch({ json: { profiles: [{ arn: arn('us-west-2') }] } }, { json: { profiles: [] } });
    expect(await svc.listAvailableProfiles('tok', 'eu-west-1')).toBe(arn('us-west-2'));
    expect(await svc.listAvailableProfiles('tok', 'eu-west-1')).toBeNull();
  });

  it('maps models with defaults for missing name and token limits', async () => {
    fakeFetch({
      json: {
        models: [
          { modelId: 'm1' },
          { modelId: 'm2', modelName: 'M2', tokenLimits: { maxInputTokens: 7 } },
        ],
      },
    });
    const out = await svc.listAvailableModels('tok', 'arn');
    expect(out).toEqual([
      expect.objectContaining({ id: 'm1', name: 'm1', maxInputTokens: 0 }),
      expect.objectContaining({ id: 'm2', name: 'M2', maxInputTokens: 7 }),
    ]);
  });
});

describe('validateApiKey', () => {
  it('rejects an empty or whitespace key without network', async () => {
    const { fn } = fakeFetch({});
    await expect(svc.validateApiKey('   ')).rejects.toThrow('API key is required');
    await expect(svc.validateApiKey(null)).rejects.toThrow('API key is required');
    expect(fn).not.toHaveBeenCalled();
  });

  it('accepts a key only when the model catalog is non-empty, and trims it', async () => {
    fakeFetch({ json: { models: [{ modelId: 'm' }] } });
    const out = await svc.validateApiKey('  key  ', 'us-east-1');
    expect(out).toEqual({
      accessToken: 'key',
      refreshToken: null,
      profileArn: null,
      region: 'us-east-1',
      authMethod: 'api_key',
    });
  });

  it('wraps an empty catalog as a validation failure (200-with-nothing is not proof)', async () => {
    fakeFetch({ json: { models: [] } });
    await expect(svc.validateApiKey('key')).rejects.toThrow(
      /API key validation failed: .*no available models/
    );
  });
});

describe('extractEmailFromJWT', () => {
  const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

  it('reads email, then preferred_username, then sub', () => {
    expect(svc.extractEmailFromJWT(jwt({ email: 'e@x' }))).toBe('e@x');
    expect(svc.extractEmailFromJWT(jwt({ preferred_username: 'u' }))).toBe('u');
    expect(svc.extractEmailFromJWT(jwt({ sub: 's' }))).toBe('s');
  });

  it('returns null for malformed input instead of throwing', () => {
    expect(svc.extractEmailFromJWT('not-a-jwt')).toBeNull();
    expect(svc.extractEmailFromJWT('a.%%%.c')).toBeNull();
  });
});
