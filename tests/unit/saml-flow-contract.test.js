import { describe, it, expect, vi, afterEach } from 'vitest';

const samlCtor = vi.fn();
const generateAuthorizeRequestAsync = vi.fn();
const _requestToUrlAsync = vi.fn();
const validatePostResponseAsync = vi.fn();

vi.mock('@node-saml/node-saml', () => ({
  SAML: class {
    constructor(options) {
      samlCtor(options);
      this.options = options;
    }
    generateAuthorizeRequestAsync = generateAuthorizeRequestAsync;
    _requestToUrlAsync = _requestToUrlAsync;
    validatePostResponseAsync = validatePostResponseAsync;
    generateServiceProviderMetadata() {
      return `<EntityDescriptor entityID="${this.options.issuer}" acs="${this.options.callbackUrl}"/>`;
    }
  },
}));
vi.mock('../../src/lib/db/repos/settingsRepo.js', () => ({ getSettings: vi.fn() }));

import { getSettings } from '../../src/lib/db/repos/settingsRepo.js';
import {
  formatX509Certificate,
  getSamlRuntimeConfig,
  getSamlBaseUrl,
  createSamlInstance,
  buildSamlAuthorizeUrl,
  validateSamlResponse,
  generateSamlMetadata,
  pickSamlEmail,
  pickSamlDisplayName,
} from '../../src/lib/auth/saml.js';

