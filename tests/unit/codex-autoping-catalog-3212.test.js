// #3212 — Codex model access is per-account and moves over time, so the fixed
// `gpt-5.5` auto-ping model can be unavailable for an otherwise valid account.
// Auto-ping now reads the account's own catalog and pings what it offers.
//
// verify-providers.mjs cannot see any of this, so the wiring is proven here at
// runtime: the catalog GET actually happens, its choice actually reaches the
// executor, and the fallbacks land where they should.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('open-sse/index.js', () => ({}), { virtual: true });

vi.mock('@/lib/localDb', () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock('@/lib/network/connectionProxy', () => ({
  resolveConnectionProxyConfig: vi.fn(),
  toConnectionProxyOptions: vi.fn(),
}));

vi.mock('@/app/api/usage/[connectionId]/route.js', () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock('@/shared/constants/config', () => ({
  QUOTA_AUTOPING_CONFIG: {
    tickIntervalMs: 60000,
    pingLeadMs: 5000,
    refreshAheadMs: 300000,
    failureCooldownMs: 900000,
    providers: {
      codex: {
        settingsKey: 'codexAutoPing',
        quotaKey: 'session',
        pingWhenResetAtSlides: true,
        resetAtDriftMs: 30000,
        minPingIntervalMs: 600000,
        skipWhenBlockingQuotaExhausted: true,
        pingModel: 'gpt-5.5',
        pingText: 'hi',
        pingInstructions: 'Reply with OK.',
        pingReasoningEffort: 'none',
      },
    },
  },
}));

// Spread the real module: the scheduler reaches the provider registry now, and
// the registry imports constants from here, so a mock that returns one key
// fails the whole file with "No <name> export" rather than one assertion.
vi.mock('open-sse/providers/shared.js', async (importOriginal) => ({
  ...(await importOriginal()),
  CLAUDE_CLI_SPOOF_HEADERS: {},
}));

vi.mock('open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: vi.fn() }));
vi.mock('open-sse/services/usage/claude.js', () => ({ getClaudeUsage: vi.fn() }));
vi.mock('open-sse/services/usage/codex.js', () => ({ getCodexUsage: vi.fn() }));
vi.mock('open-sse/executors/index.js', () => ({ getExecutor: vi.fn() }));

const CODEX_CONNECTION = {
  id: 'codex-1',
  provider: 'codex',
  authType: 'oauth',
  accessToken: 'token',
};

describe('selectCodexPingModel (#3212)', () => {
  let selectCodexPingModel;

  beforeEach(async () => {
    vi.resetModules();
    delete global.__quotaAutoPing;
    ({ selectCodexPingModel } = await import('../../src/shared/services/quotaAutoPing.js'));
  });

  it('respects catalog order when nothing is marked default', () => {
    expect(
      selectCodexPingModel({
        models: [
          { slug: 'gpt-5.6-codex', supported_in_api: true },
          { slug: 'gpt-5.5', supported_in_api: true },
        ],
      })
    ).toBe('gpt-5.6-codex');
  });

  it('filters out entries the catalog says are not API-supported', () => {
    expect(
      selectCodexPingModel({
        models: [
          { slug: 'gpt-5.6-codex-ui-only', supported_in_api: false },
          { slug: 'gpt-5.5', supported_in_api: true },
        ],
      })
    ).toBe('gpt-5.5');
  });

  it('prefers an explicit catalog default over position', () => {
    expect(
      selectCodexPingModel({
        models: [{ slug: 'gpt-5.6-codex' }, { slug: 'gpt-5.5', is_default: true }],
      })
    ).toBe('gpt-5.5');
  });

  it('treats a missing supported_in_api flag as supported', () => {
    expect(selectCodexPingModel({ models: [{ slug: 'gpt-5.5' }] })).toBe('gpt-5.5');
  });

  it('returns null when the catalog offers nothing callable', () => {
    expect(selectCodexPingModel({ models: [] })).toBeNull();
    expect(selectCodexPingModel({ models: [{ slug: 'x', supported_in_api: false }] })).toBeNull();
  });

  it('returns undefined for a payload that is not a catalog at all', () => {
    // Distinct from null on purpose: unknown means keep the configured model,
    // empty means the account genuinely has nothing to ping.
    expect(selectCodexPingModel(undefined)).toBeUndefined();
    expect(selectCodexPingModel({ error: 'nope' })).toBeUndefined();
  });
});

describe('codex auto-ping model selection is wired (#3212)', () => {
  let runQuotaAutoPingTick;
  let getUsageForProvider;
  let getCodexUsage;
  let deps;
  let state;

  const arrangeSlidingWindow = () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { 'codex-1': true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) =>
      provider === 'codex' ? [CODEX_CONNECTION] : []
    );
    state.resetCache['codex:codex-1'] = '2026-01-01T17:00:00.000Z';
    getCodexUsage.mockResolvedValue({
      quotas: {
        session: { used: 1, total: 100, remaining: 99, resetAt: '2026-01-01T17:01:00.000Z' },
      },
    });
  };

  const executed = () => deps.getExecutor.mock.results[0]?.value.execute;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    delete global.__quotaAutoPing;

    // The window fixtures below are absolute timestamps, and whether a window
    // reads as running or as long-elapsed is now decided against the clock. An
    // unpinned clock makes every one of them stale by however long ago this
    // file was written, so the tick warms a cold window instead of exercising
    // the slide path these tests are about.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T16:30:00.000Z'));

    ({ getCodexUsage } = await import('open-sse/services/usage/codex.js'));
    ({ runQuotaAutoPingTick } = await import('../../src/shared/services/quotaAutoPing.js'));
    ({ getUsageForProvider } = await import('open-sse/services/usage.js'));

    deps = {
      getSettings: vi.fn(),
      getProviderConnections: vi.fn(),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      proxyAwareFetch: vi.fn(),
      getExecutor: vi.fn(() => ({
        execute: vi
          .fn()
          .mockResolvedValue({ response: { ok: true, text: vi.fn().mockResolvedValue('') } }),
      })),
      getUsageForProvider,
    };
    state = { running: false, resetCache: {}, failureCache: {} };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pings the live catalog's model, not the configured one", async () => {
    arrangeSlidingWindow();
    deps.proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ slug: 'gpt-5.6-codex', supported_in_api: true }] }),
    });

    await runQuotaAutoPingTick(deps, state);

    const [url, init] = deps.proxyAwareFetch.mock.calls[0];
    expect(url).toContain('https://chatgpt.com/backend-api/codex/models');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer token');

    expect(executed()).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.6-codex',
        body: expect.objectContaining({ model: 'gpt-5.6-codex' }),
      })
    );
    expect(deps.updateProviderConnection).toHaveBeenCalledWith(
      'codex-1',
      expect.objectContaining({
        lastPingedResetAt: '2026-01-01T17:01:00.000Z',
      })
    );
  });

  it('skips the upstream ping when the catalog offers nothing callable', async () => {
    arrangeSlidingWindow();
    deps.proxyAwareFetch.mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    // Not recorded as pinged, and the cooldown stops it retrying every tick.
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.failureCache['codex:codex-1']).toBeTypeOf('number');
  });

  it('keeps the configured model when the catalog is unreachable', async () => {
    arrangeSlidingWindow();
    deps.proxyAwareFetch.mockRejectedValue(new Error('ECONNRESET'));

    await runQuotaAutoPingTick(deps, state);

    expect(executed()).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.5' }));
  });

  it('keeps the configured model when the catalog request is rejected', async () => {
    arrangeSlidingWindow();
    deps.proxyAwareFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await runQuotaAutoPingTick(deps, state);

    expect(executed()).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.5' }));
  });

  it('does not fetch the catalog on a tick that would not ping anyway', async () => {
    // First observation of resetAt: pingConnection returns before sendCodexPing,
    // which is what keeps this to one GET per window rather than one per tick.
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { 'codex-1': true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) =>
      provider === 'codex' ? [CODEX_CONNECTION] : []
    );
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, resetAt: '2026-01-01T17:00:00.000Z' } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });
});
