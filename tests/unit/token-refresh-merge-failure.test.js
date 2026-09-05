/**
 * Failure and merge semantics in open-sse/services/oauthCredentialManager.js.
 *
 * The money paths: a failed refresh must not wipe a still-valid token, a
 * rotated refresh_token must land, a concurrent refresh of one connection must
 * not double-fire, and an unrecoverable error must pass through untouched so
 * the caller can stop retrying.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('open-sse/services/tokenRefresh.js', async (importOriginal) => ({
  ...(await importOriginal()),
  refreshTokenByProvider: vi.fn(),
}));

import {
  mergeRefreshedCredentials,
  refreshProviderCredentials,
  withCredentialRefreshLock,
} from 'open-sse/services/oauthCredentialManager.js';
import { refreshTokenByProvider } from 'open-sse/services/tokenRefresh.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');

const current = () => ({
  connectionId: 'conn-1',
  accessToken: 'acc-old',
  refreshToken: 'rt-old',
  idToken: 'id-old',
  expiresAt: new Date(NOW + 3600_000).toISOString(),
  providerSpecificData: { deviceId: 'dev-1', profileArn: 'arn:x' },
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('mergeRefreshedCredentials', () => {
  it('returns null on a failed refresh so a still-valid stored token survives', () => {
    expect(mergeRefreshedCredentials('claude', current(), null, NOW)).toBeNull();
    expect(mergeRefreshedCredentials('claude', current(), undefined, NOW)).toBeNull();
  });

  it('passes an unrecoverable error object through unmodified (retry loop must stop)', () => {
    const err = { error: 'unrecoverable_refresh_error', code: 'token_expired' };
    expect(mergeRefreshedCredentials('codex', current(), err, NOW)).toBe(err);
    const grant = { error: 'invalid_grant' };
    expect(mergeRefreshedCredentials('codex', current(), grant, NOW)).toBe(grant);
  });

  it('keeps the old refresh_token when the provider rotates only the access token', () => {
    const next = mergeRefreshedCredentials(
      'claude',
      current(),
      { accessToken: 'acc-new', expiresIn: 3600 },
      NOW
    );
    expect(next.accessToken).toBe('acc-new');
    expect(next.refreshToken).toBe('rt-old');
    expect(next.idToken).toBe('id-old');
  });

  it('stores the rotated refresh_token when the provider returns a new one', () => {
    const next = mergeRefreshedCredentials(
      'claude',
      current(),
      { accessToken: 'acc-new', refreshToken: 'rt-new', expiresIn: 3600 },
      NOW
    );
    expect(next.refreshToken).toBe('rt-new');
  });

  it('computes expiresAt from expiresIn against the given clock and prefers it over a raw expiresAt', () => {
    const next = mergeRefreshedCredentials(
      'claude',
      current(),
      { accessToken: 'a', expiresIn: 1800, expiresAt: '2030-01-01T00:00:00Z' },
      NOW
    );
    expect(next.expiresAt).toBe(new Date(NOW + 1800_000).toISOString());
    expect(next.expiresIn).toBe(1800);
  });

  it('merges providerSpecificData shallowly instead of replacing it', () => {
    const next = mergeRefreshedCredentials(
      'kiro',
      current(),
      { accessToken: 'a', providerSpecificData: { profileArn: 'arn:new' } },
      NOW
    );
    expect(next.providerSpecificData).toEqual({ deviceId: 'dev-1', profileArn: 'arn:new' });
  });

  it('stamps lastRefreshAt whenever a token landed', () => {
    const next = mergeRefreshedCredentials('claude', current(), { accessToken: 'acc-new' }, NOW);
    expect(next.lastRefreshAt).toBe(new Date(NOW).toISOString());
  });
});

describe('withCredentialRefreshLock — one refresh per connection', () => {
  it('coalesces concurrent refreshes of the same connection into one call', async () => {
    let resolveFirst;
    const fn = vi.fn(
      () =>
        new Promise((r) => {
          resolveFirst = r;
        })
    );
    const creds = { connectionId: 'conn-A' };

    const p1 = withCredentialRefreshLock('claude', creds, fn);
    const p2 = withCredentialRefreshLock('claude', creds, fn);
    // The lock schedules refreshFn on a microtask; yield once so it has run.
    await Promise.resolve();
    resolveFirst('done');
    await expect(p1).resolves.toBe('done');
    await expect(p2).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce different connections of the same provider', async () => {
    const fn = vi.fn(async () => 'x');
    await Promise.all([
      withCredentialRefreshLock('claude', { connectionId: 'conn-A' }, fn),
      withCredentialRefreshLock('claude', { connectionId: 'conn-B' }, fn),
    ]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases the lock after completion so a later refresh runs again', async () => {
    const fn = vi.fn(async () => 'x');
    const creds = { connectionId: 'conn-A' };
    await withCredentialRefreshLock('claude', creds, fn);
    await withCredentialRefreshLock('claude', creds, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases the lock even when the refresh throws', async () => {
    const boom = vi.fn(async () => {
      throw new Error('net');
    });
    const ok = vi.fn(async () => 'ok');
    const creds = { connectionId: 'conn-A' };
    await expect(withCredentialRefreshLock('claude', creds, boom)).rejects.toThrow('net');
    await expect(withCredentialRefreshLock('claude', creds, ok)).resolves.toBe('ok');
  });
});

describe('refreshProviderCredentials', () => {
  it('returns null for null input without dispatching a refresh', async () => {
    expect(await refreshProviderCredentials('claude', null, console)).toBeNull();
    expect(refreshTokenByProvider).not.toHaveBeenCalled();
  });

  it('merges the dispatched refresh against the current bag', async () => {
    refreshTokenByProvider.mockResolvedValue({ accessToken: 'acc-new', expiresIn: 60 });
    const out = await refreshProviderCredentials('claude', current(), console);
    expect(out.accessToken).toBe('acc-new');
    expect(out.refreshToken).toBe('rt-old'); // preserved, not wiped
  });

  it('propagates a null refresh as null (caller keeps the old bag)', async () => {
    refreshTokenByProvider.mockResolvedValue(null);
    expect(await refreshProviderCredentials('claude', current(), console)).toBeNull();
  });
});
