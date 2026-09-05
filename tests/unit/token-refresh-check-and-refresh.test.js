// Targets checkAndRefreshToken's real survivors in
// src/sse/services/tokenRefresh.js: options.force strict boolean check,
// the proactive-refresh log's exact expiresIn/lastRefreshAt fields, and the
// GitHub Copilot branch's expiry math (copilotExpiresAt seconds->ms,
// remaining computation, and the exact updated field names).
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

beforeEach(() => {
  logDebug.mockReset();
  logInfo.mockReset();
  logError.mockReset();
  getProviderConnectionById.mockReset();
  updateProviderConnection.mockReset();
});

describe('options.force must be exactly true, not merely truthy', () => {
  it('force: "yes" (truthy but not === true) does not bypass the shouldRefreshCredentials gate', async () => {
    vi.resetModules();
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
      ...(await orig()),
      shouldRefreshCredentials: () => false,
    }));
    const fresh = await import('@/sse/services/tokenRefresh.js');
    const out = await fresh.checkAndRefreshToken(
      'claude',
      { connectionId: 'c1', accessToken: 'a' },
      { force: 'yes' }
    );
    expect(updateProviderConnection).not.toHaveBeenCalled();
    expect(out.accessToken).toBe('a');
  });
});

describe('proactive-refresh log carries the exact expiresIn/lastRefreshAt fields', () => {
  it('a null expiresAt logs expiresIn: null and lastRefreshAt: null when absent', async () => {
    vi.resetModules();
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
      ...(await orig()),
      shouldRefreshCredentials: () => true,
      refreshProviderCredentials: async () => null,
    }));
    const fresh = await import('@/sse/services/tokenRefresh.js');
    await fresh.checkAndRefreshToken('claude', { connectionId: 'c1', accessToken: 'a' });
    expect(logInfo).toHaveBeenCalledWith(
      'TOKEN_REFRESH',
      'Refreshing provider credentials proactively',
      expect.objectContaining({ expiresIn: null, lastRefreshAt: null })
    );
  });

  it('a lastRefreshAt on the credentials is passed through verbatim, not nulled', async () => {
    vi.resetModules();
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
      ...(await orig()),
      shouldRefreshCredentials: () => true,
      refreshProviderCredentials: async () => null,
    }));
    const fresh = await import('@/sse/services/tokenRefresh.js');
    await fresh.checkAndRefreshToken('claude', {
      connectionId: 'c1',
      accessToken: 'a',
      lastRefreshAt: 'ts-99',
    });
    expect(logInfo).toHaveBeenCalledWith(
      'TOKEN_REFRESH',
      'Refreshing provider credentials proactively',
      expect.objectContaining({ lastRefreshAt: 'ts-99' })
    );
  });
});

describe('github copilot branch expiry math', () => {
  it('copilotTokenExpiresAt (epoch seconds) is converted to ms before the buffer comparison: far-future is not refreshed', async () => {
    vi.resetModules();
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
      ...(await orig()),
      shouldRefreshCredentials: () => false,
    }));
    const fresh = await import('@/sse/services/tokenRefresh.js');
    const farFutureSecs = Math.floor((Date.now() + 60 * 60 * 1000) / 1000); // 1h out, secs
    const out = await fresh.checkAndRefreshToken('github', {
      connectionId: 'c1',
      accessToken: 'gh',
      providerSpecificData: { copilotToken: 'cop-old', copilotTokenExpiresAt: farFutureSecs },
    });
    expect(out.providerSpecificData.copilotToken).toBe('cop-old');
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it('updateProviderCredentials for copilot writes exactly providerSpecificData, no stray fields', async () => {
    vi.resetModules();
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
      ...(await orig()),
      shouldRefreshCredentials: () => false,
    }));
    vi.doMock('open-sse/services/tokenRefresh.js', async (orig) => ({
      ...(await orig()),
      refreshCopilotToken: vi.fn(async () => ({ token: 'cop-new', expiresAt: 12345 })),
    }));
    updateProviderConnection.mockResolvedValue({ id: 'c' });
    const fresh = await import('@/sse/services/tokenRefresh.js');
    await fresh.checkAndRefreshToken('github', {
      connectionId: 'c1',
      accessToken: 'gh',
      providerSpecificData: {},
    });
    const [, updates] = updateProviderConnection.mock.calls[0];
    expect(Object.keys(updates)).toEqual(['providerSpecificData']);
    expect(updates.providerSpecificData).toEqual({
      copilotToken: 'cop-new',
      copilotTokenExpiresAt: 12345,
    });
  });
});
