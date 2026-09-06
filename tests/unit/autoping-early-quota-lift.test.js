import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runQuotaAutoPingTick } from '@/shared/services/quotaAutoPing';
import { QUOTA_AUTOPING_CONFIG } from '@/shared/constants/config';
import { filterAvailableAccounts } from 'open-sse/services/accountFallback.js';

// EARLY QUOTA LIFT. Providers introduce and lift quotas without notice. The
// lock timestamp (blind exponential backoff, or the provider's last reported
// reset) is a guess about the future; the poller's usage read is a fact about
// the present. These tests pin the contract, not any provider's numbers:
//   1. a healthy governing window + a future lock => the lock is cleared this
//      tick, costing zero warm requests;
//   2. an exhausted governing window never clears the lock early;
//   3. backoffLevel survives the clear (half-open: a wrong clear re-locks
//      one level higher on the next real failure).

const NOW = new Date('2026-01-01T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();
const HOUR = 3600_000;

const CLAUDE_CFG = QUOTA_AUTOPING_CONFIG.providers.claude;

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

function makeDeps(conn, quotas) {
  const fetches = [];
  const writes = [];
  const deps = {
    getSettings: async () => ({
      [CLAUDE_CFG.settingsKey]: { enabled: true, connections: { [conn.id]: true } },
    }),
    getProviderConnections: async ({ provider }) => (provider === 'claude' ? [{ ...conn }] : []),
    updateProviderConnection: async (id, patch) => {
      writes.push([id, patch]);
    },
    resolveConnectionProxyConfig: async () => DIRECT_PROXY_CONFIG,
    refreshAndUpdateCredentials: async (connection) => ({ connection }),
    getUsageForProvider: async () => ({ quotas }),
    getExecutor: () => ({ execute: async () => ({ response: { ok: true, status: 200 } }) }),
    proxyAwareFetch: async (url, init) => {
      fetches.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => '' };
    },
  };
  return { deps, fetches, writes };
}

const lockedConn = (lockOffsetMs, extra = {}) => ({
  id: 'claude-locked',
  provider: 'claude',
  authType: 'oauth',
  accessToken: 'tok',
  providerSpecificData: {},
  rateLimitedUntil: iso(lockOffsetMs),
  backoffLevel: 3,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('early quota lift: fresh usage outranks the lock timestamp', () => {
  const healthyQuotas = {
    'session (5h)': { used: 5, total: 100, remaining: 95, resetAt: iso(4 * HOUR) },
    'weekly (7d)': { used: 10, total: 100, remaining: 90, resetAt: iso(72 * HOUR) },
  };

  it('clears a future lock when the governing window reads healthy, spending no request', async () => {
    const conn = lockedConn(2 * HOUR);
    const { deps, fetches, writes } = makeDeps(conn, healthyQuotas);

    await runQuotaAutoPingTick(deps, freshState());

    const clears = writes.filter(([, p]) => p.rateLimitedUntil === null);
    expect(clears).toEqual([[conn.id, { rateLimitedUntil: null }]]);
    expect(fetches).toEqual([]); // every window running: nothing warmed

    // The clear is exactly what fallback filtering consumes.
    const account = { ...conn, rateLimitedUntil: null };
    expect(filterAvailableAccounts([account])).toEqual([account]);
  });

  it('the clear never touches backoffLevel, so a wrong lift re-locks harder', async () => {
    const conn = lockedConn(2 * HOUR);
    const { deps, writes } = makeDeps(conn, healthyQuotas);

    await runQuotaAutoPingTick(deps, freshState());

    for (const [, patch] of writes) {
      expect(patch).not.toHaveProperty('backoffLevel');
    }
  });

  it('an already-elapsed lock is left alone (it lapses by itself, no write to learn nothing)', async () => {
    const conn = lockedConn(-60_000);
    const { deps, writes } = makeDeps(conn, healthyQuotas);

    await runQuotaAutoPingTick(deps, freshState());

    expect(writes.filter(([, p]) => p.rateLimitedUntil === null)).toEqual([]);
  });
});

describe('no early lift while the governing window is exhausted', () => {
  it('an exhausted window re-marks to the provider reset instead of clearing', async () => {
    const RESET_AT = iso(90 * 60_000);
    const conn = lockedConn(6 * HOUR); // blind backoff guessed 6h
    const { deps, writes } = makeDeps(conn, {
      'session (5h)': { used: 100, total: 100, remaining: 0, resetAt: RESET_AT },
    });

    await runQuotaAutoPingTick(deps, freshState());

    expect(writes.filter(([, p]) => p.rateLimitedUntil === null)).toEqual([]);
    // Provider's own reset replaces the blind 6h guess: adapt in BOTH directions.
    expect(writes.filter(([, p]) => 'rateLimitedUntil' in p)).toEqual([
      [conn.id, { rateLimitedUntil: RESET_AT }],
    ]);
  });

  it('an unreadable usage payload clears nothing (absence of evidence is not a lift)', async () => {
    const conn = lockedConn(2 * HOUR);
    const { deps, writes } = makeDeps(conn, null);
    deps.getUsageForProvider = async () => ({ message: 'upstream 500' });

    await runQuotaAutoPingTick(deps, freshState());

    expect(writes).toEqual([]);
  });
});
