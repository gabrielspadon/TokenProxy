import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// E1.1w — the account control plane is WIRED INTO THE REQUEST PATH.
//
// The E1.1 modules already had unit evidence and no runtime evidence: nothing
// in src/sse/ imported rankAccounts, selectAndReserve, createLeaseRegistry or
// sessionAffinityRepo, and getProviderCredentials still picked by round-robin.
// These tests drive getProviderCredentials itself, so what they constrain is
// the seam rather than the modules behind it.
//
// REAL MODULES, NOT MOCKS OF THEM. quotaRanking, accountScheduler,
// accountLease, quotaWindowBridge, schedulerRepos, switchReceipt and the SQLite
// repos all run for real against a temp-file database. Only the boundaries the
// scheduler is not under test for are faked: the connection store, the proxy
// resolver, the provider constants and the logger. Mocking the scheduler here
// would assert that a mock was called, which is the exact gap this file exists
// to close.
//
// Fake clock throughout. Nothing sleeps and no timestamp is read from the wall.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const PROVIDER = 'anthropic';
const MODEL = 'claude-sonnet-4';

// SYNTHETIC credential material — obviously fake, generated here, never read
// from the environment or any config file. The point of the redaction test is
// that these strings do NOT reach the affinity or receipt tables, so they are
// deliberately distinctive enough to grep for.
const FAKE_KEY_A = 'sk-fake-testonly-aaaa0000aaaa0000aaaa0000';
const FAKE_KEY_B = 'sk-fake-testonly-bbbb1111bbbb1111bbbb1111';
const FAKE_BEARER = 'Bearer fake-testonly-token-not-a-real-credential';
const RAW_SESSION = 'raw-session-id-must-never-be-persisted-0001';
const PROMPT_BODY = 'the quick brown fox jumps over the lazy dog and must not be persisted';

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
  // "usable" with no proxy: the proxy layer is not what these tests constrain,
  // but it must not return early, because that path releases the lease.
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

/**
 * A synthetic connection. `maxConcurrent` is the per-account admission ceiling
 * the lease registry reads through effectiveCapacity.
 */
