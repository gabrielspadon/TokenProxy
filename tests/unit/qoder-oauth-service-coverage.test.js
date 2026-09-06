// Coverage for src/lib/oauth/services/qoder.js network paths. URL
// expectations derive from the service's own imported constants, never
// hardcoded literals. All network via a stubbed global fetch; the poll
// timeout runs under fake timers so nothing waits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QoderService } from '@/lib/oauth/services/qoder.js';
import {
  QODER_DEVICE_TOKEN_URL,
  QODER_LOGIN_URL,
  QODER_USERINFO_URL,
} from '../../src/lib/qoder/constants.js';
import crypto from 'node:crypto';

const svc = new QoderService();

function stubFetch(responder) {
  const fn = vi.fn(async (url, init = {}) => {
    const r = await responder(String(url), init);
    if (r instanceof Error) throw r;
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
  return fn;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('generatePkcePair', () => {
  it('produces a base64url verifier whose sha256 matches the challenge', () => {
    const { verifier, challenge } = svc.generatePkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });
});

describe('initiateDeviceFlow', () => {
  it('builds the verification URL on the login endpoint with PKCE, nonce and machine id', () => {
    const out = svc.initiateDeviceFlow();
    const url = new URL(out.verificationUriComplete);
    expect(`${url.origin}${url.pathname}`).toBe(QODER_LOGIN_URL);
    expect(url.searchParams.get('challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe(out.nonce);
    expect(url.searchParams.get('machine_id')).toBe(out.machineId);
    const expected = crypto.createHash('sha256').update(out.codeVerifier).digest('base64url');
    expect(url.searchParams.get('challenge')).toBe(expected);
    expect(out.nonce).not.toBe(out.machineId);
  });
});

describe('pollDeviceToken', () => {
  const args = { nonce: 'n0nce', codeVerifier: 'v3rifier' };

  it('throws when nonce or verifier is missing', async () => {
    await expect(svc.pollDeviceToken({ nonce: '', codeVerifier: 'v' })).rejects.toThrow(
      'missing nonce or code verifier'
    );
    await expect(svc.pollDeviceToken({ nonce: 'n', codeVerifier: '' })).rejects.toThrow(
      'missing nonce or code verifier'
    );
  });

  it('GETs the device-token URL with encoded nonce and verifier', async () => {
    const fn = stubFetch(() => ({ status: 202 }));
    await svc.pollDeviceToken({ nonce: 'a b', codeVerifier: 'c/d' });
    const [url, init] = fn.mock.calls[0];
    const parsed = new URL(String(url));
    expect(`${parsed.origin}${parsed.pathname}`).toBe(QODER_DEVICE_TOKEN_URL);
    expect(parsed.searchParams.get('nonce')).toBe('a b');
    expect(parsed.searchParams.get('verifier')).toBe('c/d');
    expect(parsed.searchParams.get('challenge_method')).toBe('S256');
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([202, 404])('returns pending on HTTP %i', async (status) => {
    stubFetch(() => ({ ok: false, status }));
    await expect(svc.pollDeviceToken(args)).resolves.toEqual({ status: 'pending' });
  });

  it('throws with the upstream message on a JSON error body', async () => {
    stubFetch(() => ({ ok: false, status: 500, text: JSON.stringify({ message: 'boom' }) }));
    await expect(svc.pollDeviceToken(args)).rejects.toThrow('Qoder device token poll failed: boom');
  });

  it('throws with the HTTP status when the error body is not JSON', async () => {
    stubFetch(() => ({ ok: false, status: 503, text: 'gateway' }));
    await expect(svc.pollDeviceToken(args)).rejects.toThrow(
      'Qoder device token poll failed: HTTP 503'
    );
  });

  it('throws on a 200 with invalid JSON', async () => {
    stubFetch(() => ({ text: 'not-json{' }));
    await expect(svc.pollDeviceToken(args)).rejects.toThrow('invalid JSON response');
  });

  it('throws on a 200 with no token', async () => {
    stubFetch(() => ({ json: { user_id: 'u' } }));
    await expect(svc.pollDeviceToken(args)).rejects.toThrow('200 but no token');
  });

  it('maps a successful body including expiry and defaults', async () => {
    const body = { token: 'dt-abc', expires_at: 1781594470000 };
    stubFetch(() => ({ json: body }));
    const out = await svc.pollDeviceToken(args);
    expect(out).toEqual({
      status: 'ok',
      accessToken: 'dt-abc',
      refreshToken: '',
      userId: '',
      expireTime: 1781594470000,
      rawResponse: body,
    });
  });

  it('passes refresh_token and user_id through when present', async () => {
    stubFetch(() => ({
      json: { token: 'dt-x', refresh_token: 'rt-x', user_id: 'u-1', expires_at: 5 },
    }));
    const out = await svc.pollDeviceToken(args);
    expect(out.refreshToken).toBe('rt-x');
    expect(out.userId).toBe('u-1');
  });

  it('aborts a stalled request via the fetch timeout', async () => {
    vi.useFakeTimers();
    stubFetch(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error(`aborted: ${init.signal.reason}`))
          );
        })
    );
    const pending = svc.pollDeviceToken(args);
    const expectation = expect(pending).rejects.toThrow('aborted: timeout');
    await vi.runAllTimersAsync();
    await expectation;
  });
});

describe('fetchUserInfo', () => {
  it('sends the bearer token to the userinfo URL and trims the profile fields', async () => {
    const fn = stubFetch(() => ({
      json: { name: ' Ada ', email: ' ada@example.invalid ', organization_id: ' org1 ' },
    }));
    const out = await svc.fetchUserInfo('dt-tok');
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toBe(QODER_USERINFO_URL);
    expect(init.headers.Authorization).toBe('Bearer dt-tok');
    expect(out).toEqual({ name: 'Ada', email: 'ada@example.invalid', organizationId: 'org1' });
  });

  it('falls back to username when name is missing and empties absent fields', async () => {
    stubFetch(() => ({ json: { username: 'ada' } }));
    const out = await svc.fetchUserInfo('t');
    expect(out).toEqual({ name: 'ada', email: '', organizationId: '' });
  });

  it('returns empty strings on a non-ok response', async () => {
    stubFetch(() => ({ ok: false, status: 401 }));
    await expect(svc.fetchUserInfo('t')).resolves.toEqual({ name: '', email: '' });
  });

  it('returns empty strings when fetch throws', async () => {
    stubFetch(() => new Error('network down'));
    await expect(svc.fetchUserInfo('t')).resolves.toEqual({ name: '', email: '' });
  });
});

describe('parseExpiry fallbacks', () => {
  it('honors expiresInSeconds of zero as already expired', () => {
    const before = Date.now();
    const out = QoderService.parseExpiry(undefined, 0);
    expect(out).toBeGreaterThanOrEqual(before);
    expect(out).toBeLessThanOrEqual(Date.now());
  });

  it('parses an RFC3339 string', () => {
    expect(QoderService.parseExpiry('2026-06-16T07:15:04Z', undefined)).toBe(
      Date.parse('2026-06-16T07:15:04Z')
    );
  });

  it('parses a numeric ms-epoch string without Date.parse year confusion', () => {
    expect(QoderService.parseExpiry('2026', undefined)).toBe(2026);
  });

  it('falls back to 30 days when both hints are missing', () => {
    const before = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const out = QoderService.parseExpiry(undefined, undefined);
    expect(out).toBeGreaterThanOrEqual(before);
    expect(out).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60 * 1000);
  });
});
