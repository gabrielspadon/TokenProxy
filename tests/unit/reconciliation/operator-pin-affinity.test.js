import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The OPERATOR-PIN branch of selection (src/sse/services/auth.js), which is the
// path a combo member, a request replay and an `x-connection-id` request all
// take.
//
// Two halves, deliberately separated.
//
// CHARACTERISATION pins the selection semantics that must NOT move: the
// operator's account still wins over the ranker, over a live durable pin and
// over a strict refusal, and an account at capacity is still a WAIT. These
// assertions pass against the branch as it was BEFORE affinity was added to it,
// which is what makes them a control rather than a restatement of the fix.
//
// AFFINITY is the defect. The branch reserved a lease and returned, calling
// neither setPin nor touchPin, so every request an operator pinned on purpose
// left sessionAffinity untouched. A session served entirely through this branch
// therefore had no durable pin at all, and one that already had a pin could not
// tell a reused pin from a writer that was never reached — the exact locality
// the pin exists to protect, lost for exactly the traffic that asked for it.
//
// REAL MODULES against a temp-file SQLite database, mirroring
// scheduler-wiring.test.js: accountScheduler, schedulerRepos, quotaRanking,
// switchReceipt and the repos all run. Only the connection store, the proxy
// resolver, the provider constants and the logger are faked. Nothing reaches a
// provider, so no completion is spent.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const PROVIDER = 'anthropic';
const MODEL = 'claude-sonnet-4';

// SYNTHETIC credential material, generated here, never read from the
// environment or any config file. Distinctive on purpose: the redaction
// assertion greps the persisted rows for these exact strings.
const FAKE_KEY_A = 'sk-fake-testonly-aaaa0000aaaa0000aaaa0000';
const FAKE_KEY_B = 'sk-fake-testonly-bbbb1111bbbb1111bbbb1111';
const FAKE_BEARER = 'Bearer fake-testonly-token-not-a-real-credential';
const RAW_SESSION = 'raw-operator-session-must-never-be-persisted-0001';
const PROMPT_BODY = 'operator pinned prompt body that must never reach a table';

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

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let auth;
let leases;
let adapter;

function connection(id, { key, maxConcurrent, snapshot = null, extra = {} } = {}) {
  return {
    id,
    name: `account-${id}`,
    provider: PROVIDER,
    authType: 'api_key',
    apiKey: key,
    isActive: true,
    testStatus: 'active',
    maxConcurrent,
    lastQuotaSnapshot: snapshot,
    providerSpecificData: {},
    ...extra,
  };
}

