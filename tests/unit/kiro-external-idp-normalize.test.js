import { describe, expect, it } from 'vitest';
import {
  validateMicrosoftTokenEndpoint,
  normalizeScope,
  decodeJwtPayload,
  normalizeKiroExternalIdpAuth,
  buildExternalIdpRefreshParams,
} from '@/lib/oauth/kiroExternalIdp.js';

// Pure normalization/validation contracts for the CLIProxyAPI external_idp
// importer. No network anywhere in this module's pure functions.

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const makeJwt = (payload) => `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;

// A structurally valid Microsoft token endpoint, host taken from the module's
// own accepted-set behavior (validated below), not asserted as a literal elsewhere.
const ENDPOINT = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token';

function validInput(overrides = {}) {
  return {
    auth_method: 'external_idp',
    access_token: makeJwt({ email: 'user@corp.test', exp: 4102444800 }),
    refresh_token: 'rt-1',
    client_id: 'cid-1',
    token_endpoint: ENDPOINT,
    profile_arn: 'arn:aws:codewhisperer:us-east-1:1:profile/x',
    region: 'eu-west-1',
    scopes: ['openid', ' profile ', ''],
    ...overrides,
  };
}

describe('validateMicrosoftTokenEndpoint', () => {
  it('accepts an https Microsoft login endpoint and normalizes it to a URL string', () => {
    expect(validateMicrosoftTokenEndpoint(`  ${ENDPOINT}  `)).toBe(ENDPOINT);
  });

  it('rejects empty, unparseable, non-https, and non-Microsoft endpoints', () => {
    expect(() => validateMicrosoftTokenEndpoint('')).toThrow(/token_endpoint is required/);
    expect(() => validateMicrosoftTokenEndpoint('not a url')).toThrow(/valid URL/);
    expect(() => validateMicrosoftTokenEndpoint(ENDPOINT.replace('https:', 'http:'))).toThrow(
      /https/
    );
    expect(() => validateMicrosoftTokenEndpoint('https://evil.example/token')).toThrow(
      /Microsoft login endpoint/
    );
  });
});

describe('normalizeScope', () => {
  it('joins arrays with trimming and blank-dropping, trims strings, empties otherwise', () => {
    expect(normalizeScope(['openid', ' profile ', '', null])).toBe('openid profile');
    expect(normalizeScope('  openid  ')).toBe('openid');
    expect(normalizeScope(undefined)).toBe('');
    expect(normalizeScope(42)).toBe('');
  });
});

describe('decodeJwtPayload', () => {
  it('decodes a base64url payload and returns null for anything malformed', () => {
    expect(decodeJwtPayload(makeJwt({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeJwtPayload(null)).toBeNull();
    expect(decodeJwtPayload(123)).toBeNull();
    expect(decodeJwtPayload('two.parts')).toBeNull();
    expect(decodeJwtPayload('a.!!!.c')).toBeNull();
  });
});

describe('normalizeKiroExternalIdpAuth', () => {
  it('imports a valid JSON string round-trip with normalized providerSpecificData', () => {
    const out = normalizeKiroExternalIdpAuth(JSON.stringify(validInput()));
    expect(out.accessToken).toBe(validInput().access_token);
    expect(out.refreshToken).toBe('rt-1');
    expect(out.email).toBe('user@corp.test');
    expect(out.providerSpecificData).toMatchObject({
      authMethod: 'external_idp',
      clientId: 'cid-1',
      tokenEndpoint: ENDPOINT,
      scope: 'openid profile',
      region: 'eu-west-1',
    });
  });

  it('accepts camelCase field aliases', () => {
    const camel = {
      authMethod: 'external_idp',
      accessToken: validInput().access_token,
      refreshToken: 'rt-1',
      clientId: 'cid-1',
      tokenEndpoint: ENDPOINT,
      profileArn: 'arn:aws:x',
      scope: 'openid',
    };
    const out = normalizeKiroExternalIdpAuth(camel);
    expect(out.providerSpecificData.clientId).toBe('cid-1');
    expect(out.providerSpecificData.region).toBe('us-east-1'); // module default
  });

  it('rejects invalid JSON, non-objects, and non-external_idp auth methods', () => {
    expect(() => normalizeKiroExternalIdpAuth('{not json')).toThrow(/auth JSON is invalid/);
    expect(() => normalizeKiroExternalIdpAuth(null)).toThrow(/auth JSON is required/);
    expect(() => normalizeKiroExternalIdpAuth('"just a string"')).toThrow(/auth JSON is required/);
    expect(() => normalizeKiroExternalIdpAuth(validInput({ auth_method: 'social' }))).toThrow(
      /Only external_idp/
    );
  });

  it('requires each credential field by name', () => {
    for (const [field, message] of [
      ['access_token', /access_token is required/],
      ['refresh_token', /refresh_token is required/],
      ['client_id', /client_id is required/],
      ['scopes', /scopes is required/],
      ['profile_arn', /profile_arn is required/],
    ]) {
      expect(() => normalizeKiroExternalIdpAuth(validInput({ [field]: '' }))).toThrow(message);
    }
  });

  it('rejects a region that fails the shared AWS pattern', () => {
    expect(() => normalizeKiroExternalIdpAuth(validInput({ region: 'evil.host/x' }))).toThrow(
      /Invalid region/
    );
  });

  it('resolves expiresAt from explicit timestamp, then expires_in, then JWT exp, then default', () => {
    const explicit = '2031-01-02T03:04:05.000Z';
    expect(normalizeKiroExternalIdpAuth(validInput({ expired: explicit })).expiresAt).toBe(
      explicit
    );

    const before = Date.now();
    const viaExpiresIn = normalizeKiroExternalIdpAuth(validInput({ expires_in: 120 }));
    const ms = new Date(viaExpiresIn.expiresAt).getTime();
    expect(ms).toBeGreaterThanOrEqual(before + 119_000);
    expect(ms).toBeLessThanOrEqual(Date.now() + 121_000);

    // No explicit, no expires_in → JWT exp claim (fixture uses 4102444800 = 2100-01-01)
    const viaJwt = normalizeKiroExternalIdpAuth(validInput());
    expect(viaJwt.expiresAt).toBe(new Date(4102444800 * 1000).toISOString());

    // Opaque access token → 1h default
    const opaque = normalizeKiroExternalIdpAuth(validInput({ access_token: 'opaque-token' }));
    const defMs = new Date(opaque.expiresAt).getTime();
    expect(defMs).toBeGreaterThanOrEqual(before + 3_599_000);
    expect(defMs).toBeLessThanOrEqual(Date.now() + 3_601_000);
    expect(opaque.email).toBeNull(); // opaque token has no claims
  });

  it('falls back through preferred_username / upn / sub for the email claim', () => {
    const claim = (payload) =>
      normalizeKiroExternalIdpAuth(validInput({ access_token: makeJwt(payload) })).email;
    expect(claim({ preferred_username: 'pu' })).toBe('pu');
    expect(claim({ upn: 'u@corp' })).toBe('u@corp');
    expect(claim({ sub: 'subject' })).toBe('subject');
    expect(normalizeKiroExternalIdpAuth(validInput({ email: 'top@level' })).email).toBe(
      'top@level'
    );
  });
});

describe('buildExternalIdpRefreshParams', () => {
  const psd = { clientId: 'cid-1', tokenEndpoint: ENDPOINT, scope: 'openid profile' };

  it('builds a form-encoded refresh body from providerSpecificData, snake_case aliases included', () => {
    const out = buildExternalIdpRefreshParams('rt-1', {
      client_id: 'cid-1',
      token_endpoint: ENDPOINT,
      scopes: ['openid'],
    });
    expect(out.tokenEndpoint).toBe(ENDPOINT);
    expect(Object.fromEntries(out.body)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'cid-1',
      refresh_token: 'rt-1',
      scope: 'openid',
    });
    expect(out.providerSpecificData.authMethod).toBe('external_idp');
  });

  it('requires refreshToken, clientId and scope, and validates the endpoint', () => {
    expect(() => buildExternalIdpRefreshParams('', psd)).toThrow(/refresh token is required/);
    expect(() => buildExternalIdpRefreshParams('rt', { ...psd, clientId: '' })).toThrow(
      /clientId is required/
    );
    expect(() => buildExternalIdpRefreshParams('rt', { ...psd, scope: '' })).toThrow(
      /scope is required/
    );
    expect(() =>
      buildExternalIdpRefreshParams('rt', { ...psd, tokenEndpoint: 'https://evil.example/t' })
    ).toThrow(/Microsoft login endpoint/);
  });
});
