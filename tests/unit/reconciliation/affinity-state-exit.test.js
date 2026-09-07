import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// boundary-contract.json: affinity.state.exit — owner AffinityLedger.assign,
// live_gate "fifteen identities remain stable across second turn and
// restart". TokenProxy's own equivalent of the ASSIGN boundary is the write
// side of durable session affinity, exercised at two levels:
//   - sessionAffinityRepo.js's setPin (the low-level atomic upsert), and
//   - src/sse/services/accountScheduler.js's selectAndReserve driven through
//     src/sse/services/schedulerRepos.js's real synchronous SQLite facade —
//     the actual production seam that decides whether a session stays on its
//     pinned account or moves, which is what "remain stable" is a claim
//     about.
//
// Mutations this file must fail under if reintroduced:
//   - "skip atomic replacement": a repin (setPin called twice for the same
//     session+model) either errors or leaves two rows instead of replacing
//     the one row in place (setPin's ON CONFLICT upsert).
//   - "hop assigned endpoint": a session whose pinned account is still
//     usable moves anyway because a competing account edges ahead in raw
//     ranking (accountScheduler.js's previous-pin-first reordering, tested
//     across a second turn AND a restart, matching the live_gate's own
//     wording).
//   - "store unhashed identity": the affinity key persisted for a real
//     request is the raw client-supplied session identity rather than its
//     sha256 digest (auth.js's resolveRoutingSessionHash, the one place a
//     production request derives sessionHash before it ever reaches
//     setPin).
//
// REAL MODULES, NOT MOCKS OF THEM, for the modules under test. Only the
// boundaries this file is not testing are faked, matching
// scheduler-wiring.test.js's own recipe for driving getProviderCredentials:
// the connection store, the proxy resolver, the provider constants, quota
// evaluation and the logger.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const at = (offsetMs) => new Date(NOW + offsetMs);

const SESSION = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const MODEL = 'anthropic/claude-sonnet-4';

