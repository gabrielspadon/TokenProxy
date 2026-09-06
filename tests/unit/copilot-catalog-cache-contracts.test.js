/**
 * Contract tests for open-sse/services/copilotModels.js: catalog cache TTL,
 * forceRefresh bypass, filtering rules, missing-token skip, non-401 failure
 * path and the 401 refresh-retry chain. All network mocked via proxyFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: vi.fn() }));
vi.mock('open-sse/services/tokenRefresh.js', () => ({ refreshCopilotToken: vi.fn() }));

const { proxyAwareFetch } = await import('open-sse/utils/proxyFetch.js');
const { refreshCopilotToken } = await import('open-sse/services/tokenRefresh.js');
const { resolveCopilotModels, clearCopilotModelCache } =
  await import('open-sse/services/copilotModels.js');

const entry = (over = {}) => ({
  id: 'model-a',
  name: 'Model A',
  policy: { state: 'enabled' },
  capabilities: { type: 'chat' },
  ...over,
});

const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });

const CREDS = { providerSpecificData: { copilotToken: 'cop-tok' } };

beforeEach(() => {
  clearCopilotModelCache();
  proxyAwareFetch.mockReset();
  refreshCopilotToken.mockReset();
});

afterEach(() => {
  clearCopilotModelCache();
  vi.useRealTimers();
});

describe('catalog cache', () => {
  it('serves a second call from cache within the TTL, expires after it', async () => {
    vi.useFakeTimers();
    proxyAwareFetch.mockResolvedValue(ok([entry()]));

    const first = await resolveCopilotModels(CREDS);
    expect(first.models).toHaveLength(1);
    await resolveCopilotModels(CREDS);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    await resolveCopilotModels(CREDS);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh bypasses a warm cache', async () => {
    proxyAwareFetch.mockResolvedValue(ok([entry()]));
    await resolveCopilotModels(CREDS);
    await resolveCopilotModels(CREDS, { forceRefresh: true });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it('cache key is per credential', async () => {
    proxyAwareFetch.mockResolvedValue(ok([entry()]));
    await resolveCopilotModels(CREDS);
    await resolveCopilotModels({ accessToken: 'gh-other' });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });
});

describe('catalog filtering', () => {
  it('keeps only enabled chat models, dedupes ids, requires an id', async () => {
    proxyAwareFetch.mockResolvedValue(
      ok([
        entry(),
        entry(), // duplicate id
        entry({ id: 'emb', capabilities: { type: 'embeddings' } }),
        entry({ id: 'off', policy: { state: 'disabled' } }),
        entry({ id: null }),
        null,
        'not-an-object',
        entry({ id: 'no-policy', policy: undefined, name: undefined }),
      ])
    );
    const { models } = await resolveCopilotModels(CREDS);
    expect(models.map((m) => m.id).sort()).toEqual(['model-a', 'no-policy']);
    // Missing name falls back to id.
    expect(models.find((m) => m.id === 'no-policy').name).toBe('no-policy');
  });

  it('empty catalog resolves null and is not cached', async () => {
    proxyAwareFetch.mockResolvedValue(ok([]));
    expect(await resolveCopilotModels(CREDS)).toBeNull();
    await resolveCopilotModels(CREDS);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it('non-array payload resolves null', async () => {
    proxyAwareFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    expect(await resolveCopilotModels(CREDS)).toBeNull();
  });
});

describe('credential handling', () => {
  it('no token at all skips the live fetch', async () => {
    const log = { debug: vi.fn() };
    expect(await resolveCopilotModels({}, { log })).toBeNull();
    expect(await resolveCopilotModels(null)).toBeNull();
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
  });

  it('non-auth failure resolves null without a refresh attempt', async () => {
    const log = { warn: vi.fn() };
    proxyAwareFetch.mockResolvedValue(fail(500));
    expect(await resolveCopilotModels(CREDS, { log })).toBeNull();
    expect(refreshCopilotToken).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('COPILOT_MODELS', expect.stringContaining('500'));
  });

  it('401 refreshes the Copilot token, persists it, and retries once', async () => {
    const creds = { accessToken: 'gh-tok', providerSpecificData: { copilotToken: 'stale' } };
    proxyAwareFetch.mockResolvedValueOnce(fail(401)).mockResolvedValueOnce(ok([entry()]));
    refreshCopilotToken.mockResolvedValue({ token: 'fresh', expiresAt: 123 });
    const onCredentialsRefreshed = vi.fn();

    const result = await resolveCopilotModels(creds, { onCredentialsRefreshed });
    expect(result.models).toHaveLength(1);
    expect(refreshCopilotToken).toHaveBeenCalledWith('gh-tok');
    expect(onCredentialsRefreshed).toHaveBeenCalledWith({
      copilotToken: 'fresh',
      copilotTokenExpiresAt: 123,
    });
    // Retry used the refreshed token.
    const retryHeaders = proxyAwareFetch.mock.calls[1][1].headers;
    expect(retryHeaders.Authorization).toBe('Bearer fresh');
  });

  it('persist-callback failure does not sink the retry', async () => {
    const creds = { accessToken: 'gh-tok' };
    proxyAwareFetch.mockResolvedValueOnce(fail(403)).mockResolvedValueOnce(ok([entry()]));
    refreshCopilotToken.mockResolvedValue({ token: 'fresh' });
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await resolveCopilotModels(creds, {
      log,
      onCredentialsRefreshed: vi.fn().mockRejectedValue(new Error('db down')),
    });
    expect(result.models).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith('COPILOT_MODELS', expect.stringContaining('db down'));
  });

  it('refresh without a token resolves null', async () => {
    proxyAwareFetch.mockResolvedValue(fail(401));
    refreshCopilotToken.mockResolvedValue(null);
    const log = { info: vi.fn(), warn: vi.fn() };
    expect(await resolveCopilotModels({ accessToken: 'gh-tok' }, { log })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'COPILOT_MODELS',
      expect.stringContaining('did not return a token')
    );
  });

  it('retry failure after a successful refresh resolves null', async () => {
    proxyAwareFetch.mockResolvedValueOnce(fail(401)).mockResolvedValueOnce(fail(500));
    refreshCopilotToken.mockResolvedValue({ token: 'fresh' });
    const log = { info: vi.fn(), warn: vi.fn() };
    expect(await resolveCopilotModels({ accessToken: 'gh-tok' }, { log })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'COPILOT_MODELS',
      expect.stringContaining('Retry after refresh failed')
    );
  });

  it('401 with no GitHub accessToken cannot refresh and resolves null', async () => {
    proxyAwareFetch.mockResolvedValue(fail(401));
    expect(await resolveCopilotModels(CREDS)).toBeNull();
    expect(refreshCopilotToken).not.toHaveBeenCalled();
  });
});