const SETTINGS = { samlEntryPoint: 'https://idp.example.com/sso', samlCert: 'MIICabc123' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('getSamlRuntimeConfig', () => {
  it('reports configured state from stored settings', async () => {
    getSettings.mockResolvedValue(SETTINGS);
    expect(await getSamlRuntimeConfig()).toEqual({ configured: true, settings: SETTINGS });
    getSettings.mockResolvedValue({});
    expect((await getSamlRuntimeConfig()).configured).toBe(false);
  });
});

describe('getSamlBaseUrl', () => {
  it('prefers settings.baseUrl over env and headers, trimming slashes', () => {
    vi.stubEnv('BASE_URL', 'https://env.example.com');
    expect(getSamlBaseUrl(null, { baseUrl: 'https://cfg.example.com//' })).toBe(
      'https://cfg.example.com'
    );
  });

  it('uses forwarded headers when nothing is configured', () => {
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', '');
    const request = {
      url: 'http://internal:3000/x',
      headers: new Headers({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'pub.example.com' }),
    };
    expect(getSamlBaseUrl(request, {})).toBe('https://pub.example.com');
  });

  it('falls back to request URL origin, then to the loopback default', () => {
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', '');
    const request = { url: 'https://origin.example.com/x', headers: new Headers() };
    expect(getSamlBaseUrl(request, {})).toBe('https://origin.example.com');
    const fallback = getSamlBaseUrl(null, {});
    expect(fallback).toMatch(/^http:\/\/(localhost|127\.0\.0\.1)/);
  });
});

describe('createSamlInstance', () => {
  it('configures signature enforcement and PEM-formatted IdP cert', () => {
    const instance = createSamlInstance(SETTINGS, 'https://app.example.com');
    const options = samlCtor.mock.calls[0][0];
    expect(options.wantAssertionsSigned).toBe(true);
    expect(options.idpCert).toBe(formatX509Certificate(SETTINGS.samlCert));
    expect(options.idpCert).toContain('-----BEGIN CERTIFICATE-----');
    expect(options.entryPoint).toBe(SETTINGS.samlEntryPoint);
    expect(options.callbackUrl).toBe('https://app.example.com/api/auth/saml/acs');
    expect(instance.options).toBe(options);
  });
});

describe('buildSamlAuthorizeUrl', () => {
  it('extracts the request ID from the AuthnRequest and returns the redirect URL', async () => {
    generateAuthorizeRequestAsync.mockResolvedValue('<AuthnRequest ID="_req-42" Version="2.0"/>');
    _requestToUrlAsync.mockResolvedValue('https://idp.example.com/sso?SAMLRequest=abc');
    const out = await buildSamlAuthorizeUrl(null, {
      ...SETTINGS,
      baseUrl: 'https://app.example.com',
    });
    expect(out).toEqual({
      authorizeUrl: 'https://idp.example.com/sso?SAMLRequest=abc',
      requestId: '_req-42',
    });
  });

  it('returns an empty request ID when the XML carries none', async () => {
    generateAuthorizeRequestAsync.mockResolvedValue('<AuthnRequest/>');
    _requestToUrlAsync.mockResolvedValue('https://idp.example.com/sso?SAMLRequest=abc');
    const out = await buildSamlAuthorizeUrl(null, {
      ...SETTINGS,
      baseUrl: 'https://app.example.com',
    });
    expect(out.requestId).toBe('');
  });
});

describe('validateSamlResponse', () => {
  const settings = { ...SETTINGS, baseUrl: 'https://app.example.com' };
  const responseXml = (inResponseTo) =>
    Buffer.from(`<Response InResponseTo="${inResponseTo}"><Assertion/></Response>`).toString(
      'base64'
    );

  it('rejects when the IdP certificate is not configured', async () => {
    await expect(
      validateSamlResponse(null, {}, '', { samlEntryPoint: 'https://x' })
    ).rejects.toThrow(/samlCert/);
    expect(validatePostResponseAsync).not.toHaveBeenCalled();
  });

  it('rejects when SAMLResponse is missing from the POST body', async () => {
    await expect(validateSamlResponse(null, {}, '', settings)).rejects.toThrow(
      /Missing SAMLResponse/
    );
  });

  it('rejects a response whose InResponseTo does not match the stored request ID (replay)', async () => {
    await expect(
      validateSamlResponse(null, { SAMLResponse: responseXml('_other') }, '_req-1', settings)
    ).rejects.toThrow(/InResponseTo mismatch/);
    expect(validatePostResponseAsync).not.toHaveBeenCalled();
  });

  it('rejects a response carrying no InResponseTo when one is expected', async () => {
    const noAttr = Buffer.from('<Response><Assertion/></Response>').toString('base64');
    await expect(
      validateSamlResponse(null, { SAMLResponse: noAttr }, '_req-1', settings)
    ).rejects.toThrow(/received none/);
  });

  it('propagates signature validation failures from the SAML engine', async () => {
    validatePostResponseAsync.mockRejectedValue(new Error('Invalid signature'));
    await expect(
      validateSamlResponse(null, { SAMLResponse: responseXml('_req-1') }, '_req-1', settings)
    ).rejects.toThrow(/Invalid signature/);
  });

  it('returns the profile on a valid, matching response', async () => {
    validatePostResponseAsync.mockResolvedValue({ profile: { nameID: 'user@example.com' } });
    const profile = await validateSamlResponse(
      null,
      { SAMLResponse: responseXml('_req-1') },
      '_req-1',
      settings
    );
    expect(profile).toEqual({ nameID: 'user@example.com' });
  });

  it('accepts a raw string body and skips replay check when no request ID was stored', async () => {
    validatePostResponseAsync.mockResolvedValue({ nameID: 'raw@example.com' });
    const profile = await validateSamlResponse(null, responseXml('_anything'), '', settings);
    expect(profile).toEqual({ nameID: 'raw@example.com' });
  });
});

describe('generateSamlMetadata', () => {
  it('emits SP metadata bound to the resolved origin', () => {
    const xml = generateSamlMetadata('https://app.example.com', SETTINGS);
    expect(xml).toContain('https://app.example.com/api/auth/saml/acs');
  });
});

describe('claim pickers', () => {
  it('pickSamlEmail honors the configured custom attribute first, arrays included', () => {
    const settings = { samlAttributeEmail: 'customMail' };
    expect(pickSamlEmail({ customMail: ['a@b', 'c@d'], email: 'x@y' }, settings)).toBe('a@b');
    expect(pickSamlEmail({ email: 'x@y' }, settings)).toBe('x@y');
  });

  it('pickSamlEmail falls back through common claims and the attributes object', () => {
    expect(pickSamlEmail({ nameID: 'n@e' })).toBe('n@e');
    expect(pickSamlEmail({ attributes: { mail: ['attr@e'] } })).toBe('attr@e');
    expect(pickSamlEmail({})).toBe('');
    expect(pickSamlEmail(null)).toBe('');
  });

  it('pickSamlDisplayName follows custom attribute, common claims, given+surname, then email', () => {
    expect(pickSamlDisplayName({ myName: 'Custom' }, { samlAttributeName: 'myName' })).toBe(
      'Custom'
    );
    expect(pickSamlDisplayName({ displayName: 'Disp' })).toBe('Disp');
    expect(pickSamlDisplayName({ givenName: 'Ada', sn: 'Lovelace' })).toBe('Ada Lovelace');
    expect(pickSamlDisplayName({ surname: 'Only' })).toBe('Only');
    expect(pickSamlDisplayName({ email: 'e@x' })).toBe('e@x');
    expect(pickSamlDisplayName(null)).toBe('');
  });
});
