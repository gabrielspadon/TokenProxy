// src/sse/services/tokenRefresh.js re-exports each open-sse refresh function
// wrapped with a local logger. Kills the "() => undefined" ArrowFunction
// mutants at lines 35-71 by proving each wrapper forwards args and return
// value through to the underlying implementation.
import { describe, it, expect, vi } from 'vitest';

vi.mock('open-sse/services/tokenRefresh.js', async (importOriginal) => ({
  ...(await importOriginal()),
  refreshAccessToken: vi.fn(async () => ({ accessToken: 'a' })),
  refreshClaudeOAuthToken: vi.fn(async () => ({ accessToken: 'claude' })),
  refreshGoogleToken: vi.fn(async () => ({ accessToken: 'google' })),
  refreshCodexToken: vi.fn(async () => ({ accessToken: 'codex' })),
  refreshIflowToken: vi.fn(async () => ({ accessToken: 'iflow' })),
  refreshGitHubToken: vi.fn(async () => ({ accessToken: 'github' })),
  refreshCopilotToken: vi.fn(async () => ({ token: 'copilot' })),
  refreshKiroToken: vi.fn(async () => ({ accessToken: 'kiro' })),
  getAccessToken: vi.fn(async () => 'access-tok'),
  refreshTokenByProvider: vi.fn(async () => ({ accessToken: 'byprovider' })),
  formatProviderCredentials: vi.fn(() => ({ formatted: true })),
  getAllAccessTokens: vi.fn(async () => ({ tok: 1 })),
  getEffectiveRefreshLeadMs: vi.fn(() => 5000),
}));

import * as mocked from 'open-sse/services/tokenRefresh.js';
import * as wrapper from '@/sse/services/tokenRefresh.js';

describe('local wrapper exports forward args and return value', () => {
  it('refreshAccessToken', async () => {
    const out = await wrapper.refreshAccessToken('p', 'rt', { a: 1 });
    expect(out).toEqual({ accessToken: 'a' });
    expect(mocked.refreshAccessToken).toHaveBeenCalledWith('p', 'rt', { a: 1 }, expect.anything());
  });

  it('refreshClaudeOAuthToken', async () => {
    expect(await wrapper.refreshClaudeOAuthToken('rt')).toEqual({ accessToken: 'claude' });
    expect(mocked.refreshClaudeOAuthToken).toHaveBeenCalledWith('rt', expect.anything());
  });

  it('refreshGoogleToken', async () => {
    expect(await wrapper.refreshGoogleToken('rt', 'cid', 'csec')).toEqual({
      accessToken: 'google',
    });
    expect(mocked.refreshGoogleToken).toHaveBeenCalledWith('rt', 'cid', 'csec', expect.anything());
  });

  it('refreshCodexToken', async () => {
    expect(await wrapper.refreshCodexToken('rt')).toEqual({ accessToken: 'codex' });
  });

  it('refreshIflowToken', async () => {
    expect(await wrapper.refreshIflowToken('rt')).toEqual({ accessToken: 'iflow' });
  });

  it('refreshGitHubToken', async () => {
    expect(await wrapper.refreshGitHubToken('rt')).toEqual({ accessToken: 'github' });
  });

  it('refreshCopilotToken', async () => {
    expect(await wrapper.refreshCopilotToken('gh-acc')).toEqual({ token: 'copilot' });
    expect(mocked.refreshCopilotToken).toHaveBeenCalledWith('gh-acc', expect.anything());
  });

  it('refreshKiroToken', async () => {
    expect(await wrapper.refreshKiroToken('rt', { a: 1 })).toEqual({ accessToken: 'kiro' });
  });

  it('getAccessToken', async () => {
    expect(await wrapper.getAccessToken('p', { a: 1 })).toBe('access-tok');
  });

  it('refreshTokenByProvider', async () => {
    expect(await wrapper.refreshTokenByProvider('p', { a: 1 })).toEqual({
      accessToken: 'byprovider',
    });
  });

  it('formatProviderCredentials', () => {
    expect(wrapper.formatProviderCredentials('p', { a: 1 })).toEqual({ formatted: true });
  });

  it('getAllAccessTokens', async () => {
    expect(await wrapper.getAllAccessTokens({ u: 1 })).toEqual({ tok: 1 });
  });

  it('shouldRefreshCredentials forwards to oauthCredentialManager without a log arg', async () => {
    vi.resetModules();
    const shouldRefreshCredentials = vi.fn().mockReturnValue(true);
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (importOriginal) => ({
      ...(await importOriginal()),
      shouldRefreshCredentials,
    }));
    const mod = await import('@/sse/services/tokenRefresh.js');
    expect(mod.shouldRefreshCredentials('p', { a: 1 })).toBe(true);
    expect(shouldRefreshCredentials).toHaveBeenCalledWith('p', { a: 1 });
  });
});