// Every fixture account holds a key: live selection now skips a stored account
// with nothing to present, and these tests describe accounts that can answer.
function connection(id, { key = `synthetic-${id}`, maxConcurrent, snapshot = null, extra = {} } = {}) {
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
 * A percentage-scale quota snapshot in deriveQuotaSnapshot's own shape, which
 * is what the bridge converts. `remainingPercentage` is what makes one account
 * outrank another.
 */
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-wiring-'));
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

// One request's worth of client evidence. The session id is carried in a
// header sessionManager already reads, so the identity that reaches the pin is
// derived the way a real request derives it.
function clientOptions(sessionId = RAW_SESSION) {
  return {
    clientHeaders: { 'x-session-id': sessionId },
    clientBody: { messages: [{ role: 'user', content: PROMPT_BODY }] },
  };
}

describe('E1.1w: getProviderCredentials selects through the scheduler', () => {
  it('picks the account the RANKER prefers, not the one round-robin would', async () => {
    // quotaRanking's ordering key 2 is the resetAt array, longest horizon
    // first: burn the entitlement about to be wasted. `beta` resets in an hour
    // and `alpha` in five, so beta wins DESPITE having less headroom, which is
    // the point. A naive most-remaining pick would take alpha, and so would
    // round-robin, alpha being first in the list.
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, snapshot: snapshot(80, { resetOffsetMs: 5 * HOUR }) }),
      connection('beta', { key: FAKE_KEY_B, snapshot: snapshot(20, { resetOffsetMs: HOUR }) }),
    ]);

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());

    expect(picked?.connectionId).toBe('beta');
    // The lease is what proves a slot was reserved rather than merely counted.
    expect(picked.accountLease).toBeTruthy();
    expect(picked.accountLease.connectionId).toBe('beta');
    expect(leases._getLeaseRegistry().inFlight('beta')).toBe(1);
    leases.releaseAccountLease(picked.accountLease);
  });

  it('keeps a second request on the SAME account while that account stays eligible', async () => {
    // alpha's entitlement expires first, so the ranker takes alpha.
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, snapshot: snapshot(60, { resetOffsetMs: HOUR }) }),
      connection('beta', { key: FAKE_KEY_B, snapshot: snapshot(60, { resetOffsetMs: 5 * HOUR }) }),
    ]);

    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(first.connectionId).toBe('alpha');
    expect(first.sessionIdentitySource).toBe('explicit');
    leases.releaseAccountLease(first.accountLease);

    // The pin is on disk now. INVERT the ranking key itself, not the headroom:
    // beta's window now expires first, so ranking alone would move the session
    // to beta. alpha keeps ample headroom, so it stays eligible and the pin is
    // the only thing that can hold the session there. Flipping
    // `remainingPercentage` instead would not have tested anything, since
    // quotaRanking orders on the resetAt array and never on remaining.
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, snapshot: snapshot(60, { resetOffsetMs: 5 * HOUR }) }),
      connection('beta', { key: FAKE_KEY_B, snapshot: snapshot(60, { resetOffsetMs: HOUR }) }),
    ]);

    const second = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(second.connectionId).toBe('alpha');
    leases.releaseAccountLease(second.accountLease);

    const pins = rows('SELECT sessionHash, model, connectionId FROM sessionAffinity');
    expect(pins).toHaveLength(1);
    expect(pins[0].connectionId).toBe('alpha');
    expect(pins[0].model).toBe(MODEL);

    // One receipt, for the first pin. A sticky re-selection is not a switch, so
    // a second receipt here would mean the session repinned onto itself.
    expect(rows('SELECT trigger FROM accountSwitches').map((r) => r.trigger)).toEqual(['first-pin']);
  });

  it('advances lastSeenAt on a sticky re-selection without moving pinnedAt', async () => {
    // The reuse branch is the ONLY branch a settled session ever takes, and it
    // wrote NOTHING. selectAndReserve calls setPin on a first pin and on a
    // repin, and no production caller ever reached sessionAffinityRepo.touchPin,
    // so one session produced exactly one row-write for its entire life. That is
    // why a gateway can serve forty requests off a live pin and leave
    // sessionAffinity untouched, and why lastSeenAt could not tell "the pin was
    // reused" apart from "the writer was never reached".
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, maxConcurrent: 4, snapshot: snapshot(90) }),
    ]);

    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(first.connectionId).toBe('alpha');
    leases.releaseAccountLease(first.accountLease);
    const atPin = rows('SELECT pinnedAt, lastSeenAt FROM sessionAffinity')[0];
    expect(atPin.pinnedAt).toBe(iso(0));
    expect(atPin.lastSeenAt).toBe(iso(0));

    vi.setSystemTime(NOW + HOUR);
    const second = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(second.connectionId).toBe('alpha');
    leases.releaseAccountLease(second.accountLease);

    const after = rows('SELECT pinnedAt, lastSeenAt FROM sessionAffinity');
    expect(after).toHaveLength(1);
    // Liveness moved: the row now says the session was seen an hour later.
    expect(after[0].lastSeenAt).toBe(iso(HOUR));
    // The binding's own age did NOT move. decideRepin re-ranks at pinnedAt, so
    // restamping it on every reuse would make a settled pin look permanently
    // new and defeat rule 5.
    expect(after[0].pinnedAt).toBe(iso(0));
    // A same-account re-selection is still not a switch.
    expect(rows('SELECT trigger FROM accountSwitches').map((r) => r.trigger)).toEqual(['first-pin']);
  });

  it('repins and writes a switch receipt when the pinned account is gone', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, snapshot: snapshot(90) }),
      connection('beta', { key: FAKE_KEY_B, snapshot: snapshot(10) }),
    ]);
    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(first.connectionId).toBe('alpha');
    leases.releaseAccountLease(first.accountLease);

    // alpha depletes and is excluded from this request's candidate set, the
    // same way the chat loop excludes an account after a failure.
    const second = await auth.getProviderCredentials(
      PROVIDER,
      new Set(['alpha']),
      MODEL,
      clientOptions()
    );
    expect(second.connectionId).toBe('beta');
    leases.releaseAccountLease(second.accountLease);

    // rowid, not switchedAt: the clock is frozen, so both receipts share a
    // timestamp and ordering by it is a tie the assertion would win or lose by
    // chance. rowid is insertion order, which is what "first pin then repin"
    // actually means.
    const receipts = rows(
      'SELECT sessionHash, model, fromConnectionId, toConnectionId, trigger FROM accountSwitches ORDER BY rowid'
    );
    // Two receipts: the first pin (from NULL) and the repin.
    expect(receipts).toHaveLength(2);
    expect(receipts[0].fromConnectionId).toBeNull();
    expect(receipts[0].toConnectionId).toBe('alpha');
    expect(receipts[0].trigger).toBe('first-pin');

    const repin = receipts[1];
    expect(repin.fromConnectionId).toBe('alpha');
    expect(repin.toConnectionId).toBe('beta');
    // The vocabulary schema.js documents for this column, rather than the old
    // 'repin', which said that the pin moved but never why. The pinned account
    // left the candidate set entirely here, so 'unavailable' is the fact.
    expect(repin.trigger).toBe('unavailable');
    expect(repin.model).toBe(MODEL);
    expect(repin.sessionHash).toBeTruthy();

    // The pin followed the switch rather than being left stale.
    const pins = rows('SELECT connectionId FROM sessionAffinity');
    expect(pins).toHaveLength(1);
    expect(pins[0].connectionId).toBe('beta');
  });

  it('persists derived quota windows so the ranker reads a live table (W3)', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, snapshot: snapshot(42) }),
    ]);

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    leases.releaseAccountLease(picked.accountLease);
    // putWindows is best-effort and not awaited by the request path, so let its
    // microtask chain settle before reading the table.
    await new Promise((resolve) => setImmediate(resolve));

    const windows = rows(
      'SELECT connectionId, scope, remaining, "limit", confidence FROM quotaWindows'
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].connectionId).toBe('alpha');
    // Percentage-only evidence lands on the synthetic scale and SAYS SO. A
    // fabricated limit stamped 'fresh' would be the failure this asserts against.
    expect(windows[0].remaining).toBe(42);
    expect(windows[0].limit).toBe(100);
    expect(windows[0].confidence).toBe('unknown');
  });

  // W3, the other half. The gate asked whether evidence is WRITTEN; absence of
  // evidence is evidence too, and it was the half that never reached the table.
  // putWindows is delete-then-insert precisely so a window the provider has
  // stopped reporting disappears, but persistWindows used to return early on an
  // empty array, so the delete never ran and the ranker went on comparing a
  // shape the account no longer has.
  it('CLEARS a stale window once a live read reports nothing rankable (W3)', async () => {
    const repos = await import('@/lib/db/repos/quotaWindowsRepo.js');
    await repos.putWindows('alpha', [
      {
        scope: 'session (5h)',
        remaining: 90,
        limit: 100,
        resetAt: iso(HOUR),
        observedAt: iso(0),
        confidence: 'fresh',
      },
    ]);
    expect(rows('SELECT scope FROM quotaWindows')).toHaveLength(1);

    // A read that SUCCEEDED and found one unlimited window. The bridge drops an
    // unlimited window (it constrains nothing), so this is real evidence that
    // yields zero rankable windows -- not a failed fetch.
    quotaMocks.evaluateQuota.mockResolvedValue({
      paused: false,
      reason: 'ok',
      snapshot: {
        windows: [{ key: 'session (5h)', remainingPercentage: 90, resetAt: iso(HOUR), unlimited: true }],
        fetchedAt: iso(0),
      },
      rawUsage: null,
    });
    dbMocks.getProviderConnections.mockResolvedValue([connection('alpha', { key: FAKE_KEY_A })]);

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    leases.releaseAccountLease(picked.accountLease);
    await new Promise((resolve) => setImmediate(resolve));

    // The row is GONE. Left behind, it would outrank an account that reported
    // honestly, on a number nothing measured.
    expect(rows('SELECT scope FROM quotaWindows')).toHaveLength(0);
  });

  // The same change must not erase good evidence on a read that FAILED. That
  // direction is fail-open: evaluateQuota never pauses an account it could not
  // read, and the table must not lose what it knows either.
  it('KEEPS a stored window when the read produced no snapshot at all (W3)', async () => {
    const repos = await import('@/lib/db/repos/quotaWindowsRepo.js');
    await repos.putWindows('alpha', [
      {
        scope: 'session (5h)',
        remaining: 90,
        limit: 100,
        resetAt: iso(HOUR),
        observedAt: iso(0),
        confidence: 'fresh',
      },
    ]);

    // snapshot:null and the connection carries no persisted one either, so
    // nothing was measured on this pass.
    quotaMocks.evaluateQuota.mockResolvedValue({
      paused: false,
      reason: 'quota fetch timeout',
      snapshot: null,
      rawUsage: null,
    });
    dbMocks.getProviderConnections.mockResolvedValue([connection('alpha', { key: FAKE_KEY_A })]);

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    leases.releaseAccountLease(picked.accountLease);
    await new Promise((resolve) => setImmediate(resolve));

    const kept = rows('SELECT scope, remaining, confidence FROM quotaWindows');
    expect(kept).toHaveLength(1);
    expect(kept[0].remaining).toBe(90);
  });

  it('reports a WAIT rather than a silent round-robin when every account is at capacity', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, maxConcurrent: 1, snapshot: snapshot(90) }),
    ]);

    const held = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(held.connectionId).toBe('alpha');

    // The one slot is taken. A round-robin fallback would hand out the account
    // anyway; the scheduler must refuse WITH a retry hint.
    const blocked = await auth.getProviderCredentials(
      PROVIDER,
      null,
      MODEL,
      clientOptions('other-session')
    );
    expect(blocked.allRateLimited).toBe(true);
    expect(blocked.retryAfter).toBeTruthy();
    expect(blocked.connectionId).toBeUndefined();
    // Refusing must not have leaked a second slot.
    expect(leases._getLeaseRegistry().inFlight('alpha')).toBe(1);

    leases.releaseAccountLease(held.accountLease);
    expect(leases._getLeaseRegistry().inFlight('alpha')).toBe(0);
  });

  it('fails OPEN on a quota lookup that throws', async () => {
    quotaMocks.evaluateQuota.mockRejectedValue(new Error('quota backend down'));
    dbMocks.getProviderConnections.mockResolvedValue([connection('alpha', { key: FAKE_KEY_A })]);

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    // A quota lookup that throws must never make an account ineligible.
    expect(picked?.connectionId).toBe('alpha');
    leases.releaseAccountLease(picked.accountLease);
  });

  it('honours an operator pin and still takes a lease for it', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, snapshot: snapshot(90) }),
      connection('beta', { key: FAKE_KEY_B, snapshot: snapshot(10) }),
    ]);

    // Ranking prefers alpha; the operator named beta, so beta wins.
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, {
      ...clientOptions(),
      preferredConnectionId: 'beta',
    });
    expect(picked.connectionId).toBe('beta');
    expect(leases._getLeaseRegistry().inFlight('beta')).toBe(1);
    leases.releaseAccountLease(picked.accountLease);
    expect(leases._getLeaseRegistry().inFlight('beta')).toBe(0);
  });
});

