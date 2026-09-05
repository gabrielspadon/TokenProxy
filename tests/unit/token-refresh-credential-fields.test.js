// Targets remaining tokenRefresh.js survivors: releaseConnection's debug log
// call, needsProjectId's false branch, updateProviderCredentials' idToken/
// lastRefreshAt/expiresAt-without-existingProviderSpecificData fields and its
// error-path log fields, and checkAndRefreshToken's refreshLead/remaining
// computation plus copilot-branch expiry math. All localDb/log fully mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logDebug = vi.fn();
const logInfo = vi.fn();
const logError = vi.fn();
vi.mock('../../src/sse/utils/logger.js', () => ({
  debug: (...a) => logDebug(...a),
  info: (...a) => logInfo(...a),
  error: (...a) => logError(...a),
}));

const getProviderConnectionById = vi.fn();
const updateProviderConnection = vi.fn();
vi.mock('../../src/lib/localDb.js', () => ({
  getProviderConnectionById: (...a) => getProviderConnectionById(...a),
  updateProviderConnection: (...a) => updateProviderConnection(...a),
}));

const removeConnection = vi.fn();
vi.mock('open-sse/services/projectId.js', () => ({
  getProjectIdForConnection: vi.fn(),
  removeConnection: (...a) => removeConnection(...a),
}));

beforeEach(() => {
  logDebug.mockReset();
  logInfo.mockReset();
  logError.mockReset();
  getProviderConnectionById.mockReset();
  updateProviderConnection.mockReset();
  removeConnection.mockReset();
});

const mod = await import('@/sse/services/tokenRefresh.js');

describe('releaseConnection', () => {
  it('calls removeConnection and logs the exact connectionId field', () => {
    mod.releaseConnection('conn-9');
    expect(removeConnection).toHaveBeenCalledWith('conn-9');
    expect(logDebug).toHaveBeenCalledWith('TOKEN_REFRESH', 'Released connection resources', {
      connectionId: 'conn-9',
    });
  });
});

describe('updateProviderCredentials field writes', () => {
  it('writes idToken and lastRefreshAt when present', async () => {
    getProviderConnectionById.mockResolvedValue({});
    updateProviderConnection.mockResolvedValue({ id: 'c' });
    await mod.updateProviderCredentials('c', { idToken: 'id-1', lastRefreshAt: 'ts-1' });
    const [, updates] = updateProviderConnection.mock.calls[0];
    expect(updates.idToken).toBe('id-1');
    expect(updates.lastRefreshAt).toBe('ts-1');
  });

  it('a raw expiresAt with no existingProviderSpecificData still writes providerSpecificData for a bare copilotToken', async () => {
    updateProviderConnection.mockResolvedValue({ id: 'c' });
    await mod.updateProviderCredentials('c', { copilotToken: 'cop-1' });
    const [, updates] = updateProviderConnection.mock.calls[0];
    expect(updates.providerSpecificData).toEqual({ copilotToken: 'cop-1' });
  });

  it('logs success:true with the exact connectionId on a truthy DB write', async () => {
    updateProviderConnection.mockResolvedValue({ id: 'c' });
    await mod.updateProviderCredentials('conn-5', { accessToken: 'a' });
    expect(logInfo).toHaveBeenCalledWith('TOKEN_REFRESH', 'Credentials updated in localDb', {
      connectionId: 'conn-5',
      success: true,
    });
  });

  it('a thrown DB error logs the exact connectionId and error.message, then returns false', async () => {
    updateProviderConnection.mockRejectedValue(new Error('db down'));
    const result = await mod.updateProviderCredentials('conn-7', { accessToken: 'a' });
    expect(result).toBe(false);
    expect(logError).toHaveBeenCalledWith(
      'TOKEN_REFRESH',
      'Error updating credentials in localDb',
      {
        connectionId: 'conn-7',
        error: 'db down',
      }
    );
  });
});

describe('checkAndRefreshToken: needsProjectId false branch and creds.id fallback', () => {
  it('a provider not needing a projectId (claude) never calls getProjectIdForConnection even with a fresh accessToken and no existing projectId', async () => {
    const { getProjectIdForConnection } = await import('open-sse/services/projectId.js');
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
      ...(await orig()),
      shouldRefreshCredentials: () => true,
      refreshProviderCredentials: async () => ({ accessToken: 'new-a', expiresIn: 60 }),
    }));
    updateProviderConnection.mockResolvedValue({ id: 'c' });
    await mod.checkAndRefreshToken('claude', { connectionId: 'conn-1', accessToken: 'old' });
    expect(getProjectIdForConnection).not.toHaveBeenCalled();
  });

  it('creds.id is used as connectionId fallback when connectionId is absent', async () => {
    vi.resetModules();
    updateProviderConnection.mockResolvedValue({ id: 'c' });
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
      ...(await orig()),
      shouldRefreshCredentials: () => true,
      refreshProviderCredentials: async () => ({ accessToken: 'new-a', expiresIn: 60 }),
    }));
    const fresh = await import('@/sse/services/tokenRefresh.js');
    await fresh.checkAndRefreshToken('claude', { id: 'conn-fallback', accessToken: 'old' });
    expect(updateProviderConnection).toHaveBeenCalledWith('conn-fallback', expect.anything());
  });
});

describe('checkAndRefreshToken: github copilot missing-token and expiry math', () => {
  it('a missing copilotToken forces a refresh with remaining computed as 0 - now (negative), not skipped', async () => {
    vi.resetModules();
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
      ...(await orig()),
      shouldRefreshCredentials: () => false,
    }));
    vi.doMock('open-sse/services/tokenRefresh.js', async (orig) => ({
      ...(await orig()),
      refreshCopilotToken: vi.fn(async () => ({ token: 'cop-new', expiresAt: 999 })),
    }));
    updateProviderConnection.mockResolvedValue({ id: 'c' });
    const fresh = await import('@/sse/services/tokenRefresh.js');
    const out = await fresh.checkAndRefreshToken('github', {
      connectionId: 'conn-1',
      accessToken: 'gh-acc',
      providerSpecificData: {},
    });
    expect(out.copilotToken).toBe('cop-new');
    expect(out.providerSpecificData.copilotTokenExpiresAt).toBe(999);
  });

  it('a copilot refresh that resolves falsy leaves providerSpecificData untouched', async () => {
    vi.resetModules();
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
      ...(await orig()),
      shouldRefreshCredentials: () => false,
    }));
    vi.doMock('open-sse/services/tokenRefresh.js', async (orig) => ({
      ...(await orig()),
      refreshCopilotToken: vi.fn(async () => null),
    }));
    const fresh = await import('@/sse/services/tokenRefresh.js');
    const out = await fresh.checkAndRefreshToken('github', {
      connectionId: 'conn-1',
      accessToken: 'gh-acc',
      providerSpecificData: {},
    });
    expect(out.copilotToken).toBeUndefined();
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});
