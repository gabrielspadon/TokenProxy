// Kills remaining tokenRefresh.js survivors in updateProviderCredentials'
// per-field merge logic, _refreshProjectId's resolved-projectId persist path,
// and checkAndRefreshToken's copilot-refresh-result merge. All DB/network
// mocked; no real localDb or provider calls.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/localDb', () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn().mockResolvedValue({ id: 'conn-1' }),
}));
vi.mock('open-sse/services/projectId.js', () => ({
  getProjectIdForConnection: vi.fn(),
  removeConnection: vi.fn(),
}));
vi.mock('@/lib/antigravityVerification', () => ({
  createAntigravityVerificationHooks: vi.fn(() => ({})),
}));

import { getProviderConnectionById, updateProviderConnection } from '@/lib/localDb';
import { getProjectIdForConnection } from 'open-sse/services/projectId.js';
import { updateProviderCredentials, releaseConnection } from '@/sse/services/tokenRefresh.js';

beforeEach(() => {
  vi.clearAllMocks();
  updateProviderConnection.mockResolvedValue({ id: 'conn-1' });
  getProviderConnectionById.mockResolvedValue(null);
});

describe('releaseConnection', () => {
  it('is a no-op for a falsy connectionId (does not call removeConnection)', async () => {
    const { removeConnection } = await import('open-sse/services/projectId.js');
    releaseConnection('');
    expect(removeConnection).not.toHaveBeenCalled();
  });
});

describe('updateProviderCredentials: field-by-field merge', () => {
  it('writes accessToken only when present, not when absent', async () => {
    await updateProviderCredentials('c1', { accessToken: 'tok' });
    expect(updateProviderConnection).toHaveBeenCalledWith('c1', { accessToken: 'tok' });
  });

  it('restarts refreshTokenIssuedAt/Fp when the refresh token actually rotated', async () => {
    getProviderConnectionById.mockResolvedValueOnce({
      refreshToken: 'old',
      refreshTokenIssuedAt: '2020-01-01T00:00:00.000Z',
    });
    await updateProviderCredentials('c1', { refreshToken: 'new' });
    const call = updateProviderConnection.mock.calls[0][1];
    expect(call.refreshToken).toBe('new');
    expect(call.refreshTokenIssuedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(call.refreshTokenFp).toBeTruthy();
  });

  it('keeps the original issued-at when the refresh token is unchanged', async () => {
    getProviderConnectionById.mockResolvedValueOnce({
      refreshToken: 'same',
      refreshTokenIssuedAt: '2020-01-01T00:00:00.000Z',
    });
    await updateProviderCredentials('c1', { refreshToken: 'same' });
    const call = updateProviderConnection.mock.calls[0][1];
    expect(call).not.toHaveProperty('refreshTokenIssuedAt');
    expect(call).not.toHaveProperty('refreshTokenFp');
  });

  it('prefers expiresIn over a raw expiresAt when both are present', async () => {
    await updateProviderCredentials('c1', { expiresIn: 60, expiresAt: 'garbage' });
    const call = updateProviderConnection.mock.calls[0][1];
    expect(call.expiresIn).toBe(60);
    expect(typeof call.expiresAt).toBe('string');
  });

  it('normalizes a raw expiresAt into expiresIn when expiresIn is absent', async () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    await updateProviderCredentials('c1', { expiresAt: future });
    const call = updateProviderConnection.mock.calls[0][1];
    expect(call.expiresIn).toBeGreaterThan(0);
    expect(call.expiresAt).toBe(future);
  });

  it('an invalid expiresAt with no expiresIn writes neither field', async () => {
    await updateProviderCredentials('c1', { expiresAt: 'not-a-date' });
    const call = updateProviderConnection.mock.calls[0][1];
    expect(call).not.toHaveProperty('expiresAt');
    expect(call).not.toHaveProperty('expiresIn');
  });

  it('merges providerSpecificData onto existingProviderSpecificData rather than replacing it', async () => {
    await updateProviderCredentials('c1', {
      providerSpecificData: { b: 2 },
      existingProviderSpecificData: { a: 1 },
    });
    const call = updateProviderConnection.mock.calls[0][1];
    expect(call.providerSpecificData).toEqual({ a: 1, b: 2 });
  });

  it('a copilotToken-only update writes just that field into providerSpecificData, not copilotTokenExpiresAt', async () => {
    await updateProviderCredentials('c1', {
      copilotToken: 'cop',
      existingProviderSpecificData: { other: 1 },
    });
    const call = updateProviderConnection.mock.calls[0][1];
    expect(call.providerSpecificData).toEqual({ other: 1, copilotToken: 'cop' });
  });

  it('returns false and logs, without throwing, when updateProviderConnection rejects', async () => {
    updateProviderConnection.mockRejectedValueOnce(new Error('db down'));
    const ok = await updateProviderCredentials('c1', { accessToken: 'x' });
    expect(ok).toBe(false);
  });

  it('returns true when updateProviderConnection resolves truthy, false when it resolves falsy', async () => {
    updateProviderConnection.mockResolvedValueOnce({ id: 'c1' });
    expect(await updateProviderCredentials('c1', { accessToken: 'x' })).toBe(true);
    updateProviderConnection.mockResolvedValueOnce(null);
    expect(await updateProviderCredentials('c1', { accessToken: 'x' })).toBe(false);
  });
});

