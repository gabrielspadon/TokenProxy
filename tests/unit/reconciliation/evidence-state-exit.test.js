import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIDENCE, toRankerWindow, toRankerWindows } from '@/shared/utils/quotaWindowBridge.js';

// boundary-contract.json: evidence.state.exit — owner writeEvidenceAtomic,
// live_gate "qualified evidence includes sustained throughput cache tools
// and context". TokenProxy has no per-endpoint benchmark record with those
// four named fields; its evidence is quota-window entitlement. The
// underlying invariant — a WRITE never promotes a failed or unmeasured
// reading into evidence indistinguishable from a real one — has a direct,
// current equivalent, reinterpreted explicitly below:
//   - "promote failed benchmark" -> a window with no parseable reset
//     evidence (an unusable/failed reading) converts to null and is dropped,
//     never promoted into the array that would be persisted.
//   - "invent throughput" -> a percentage-only reading (no measurable
//     provider total) is tagged 'unknown', never 'fresh' — the missing
//     total is never fabricated as if it had been measured.
//   - "replace last good on refresh failure" -> a refresh that returns no
//     usable windows must not wipe the good evidence already on disk. This
//     one is NOT reachable through quotaWindowBridge.js alone: the guard
//     lives in src/sse/services/auth.js's module-private persistWindows,
//     the only caller of quotaWindowsRepo.putWindows (the atomic
//     replace-all this boundary's symbol name refers to), reached only
//     through the real getProviderCredentials entry point. Recipe copied
//     from scheduler-wiring.test.js's own W3 test, which this file extends
//     with a second, failed refresh.
//
// The first two are pure functions (quotaWindowBridge.js declares itself
// pure: no DB imports, no clock reads) exercised directly, no mocks. The
// third drives auth.js for real against a temp-file SQLite database, only
// the connection store, proxy resolver, provider constants, quota
// evaluation and logger faked.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

describe('evidence.state.exit: a write never fabricates or promotes unqualified evidence', () => {
  it('never promotes a reading with no parseable reset evidence into the written set (mutation: promote failed benchmark)', () => {
    const noResetAt = toRankerWindow(
      { key: 'session (5h)', resetAt: null, unlimited: false },
      { total: 300, remaining: 100 },
      { observedAt: iso(0), now: NOW }
    );
    expect(noResetAt).toBeNull();

    // Same claim at the batch level: a snapshot containing one unusable
    // reading among usable ones drops only the unusable one, and it never
    // silently becomes a fabricated success.
    const batch = toRankerWindows(
      {
        windows: [
          { key: 'session (5h)', resetAt: iso(5 * HOUR), unlimited: false, remainingPercentage: 40 },
          { key: 'weekly (7d)', resetAt: null, unlimited: false, remainingPercentage: 90 },
        ],
        fetchedAt: iso(0),
      },
      null,
      { now: NOW }
    );
    expect(batch).toHaveLength(1);
    expect(batch[0].scope).toBe('session (5h)');
  });

  it('tags an unmeasured percentage-only reading unknown, never fabricating a measured total (mutation: invent throughput)', () => {
    const percentageOnly = toRankerWindow(
      { key: 'session (5h)', resetAt: iso(5 * HOUR), unlimited: false, remainingPercentage: 42 },
      null, // no rawQuota: the provider gave no measurable total
      { observedAt: iso(0), now: NOW }
    );
    expect(percentageOnly).not.toBeNull();
    // The synthetic scale, explicitly marked as such — never silently
    // presented as a real measurement.
    expect(percentageOnly.confidence).toBe(CONFIDENCE.UNKNOWN);
    expect(percentageOnly.confidence).not.toBe(CONFIDENCE.FRESH);
    expect(percentageOnly.limit).toBe(100);
    expect(percentageOnly.remaining).toBe(42);
  });
});

// --------------------------------------------------- M3 (refresh failure) --
const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(async () => ({})),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn(async () => ({})),
  updateProviderStrategyProxyPoolSnapshotIfBound: vi.fn(async () => ({})),
  validateApiKey: vi.fn(async () => null),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
}));
const quotaMocks = vi.hoisted(() => ({ evaluateQuota: vi.fn() }));
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

describe('evidence.state.exit: a refresh that finds no evidence leaves the last good evidence on disk (mutation: replace last good on refresh failure)', () => {
  const PROVIDER = 'anthropic';
  const MODEL = 'claude-sonnet-4';
  const FAKE_KEY = 'sk-fake-testonly-evidenceexit-000000000000';
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let auth;
  let leases;
  let adapter;

  function connection(id) {
    return {
      id,
      name: `account-${id}`,
      provider: PROVIDER,
      authType: 'api_key',
      apiKey: FAKE_KEY,
      isActive: true,
      testStatus: 'active',
      lastQuotaSnapshot: null,
      providerSpecificData: {},
    };
  }

  function clientOptions() {
    return {
      clientHeaders: { 'x-session-id': 'evidence-exit-m3-session' },
      clientBody: { messages: [{ role: 'user', content: 'hello' }] },
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
    proxyMocks.resolveConnectionProxyConfig.mockResolvedValue({ kind: 'usable' });
    proxyMocks.toConnectionProxyOptions.mockReturnValue({ connectionProxyEnabled: false });
    proxyMocks.pickProxyPoolId.mockReturnValue(null);
    vi.setSystemTime(NOW);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-evidence-exit-m3-'));
    await loadAuth();
    dbMocks.getProviderConnections.mockResolvedValue([connection('alpha')]);
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

  it('keeps the previously-written window row when the next refresh comes back with no evidence at all', async () => {
    // Good refresh: real evidence lands in the real quotaWindows table.
    quotaMocks.evaluateQuota.mockResolvedValueOnce({
      paused: false,
      reason: 'ok',
      snapshot: {
        windows: [{ key: 'session (5h)', remainingPercentage: 55, resetAt: iso(5 * HOUR), unlimited: false }],
        fetchedAt: iso(0),
      },
    });
    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    leases.releaseAccountLease(first.accountLease);
    await new Promise((resolve) => setImmediate(resolve));

    const afterGood = adapter.all(
      `SELECT connectionId, remaining, confidence FROM quotaWindows WHERE connectionId = ?`,
      ['alpha']
    );
    expect(afterGood).toHaveLength(1);
    expect(afterGood[0].remaining).toBe(55);

    // Failed refresh: evaluateQuota finds nothing (fetch error, ineligible,
    // required proxy unavailable — any of quotaGuard's own fail-open exits
    // resolve to snapshot: null the same way).
    quotaMocks.evaluateQuota.mockResolvedValueOnce({ paused: false, reason: 'no-data', snapshot: null });
    const second = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    leases.releaseAccountLease(second.accountLease);
    await new Promise((resolve) => setImmediate(resolve));

    // The row from the good refresh is exactly as it was — never wiped by
    // the empty one.
    const afterFailed = adapter.all(
      `SELECT connectionId, remaining, confidence FROM quotaWindows WHERE connectionId = ?`,
      ['alpha']
    );
    expect(afterFailed).toHaveLength(1);
    expect(afterFailed[0].remaining).toBe(55);
  });
});
