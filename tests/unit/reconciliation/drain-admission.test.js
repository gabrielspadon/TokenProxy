import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// drain.state.entry enforced on the traffic path — ESTABLISHED DEFECT this
// file pins shut: drain state was read only by the admin layer
// (src/lib/admin/state.js, src/lib/admin/qualification.js) and never by the
// real selection path, so a connection an operator marked draining kept
// receiving new chat/completion traffic. src/sse/services/auth.js's
// getProviderCredentials is the single place a connection is actually chosen
// for a request, so that is where these tests drive drain.state.entry (the
// same document POST /api/admin/drain/{connectionId} writes) and its lifted
// counterpart, and assert on admission outcomes rather than on drain.state.js
// in isolation.
//
// REAL MODULES, NOT MOCKS OF THEM, following scheduler-wiring.test.js's own
// boundary: @/lib/admin/state.js (the real kv-backed drain doc),
// @/sse/services/auth.js, accountScheduler, accountLeaseRegistry, quotaRanking
// and the SQLite repos all run against one real temp-file database. Only the
// connection store, the proxy resolver, the provider constants, quotaGuard and
// the logger are mocked — none of them is what drain enforcement depends on.
//
// Fake clock throughout. Nothing sleeps and no timestamp is read from the wall.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const PROVIDER = 'anthropic';
const MODEL = 'claude-sonnet-4';

const FAKE_KEY_A = 'sk-fake-testonly-drainaaaa0000aaaa0000aaaa';
const FAKE_KEY_B = 'sk-fake-testonly-drainbbbb1111bbbb1111bbbb';

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
// Hoisted so beforeEach can restore the default. A vi.mock factory's own vi.fn
// is NOT re-created by resetModules, so a mockResolvedValue set inside one test
// leaks into every test after it.
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
let state;
let leases;
let adapter;

/**
 * A synthetic connection. `maxConcurrent` is the per-account admission ceiling
 * the lease registry reads through effectiveCapacity.
 */
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

/**
 * A percentage-scale quota snapshot in deriveQuotaSnapshot's own shape
 * (scheduler-wiring.test.js's fixture, reused so ranking is exercised the
 * same way here). `resetOffsetMs` is what quotaRanking orders on: the
 * SHORTER horizon ranks first, so the account whose window resets sooner is
 * the one selection would otherwise prefer.
 */
function snapshot(remainingPercentage, { resetOffsetMs = 5 * HOUR } = {}) {
  return {
    windows: [
      {
        key: 'session (5h)',
        remainingPercentage,
        resetAt: iso(resetOffsetMs),
        unlimited: false,
      },
    ],
    fetchedAt: iso(0),
  };
}

async function loadModules() {
  delete global._dbAdapter;
  vi.resetModules();
  process.env.DATA_DIR = tempDir;
  const { getAdapter } = await import('@/lib/db/driver.js');
  adapter = await getAdapter();
  auth = await import('@/sse/services/auth.js');
  state = await import('@/lib/admin/state.js');
  leases = await import('@/sse/services/accountLeaseRegistry.js');
}

function rows(sql, params = []) {
  return adapter.all(sql, params);
}

// One request's worth of client evidence, keyed only by session id: every
// call in this file names its own session explicitly so a durable pin from
// one test step never leaks into the next one's selection.
function clientOptions(sessionId) {
  return { clientHeaders: { 'x-session-id': sessionId } };
}

// drain.state.entry: marks a connection draining through the same document
// shape POST /api/admin/drain/{connectionId} writes (src/lib/admin/state.js),
// without the admin-authz plumbing this file has no reason to exercise —
// drain-restart.test.js already covers that route's own contract.
async function markDraining(connectionId) {
  await state.writeDrainDoc(connectionId, {
    isDraining: true,
    requestedAt: iso(0),
    completedAt: null,
  });
}

