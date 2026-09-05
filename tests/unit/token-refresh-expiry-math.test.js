/**
 * Expiry math on the refresh path (open-sse/services/oauthCredentialManager.js
 * + getEffectiveRefreshLeadMs in open-sse/services/tokenRefresh.js).
 *
 * A refresh fired too early wastes round trips; fired too late it 401-storms.
 * Pure functions, fixed clock passed explicitly — no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldRefreshCredentials,
  isCodexRefreshStale,
  getCredentialExpiryMs,
} from 'open-sse/services/oauthCredentialManager.js';
import {
  getEffectiveRefreshLeadMs,
  getRefreshLeadMs,
  TOKEN_EXPIRY_BUFFER_MS,
} from 'open-sse/services/tokenRefresh.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');
const MIN = 60 * 1000;

describe('shouldRefreshCredentials — no early, no late', () => {
  it('returns false for null credentials', () => {
    expect(shouldRefreshCredentials('claude', null, NOW)).toBe(false);
  });

  it('does not refresh a token with 10 minutes left on the default 5-minute lead', () => {
    const creds = { expiresAt: new Date(NOW + 10 * MIN).toISOString() };
    expect(shouldRefreshCredentials('some-generic', creds, NOW)).toBe(false);
  });

  it('refreshes a token inside the default 5-minute lead', () => {
    const creds = { expiresAt: new Date(NOW + 4 * MIN).toISOString() };
    expect(shouldRefreshCredentials('some-generic', creds, NOW)).toBe(true);
  });

  it('refreshes an already-expired token', () => {
    const creds = { expiresAt: new Date(NOW - 1).toISOString() };
    expect(shouldRefreshCredentials('some-generic', creds, NOW)).toBe(true);
  });

  it('reads a seconds-epoch expiresAt as seconds, not milliseconds', () => {
    // 1e9-scale numbers are epoch seconds; treated as ms they'd read as 1970
    // and force a refresh on every request.
    const okSecs = Math.floor((NOW + 10 * MIN) / 1000);
    expect(getCredentialExpiryMs({ expiresAt: okSecs })).toBe(okSecs * 1000);
    expect(shouldRefreshCredentials('some-generic', { expiresAt: okSecs }, NOW)).toBe(false);
    const soonSecs = Math.floor((NOW + 4 * MIN) / 1000);
    expect(shouldRefreshCredentials('some-generic', { expiresAt: soonSecs }, NOW)).toBe(true);
  });

  it('codex: proactively refreshes on staleness even when expiry is far out', () => {
    const creds = {
      refreshToken: 'rt',
      expiresAt: new Date(NOW + 30 * 24 * 60 * MIN).toISOString(),
      lastRefreshAt: new Date(NOW - 9 * 24 * 60 * MIN).toISOString(), // > 8-day window
    };
    expect(shouldRefreshCredentials('codex', creds, NOW)).toBe(true);
  });

  it('codex: fresh lastRefreshAt and far expiry means no refresh', () => {
    const creds = {
      refreshToken: 'rt',
      expiresAt: new Date(NOW + 6 * 24 * 60 * MIN).toISOString(), // beyond 5-day lead
      lastRefreshAt: new Date(NOW - 1 * 24 * 60 * MIN).toISOString(),
    };
    expect(shouldRefreshCredentials('codex', creds, NOW)).toBe(false);
  });

  it('codex staleness treats a missing lastRefreshAt as stale', () => {
    expect(isCodexRefreshStale({}, NOW)).toBe(true);
  });
});

describe('getEffectiveRefreshLeadMs — lead never swallows the whole lifetime', () => {
  it('halves the lead when the configured lead exceeds the token lifetime', () => {
    // 4-minute-lived token under the 5-minute default lead: without the clamp
    // every refresh immediately re-qualifies and the proxy refreshes in a loop.
    const creds = {
      expiresAt: new Date(NOW + 4 * MIN).toISOString(),
      lastRefreshAt: new Date(NOW).toISOString(),
    };
    expect(getEffectiveRefreshLeadMs('some-generic', creds, NOW)).toBe(2 * MIN);
  });

  it('keeps the configured lead when lifetime is comfortably longer', () => {
    const creds = {
      expiresAt: new Date(NOW + 60 * MIN).toISOString(),
      lastRefreshAt: new Date(NOW).toISOString(),
    };
    expect(getEffectiveRefreshLeadMs('some-generic', creds, NOW)).toBe(TOKEN_EXPIRY_BUFFER_MS);
  });

  it('clamps the codex 5-day lead against a 1-hour-lived token', () => {
    const creds = {
      expiresAt: new Date(NOW + 60 * MIN).toISOString(),
      lastRefreshAt: new Date(NOW).toISOString(),
    };
    expect(getEffectiveRefreshLeadMs('codex', creds, NOW)).toBe(30 * MIN);
  });

  it('falls back to the raw lead when lastRefreshAt is absent (no lifetime known)', () => {
    const creds = { expiresAt: new Date(NOW + 60 * MIN).toISOString() };
    expect(getEffectiveRefreshLeadMs('codex', creds, NOW)).toBe(getRefreshLeadMs('codex'));
  });
});

describe('getRefreshLeadMs — per-connection override bounds', () => {
  it('rejects an override above the 30-day cap and keeps the provider default', () => {
    const psd = { refreshLeadMs: 31 * 24 * 60 * MIN };
    expect(getRefreshLeadMs('some-generic', psd)).toBe(TOKEN_EXPIRY_BUFFER_MS);
  });

  it('rejects zero, negative, NaN and string overrides', () => {
    for (const bad of [0, -1, NaN, '600000', Infinity]) {
      expect(getRefreshLeadMs('some-generic', { refreshLeadMs: bad })).toBe(TOKEN_EXPIRY_BUFFER_MS);
    }
  });
});
