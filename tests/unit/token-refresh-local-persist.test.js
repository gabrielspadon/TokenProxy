/**
 * src/sse/services/tokenRefresh.js — the localDb persistence wrapper.
 *
 * The money paths: a failed refresh must leave the stored bag untouched, a
 * rotated refresh_token restarts the issue record (refreshTokenIssuedAt/Fp)
 * while an unchanged one keeps its original age, expiresIn wins over a raw
 * expiresAt, and the GitHub leg refreshes the Copilot token exactly when it
 * is missing or inside the 5-minute buffer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/localDb', () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock('open-sse/services/projectId.js', () => ({
  getProjectIdForConnection: vi.fn(),
  removeConnection: vi.fn(),
}));

vi.mock('open-sse/services/oauthCredentialManager.js', async (importOriginal) => ({
  ...(await importOriginal()),
  refreshProviderCredentials: vi.fn(),
  shouldRefreshCredentials: vi.fn(),
}));

vi.mock('open-sse/services/tokenRefresh.js', async (importOriginal) => ({
  ...(await importOriginal()),
  refreshCopilotToken: vi.fn(),
  refreshGitHubToken: vi.fn(),
}));

vi.mock('@/lib/antigravityVerification', () => ({
  createAntigravityVerificationHooks: vi.fn(() => ({})),
}));

import { getProviderConnectionById, updateProviderConnection } from '@/lib/localDb';
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from 'open-sse/services/oauthCredentialManager.js';
import { refreshCopilotToken, refreshGitHubToken } from 'open-sse/services/tokenRefresh.js';
import { getProjectIdForConnection, removeConnection } from 'open-sse/services/projectId.js';
import {
  updateProviderCredentials,
  checkAndRefreshToken,
  refreshGitHubAndCopilotTokens,
  releaseConnection,
} from '@/sse/services/tokenRefresh.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  updateProviderConnection.mockResolvedValue({ id: 'conn-1' });
  getProviderConnectionById.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe('updateProviderCredentials — issue record on rotation', () => {
  it('stamps refreshTokenIssuedAt and Fp on a genuine rotation', async () => {
    getProviderConnectionById.mockResolvedValue({
      refreshToken: 'rt-old',
      refreshTokenIssuedAt: '2026-09-01T00:00:00Z',
    });
    await updateProviderCredentials('conn-1', { refreshToken: 'rt-new' });
    const updates = updateProviderConnection.mock.calls[0][1];
    expect(updates.refreshToken).toBe('rt-new');
    expect(updates.refreshTokenIssuedAt).toBe(new Date(NOW).toISOString());
    expect(updates.refreshTokenFp).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps the original issue timestamp when the token did not rotate', async () => {
    getProviderConnectionById.mockResolvedValue({
      refreshToken: 'rt-same',
      refreshTokenIssuedAt: '2026-09-01T00:00:00Z',
    });
    await updateProviderCredentials('conn-1', { refreshToken: 'rt-same' });
    const updates = updateProviderConnection.mock.calls[0][1];
    expect(updates.refreshTokenIssuedAt).toBeUndefined();
    expect(updates.refreshTokenFp).toBeUndefined();
  });

  it('seeds the issue record when none was persisted yet', async () => {
    getProviderConnectionById.mockResolvedValue({ refreshToken: 'rt-same' });
    await updateProviderCredentials('conn-1', { refreshToken: 'rt-same' });
    expect(updateProviderConnection.mock.calls[0][1].refreshTokenIssuedAt).toBe(
      new Date(NOW).toISOString()
    );
  });
});

describe('updateProviderCredentials — expiry normalization', () => {
  it('expiresIn wins over expiresAt and produces both fields', async () => {
    await updateProviderCredentials('conn-1', {
      accessToken: 'a',
      expiresIn: 3600,
      expiresAt: '2030-01-01T00:00:00Z',
    });
    const updates = updateProviderConnection.mock.calls[0][1];
    expect(updates.expiresAt).toBe(new Date(NOW + 3600_000).toISOString());
    expect(updates.expiresIn).toBe(3600);
  });

  it('derives expiresIn from a bare ISO expiresAt', async () => {
    await updateProviderCredentials('conn-1', {
      accessToken: 'a',
      expiresAt: new Date(NOW + 120_000).toISOString(),
    });
    const updates = updateProviderConnection.mock.calls[0][1];
    expect(updates.expiresIn).toBe(120);
  });

  it('drops an unparsable expiresAt instead of storing garbage', async () => {
    await updateProviderCredentials('conn-1', {
      accessToken: 'a',
      expiresAt: 'not-a-date',
    });
    const updates = updateProviderConnection.mock.calls[0][1];
    expect(updates.expiresIn).toBeUndefined();
    expect(updates.expiresAt).toBeUndefined();
  });

  it('merges providerSpecificData over the existing bag rather than replacing it', async () => {
    await updateProviderCredentials('conn-1', {
      providerSpecificData: { b: 2 },
      existingProviderSpecificData: { a: 1, b: 1 },
    });
    expect(updateProviderConnection.mock.calls[0][1].providerSpecificData).toEqual({ a: 1, b: 2 });
  });

  it('returns false and swallows a localDb write failure', async () => {
    updateProviderConnection.mockRejectedValue(new Error('db locked'));
    await expect(updateProviderCredentials('conn-1', { accessToken: 'a' })).resolves.toBe(false);
  });
});

describe('checkAndRefreshToken', () => {
  it('does nothing when the token is not near expiry', async () => {
    shouldRefreshCredentials.mockReturnValue(false);
    const creds = {
      connectionId: 'conn-1',
      accessToken: 'acc-old',
      expiresAt: new Date(NOW + 3600_000).toISOString(),
    };
    const out = await checkAndRefreshToken('claude', creds);
    expect(refreshProviderCredentials).not.toHaveBeenCalled();
    expect(out.accessToken).toBe('acc-old');
  });

  it('a failed refresh returns the ORIGINAL bag — a still-valid token is never wiped', async () => {
    shouldRefreshCredentials.mockReturnValue(true);
    refreshProviderCredentials.mockResolvedValue(null);
    const creds = { connectionId: 'conn-1', accessToken: 'acc-old', refreshToken: 'rt-old' };
    const out = await checkAndRefreshToken('claude', creds);
    expect(out.accessToken).toBe('acc-old');
    expect(out.refreshToken).toBe('rt-old');
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it('an error-object refresh (invalid_grant) also leaves the stored bag untouched', async () => {
    shouldRefreshCredentials.mockReturnValue(true);
    refreshProviderCredentials.mockResolvedValue({ error: 'invalid_grant' });
    const out = await checkAndRefreshToken('claude', {
      connectionId: 'conn-1',
      accessToken: 'acc-old',
    });
    expect(out.accessToken).toBe('acc-old');
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it('persists and returns the refreshed bag with a recomputed expiresAt', async () => {
    shouldRefreshCredentials.mockReturnValue(true);
    refreshProviderCredentials.mockResolvedValue({
      accessToken: 'acc-new',
      refreshToken: 'rt-new',
      expiresIn: 3600,
    });
    const out = await checkAndRefreshToken('claude', {
      connectionId: 'conn-1',
      accessToken: 'acc-old',
      refreshToken: 'rt-old',
    });
    expect(out.accessToken).toBe('acc-new');
    expect(out.refreshToken).toBe('rt-new');
    expect(out.expiresAt).toBe(new Date(NOW + 3600_000).toISOString());
    expect(updateProviderConnection).toHaveBeenCalledTimes(1);
  });

  it('falls back to creds.id as connectionId so persistence targets the right row', async () => {
    shouldRefreshCredentials.mockReturnValue(true);
    refreshProviderCredentials.mockResolvedValue({ accessToken: 'acc-new', expiresIn: 60 });
    await checkAndRefreshToken('claude', { id: 'row-9', accessToken: 'acc-old' });
    expect(updateProviderConnection.mock.calls[0][0]).toBe('row-9');
  });

  it('github: refreshes the copilot token when it is missing even if the OAuth token is fresh', async () => {
    shouldRefreshCredentials.mockReturnValue(false);
    refreshCopilotToken.mockResolvedValue({
      token: 'cop-new',
      expiresAt: Math.floor(NOW / 1000) + 1800,
    });
    const out = await checkAndRefreshToken('github', {
      connectionId: 'conn-1',
      accessToken: 'gh-acc',
      providerSpecificData: {},
    });
    expect(refreshCopilotToken.mock.calls[0][0]).toBe('gh-acc');
    expect(out.providerSpecificData.copilotToken).toBe('cop-new');
    expect(out.copilotToken).toBe('cop-new');
  });

  it('github: leaves a copilot token with 30 minutes left alone', async () => {
    shouldRefreshCredentials.mockReturnValue(false);
    const out = await checkAndRefreshToken('github', {
      connectionId: 'conn-1',
      accessToken: 'gh-acc',
      providerSpecificData: {
        copilotToken: 'cop-live',
        copilotTokenExpiresAt: Math.floor(NOW / 1000) + 1800,
      },
    });
    expect(refreshCopilotToken).not.toHaveBeenCalled();
    expect(out.providerSpecificData.copilotToken).toBe('cop-live');
  });

  it('github: refreshes a copilot token inside the 5-minute buffer', async () => {
    shouldRefreshCredentials.mockReturnValue(false);
    refreshCopilotToken.mockResolvedValue({
      token: 'cop-new',
      expiresAt: Math.floor(NOW / 1000) + 1800,
    });
    await checkAndRefreshToken('github', {
      connectionId: 'conn-1',
      accessToken: 'gh-acc',
      providerSpecificData: {
        copilotToken: 'cop-dying',
        copilotTokenExpiresAt: Math.floor(NOW / 1000) + 120, // 2 min left < 5 min buffer
      },
    });
    expect(refreshCopilotToken).toHaveBeenCalledTimes(1);
  });

  it('github: keeps the dying copilot token when the exchange fails', async () => {
    shouldRefreshCredentials.mockReturnValue(false);
    refreshCopilotToken.mockResolvedValue(null);
    const out = await checkAndRefreshToken('github', {
      connectionId: 'conn-1',
      accessToken: 'gh-acc',
      providerSpecificData: { copilotToken: 'cop-dying', copilotTokenExpiresAt: 0 },
    });
    expect(out.providerSpecificData.copilotToken).toBe('cop-dying');
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe('refreshGitHubAndCopilotTokens', () => {
  it('chains the fresh GitHub access token into the copilot exchange', async () => {
    refreshGitHubToken.mockResolvedValue({ accessToken: 'gh-new', refreshToken: 'rt-new' });
    refreshCopilotToken.mockResolvedValue({ token: 'cop-new', expiresAt: 123 });
    const out = await refreshGitHubAndCopilotTokens({ refreshToken: 'rt-old' });
    expect(refreshCopilotToken.mock.calls[0][0]).toBe('gh-new');
    expect(out.providerSpecificData).toEqual({
      copilotToken: 'cop-new',
      copilotTokenExpiresAt: 123,
    });
    expect(out.accessToken).toBe('gh-new');
  });

  it('returns the GitHub bag alone when the copilot exchange fails', async () => {
    refreshGitHubToken.mockResolvedValue({ accessToken: 'gh-new' });
    refreshCopilotToken.mockResolvedValue(null);
    const out = await refreshGitHubAndCopilotTokens({ refreshToken: 'rt-old' });
    expect(out).toEqual({ accessToken: 'gh-new' });
  });

  it('propagates a failed GitHub refresh without calling the copilot exchange', async () => {
    refreshGitHubToken.mockResolvedValue(null);
    expect(await refreshGitHubAndCopilotTokens({ refreshToken: 'rt-old' })).toBeNull();
    expect(refreshCopilotToken).not.toHaveBeenCalled();
  });
});

describe('releaseConnection', () => {
  it('evicts the projectId cache entry for the closed connection', () => {
    releaseConnection('conn-1');
    expect(removeConnection).toHaveBeenCalledWith('conn-1');
  });

  it('is a no-op for a falsy id', () => {
    releaseConnection('');
    expect(removeConnection).not.toHaveBeenCalled();
  });
});