// ---------------------------------------------------------------- M1 rig ---
// Direct repo access, matching affinity.test.js's own restart-free setPin
// checks, for the one mutation (atomic replacement) that needs nothing more
// than the repo itself.
describe('affinity.state.exit: setPin replaces the one row atomically (mutation: skip atomic replacement)', () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;

  afterEach(() => {
    try {
      global._dbAdapter?.instance?.close?.();
    } catch {}
    delete global._dbAdapter;
    vi.resetModules();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('a second setPin for the same (session, model) replaces the row in place rather than erroring or duplicating it', async () => {
    delete global._dbAdapter;
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-affinity-exit-m1-'));
    process.env.DATA_DIR = tempDir;
    const { getAdapter } = await import('@/lib/db/driver.js');
    const adapter = await getAdapter();
    const affinity = await import('@/lib/db/repos/sessionAffinityRepo.js');

    await affinity.setPin(SESSION, MODEL, 'conn-one', { now: at(0) });
    // Must not throw. A plain INSERT with no upsert clause raises a PRIMARY
    // KEY constraint violation on this exact call.
    await expect(
      affinity.setPin(SESSION, MODEL, 'conn-two', { now: at(HOUR) })
    ).resolves.not.toThrow();

    const rowsForTuple = adapter.all(
      `SELECT connectionId FROM sessionAffinity WHERE sessionHash = ? AND model = ?`,
      [SESSION, MODEL]
    );
    expect(rowsForTuple).toHaveLength(1);
    expect(rowsForTuple[0].connectionId).toBe('conn-two');
  });
});

// -------------------------------------------------------- M3 (hop) rig -----
// The real scheduler seam: accountScheduler.selectAndReserve driven by
// schedulerRepos' real synchronous SQLite facade, no auth.js involved. Fifteen
// distinct identities, a second turn that flips which account raw ranking
// alone would prefer, and a restart, matching the live_gate's own wording.
describe('affinity.state.exit: fifteen identities remain stable across a second turn and a restart (mutation: hop assigned endpoint)', () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;

  const IDENTITIES = Array.from(
    { length: 15 },
    (_, i) => `sha256:${String(i).padStart(4, 'f')}${'0'.repeat(60)}`
  );

  // A usable general window, reset offset the only thing that varies: it is
  // the ranker's ordering key, per quotaRanking.js — soonest reset wins.
  const usableWindow = (resetOffsetMs) => [
    {
      scope: 'session (5h)',
      remaining: 100,
      limit: 100,
      resetAt: new Date(NOW + resetOffsetMs).toISOString(),
      confidence: 'fresh',
    },
  ];

  async function openRepos(nowMs) {
    delete global._dbAdapter;
    vi.resetModules();
    process.env.DATA_DIR = tempDir;
    const { getAdapter } = await import('@/lib/db/driver.js');
    const adapter = await getAdapter();
    const { createSchedulerRepos } = await import('@/sse/services/schedulerRepos.js');
    const { createLeaseRegistry } = await import('@/shared/utils/accountLease.js');
    const repos = await createSchedulerRepos({ now: nowMs });
    const registry = createLeaseRegistry({ capacityOf: () => 0 }); // ungated
    return { adapter, repos, registry };
  }

  afterEach(() => {
    try {
      global._dbAdapter?.instance?.close?.();
    } catch {}
    delete global._dbAdapter;
    vi.resetModules();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('keeps every one of fifteen sessions on its first-pinned account across a ranking flip and a restart', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-affinity-exit-m3-'));

    const { selectAndReserve } = await import('@/sse/services/accountScheduler.js');

    // Equal deadlines let live load spread new agents across all three accounts.
    // Later deadline changes must not move any established pin.
    const firstPin = new Map();
    const turn1 = await openRepos(NOW);
    const accountsTurn1 = [
      { id: 'acct-a', windows: usableWindow(HOUR) },
      { id: 'acct-b', windows: usableWindow(HOUR) },
      { id: 'acct-c', windows: usableWindow(HOUR) },
    ];
    for (const sessionHash of IDENTITIES) {
      const result = selectAndReserve({
        sessionHash,
        model: MODEL,
        accounts: accountsTurn1,
        now: NOW,
        registry: turn1.registry,
        repos: turn1.repos,
      });
      expect(result.unavailable).toBeUndefined();
      expect(result.reason).toBe('first-pin');
      firstPin.set(sessionHash, result.connection.id);
      turn1.registry.release(result.lease);
    }
    const perAccount = new Map();
    for (const id of firstPin.values()) perAccount.set(id, (perAccount.get(id) ?? 0) + 1);
    expect([...perAccount.entries()].sort()).toEqual([
      ['acct-a', 5],
      ['acct-b', 5],
      ['acct-c', 5],
    ]);

    // Turn 2, two hours later: acct-b now resets soonest — ranking ALONE
    // would move every session there. Every identity is still pinned where
    // turn 1 put it, every account is still fully usable, so the only thing
    // that can hold them there is the pin itself.
    const turn2Now = NOW + 2 * HOUR;
    const turn2 = await openRepos(turn2Now);
    const accountsTurn2 = [
      { id: 'acct-a', windows: usableWindow(5 * HOUR) },
      { id: 'acct-b', windows: usableWindow(HOUR) },
      { id: 'acct-c', windows: usableWindow(9 * HOUR) },
    ];
    for (const sessionHash of IDENTITIES) {
      const result = selectAndReserve({
        sessionHash,
        model: MODEL,
        accounts: accountsTurn2,
        now: turn2Now,
        registry: turn2.registry,
        repos: turn2.repos,
      });
      expect(result.connection.id).toBe(firstPin.get(sessionHash));
      expect(result.reason).toBe('pinned');
      turn2.registry.release(result.lease);
    }

    // Restart: close the handle, drop the memoized adapter, reset the module
    // registry, reopen the SAME file — matching affinity.test.js's own rig.
    // Nothing but the file crosses this boundary. Read back through the repo
    // directly, which is the durability half of the claim distinct from
    // turn 2's ranking-flip half above.
    try {
      turn2.adapter.close?.();
    } catch {}
    delete global._dbAdapter;
    vi.resetModules();
    process.env.DATA_DIR = tempDir;
    const { getAdapter } = await import('@/lib/db/driver.js');
    await getAdapter();
    const affinity = await import('@/lib/db/repos/sessionAffinityRepo.js');

    for (const sessionHash of IDENTITIES) {
      const pin = await affinity.getPin(sessionHash, MODEL, { now: at(3 * HOUR) });
      expect(pin?.connectionId).toBe(firstPin.get(sessionHash));
    }
  });
});

// ------------------------------------------------ M2 (store unhashed) rig --
// The one mutation that needs the full production seam: a client-supplied
// session identity only ever becomes a durable key by way of
// resolveRoutingSessionHash inside auth.js's getProviderCredentials, which is
// module-private (not exported) and therefore not reachable except through
// that real entry point. Recipe copied from scheduler-wiring.test.js, scoped
// to the one connection and one call this assertion needs.
const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(async () => ({})),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn(async () => ({})),
  updateProviderStrategyProxyPoolSnapshotIfBound: vi.fn(async () => ({})),
  validateApiKey: vi.fn(async () => null),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
}));
const quotaMocks = vi.hoisted(() => ({
  evaluateQuota: vi.fn(async () => ({ paused: false, reason: 'disabled', snapshot: null })),
}));
const proxyMocks = vi.hoisted(() => ({
  pickProxyPoolId: vi.fn(() => null),
  resolveConnectionProxyConfig: vi.fn(async () => ({ kind: 'usable' })),
  toConnectionProxyOptions: vi.fn(() => ({ connectionProxyEnabled: false })),
}));