describe('E1.1w: lease lifetime (W2)', () => {
  const registry = () => leases._getLeaseRegistry();

  beforeEach(() => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, snapshot: snapshot(90) }),
      connection('beta', { key: FAKE_KEY_B, snapshot: snapshot(50) }),
    ]);
  });

  it('a double release frees nothing extra', async () => {
    const a = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('s-a'));
    const b = await auth.getProviderCredentials(
      PROVIDER,
      new Set(['alpha']),
      MODEL,
      clientOptions('s-b')
    );
    expect(a.connectionId).toBe('alpha');
    expect(b.connectionId).toBe('beta');
    expect(registry().inFlight()).toBe(2);

    expect(leases.releaseAccountLease(a.accountLease)).toBe(true);
    // The second release of the SAME lease returns false and, critically, does
    // not free b's slot. An identity-keyed registry is what makes that true; a
    // counter would have decremented something.
    expect(leases.releaseAccountLease(a.accountLease)).toBe(false);
    expect(registry().inFlight('beta')).toBe(1);

    leases.releaseAccountLease(b.accountLease);
    expect(registry().snapshot()).toEqual({});
  });

  it('a fabricated lease frees nothing', async () => {
    const held = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(leases.releaseAccountLease({ connectionId: held.connectionId, seq: 999 })).toBe(false);
    expect(registry().inFlight(held.connectionId)).toBe(1);
    leases.releaseAccountLease(held.accountLease);
    expect(registry().snapshot()).toEqual({});
  });

  it('a retry that switches accounts leaves nothing behind on the first', async () => {
    // Exactly the chat loop's shape: take a lease, fail, release, exclude, and
    // select again. The account that was abandoned must show zero in flight.
    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(first.connectionId).toBe('alpha');
    leases.releaseAccountLease(first.accountLease);

    const second = await auth.getProviderCredentials(
      PROVIDER,
      new Set(['alpha']),
      MODEL,
      clientOptions()
    );
    expect(second.connectionId).toBe('beta');
    expect(registry().inFlight('alpha')).toBe(0);
    expect(registry().inFlight('beta')).toBe(1);

    leases.releaseAccountLease(second.accountLease);
    expect(registry().snapshot()).toEqual({});
  });

  it('releases the lease when proxy resolution makes the account unusable', async () => {
    proxyMocks.resolveConnectionProxyConfig.mockResolvedValue({ kind: 'unavailable' });

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    // Nothing came back, so no caller can ever release: the function itself
    // must have, or the slot is stranded for the life of the process.
    expect(picked).toBeNull();
    expect(registry().snapshot()).toEqual({});
  });

  it('hands a streaming response its lease and releases when the body ends', async () => {
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    const id = picked.connectionId;
    expect(registry().inFlight(id)).toBe(1);

    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
          controller.close();
        },
      })
    );
    const tracked = leases.releaseAccountLeaseOnResponse(upstream, picked.accountLease);

    // Still held: the client has read nothing yet. This is the whole point —
    // releasing at `return` would report the account idle for the entire stream.
    expect(registry().inFlight(id)).toBe(1);

    const reader = tracked.body.getReader();
    while (!(await reader.read()).done) {
      /* drain */
    }
    expect(registry().inFlight(id)).toBe(0);
  });

  it('releases when the client cancels a stream mid-flight', async () => {
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    const id = picked.connectionId;

    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
          // Deliberately left open: a disconnect is what ends this one.
        },
      })
    );
    const tracked = leases.releaseAccountLeaseOnResponse(upstream, picked.accountLease);
    const reader = tracked.body.getReader();
    await reader.read();
    expect(registry().inFlight(id)).toBe(1);

    await reader.cancel('client went away');
    expect(registry().inFlight(id)).toBe(0);
  });

  it('releases a body-less response immediately', async () => {
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    const id = picked.connectionId;
    leases.releaseAccountLeaseOnResponse(new Response(null, { status: 204 }), picked.accountLease);
    expect(registry().inFlight(id)).toBe(0);
  });
});