describe('_refreshProjectId gating (via checkAndRefreshToken)', () => {
  it('fetches a projectId for antigravity/gemini-cli when the connection has none', async () => {
    vi.resetModules();
    vi.doMock('@/lib/localDb', () => ({
      getProviderConnectionById: vi.fn(),
      updateProviderConnection: vi.fn().mockResolvedValue({ id: 'conn-1' }),
    }));
    const getProjectIdForConnection = vi.fn().mockResolvedValue('proj-9');
    vi.doMock('open-sse/services/projectId.js', () => ({
      getProjectIdForConnection,
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
      createAntigravityVerificationHooks: vi.fn(() => ({ hook: true })),
    }));
    const { checkAndRefreshToken } = await import('@/sse/services/tokenRefresh.js');
    await checkAndRefreshToken('antigravity', { connectionId: 'conn-1', accessToken: 'old' });
    await Promise.resolve();
    await Promise.resolve();
    expect(getProjectIdForConnection).toHaveBeenCalledWith('conn-1', 'acc-new', 'antigravity', {
      hook: true,
    });
  });

  it('does not fetch a projectId for a provider that does not need one', async () => {
    vi.resetModules();
    vi.doMock('@/lib/localDb', () => ({
      getProviderConnectionById: vi.fn(),
      updateProviderConnection: vi.fn().mockResolvedValue({ id: 'conn-1' }),
    }));
    const getProjectIdForConnection = vi.fn();
    vi.doMock('open-sse/services/projectId.js', () => ({
      getProjectIdForConnection,
      removeConnection: vi.fn(),
    }));
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (importOriginal) => ({
      ...(await importOriginal()),
      refreshProviderCredentials: vi
        .fn()
        .mockResolvedValue({ accessToken: 'acc-new', expiresIn: 60 }),
      shouldRefreshCredentials: vi.fn().mockReturnValue(true),
    }));
    const { checkAndRefreshToken } = await import('@/sse/services/tokenRefresh.js');
    await checkAndRefreshToken('claude', { connectionId: 'conn-1', accessToken: 'old' });
    await Promise.resolve();
    expect(getProjectIdForConnection).not.toHaveBeenCalled();
  });

  it('does not fetch a projectId when the connection already has one', async () => {
    vi.resetModules();
    vi.doMock('@/lib/localDb', () => ({
      getProviderConnectionById: vi.fn(),
      updateProviderConnection: vi.fn().mockResolvedValue({ id: 'conn-1' }),
    }));
    const getProjectIdForConnection = vi.fn();
    vi.doMock('open-sse/services/projectId.js', () => ({
      getProjectIdForConnection,
      removeConnection: vi.fn(),
    }));
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (importOriginal) => ({
      ...(await importOriginal()),
      refreshProviderCredentials: vi
        .fn()
        .mockResolvedValue({ accessToken: 'acc-new', expiresIn: 60 }),
      shouldRefreshCredentials: vi.fn().mockReturnValue(true),
    }));
    const { checkAndRefreshToken } = await import('@/sse/services/tokenRefresh.js');
    await checkAndRefreshToken('gemini-cli', {
      connectionId: 'conn-1',
      accessToken: 'old',
      projectId: 'existing',
    });
    await Promise.resolve();
    expect(getProjectIdForConnection).not.toHaveBeenCalled();
  });
});

describe('checkAndRefreshToken: github copilot expiry boundary (<=, not <)', () => {
  const NOW = Date.parse('2026-09-05T12:00:00Z');

  async function loadWithMocks() {
    vi.resetModules();
    vi.doMock('@/lib/localDb', () => ({
      getProviderConnectionById: vi.fn(),
      updateProviderConnection: vi.fn().mockResolvedValue({ id: 'conn-1' }),
    }));
    vi.doMock('open-sse/services/projectId.js', () => ({
      getProjectIdForConnection: vi.fn(),
      removeConnection: vi.fn(),
    }));
    const refreshCopilotToken = vi.fn().mockResolvedValue({ token: 'cop-new', expiresAt: 999 });
    vi.doMock('open-sse/services/tokenRefresh.js', async (importOriginal) => ({
      ...(await importOriginal()),
      refreshCopilotToken,
    }));
    vi.doMock('open-sse/services/oauthCredentialManager.js', async (importOriginal) => ({
      ...(await importOriginal()),
      shouldRefreshCredentials: vi.fn().mockReturnValue(false),
    }));
    const mod = await import('@/sse/services/tokenRefresh.js');
    return { ...mod, refreshCopilotToken };
  }

  it('does NOT refresh exactly at the buffer boundary (remaining === buffer, strict <)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { checkAndRefreshToken, refreshCopilotToken, TOKEN_EXPIRY_BUFFER_MS } =
      await loadWithMocks();
    const expiresAtSec = Math.floor((NOW + TOKEN_EXPIRY_BUFFER_MS) / 1000);
    await checkAndRefreshToken('github', {
      connectionId: 'conn-1',
      accessToken: 'gh-acc',
      providerSpecificData: { copilotToken: 'cop-live', copilotTokenExpiresAt: expiresAtSec },
    });
    expect(refreshCopilotToken).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('refreshes one second inside the buffer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { checkAndRefreshToken, refreshCopilotToken, TOKEN_EXPIRY_BUFFER_MS } =
      await loadWithMocks();
    const expiresAtSec = Math.floor((NOW + TOKEN_EXPIRY_BUFFER_MS - 1000) / 1000);
    await checkAndRefreshToken('github', {
      connectionId: 'conn-1',
      accessToken: 'gh-acc',
      providerSpecificData: { copilotToken: 'cop-live', copilotTokenExpiresAt: expiresAtSec },
    });
    expect(refreshCopilotToken).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
