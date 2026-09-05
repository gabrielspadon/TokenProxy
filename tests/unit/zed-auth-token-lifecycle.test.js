/**
 * open-sse/shared/zedAuth.js — keypair auth, LLM-token cache, refresh triggers.
 *
 * Zed has no refresh_token: the LLM token is re-minted from the long-lived
 * access token. The money paths: the mint must not double-fire while cached,
 * a 401 or x-zed-expired-token header must force a re-mint, the RSA
 * decrypt roundtrip must survive both paddings, and a mint reply without a
 * token must surface an error rather than cache garbage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

vi.mock('open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from 'open-sse/utils/proxyFetch.js';
import {
  createZedNativeAuthData,
  parseZedCallbackPayload,
  decryptZedAccessToken,
  decodeZedPrivateKeyVerifier,
  buildZedUserAuthHeader,
  resolveZedOrganizationId,
  fetchZedLlmToken,
  shouldRefreshZedLlmToken,
  clearZedCaches,
  ZED_HEADERS,
} from 'open-sse/shared/zedAuth.js';

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

const creds = (token = 'tok-1') => ({
  accessToken: token,
  providerSpecificData: { userId: 'u-1', organizationId: 'org-1' },
});

beforeEach(() => {
  vi.clearAllMocks();
  clearZedCaches();
});

describe('keypair auth roundtrip', () => {
  it('decrypts an OAEP-encrypted access token with the generated verifier', () => {
    const { privateKeyVerifier, publicKey } = createZedNativeAuthData();
    // Rebuild the public key the way zed.dev receives it (padded b64url DER pkcs1)
    const der = Buffer.from(publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const pub = crypto.createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
    const encrypted = crypto
      .publicEncrypt(
        { key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from('secret-token')
      )
      .toString('base64url');
    expect(decryptZedAccessToken(encrypted, privateKeyVerifier)).toBe('secret-token');
  });

  it('falls back to PKCS1 padding when OAEP fails', () => {
    const { privateKeyVerifier } = createZedNativeAuthData();
    const pem = decodeZedPrivateKeyVerifier(privateKeyVerifier);
    const pub = crypto.createPublicKey(pem);
    const encrypted = crypto
      .publicEncrypt(
        { key: pub, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from('legacy-token')
      )
      .toString('base64url');
    expect(decryptZedAccessToken(encrypted, privateKeyVerifier)).toBe('legacy-token');
  });

  it('rejects a verifier without the zed-rsa-pkcs1 prefix instead of decrypting with garbage', () => {
    expect(() => decodeZedPrivateKeyVerifier('plain-pem')).toThrow(/restart the login flow/);
  });
});

describe('parseZedCallbackPayload', () => {
  it('parses a callback URL query', () => {
    const out = parseZedCallbackPayload('http://127.0.0.1:58443/?user_id=42&access_token=enc-abc');
    expect(out).toEqual({ userId: '42', encryptedAccessToken: 'enc-abc' });
  });

  it('parses a raw JSON paste and a bare query string', () => {
    expect(parseZedCallbackPayload('{"user_id":"7","access_token":"e"}')).toEqual({
      userId: '7',
      encryptedAccessToken: 'e',
    });
    expect(parseZedCallbackPayload('user_id=7&access_token=e')).toEqual({
      userId: '7',
      encryptedAccessToken: 'e',
    });
  });

  it('rejects a payload missing user_id or access_token', () => {
    expect(() => parseZedCallbackPayload('http://127.0.0.1/?user_id=42')).toThrow(
      /user_id and access_token/
    );
    expect(() => parseZedCallbackPayload('')).toThrow(/Missing Zed callback URL/);
  });
});

describe('buildZedUserAuthHeader', () => {
  it('formats userId + accessToken and throws when either is missing', () => {
    expect(buildZedUserAuthHeader(creds())).toBe('u-1 tok-1');
    expect(() => buildZedUserAuthHeader({ accessToken: 't' })).toThrow(/missing userId/);
    expect(() => buildZedUserAuthHeader({ providerSpecificData: { userId: 'u' } })).toThrow(
      /missing userId or accessToken/
    );
  });
});

describe('resolveZedOrganizationId', () => {
  it('prefers the explicit connection org over user info', () => {
    expect(resolveZedOrganizationId(creds(), { default_organization_id: 'org-user' })).toBe(
      'org-1'
    );
  });

  it('falls back to the personal organization from user info', () => {
    const c = { providerSpecificData: {} };
    const userInfo = {
      organizations: [{ id: 'org-a' }, { id: 'org-b', is_personal: true }],
    };
    expect(resolveZedOrganizationId(c, userInfo)).toBe('org-b');
  });

  it('unwraps tuple-shaped ids', () => {
    const c = { providerSpecificData: { organizationId: ['org-t'] } };
    expect(resolveZedOrganizationId(c)).toBe('org-t');
  });
});

describe('fetchZedLlmToken — cache discipline', () => {
  it('mints once and serves the cached token on the second call (no double round trip)', async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ token: 'llm-1' }));
    const c = creds();
    expect(await fetchZedLlmToken(c)).toBe('llm-1');
    expect(await fetchZedLlmToken(c)).toBe('llm-1');
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe('https://cloud.zed.dev/client/llm_tokens');
    expect(JSON.parse(init.body)).toEqual({ organization_id: 'org-1' });
    expect(init.headers.Authorization).toBe('u-1 tok-1');
  });

  it('forceRefresh bypasses a live cache entry', async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ token: 'llm-1' }))
      .mockResolvedValueOnce(jsonResponse({ token: 'llm-2' }));
    const c = creds();
    await fetchZedLlmToken(c);
    expect(await fetchZedLlmToken(c, { forceRefresh: true })).toBe('llm-2');
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it('a rotated access token gets its own cache slot (no stale token for new login)', async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ token: 'llm-old' }))
      .mockResolvedValueOnce(jsonResponse({ token: 'llm-new' }));
    await fetchZedLlmToken(creds('tok-A'.padEnd(20, 'a')));
    expect(await fetchZedLlmToken(creds('tok-B'.padEnd(20, 'b')))).toBe('llm-new');
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it('throws instead of caching when the mint reply carries no token', async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ nope: true }));
    await expect(fetchZedLlmToken(creds())).rejects.toThrow(/did not return an LLM token/);
    // and the failure was not cached: the next call tries again
    proxyAwareFetch.mockResolvedValue(jsonResponse({ token: 'llm-later' }));
    expect(await fetchZedLlmToken(creds())).toBe('llm-later');
  });

  it('surfaces the server error message on a non-ok mint', async () => {
    proxyAwareFetch.mockResolvedValue(
      jsonResponse({ message: 'plan expired' }, { ok: false, status: 402 })
    );
    await expect(fetchZedLlmToken(creds())).rejects.toThrow('plan expired');
  });

  it('throws when no organization can be resolved anywhere', async () => {
    // users/me returns no orgs
    proxyAwareFetch.mockResolvedValue(jsonResponse({ organizations: [] }));
    await expect(
      fetchZedLlmToken({ accessToken: 't', providerSpecificData: { userId: 'u' } })
    ).rejects.toThrow(/No Zed organization/);
  });
});

describe('shouldRefreshZedLlmToken', () => {
  it('fires on 401 and on either expiry header, not on a clean 200', () => {
    const withHeader = (name) => ({
      status: 200,
      headers: { has: (h) => h === name },
    });
    expect(shouldRefreshZedLlmToken({ status: 401, headers: { has: () => false } })).toBe(true);
    expect(shouldRefreshZedLlmToken(withHeader(ZED_HEADERS.expiredToken))).toBe(true);
    expect(shouldRefreshZedLlmToken(withHeader(ZED_HEADERS.outdatedToken))).toBe(true);
    expect(shouldRefreshZedLlmToken({ status: 200, headers: { has: () => false } })).toBe(false);
  });
});
