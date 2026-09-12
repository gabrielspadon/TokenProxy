// Kills remaining private-helper survivors, reached only indirectly:
// normalizeExpiresAt's falsy guard (line 101), needsProjectId's provider
// allowlist (line 113), _refreshProjectId's antigravity-only verification
// hooks branch (line 128), its resolved-projectId guard (line 133), and
// updateProviderCredentials' else-if expiresAt branch gating (line 181).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/localDb', () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn().mockResolvedValue({ id: 'conn-1' }),
}));
vi.mock('@/lib/antigravityVerification', () => ({
  createAntigravityVerificationHooks: vi.fn(() => ({ hook: true })),
}));

beforeEach(() => vi.clearAllMocks());

describe('normalizeExpiresAt falsy guard (via updateProviderCredentials else-if)', () => {
  it('an empty-string expiresAt with no expiresIn writes neither field (falsy short-circuits before Date parsing)', async () => {
    const localDb = await import('@/lib/localDb');
    localDb.updateProviderConnection.mockResolvedValueOnce({ id: 'c1' });
    const { updateProviderCredentials } = await import('@/sse/services/tokenRefresh.js');
    await updateProviderCredentials('c1', { expiresAt: '' });
    const call = localDb.updateProviderConnection.mock.calls[0][1];
    expect(call).not.toHaveProperty('expiresAt');
    expect(call).not.toHaveProperty('expiresIn');
  });
});

describe('needsProjectId allowlist (via checkAndRefreshToken, provider not in the list)', () => {
  it('a grok-cli refresh never calls createAntigravityVerificationHooks or getProjectIdForConnection', async () => {
    vi.resetModules();
    const getProjectIdForConnection = vi.fn();
    vi.doMock('open-sse/services/projectId.js', () => ({
      getProjectIdForConnection,
      removeConnection: vi.fn(),
    }));
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
      ...(await orig()),
      shouldRefreshCredentials: () => true,
      refreshProviderCredentials: async () => ({ id: 'c1', connectionId: 'c1', accessToken: 'new-a', expiresIn: 60 }),
    }));
    const { createAntigravityVerificationHooks } = await import('@/lib/antigravityVerification');
    const { checkAndRefreshToken } = await import('@/sse/services/tokenRefresh.js');
    await checkAndRefreshToken('grok-cli', { connectionId: 'c1', accessToken: 'old' });
    await Promise.resolve();
    await Promise.resolve();
    expect(getProjectIdForConnection).not.toHaveBeenCalled();
    expect(createAntigravityVerificationHooks).not.toHaveBeenCalled();
  });
});

describe('_refreshProjectId verification-hooks branch: only antigravity gets real hooks', () => {
  it('gemini-cli (needs a projectId but is not antigravity) calls getProjectIdForConnection with an empty hooks object', async () => {
    vi.resetModules();
    const getProjectIdForConnection = vi.fn().mockResolvedValue(null);
    vi.doMock('open-sse/services/projectId.js', () => ({
      getProjectIdForConnection,
      removeConnection: vi.fn(),
    }));
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
      ...(await orig()),
      shouldRefreshCredentials: () => true,
      refreshProviderCredentials: async () => ({ id: 'c1', connectionId: 'c1', accessToken: 'new-a', expiresIn: 60 }),
    }));
    const { createAntigravityVerificationHooks } = await import('@/lib/antigravityVerification');
    const { checkAndRefreshToken } = await import('@/sse/services/tokenRefresh.js');
    await checkAndRefreshToken('gemini-cli', { connectionId: 'c1', accessToken: 'old' });
    await Promise.resolve();
    await Promise.resolve();
    expect(getProjectIdForConnection).toHaveBeenCalledWith('c1', 'new-a', 'gemini-cli', {});
    expect(createAntigravityVerificationHooks).not.toHaveBeenCalled();
  });
});
