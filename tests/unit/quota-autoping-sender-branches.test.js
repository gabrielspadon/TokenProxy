// Sender and bookkeeping branches of the quota auto-ping scheduler: the claude
// full-catalogue walk, codex stream draining and cancel, antigravity partial
// warms, the generic sender's refusal paths, and every persistence-failure
// catch. All I/O is injected through the deps parameter; zero network, zero DB.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/localDb', () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn(),
}));
vi.mock('@/lib/network/connectionProxy', () => ({
  resolveConnectionProxyConfig: vi.fn(),
  toConnectionProxyOptions: vi.fn(),
}));
vi.mock('@/app/api/usage/[connectionId]/route.js', () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

const { runQuotaAutoPingTick, startQuotaAutoPing, stopQuotaAutoPing } =
  await import('@/shared/services/quotaAutoPing');
const { QUOTA_AUTOPING_CONFIG: C } = await import('@/shared/constants/config');

const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();

const freshState = () => ({
  running: false,
  failureCache: {},
  resetCache: {},
  seenResets: {},
  allRunning: {},
});

// One enabled connection for one provider, everything else injectable.
function tickDeps(provider, cfg, { quotas = {}, connection = {}, ...overrides } = {}) {
  const conn = {
    id: `${provider}-1`,
    provider,
    authType: (cfg.authTypes || ['oauth'])[0],
    accessToken: 'tok',
    providerSpecificData: {},
    ...connection,
  };
  return {
    getSettings: async () => ({
      [cfg.settingsKey]: { enabled: true, connections: { [conn.id]: true } },
    }),
    getProviderConnections: async () => [conn],
    // Plain shape (no kind:'usable') so buildProxyOptions builds from fields
    // instead of routing through the mocked toConnectionProxyOptions.
    resolveConnectionProxyConfig: vi.fn(async () => ({
      connectionProxyEnabled: false,
      strictProxy: false,
    })),
    refreshAndUpdateCredentials: async (c) => ({ connection: c }),
    updateProviderConnection: vi.fn(async () => {}),
    getUsageForProvider: async () => ({ quotas }),
    getExecutor: () => null,
    proxyAwareFetch: vi.fn(),
    ...overrides,
  };
}

// A synthetic provider registered for one test only, so the generic-sender
// refusal branches are reachable without depending on any real provider's
// registry contents.
const SYNTH = 'synthetic-autoping-test';
async function withProvider(cfg, fn) {
  C.providers[SYNTH] = cfg;
  try {
    return await fn(cfg);
  } finally {
    delete C.providers[SYNTH];
  }
}
const synthCfg = (extra = {}) => ({
  settingsKey: 'synthAutoPingTest',
  quotaKey: 'win',
  expectedWindows: ['win'],
  authTypes: ['oauth'],
  pingText: 'hi',
  pingMaxTokens: 1,
  ...extra,
});

let logSpy;
let warnSpy;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

const logged = (spy) => spy.mock.calls.map((c) => c.join(' ')).join('\n');

describe('claude sender walks the whole candidate list', () => {
  it('records a failure after every candidate model is refused', async () => {
    const cfg = C.providers.claude;
    const { claudePingCandidates } = await import('@/shared/services/quotaAutoPing');
    const candidates = claudePingCandidates(cfg);
    const state = freshState();
    const deps = tickDeps('claude', cfg, {
      proxyAwareFetch: vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })),
    });
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(candidates.length);
    expect(logged(logSpy)).toContain('every candidate model was refused');
    expect(state.failureCache['claude:claude-1']).toBeDefined();
  });
});