function snapshot(remainingPercentage, { resetOffsetMs = 5 * HOUR, fetchedAt = iso(0) } = {}) {
  return {
    windows: [
      {
        key: 'session (5h)',
        remainingPercentage,
        resetAt: iso(resetOffsetMs),
        unlimited: false,
      },
    ],
    fetchedAt,
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

function rows(sql, params = []) {
  return adapter.all(sql, params);
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-operator-pin-'));
  await loadAuth();
});

afterEach(() => {
  vi.useRealTimers();
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {
    /* the temp dir goes away regardless */
  }
  delete global._dbAdapter;
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// One request's worth of client evidence, in the header sessionManager already
// reads, so the identity reaching the pin is derived the way a real request
// derives it.
function clientOptions(sessionId = RAW_SESSION) {
  return {
    clientHeaders: { 'x-session-id': sessionId },
    clientBody: { messages: [{ role: 'user', content: PROMPT_BODY }] },
  };
}

// alpha resets in an hour and beta in five, and quotaRanking takes the window
// about to be wasted, so RANKING PREFERS ALPHA in every fixture below. An
// assertion that beta was selected is therefore evidence the operator's choice
// beat the ranker, not a coincidence of list order.
function rankerPrefersAlpha({ maxConcurrent } = {}) {
  return [
    connection('alpha', {
      key: FAKE_KEY_A,
      maxConcurrent,
      snapshot: snapshot(60, { resetOffsetMs: HOUR }),
    }),
    connection('beta', {
      key: FAKE_KEY_B,
      maxConcurrent,
      snapshot: snapshot(60, { resetOffsetMs: 5 * HOUR }),
    }),
  ];
}

function operatorOptions(connectionId, { sessionId = RAW_SESSION, strict = false } = {}) {
  return {
    ...clientOptions(sessionId),
    preferredConnectionId: connectionId,
    ...(strict ? { strictPreferredConnection: true } : {}),
  };
}

describe('operator-pin branch: selection semantics that must not move', () => {
  it('still overrides the ranker', async () => {
    dbMocks.getProviderConnections.mockResolvedValue(rankerPrefersAlpha());

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, operatorOptions('beta'));

    expect(picked.connectionId).toBe('beta');
    expect(picked.accountLease?.connectionId).toBe('beta');
    expect(leases._getLeaseRegistry().inFlight('beta')).toBe(1);
    leases.releaseAccountLease(picked.accountLease);
    expect(leases._getLeaseRegistry().inFlight('beta')).toBe(0);
  });

  it('still overrides a LIVE durable pin held by another account', async () => {
    // The scheduler pins this session to alpha first, so the operator branch is
    // now overriding a real row rather than an empty table. The operator named
    // beta, so beta serves the request: adding durability to that decision must
    // never turn into the pin overruling the operator.
    dbMocks.getProviderConnections.mockResolvedValue(rankerPrefersAlpha({ maxConcurrent: 4 }));

    const scheduled = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(scheduled.connectionId).toBe('alpha');
    leases.releaseAccountLease(scheduled.accountLease);
    expect(rows('SELECT connectionId FROM sessionAffinity')[0].connectionId).toBe('alpha');

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, operatorOptions('beta'));
    expect(picked.connectionId).toBe('beta');
    leases.releaseAccountLease(picked.accountLease);
  });

  it('still refuses rather than substituting when a STRICT pin is unavailable', async () => {
    // A combo member that named an account has chosen it: falling back spends
    // the wrong subscription, so the member fails and the combo advances.
    dbMocks.getProviderConnections.mockResolvedValue(rankerPrefersAlpha());

    const picked = await auth.getProviderCredentials(
      PROVIDER,
      new Set(['beta']),
      MODEL,
      operatorOptions('beta', { strict: true })
    );

    expect(picked).toBeNull();
    expect(leases._getLeaseRegistry().inFlight('alpha')).toBe(0);
  });

  it('still reports a WAIT when the pinned account is at capacity', async () => {
    dbMocks.getProviderConnections.mockResolvedValue(rankerPrefersAlpha({ maxConcurrent: 1 }));

    const held = await auth.getProviderCredentials(PROVIDER, null, MODEL, operatorOptions('beta'));
    expect(held.connectionId).toBe('beta');

    const blocked = await auth.getProviderCredentials(
      PROVIDER,
      null,
      MODEL,
      operatorOptions('beta', { sessionId: 'a-different-session' })
    );
    expect(blocked.allRateLimited).toBe(true);
    expect(blocked.retryAfter).toBeTruthy();
    expect(blocked.connectionId).toBeUndefined();
    expect(leases._getLeaseRegistry().inFlight('beta')).toBe(1);

    leases.releaseAccountLease(held.accountLease);
  });
});

describe('operator-pin branch: the selection is DURABLE (the defect)', () => {
  it('writes the pin on a first operator-pinned selection', async () => {
    dbMocks.getProviderConnections.mockResolvedValue(rankerPrefersAlpha());

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, operatorOptions('beta'));
    expect(picked.connectionId).toBe('beta');
    leases.releaseAccountLease(picked.accountLease);

    const pins = rows('SELECT sessionHash, model, connectionId, pinnedAt, lastSeenAt FROM sessionAffinity');
    expect(pins).toHaveLength(1);
    expect(pins[0].connectionId).toBe('beta');
    expect(pins[0].model).toBe(MODEL);
    expect(pins[0].pinnedAt).toBe(iso(0));
    expect(pins[0].lastSeenAt).toBe(iso(0));
  });

  it('TOUCHES the pin on a reused operator-pinned selection without moving pinnedAt', async () => {
    dbMocks.getProviderConnections.mockResolvedValue(rankerPrefersAlpha({ maxConcurrent: 4 }));

    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, operatorOptions('beta'));
    leases.releaseAccountLease(first.accountLease);

    vi.setSystemTime(NOW + HOUR);
    const second = await auth.getProviderCredentials(PROVIDER, null, MODEL, operatorOptions('beta'));
    expect(second.connectionId).toBe('beta');
    leases.releaseAccountLease(second.accountLease);

    const pins = rows('SELECT pinnedAt, lastSeenAt FROM sessionAffinity');
    expect(pins).toHaveLength(1);
    // Liveness moved, so an operator-served session is now distinguishable from
    // an abandoned one and from a writer that was never reached.
    expect(pins[0].lastSeenAt).toBe(iso(HOUR));
    // The binding's own age did NOT move: decideRepin re-ranks at pinnedAt.
    expect(pins[0].pinnedAt).toBe(iso(0));
    // A same-account re-selection is not a switch, so exactly one receipt.
    expect(rows('SELECT trigger FROM accountSwitches').map((r) => r.trigger)).toEqual(['first-pin']);
  });

  it('records a switch receipt when the operator moves the session off its pin', async () => {
    dbMocks.getProviderConnections.mockResolvedValue(rankerPrefersAlpha({ maxConcurrent: 4 }));

    const scheduled = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(scheduled.connectionId).toBe('alpha');
    leases.releaseAccountLease(scheduled.accountLease);

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, operatorOptions('beta'));
    expect(picked.connectionId).toBe('beta');
    leases.releaseAccountLease(picked.accountLease);

    // rowid, not switchedAt: the clock is frozen, so ordering by timestamp is a
    // tie the assertion would win or lose by chance.
    const receipts = rows(
      'SELECT fromConnectionId, toConnectionId, trigger, model FROM accountSwitches ORDER BY rowid'
    );
    expect(receipts).toHaveLength(2);
    expect(receipts[0].trigger).toBe('first-pin');
    expect(receipts[1].fromConnectionId).toBe('alpha');
    expect(receipts[1].toConnectionId).toBe('beta');
    expect(receipts[1].trigger).toBe('operator-pin');
    expect(receipts[1].model).toBe(MODEL);

    expect(rows('SELECT connectionId FROM sessionAffinity')[0].connectionId).toBe('beta');
  });

  it('hands the durable pin to the SCHEDULER path on the next unpinned request', async () => {
    // The whole point of writing the pin: a later request with no operator pin
    // stays where the operator put the session, so the provider-side prompt
    // cache the operator was protecting is still warm. Ranking prefers alpha,
    // so a scheduler that ignored the pin would move off beta.
    dbMocks.getProviderConnections.mockResolvedValue(rankerPrefersAlpha({ maxConcurrent: 4 }));

    const pinned = await auth.getProviderCredentials(PROVIDER, null, MODEL, operatorOptions('beta'));
    expect(pinned.connectionId).toBe('beta');
    leases.releaseAccountLease(pinned.accountLease);

    const next = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(next.connectionId).toBe('beta');
    leases.releaseAccountLease(next.accountLease);
  });

  it('persists a HASH, never the raw session id, a key or the prompt body', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', {
        key: FAKE_KEY_A,
        maxConcurrent: 4,
        snapshot: snapshot(60, { resetOffsetMs: HOUR }),
        extra: { accessToken: FAKE_BEARER },
      }),
      connection('beta', {
        key: FAKE_KEY_B,
        maxConcurrent: 4,
        snapshot: snapshot(60, { resetOffsetMs: 5 * HOUR }),
      }),
    ]);

    const scheduled = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    leases.releaseAccountLease(scheduled.accountLease);
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, operatorOptions('beta'));
    leases.releaseAccountLease(picked.accountLease);

    const pins = rows('SELECT * FROM sessionAffinity');
    const receipts = rows('SELECT * FROM accountSwitches');
    expect(pins.length).toBeGreaterThan(0);
    expect(receipts.length).toBeGreaterThan(0);

    // Every column of both tables, serialized and searched whole: asserting per
    // known column would pass a schema that later gains a leaky one.
    const persisted = JSON.stringify({ pins, receipts });
    for (const secret of [RAW_SESSION, FAKE_KEY_A, FAKE_KEY_B, FAKE_BEARER, PROMPT_BODY]) {
      expect(persisted).not.toContain(secret);
    }
    for (const row of [...pins, ...receipts]) {
      expect(row.sessionHash).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('writes NOTHING when the pinned account is at capacity', async () => {
    // The refusal path returns before any slot is proven free. Pinning a session
    // to an account that did not serve it would be a fabricated binding.
    dbMocks.getProviderConnections.mockResolvedValue(rankerPrefersAlpha({ maxConcurrent: 1 }));

    const held = await auth.getProviderCredentials(PROVIDER, null, MODEL, operatorOptions('beta'));
    expect(held.connectionId).toBe('beta');

    const blocked = await auth.getProviderCredentials(
      PROVIDER,
      null,
      MODEL,
      operatorOptions('beta', { sessionId: 'a-session-that-never-got-a-slot' })
    );
    expect(blocked.allRateLimited).toBe(true);

    // One row, for the session that actually got the slot.
    expect(rows('SELECT sessionHash FROM sessionAffinity')).toHaveLength(1);

    leases.releaseAccountLease(held.accountLease);
  });
});