describe('E1.1w: the persisted session identity is a HASH (W4)', () => {
  it('writes no raw session id, credential or prompt body to either table', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', {
        key: FAKE_KEY_A,
        snapshot: snapshot(90),
        extra: { accessToken: FAKE_BEARER },
      }),
      connection('beta', { key: FAKE_KEY_B, snapshot: snapshot(50) }),
    ]);

    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    leases.releaseAccountLease(first.accountLease);
    const second = await auth.getProviderCredentials(
      PROVIDER,
      new Set([first.connectionId]),
      MODEL,
      clientOptions()
    );
    leases.releaseAccountLease(second.accountLease);

    const pins = rows('SELECT * FROM sessionAffinity');
    const receipts = rows('SELECT * FROM accountSwitches');
    expect(pins.length).toBeGreaterThan(0);
    expect(receipts.length).toBeGreaterThan(0);

    // Serialize EVERY column of both tables and search the whole text. Asserting
    // per known column would pass a schema that later gains a leaky one.
    const persisted = JSON.stringify({ pins, receipts });
    for (const secret of [RAW_SESSION, FAKE_KEY_A, FAKE_KEY_B, FAKE_BEARER, PROMPT_BODY]) {
      expect(persisted).not.toContain(secret);
    }

    // Positively a digest, not merely "not the raw id": 32 lowercase hex chars.
    for (const row of [...pins, ...receipts]) {
      expect(row.sessionHash).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('gives two different client sessions two different pins', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, maxConcurrent: 4, snapshot: snapshot(90) }),
    ]);

    const one = await auth.getProviderCredentials(
      PROVIDER,
      null,
      MODEL,
      clientOptions('session-one')
    );
    leases.releaseAccountLease(one.accountLease);
    const two = await auth.getProviderCredentials(
      PROVIDER,
      null,
      MODEL,
      clientOptions('session-two')
    );
    leases.releaseAccountLease(two.accountLease);

    const hashes = rows('SELECT sessionHash FROM sessionAffinity').map((r) => r.sessionHash);
    expect(new Set(hashes).size).toBe(2);
  });

  it('derives a STABLE hash for one session across requests', async () => {
    // The regression this pins: resolveSessionIdentity falls through to
    // generateBinaryStyleId() when there is no client evidence, which is random
    // per call. Hashing that would give every request its own pin, so affinity
    // could never hit and sessionAffinity would grow a dead row per request.
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, maxConcurrent: 4, snapshot: snapshot(90) }),
    ]);

    for (let i = 0; i < 3; i += 1) {
      const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
      leases.releaseAccountLease(picked.accountLease);
    }
    expect(rows('SELECT sessionHash FROM sessionAffinity')).toHaveLength(1);
  });

  it('treats a request with NO client evidence as one stable anonymous session', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { key: FAKE_KEY_A, maxConcurrent: 4, snapshot: snapshot(90) }),
    ]);

    for (let i = 0; i < 3; i += 1) {
      const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, {});
      expect(picked.sessionIdentitySource).toBe('inferred');
      leases.releaseAccountLease(picked.accountLease);
    }
    // One row, not three: an anonymous caller is pinned, not re-rolled.
    const pins = rows('SELECT sessionHash FROM sessionAffinity');
    expect(pins).toHaveLength(1);
    expect(pins[0].sessionHash).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// The live-pool regressions. Every fixture below is the shape the RTX seam
