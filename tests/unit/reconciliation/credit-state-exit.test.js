import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// boundary-contract.json: credit.state.exit — owner
// writeCreditSnapshotAtomic, live_gate "refresh writes only account hash
// balance and observation time". TokenProxy has no dollar-balance ledger and
// no independently-hashed account identifier; its closest real equivalent is
// the periodic per-account entitlement refresh in
// src/sse/services/quotaGuard.js: evaluateQuota fetches usage, derives a
// safe snapshot through deriveQuotaSnapshot (src/shared/utils/quotaPause.js),
// and storeSnapshot persists it through the SAME single, narrow write —
// `updateProviderConnection(connectionId, { lastQuotaSnapshot: snapshot })`
// — every time. That write is this boundary's writeCreditSnapshotAtomic: one
// call, one field, scoped to the connection that was actually refreshed. The
// mapping is stated honestly rather than pretended exact:
//   - "account hash" -> connectionId (the scoping key here is a plain id,
//     never independently hashed the way sessionHash is elsewhere in this
//     repo — an honest gap, not papered over).
//   - "balance" -> the per-window remainingPercentage TokenProxy actually
//     tracks (a percentage-scale headroom, not a currency balance).
//   - "observation time" -> fetchedAt, exactly.
//
// Mutations this file must fail under if reintroduced:
//   - "write nonfinite balance": a reading that cannot produce a finite
//     percentage is written anyway (quotaPause.js's quotaRemainingPercentage
//     finite guard).
//   - "expose upstream payload": a raw provider field survives into the
//     window or the write patch, outside {key, remainingPercentage, resetAt,
//     unlimited} and {lastQuotaSnapshot} respectively (deriveQuotaSnapshot's
//     window projection).
//   - "refresh with changed account": the write for one connection's refresh
//     lands under a different connection's id (quotaGuard.js's
//     storeSnapshot call site).
//
// REAL quotaGuard.js and REAL quotaPause.js. Only the true I/O boundaries are
// mocked: the provider usage fetch, the proxy resolver, the persistence call
// and the antigravity probe (unused here, mocked defensively so its own
// heavier import graph never loads).
const usageMocks = vi.hoisted(() => ({ getUsageForProvider: vi.fn() }));
const dbMocks = vi.hoisted(() => ({ updateProviderConnection: vi.fn(async () => ({})) }));
const proxyMocks = vi.hoisted(() => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({ kind: 'usable' })),
  toConnectionProxyOptions: vi.fn(() => ({ connectionProxyEnabled: false })),
}));
const antigravityMocks = vi.hoisted(() => ({ runAntigravityUsageProbe: vi.fn() }));

vi.mock('open-sse/services/usage.js', () => usageMocks);
vi.mock('@/lib/localDb', () => dbMocks);
vi.mock('@/lib/network/connectionProxy', () => proxyMocks);
vi.mock('@/lib/antigravityVerification', () => antigravityMocks);

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function oauthConnection(id) {
  return {
    id,
    provider: 'anthropic',
    authType: 'oauth',
    quotaPauseThresholds: { 'session (5h)': 15 },
    providerSpecificData: {},
    lastQuotaSnapshot: null,
  };
}

function writesFor(id) {
  return dbMocks.updateProviderConnection.mock.calls.find(([connectionId]) => connectionId === id);
}

