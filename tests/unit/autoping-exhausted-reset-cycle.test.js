import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runQuotaAutoPingTick } from '@/shared/services/quotaAutoPing';
import { QUOTA_AUTOPING_CONFIG } from '@/shared/constants/config';
import { filterAvailableAccounts } from 'open-sse/services/accountFallback.js';

// ANTI-REVERT GUARDS on the warming economics, on the real Claude config.
// Three behaviors, each of which has independently regressed before:
//   1. an exhausted governing window marks the account skipped until the
//      provider's own reset timestamp, and that mark lapses on its own;
//   2. once the timestamp passes the account is re-pinged (the clock must be
//      restarted, it does not restart itself);
//   3. an account whose windows are already counting is never pinged — a warm
//      request against a running window is quota spent to learn nothing.

const NOW = new Date('2026-01-01T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();
const HOUR = 3600_000;

const CLAUDE_CFG = QUOTA_AUTOPING_CONFIG.providers.claude;
const CONN = {
  id: 'claude-1',
  provider: 'claude',
  authType: 'oauth',
  accessToken: 'tok',
  providerSpecificData: {},
};

// The real resolver never returns null; "no proxy" is an intentional-direct shape.
const DIRECT_PROXY_CONFIG = {
  kind: 'usable',
  resolutionKind: 'intentional-direct',
  connectionProxyEnabled: false,
  connectionProxyUrl: '',
  connectionNoProxy: '',
  vercelRelayUrl: '',
  strictProxy: false,
};

const freshState = () => ({
  running: false,
  failureCache: {},
  resetCache: {},
  seenResets: {},
  allRunning: {},
});

function makeDeps(quotasByCall) {
  const fetches = [];
  const writes = [];
  let usageCall = 0;
  const deps = {
    getSettings: async () => ({
      [CLAUDE_CFG.settingsKey]: { enabled: true, connections: { [CONN.id]: true } },
    }),
    getProviderConnections: async ({ provider }) => (provider === 'claude' ? [{ ...CONN }] : []),
    updateProviderConnection: async (id, patch) => {
      writes.push([id, patch]);
    },
    resolveConnectionProxyConfig: async () => DIRECT_PROXY_CONFIG,
    refreshAndUpdateCredentials: async (connection) => ({ connection }),
    getUsageForProvider: async () => {
      const quotas = quotasByCall[Math.min(usageCall, quotasByCall.length - 1)];
      usageCall += 1;
      return { quotas };
    },
    getExecutor: () => ({ execute: async () => ({ response: { ok: true, status: 200 } }) }),
    proxyAwareFetch: async (url, init) => {
      fetches.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => '' };
    },
  };
  return { deps, fetches, writes, usageCalls: () => usageCall };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an account already counting time is never pinged', () => {
  it('sends nothing while every tracked window is running, and holds the usage read too', async () => {
    const runningQuotas = {
      'session (5h)': { used: 50, total: 100, remaining: 50, resetAt: iso(2 * HOUR) },
      'weekly (7d)': { used: 10, total: 100, remaining: 90, resetAt: iso(72 * HOUR) },
    };
    const { deps, fetches, writes, usageCalls } = makeDeps([runningQuotas]);
    const state = freshState();

    await runQuotaAutoPingTick(deps, state);
    expect(fetches).toEqual([]); // no warm request: the clock is already running
    expect(writes.filter(([, p]) => 'rateLimitedUntil' in p)).toEqual([]);

    // Next tick, still far from reset: the all-running guard must also skip the
    // refresh+usage round trip, not just the ping.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await runQuotaAutoPingTick(deps, state);
    expect(usageCalls()).toBe(1);
    expect(fetches).toEqual([]);
  });
});

describe('exhausted governing window: skipped until the reset timestamp, then re-pinged', () => {
  const RESET_AT = iso(90 * 60_000); // provider says the session window resets in 90min
  const exhaustedQuotas = {
    // Governing window spent; weekly absent (cold), which would otherwise be a
    // warm target — the exhausted window must block that spend.
    'session (5h)': { used: 100, total: 100, remaining: 0, resetAt: RESET_AT },
  };

  it('writes rateLimitedUntil from the provider reset and does not spend a ping', async () => {
    const { deps, fetches, writes } = makeDeps([exhaustedQuotas]);

    await runQuotaAutoPingTick(deps, freshState());

    expect(fetches).toEqual([]); // blocked-by-exhausted: no warm while spent
    const marks = writes.filter(([, p]) => 'rateLimitedUntil' in p);
    expect(marks).toEqual([[CONN.id, { rateLimitedUntil: RESET_AT }]]);
  });

  it('the mark is exactly what account fallback filters on, and it lapses at the reset', async () => {
    const { deps, writes } = makeDeps([exhaustedQuotas]);
    await runQuotaAutoPingTick(deps, freshState());
    const [, patch] = writes.find(([, p]) => 'rateLimitedUntil' in p);
    const account = { ...CONN, ...patch };

    // Before the reset: skipped like a paused account.
    expect(filterAvailableAccounts([account])).toEqual([]);
    // After the reset passes: available again with no write needed.
    vi.setSystemTime(new Date(new Date(RESET_AT).getTime() + 1000));
    expect(filterAvailableAccounts([account])).toEqual([account]);
  });

  it('re-pings once the reset timestamp has passed and the window reads stopped', async () => {
    // Tick 2 happens after the reset; the provider still reports the OLD reset
    // (now elapsed), which is the stopped-clock state warming exists to break.
    const { deps, fetches } = makeDeps([exhaustedQuotas, exhaustedQuotas]);
    const state = freshState();

    await runQuotaAutoPingTick(deps, state);
    expect(fetches).toEqual([]); // exhausted: nothing spent yet

    vi.setSystemTime(new Date(NOW.getTime() + 2 * HOUR)); // past RESET_AT
    await runQuotaAutoPingTick(deps, state);

    expect(fetches.length).toBe(1); // the re-ping the reset was waiting for
    expect(fetches[0].url).toContain('api.anthropic.com');
    expect(fetches[0].body.model).toBe(CLAUDE_CFG.pingModel);
    expect(fetches[0].body.max_tokens).toBe(CLAUDE_CFG.pingMaxTokens);
  });
});

describe('a spent warm is recorded; a refused one is not', () => {
  const coldQuotas = {
    // Session reset elapsed one minute ago: cold, warm due immediately.
    'session (5h)': { used: 40, total: 100, remaining: 60, resetAt: iso(-60_000) },
    'weekly (7d)': { used: 10, total: 100, remaining: 90, resetAt: iso(72 * HOUR) },
  };

  it('a successful ping persists lastPingAt and per-window warm state', async () => {
    const { deps, fetches, writes } = makeDeps([coldQuotas]);

    await runQuotaAutoPingTick(deps, freshState());

    expect(fetches.length).toBe(1);
    const warmWrite = writes.find(([, p]) => 'lastPingAt' in p);
    expect(warmWrite).toBeDefined();
    expect(warmWrite[1].autoPingWindows['session (5h)'].lastWarmedAt).toBeTruthy();
  });

  it('a rate-limited ping records no warm, so the window is not falsely marked started', async () => {
    const { deps, writes } = makeDeps([coldQuotas]);
    deps.proxyAwareFetch = async () => ({ ok: false, status: 429, text: async () => 'limited' });

    await runQuotaAutoPingTick(deps, freshState());

    expect(writes.filter(([, p]) => 'lastPingAt' in p)).toEqual([]);
  });
});