// The DELETE counterpart: drain lifted, completedAt recorded.
async function liftDrain(connectionId) {
  await state.writeDrainDoc(connectionId, {
    isDraining: false,
    requestedAt: iso(0),
    completedAt: iso(HOUR),
  });
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-drain-admission-'));
  await loadModules();
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

describe('drain.state.entry excludes a draining connection from NEW selection', () => {
  it('never selects the draining connection even though it would otherwise rank first', async () => {
    // alpha's window resets soonest, so ranking prefers it over beta absent
    // drain — proven below before alpha is ever marked draining.
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, snapshot: snapshot(60, { resetOffsetMs: HOUR }) }),
      connection('beta', { key: FAKE_KEY_B, snapshot: snapshot(60, { resetOffsetMs: 5 * HOUR }) }),
    ]);
    const before = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('probe-session'));
    expect(before.connectionId).toBe('alpha');
    leases.releaseAccountLease(before.accountLease);

    await markDraining('alpha');

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('fresh-session'));
    expect(picked.connectionId).toBe('beta');
    leases.releaseAccountLease(picked.accountLease);
  });

  it('excludes it from a same-account retry too, not only a first attempt', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A }),
      connection('beta', { key: FAKE_KEY_B }),
    ]);
    await markDraining('alpha');

    // ignoreModelLockConnId bypasses the model-lock check for a same-account
    // retry; drain must still exclude alpha through that bypass rather than
    // being read only on a connection's first attempt.
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, {
      ...clientOptions('retry-session'),
      ignoreModelLockConnId: 'alpha',
    });
    expect(picked.connectionId).toBe('beta');
    leases.releaseAccountLease(picked.accountLease);
  });
});

describe('drain.state.entry does not delete the pin or kill an in-flight stream', () => {
  it('a lease and session pin already bound to the connection survive it being marked draining, and complete normally', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, maxConcurrent: 4 }),
      connection('beta', { key: FAKE_KEY_B, maxConcurrent: 4 }),
    ]);

    // Stands in for an in-flight stream: the lease is taken and held, not
    // released, exactly like a request still reading its response body.
    const inFlight = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('pinned-session'));
    expect(inFlight.connectionId).toBe('alpha');
    expect(leases._getLeaseRegistry().inFlight('alpha')).toBe(1);

    await markDraining('alpha');

    // Draining did not revoke the already-held lease.
    expect(leases._getLeaseRegistry().inFlight('alpha')).toBe(1);
    // Draining did not delete the session's durable pin.
    const pins = rows('SELECT connectionId FROM sessionAffinity');
    expect(pins).toHaveLength(1);
    expect(pins[0].connectionId).toBe('alpha');

    // The in-flight request completes normally: releasing its lease behaves
    // exactly as it would with no drain in effect at all.
    expect(leases.releaseAccountLease(inFlight.accountLease)).toBe(true);
    expect(leases._getLeaseRegistry().inFlight('alpha')).toBe(0);
  });
});

describe('drain.state.entry lifted returns the connection to selection', () => {
  it('a connection refused while draining is selected again once the drain is lifted', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([connection('alpha', { key: FAKE_KEY_A })]);

    await markDraining('alpha');
    const refused = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('during-drain'));
    expect(refused).toBeNull();

    await liftDrain('alpha');
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('after-drain'));
    expect(picked.connectionId).toBe('alpha');
    leases.releaseAccountLease(picked.accountLease);
  });
});

describe('every connection draining refuses new work rather than serving anyway', () => {
  it('returns no credentials once the sole connection is draining, though it served the identical request before', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([connection('alpha', { key: FAKE_KEY_A })]);

    const before = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('pre-drain'));
    expect(before.connectionId).toBe('alpha');
    leases.releaseAccountLease(before.accountLease);

    await markDraining('alpha');

    // NOT silently served: drain must refuse this request rather than fall
    // back to treating the connection as though nothing were draining.
    const refused = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('post-drain'));
    expect(refused).toBeNull();
    expect(leases._getLeaseRegistry().snapshot()).toEqual({});
  });

  it('refuses across every candidate when a provider with several connections is entirely draining', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A }),
      connection('beta', { key: FAKE_KEY_B }),
    ]);
    await markDraining('alpha');
    await markDraining('beta');

    const refused = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('all-draining'));
    expect(refused).toBeNull();
    expect(leases._getLeaseRegistry().snapshot()).toEqual({});
  });
});