vi.mock('@/lib/localDb', () => dbMocks);
vi.mock('@/lib/network/connectionProxy', () => proxyMocks);
vi.mock('@/shared/constants/providers.js', async (importOriginal) => ({
  ...(await importOriginal()),
  FREE_PROVIDERS: {},
  FREE_TIER_PROVIDERS: {},
  NO_AUTH_PROVIDER_IDS: [],
  resolveProviderId: (provider) => provider,
  isNoAuthProvider: () => false,
  isProviderDisabled: () => false,
}));
vi.mock('@/sse/services/quotaGuard.js', () => quotaMocks);
vi.mock('@/sse/utils/logger.js', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

describe('affinity.state.exit: the affinity key a real request writes is a digest (mutation: store unhashed identity)', () => {
  const PROVIDER = 'anthropic';
  const MODEL_M2 = 'claude-sonnet-4';
  const FAKE_KEY = 'sk-fake-testonly-exitm2-0000000000000000';
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let auth;
  let leases;
  let adapter;

  function connection(id, { key, extra = {} } = {}) {
    return {
      id,
      name: `account-${id}`,
      provider: PROVIDER,
      authType: 'api_key',
      apiKey: key,
      isActive: true,
      testStatus: 'active',
      lastQuotaSnapshot: null,
      providerSpecificData: {},
      ...extra,
    };
  }

  async function loadAuth() {
    delete global._dbAdapter;
    vi.resetModules();
    process.env.DATA_DIR = tempDir;
    const { getAdapter } = await import('@/lib/db/driver.js');
    adapter = await getAdapter();
    auth = await import('@/sse/services/auth.js');
    leases = await import('@/sse/services/accountLeaseRegistry.js');
    return auth;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    dbMocks.getSettings.mockResolvedValue({});
    dbMocks.getProxyPools.mockResolvedValue([]);
    quotaMocks.evaluateQuota.mockResolvedValue({ paused: false, reason: 'disabled', snapshot: null });
    proxyMocks.resolveConnectionProxyConfig.mockResolvedValue({ kind: 'usable' });
    proxyMocks.toConnectionProxyOptions.mockReturnValue({ connectionProxyEnabled: false });
    proxyMocks.pickProxyPoolId.mockReturnValue(null);
    vi.setSystemTime(NOW);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-affinity-exit-m2-'));
    await loadAuth();
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      global._dbAdapter?.instance?.close?.();
    } catch {}
    delete global._dbAdapter;
    vi.resetModules();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('persists a sha256 digest for the affinity key, never the raw client-supplied session identity however it is shaped', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([connection('alpha', { key: FAKE_KEY })]);
    // A deliberately hostile-looking raw identity: if this ever reached the
    // key unhashed it would be trivially greppable in the persisted row.
    const RAW_IDENTITY = "'; DROP TABLE sessionAffinity; --raw-identity-must-never-persist-0007";

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL_M2, {
      clientHeaders: { 'x-session-id': RAW_IDENTITY },
      clientBody: { messages: [{ role: 'user', content: 'hello' }] },
    });
    leases.releaseAccountLease(picked.accountLease);

    const pins = adapter.all('SELECT sessionHash FROM sessionAffinity');
    expect(pins).toHaveLength(1);
    expect(pins[0].sessionHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(pins)).not.toContain(RAW_IDENTITY);
  });
});