// actually reported on 2026-09-04, when quota ranking was inert on a ten-
// account Claude pool and the receipts recorded `cohort-degraded` for a third
// of all switches.
// ---------------------------------------------------------------------------

/**
 * A percentage-scale snapshot carrying MORE THAN ONE window, which is what a
 * real provider reports and what the old cohort gate could not tolerate.
 * `windows` is a list of [key, remainingPercentage, resetOffsetMs].
 */
function multiSnapshot(windows, { fetchedAt = iso(0) } = {}) {
  return {
    windows: windows.map(([key, remainingPercentage, resetOffsetMs]) => ({
      key,
      remainingPercentage,
      resetAt: iso(resetOffsetMs),
      unlimited: false,
    })),
    fetchedAt,
  };
}

describe('E1.1w: a mixed-shape pool still ranks, and never serves a depleted account', () => {
  it('skips a depleted account that sits first in the list and takes the soonest deadline', async () => {
    // THE PRODUCTION BUG. These three accounts report three different window
    // shapes, which used to trip the cohort gate: rankAccounts returned
    // `degraded` with an empty eligible set, and selectAndReserve then walked
    // `ranked` — the raw connection-list order — and reserved whatever came
    // first. Here that is `beta`, whose 5h window is at zero. The request went
    // upstream, came back 429, and the pool was walked one wasted call at a
    // time.
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('beta', {
        key: FAKE_KEY_B,
        snapshot: multiSnapshot([['session (5h)', 0, HOUR], ['weekly (7d)', 50, 3 * 24 * HOUR]]),
      }),
      connection('alpha', {
        key: FAKE_KEY_A,
        snapshot: multiSnapshot([['session (5h)', 80, 5 * HOUR]]),
      }),
      connection('gamma', {
        key: FAKE_KEY_A,
        snapshot: multiSnapshot([['weekly (7d)', 40, 2 * 24 * HOUR]]),
      }),
    ]);

    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());

    // Gamma has a known weekly deadline; alpha has no weekly evidence.
    // Beta is excluded because its 5h quota is depleted.
    expect(picked?.connectionId).toBe('gamma');
    expect(picked.allRateLimited).toBeUndefined();
    leases.releaseAccountLease(picked.accountLease);

    // And the receipt says the pin was made on purpose, not on a refusal.
    const triggers = rows('SELECT trigger FROM accountSwitches').map((r) => r.trigger);
    expect(triggers).toEqual(['first-pin']);
  });

  it('answers 429 with the earliest real reset once nothing in the pool has headroom', async () => {
    // The other half of the operator contract: a 429 is owed to the caller
    // only when no account can serve, and it has to carry the time the first
    // window actually comes back. This branch used to answer 503 with a flat
    // one-second floor, so a client retried straight into the same exhausted
    // pool and kept doing it until a window rolled over hours later.
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', {
        key: FAKE_KEY_A,
        snapshot: multiSnapshot([['session (5h)', 0, 5 * HOUR]]),
      }),
      connection('beta', {
        key: FAKE_KEY_B,
        snapshot: multiSnapshot([['session (5h)', 0, 3 * HOUR]]),
      }),
    ]);

    const answer = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());

    expect(answer?.allRateLimited).toBe(true);
    expect(answer.clientErrorStatus).toBe(429);
    expect(answer.lastErrorCode).toBe(429);
    // beta's window is the first one back, so that is the instant quoted.
    expect(answer.retryAfter).toBe(iso(3 * HOUR));
    expect(answer.lastError).toContain('no-eligible-account');
    // Nothing was reserved, so no slot is stranded.
    expect(leases._getLeaseRegistry().inFlight('alpha')).toBe(0);
    expect(leases._getLeaseRegistry().inFlight('beta')).toBe(0);
  });

  it('holds a session on its own depleted account rather than refusing on a stale reading', async () => {
    // Quota evidence is a percentage snapshot at `confidence: unknown` that can
    // be hours old, so "everything reads depleted" is not proof that nothing
    // will serve. With a pin in hand the session stays where it is and lets the
    // upstream be the authority; the 429 cascade above is what turns a real
    // refusal into a real answer.
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', {
        key: FAKE_KEY_A,
        snapshot: multiSnapshot([['session (5h)', 60, HOUR]]),
      }),
      connection('beta', {
        key: FAKE_KEY_B,
        snapshot: multiSnapshot([['session (5h)', 60, 5 * HOUR]]),
      }),
    ]);
    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(first.connectionId).toBe('alpha');
    leases.releaseAccountLease(first.accountLease);

    // Both accounts now read empty, with resets still in the future.
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', {
        key: FAKE_KEY_A,
        snapshot: multiSnapshot([['session (5h)', 0, HOUR]]),
      }),
      connection('beta', {
        key: FAKE_KEY_B,
        snapshot: multiSnapshot([['session (5h)', 0, 5 * HOUR]]),
      }),
    ]);
    const second = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());

    expect(second?.connectionId).toBe('alpha');
    expect(second.allRateLimited).toBeUndefined();
    leases.releaseAccountLease(second.accountLease);
    // Held, not moved: no second receipt.
    const triggers = rows('SELECT trigger FROM accountSwitches').map((r) => r.trigger);
    expect(triggers).toEqual(['first-pin']);
  });
});

