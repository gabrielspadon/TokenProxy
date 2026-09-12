// Kills checkAndRefreshToken survivors: the proactive-refresh log's
// remaining-is-not-null branch (a real expiresAt must log a numeric
// expiresIn, not always null), mergedCreds actually carrying
// existingProviderSpecificData through to updateProviderCredentials, the
// copilot branch's optional-chaining on a missing providerSpecificData, and
// the copilot log's "missing" fallback when copilotToken is absent.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logInfo = vi.fn();
vi.mock('../../src/sse/utils/logger.js', () => ({
  debug: vi.fn(),
  info: (...a) => logInfo(...a),
  error: vi.fn(),
}));

const updateProviderConnection = vi.fn();
vi.mock('../../src/lib/localDb.js', () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: (...a) => updateProviderConnection(...a),
}));

beforeEach(() => {
  logInfo.mockReset();
  updateProviderConnection.mockReset();
  updateProviderConnection.mockImplementation(async (id, updates) => ({ id, ...updates }));
});

it('a credentials object with a real expiresAt logs a numeric expiresIn, not null', async () => {
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
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const [, , fields] = logInfo.mock.calls[0];
  expect(fields.expiresIn).not.toBeNull();
  expect(typeof fields.expiresIn).toBe('number');
});

it('mergedCreds passed to updateProviderCredentials carries existingProviderSpecificData from the prior creds', async () => {
  vi.resetModules();
  vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
    ...(await orig()),
    shouldRefreshCredentials: () => true,
    refreshProviderCredentials: async (_provider, _credentials, _log, options) =>
      options.onCredentialsRefreshed({
        accessToken: 'new-a',
        expiresIn: 60,
        providerSpecificData: { added: 1 },
      }, { expectedCredentials: options.expectedCredentials }),
  }));
  const fresh = await import('@/sse/services/tokenRefresh.js');
  await fresh.checkAndRefreshToken('claude', {
    connectionId: 'c1',
    accessToken: 'old',
    providerSpecificData: { keep: 'me' },
  });
  const [, updates] = updateProviderConnection.mock.calls[0];
  expect(updates.providerSpecificData).toEqual({ keep: 'me', added: 1 });
});

it('github with no providerSpecificData at all does not throw and still forces a copilot refresh', async () => {
  vi.resetModules();
  vi.doMock('open-sse/services/oauthCredentialManager.js', async (orig) => ({
    ...(await orig()),
    shouldRefreshCredentials: () => false,
  }));
  vi.doMock('open-sse/services/tokenRefresh.js', async (orig) => ({
    ...(await orig()),
    refreshCopilotToken: vi.fn(async () => ({ token: 'cop-new', expiresAt: 999 })),
  }));
  const fresh = await import('@/sse/services/tokenRefresh.js');
  const out = await fresh.checkAndRefreshToken('github', {
    connectionId: 'c1',
    accessToken: 'gh',
  });
  expect(out.copilotToken).toBe('cop-new');
});

it('copilot log reports expiresIn: "missing" (string) when copilotToken is absent, not a number', async () => {
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
  await fresh.checkAndRefreshToken('github', {
    connectionId: 'c1',
    accessToken: 'gh',
    providerSpecificData: {},
  });
  const [, , fields] = logInfo.mock.calls[0];
  expect(fields.expiresIn).toBe('missing');
});