describe('codex sender stream handling', () => {
  it('drains a text-less ok response through its body reader', async () => {
    const cfg = C.providers.codex;
    const reads = [{ done: false }, { done: true }];
    const releaseLock = vi.fn();
    const reader = { read: vi.fn(async () => reads.shift()), releaseLock };
    const deps = tickDeps('codex', cfg, {
      proxyAwareFetch: vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })),
      getExecutor: () => ({
        execute: async () => ({
          response: { ok: true, status: 200, body: { getReader: () => reader } },
        }),
      }),
    });
    await runQuotaAutoPingTick(deps, freshState());
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith(
      'codex-1',
      expect.objectContaining({ lastPingAt: expect.any(String) })
    );
  });

  it('cancels the body and fails the warm on a non-ok response, even when cancel throws', async () => {
    const cfg = C.providers.codex;
    const cancel = vi.fn(() => {
      throw new Error('already closed');
    });
    const state = freshState();
    const deps = tickDeps('codex', cfg, {
      proxyAwareFetch: vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })),
      getExecutor: () => ({
        execute: async () => ({ response: { ok: false, status: 429, body: { cancel } } }),
      }),
    });
    await runQuotaAutoPingTick(deps, state);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(state.failureCache['codex:codex-1']).toBeDefined();
  });
});

describe('antigravity sender per-family outcomes', () => {
  it('counts a 400 family as not warmed and reports a partial warm as success', async () => {
    const cfg = C.providers.antigravity;
    const families = cfg.quotaKeys;
    expect(families.length).toBeGreaterThan(1);
    let call = 0;
    const deps = tickDeps('antigravity', cfg, {
      getExecutor: () => ({
        execute: async () => ({
          // First family refused as a model-level 400, the rest land.
          response: { status: call++ === 0 ? 400 : 200, text: async () => '' },
        }),
      }),
    });
    await runQuotaAutoPingTick(deps, freshState());
    expect(call).toBe(families.length);
    const out = logged(logSpy);
    expect(out).toContain('not counting as warmed');
    expect(out).toContain(`${families.length - 1}/${families.length} quota families warmed`);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith(
      'antigravity-1',
      expect.objectContaining({ lastPingAt: expect.any(String) })
    );
  });
});

describe('generic sender refusals', () => {
  it('fails when no model is resolvable at all', () =>
    withProvider(synthCfg(), async (cfg) => {
      const state = freshState();
      await runQuotaAutoPingTick(tickDeps(SYNTH, cfg), state);
      expect(logged(logSpy)).toContain('no model to warm with');
      expect(state.failureCache[`${SYNTH}:${SYNTH}-1`]).toBeDefined();
    }));

  it('fails when the provider has no executor', () =>
    withProvider(synthCfg({ pingModel: 'model-x' }), async (cfg) => {
      await runQuotaAutoPingTick(tickDeps(SYNTH, cfg), freshState());
      expect(logged(logSpy)).toContain('no executor, cannot warm');
    }));

  it('treats a 5xx answer as a failed warm', () =>
    withProvider(synthCfg({ pingModel: 'model-x' }), async (cfg) => {
      const deps = tickDeps(SYNTH, cfg, {
        getExecutor: () => ({ execute: async () => ({ response: { status: 503 } }) }),
      });
      const state = freshState();
      await runQuotaAutoPingTick(deps, state);
      expect(logged(logSpy)).toContain('treating as failed');
      expect(state.failureCache[`${SYNTH}:${SYNTH}-1`]).toBeDefined();
    }));
});