describe('model entitlement and temporary pin recovery', () => {
  it('marks capacity waits as terminal across model fallback boundaries', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { maxConcurrent: 1, snapshot: snapshot(90) }),
      connection('beta', { maxConcurrent: 1, snapshot: snapshot(90) }),
    ]);
    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    const wait = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(wait).toMatchObject({ allRateLimited: true, mustWait: true });
    expect(rows('SELECT connectionId FROM sessionAffinity')[0].connectionId).toBe(first.connectionId);
    leases.releaseAccountLease(first.accountLease);
  });
  it('skips an account whose configured model list excludes the requested model', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      connection('alpha', { snapshot: snapshot(90), extra: { providerSpecificData: { enabledModels: ['claude-opus-5'] } } }),
      connection('beta', { snapshot: snapshot(90), extra: { providerSpecificData: { enabledModels: [MODEL] } } }),
    ]);
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(picked.connectionId).toBe('beta');
    expect(quotaMocks.evaluateQuota).toHaveBeenCalledTimes(1);
    leases.releaseAccountLease(picked.accountLease);
  });

  it.each([429, 503])('waits on a temporary %i lock and recovers the same pin', async (status) => {
    const pool = [connection('alpha', { snapshot: snapshot(90) }), connection('beta', { snapshot: snapshot(90) })];
    dbMocks.getProviderConnections.mockResolvedValue(pool);
    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    leases.releaseAccountLease(first.accountLease);
    const pinned = pool.find((c) => c.id === first.connectionId);
    const until = iso(30_000);
    Object.assign(pinned, {
      [`modelLock_${MODEL}`]: until,
      [`modelFailure_${MODEL}`]: { status, until, message: 'Temporary limit', failureClass: status === 429 ? 'rate' : 'transient' },
    });
    const wait = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(wait).toMatchObject({ allRateLimited: true, mustWait: true, retryAfter: until });
    expect(rows('SELECT connectionId FROM sessionAffinity')[0].connectionId).toBe(first.connectionId);
    vi.setSystemTime(NOW + 30_001);
    const recovered = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions());
    expect(recovered.connectionId).toBe(first.connectionId);
    leases.releaseAccountLease(recovered.accountLease);
  });

  it('releases a reserved lease when proxy resolution throws', async () => {
    dbMocks.getProviderConnections.mockResolvedValue([connection('alpha', { snapshot: snapshot(90) })]);
    proxyMocks.resolveConnectionProxyConfig.mockRejectedValue(new Error('proxy unavailable'));
    await expect(auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions())).rejects.toThrow('proxy unavailable');
    expect(leases._getLeaseRegistry().inFlight()).toBe(0);
  });
});

it('cancels a provider-selection waiter without unlocking its live predecessor', async () => {
  const { withRequestLifetime } = await import('open-sse/utils/requestLifetime.js');
  const account = connection('abort-queue', { key: FAKE_KEY_A, maxConcurrent: 4 });
  let releaseRead;
  dbMocks.getProviderConnections.mockResolvedValue([account]).mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve; }));
  const first = auth.getProviderCredentials(PROVIDER, null, MODEL);
  await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
  const abort = new AbortController();
  const second = withRequestLifetime(abort.signal, () => auth.getProviderCredentials(PROVIDER, null, MODEL));
  const third = auth.getProviderCredentials(PROVIDER, null, MODEL);
  abort.abort(new Error('caller left'));
  await expect(second).rejects.toThrow('caller left');
  expect(dbMocks.getProviderConnections).toHaveBeenCalledTimes(1);
  releaseRead([account]);
  const [a, b] = await Promise.all([first, third]);
  expect(a.connectionId).toBe(account.id); expect(b.connectionId).toBe(account.id);
  leases.releaseAccountLease(a.accountLease); leases.releaseAccountLease(b.accountLease);
  expect(leases.leaseRegistry.inFlight()).toBe(0);
});