describe('credit.state.exit: a refresh writes only the safe derived snapshot for the account it refreshed', () => {
  let evaluateQuota;
  let _clearQuotaCache;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    proxyMocks.resolveConnectionProxyConfig.mockResolvedValue({ kind: 'usable' });
    proxyMocks.toConnectionProxyOptions.mockReturnValue({ connectionProxyEnabled: false });
    dbMocks.updateProviderConnection.mockResolvedValue({});
    vi.setSystemTime(NOW);
    const quotaGuard = await import('@/sse/services/quotaGuard.js');
    evaluateQuota = quotaGuard.evaluateQuota;
    _clearQuotaCache = quotaGuard._clearQuotaCache;
    _clearQuotaCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a reading that cannot produce a finite percentage rather than writing it (mutation: write nonfinite balance)', async () => {
    usageMocks.getUsageForProvider.mockResolvedValueOnce({
      quotas: {
        'session (5h)': { remainingPercentage: NaN, resetAt: iso(5 * HOUR) },
        'weekly (7d)': { used: 10, total: 100, resetAt: iso(30 * HOUR) },
      },
    });

    const result = await evaluateQuota(oauthConnection('conn-nonfinite'));
    expect(result.snapshot).not.toBeNull();
    // The NaN reading is dropped outright; only the finite one survives.
    expect(result.snapshot.windows).toHaveLength(1);
    expect(result.snapshot.windows[0].key).toBe('weekly (7d)');
    expect(Number.isFinite(result.snapshot.windows[0].remainingPercentage)).toBe(true);

    const written = writesFor('conn-nonfinite');
    expect(written).toBeTruthy();
    for (const w of written[1].lastQuotaSnapshot.windows) {
      expect(Number.isFinite(w.remainingPercentage)).toBe(true);
    }
  });

  it('writes only {key, remainingPercentage, resetAt, unlimited} per window and only {lastQuotaSnapshot} as the patch, nothing from the raw upstream payload (mutation: expose upstream payload)', async () => {
    usageMocks.getUsageForProvider.mockResolvedValueOnce({
      quotas: {
        'session (5h)': {
          used: 10,
          total: 100,
          resetAt: iso(5 * HOUR),
          internalAccountId: 'acct-should-never-leave-9001',
          planTier: 'enterprise-secret-should-never-leave',
        },
      },
    });

    const result = await evaluateQuota(oauthConnection('conn-expose'));
    expect(result.snapshot).not.toBeNull();
    for (const w of result.snapshot.windows) {
      expect(Object.keys(w).sort()).toEqual(['key', 'remainingPercentage', 'resetAt', 'unlimited']);
    }

    const written = writesFor('conn-expose');
    expect(written).toBeTruthy();
    expect(Object.keys(written[1]).sort()).toEqual(['lastQuotaSnapshot']);
    // The derived snapshot plus the binding that makes it usable, and nothing
    // else. evidenceIdentity is quotaEvidenceIdentity's opaque sha256 over
    // {id, credentialRevision, quotaPauseThresholds, proxyOptions}, written by
    // storeSnapshot so quotaGuard can REJECT this row later when the
    // credential or the route has moved under it. A persisted snapshot without
    // it never reads back (quotaGuard.js readSnapshot/staleSnapshot both
    // require the identity to match), so this field is the write's contract,
    // not a passenger on it. That it is a bare digest is asserted rather than
    // assumed: the mutation this test guards is upstream data surviving the
    // write, and a digest can carry none.
    expect(Object.keys(written[1].lastQuotaSnapshot).sort())
      .toEqual(['evidenceIdentity', 'fetchedAt', 'windows']);
    expect(written[1].lastQuotaSnapshot.evidenceIdentity).toMatch(/^[0-9a-f]{64}$/);

    const serialized = JSON.stringify(written[1]);
    expect(serialized).not.toContain('acct-should-never-leave-9001');
    expect(serialized).not.toContain('enterprise-secret-should-never-leave');
  });

  it('never lets one connection refresh write under a different connection id (mutation: refresh with changed account)', async () => {
    const usageFor = {
      'conn-a': { quotas: { 'session (5h)': { used: 20, total: 100, resetAt: iso(5 * HOUR) } } },
      'conn-b': { quotas: { 'session (5h)': { used: 80, total: 100, resetAt: iso(5 * HOUR) } } },
    };
    usageMocks.getUsageForProvider.mockImplementation(async (connection) => usageFor[connection.id]);

    await evaluateQuota(oauthConnection('conn-a'));
    await evaluateQuota(oauthConnection('conn-b'));

    const writeA = writesFor('conn-a');
    const writeB = writesFor('conn-b');
    expect(writeA).toBeTruthy();
    expect(writeB).toBeTruthy();
    // used=20/total=100 -> 80% remaining; used=80/total=100 -> 20% remaining.
    // A cross-wired write would swap these or collapse both onto one id.
    expect(writeA[1].lastQuotaSnapshot.windows[0].remainingPercentage).toBe(80);
    expect(writeB[1].lastQuotaSnapshot.windows[0].remainingPercentage).toBe(20);
  });
});