describe('quota bookkeeping around the warm', () => {
  it('marks the connection rate-limited when the governing quota is exhausted (string numbers)', () =>
    withProvider(synthCfg(), async (cfg) => {
      const resetAt = FUTURE();
      const deps = tickDeps(SYNTH, cfg, { quotas: { win: { remaining: '0', resetAt } } });
      await runQuotaAutoPingTick(deps, freshState());
      expect(deps.updateProviderConnection).toHaveBeenCalledWith(`${SYNTH}-1`, {
        rateLimitedUntil: resetAt,
      });
    }));

  it('logs, and survives, a failed early-lift lock clear', () =>
    withProvider(synthCfg(), async (cfg) => {
      const deps = tickDeps(SYNTH, cfg, {
        quotas: { win: { remaining: 5, resetAt: FUTURE() } },
        connection: { rateLimitedUntil: FUTURE() },
        updateProviderConnection: vi.fn(async () => {
          throw new Error('db busy');
        }),
      });
      await runQuotaAutoPingTick(deps, freshState());
      expect(logged(warnSpy)).toContain('could not clear lifted lock');
    }));

  it('reports a started clock and keeps the in-memory mirror when the durable write fails', () =>
    withProvider(synthCfg(), async (cfg) => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const state = freshState();
      const deps = tickDeps(SYNTH, cfg, {
        quotas: { win: { remaining: 5, resetAt: FUTURE() } },
        connection: { autoPingWindows: { win: { lastWarmedAt: past, unstartedSince: past } } },
        updateProviderConnection: vi.fn(async () => {
          throw new Error('disk full');
        }),
      });
      await runQuotaAutoPingTick(deps, state);
      expect(logged(logSpy)).toContain('clock running for win');
      expect(logged(warnSpy)).toContain('could not persist warm state');
      // Mirror carries the brake for this process even though the write failed.
      expect(state.warmStateCache[`${SYNTH}:${SYNTH}-1`].win.unstartedSince).toBeNull();
    }));

  it('records a failure when the credential refresh throws', () =>
    withProvider(synthCfg(), async (cfg) => {
      const state = freshState();
      const deps = tickDeps(SYNTH, cfg, {
        refreshAndUpdateCredentials: async () => {
          throw new Error('token endpoint down');
        },
      });
      await runQuotaAutoPingTick(deps, state);
      expect(logged(warnSpy)).toContain('refresh failed');
      expect(state.failureCache[`${SYNTH}:${SYNTH}-1`]).toBeDefined();
    }));

  it('skips a connection on cooldown without touching the proxy resolver', () =>
    withProvider(synthCfg(), async (cfg) => {
      const state = freshState();
      // A failure recorded with no failureCounts entry (pre-escalation shape)
      // still cools down, on the default single-failure window.
      state.failureCache[`${SYNTH}:${SYNTH}-1`] = Date.now();
      const deps = tickDeps(SYNTH, cfg);
      await runQuotaAutoPingTick(deps, state);
      expect(deps.resolveConnectionProxyConfig).not.toHaveBeenCalled();
    }));

  it('records a failure when the post-warm state write fails, so the spend is not repeated', async () => {
    const cfg = C.providers.claude;
    const state = freshState();
    const deps = tickDeps('claude', cfg, {
      proxyAwareFetch: vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
      updateProviderConnection: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({})
        .mockRejectedValue(new Error('db gone')),
    });
    await runQuotaAutoPingTick(deps, state);
    expect(logged(warnSpy)).toContain('warm spent but state write failed');
    expect(state.failureCache['claude:claude-1']).toBeDefined();
  });

  it('contains a settings-read failure inside the tick', async () => {
    await runQuotaAutoPingTick(
      {
        getSettings: async () => {
          throw new Error('settings unreadable');
        },
      },
      freshState()
    );
    expect(logged(warnSpy)).toContain('tick error:');
  });
});

describe('scheduler lifecycle', () => {
  it('starts once, ticks on the interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      startQuotaAutoPing();
      startQuotaAutoPing(); // idempotent
      expect(logged(logSpy)).toContain('scheduler started');
      // The interval tick runs against the mocked default deps: getSettings
      // returns undefined, so the tick enumerates nothing and touches nothing.
      await vi.advanceTimersByTimeAsync(C.tickIntervalMs);
      stopQuotaAutoPing();
      stopQuotaAutoPing(); // idempotent
      expect(logged(logSpy)).toContain('scheduler stopped');
    } finally {
      stopQuotaAutoPing();
      vi.useRealTimers();
    }
  });
});