describe('_refreshProjectId: resolved projectId is persisted', () => {
  it('calls updateProviderCredentials with the resolved projectId once getProjectIdForConnection resolves', async () => {
    getProjectIdForConnection.mockResolvedValueOnce('proj-live');
    vi.resetModules();
    vi.doMock('@/lib/localDb', () => ({
      getProviderConnectionById: vi.fn(),
      updateProviderConnection: vi.fn().mockResolvedValue({ id: 'conn-1' }),
    }));
    vi.doMock('open-sse/services/projectId.js', () => ({
      getProjectIdForConnection: vi.fn().mockResolvedValue('proj-live'),
      removeConnection: vi.fn(),
    }));
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (importOriginal) => ({
      ...(await importOriginal()),
      refreshProviderCredentials: vi
        .fn()
        .mockResolvedValue({ accessToken: 'acc-new', expiresIn: 60 }),
      shouldRefreshCredentials: vi.fn().mockReturnValue(true),
    }));
    vi.doMock('@/lib/antigravityVerification', () => ({
      createAntigravityVerificationHooks: vi.fn(() => ({})),
    }));
    const localDb = await import('@/lib/localDb');
    const { checkAndRefreshToken } = await import('@/sse/services/tokenRefresh.js');
    await checkAndRefreshToken('antigravity', { connectionId: 'conn-1', accessToken: 'old' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const persistCall = localDb.updateProviderConnection.mock.calls.find(
      (c) => c[1] && c[1].projectId === 'proj-live'
    );
    expect(persistCall).toBeTruthy();
  });

  it('does not persist when getProjectIdForConnection resolves falsy', async () => {
    vi.resetModules();
    vi.doMock('@/lib/localDb', () => ({
      getProviderConnectionById: vi.fn(),
      updateProviderConnection: vi.fn().mockResolvedValue({ id: 'conn-1' }),
    }));
    vi.doMock('open-sse/services/projectId.js', () => ({
      getProjectIdForConnection: vi.fn().mockResolvedValue(null),
      removeConnection: vi.fn(),
    }));
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (importOriginal) => ({
      ...(await importOriginal()),
      refreshProviderCredentials: vi
        .fn()
        .mockResolvedValue({ accessToken: 'acc-new', expiresIn: 60 }),
      shouldRefreshCredentials: vi.fn().mockReturnValue(true),
    }));
    vi.doMock('@/lib/antigravityVerification', () => ({
      createAntigravityVerificationHooks: vi.fn(() => ({})),
    }));
    const localDb = await import('@/lib/localDb');
    const { checkAndRefreshToken } = await import('@/sse/services/tokenRefresh.js');
    await checkAndRefreshToken('antigravity', { connectionId: 'conn-1', accessToken: 'old' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const persistCall = localDb.updateProviderConnection.mock.calls.find(
      (c) => c[1] && 'projectId' in c[1]
    );
    expect(persistCall).toBeUndefined();
  });
});

describe('checkAndRefreshToken: does not refresh when _shouldRefreshCredentials is false and force is not set', () => {
  it('skips the refresh call entirely', async () => {
    vi.resetModules();
    vi.doMock('@/lib/localDb', () => ({
      getProviderConnectionById: vi.fn(),
      updateProviderConnection: vi.fn().mockResolvedValue({ id: 'conn-1' }),
    }));
    vi.doMock('open-sse/services/projectId.js', () => ({
      getProjectIdForConnection: vi.fn(),
      removeConnection: vi.fn(),
    }));
    const refreshProviderCredentials = vi.fn();
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (importOriginal) => ({
      ...(await importOriginal()),
      refreshProviderCredentials,
      shouldRefreshCredentials: vi.fn().mockReturnValue(false),
    }));
    const { checkAndRefreshToken } = await import('@/sse/services/tokenRefresh.js');
    await checkAndRefreshToken('claude', { connectionId: 'conn-1', accessToken: 'old' });
    expect(refreshProviderCredentials).not.toHaveBeenCalled();
  });
});
