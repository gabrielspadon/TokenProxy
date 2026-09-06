import { describe, expect, it, vi } from 'vitest';

// selectAndReserve's trace contract (docs/logging-design.md rows 25-30) and
// the lease registry's richer verdicts (rows 37-39). Both stay pure: they
// RETURN verdicts; auth.js prints them.
import { selectAndReserve } from '@/sse/services/accountScheduler.js';
import { createLeaseRegistry } from '@/shared/utils/accountLease.js';
import { effectiveCapacity } from '@/shared/utils/accountCapacity.js';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const w = (remaining, resetAt, confidence = 'fresh') => ({
  scope: 'session (5h)',
  remaining,
  limit: 1000,
  resetAt,
  observedAt: iso(0),
  confidence,
});

const connection = (id, { windows, priority = 0 } = {}) => ({
  id,
  name: `account-${id}`,
  priority,
  provider: 'openai',
  authType: 'api_key',
  apiKey: 'key',
  isActive: true,
  testStatus: 'active',
  maxConcurrent: 8,
  providerSpecificData: {},
  windows: windows ?? [w(100, iso(1 * HOUR))],
});

const healthyA = () => connection('conn_aaaaaaaa');
const healthyB = () => connection('conn_bbbbbbbb', { windows: [w(100, iso(2 * HOUR))] });

/** In-memory repos: pin store + recorded switch receipts. */
function fakeRepos({ pin = null, receiptId = null } = {}) {
  const state = { pin, receipts: [] };
  return {
    state,
    transaction: (fn) => fn(),
    getPin: () => state.pin,
    setPin: ({ connectionId }) => { state.pin = { connectionId }; },
    touchPin: () => {},
    recordSwitch: (receipt) => {
      const recorded = { ...receipt, id: receiptId || 'rcpt-0000-1111' };
      state.receipts.push(recorded);
      return recorded;
    },
  };
}

function args(overrides = {}) {
  return {
    sessionHash: 'sha256:sess0001',
    model: 'gpt-5.1-codex',
    accounts: [healthyA(), healthyB()],
    now: NOW,
    registry: createLeaseRegistry({ capacityOf: () => 8 }),
    repos: fakeRepos(),
    ...overrides,
  };
}

describe('selectAndReserve trace', () => {
  it('returns the ranking win plus an initial-pin verdict and no skips on a clean selection', () => {
    const decision = selectAndReserve(args());
    expect(decision.unavailable).toBeUndefined();
    const verdicts = decision.trace.map((e) => `${e.cls}.${e.verdict}`);
    expect(verdicts).toEqual(['SEL.win', 'SEL.repin']);
    expect(decision.trace[0].fields.conn).toBe('conn_aaa');
    expect(decision.trace[1].fields).toMatchObject({
      from: 'none',
      to: 'conn_aaa',
      trigger: 'initial-pin',
      why: 'no-existing-pin',
    });
    expect(decision.skipped).toEqual([]);
    // The recorded receipt id is reachable for SEL.repin's rcpt=.
    expect(decision.receipt.id).toBe('rcpt-0000-1111');
  });

  it('maps a healthy pin to the silent pin-hit verdict (not printed, but returned)', () => {
    const repos = fakeRepos({ pin: { connectionId: 'conn_aaaaaaaa' } });
    const decision = selectAndReserve(args({ repos }));
    expect(decision.reason).toBe('pinned');
    const pinHit = decision.trace.find((e) => e.verdict === 'pin-hit');
    expect(pinHit).toMatchObject({ cls: 'SEL', verdict: 'pin-hit', fields: { conn: 'conn_aaa' } });
    expect(typeof pinHit.fields.why).toBe('string');
  });

  it('maps an exhausted pin to the pin-expired verdict with from/to', () => {
    const repos = fakeRepos({ pin: { connectionId: 'conn_aaaaaaaa' } });
    const exhausted = connection('conn_aaaaaaaa', { windows: [w(0, iso(5 * HOUR))] });
    const decision = selectAndReserve(args({ repos, accounts: [exhausted, healthyB()] }));
    const expired = decision.trace.find((e) => e.verdict === 'pin-expired');
    expect(expired).toMatchObject({
      cls: 'SEL',
      verdict: 'pin-expired',
      fields: { from: 'conn_aaa', to: 'conn_bbb', trigger: 'exhaustion', why: 'pinned-window-exhausted' },
    });
  });

  it('folds slot-walk skips, max 3 then +N, and refuses when every slot is taken', () => {
    const accounts = [
      healthyA(),
      connection('conn_cccccccc'),
      connection('conn_dddddddd'),
      connection('conn_eeeeeeee'),
      connection('conn_ffffffff'),
    ];
    // Every connection is at its cap of 1 before the walk starts, so all five
    // are tried and refused in ranked order: 3 named, the rest counted.
    const registry = createLeaseRegistry({ capacityOf: () => 1 });
    for (const a of accounts) registry.reserve(a.id);
    const decision = selectAndReserve(args({ accounts, registry }));
    expect(decision.unavailable).toBe(true);
    expect(decision.reason).toBe('at-capacity');
    const skipped = decision.trace.find((e) => e.verdict === 'skipped');
    expect(skipped.fields.alt).toHaveLength(3);
    expect(skipped.fields.more).toBe(accounts.length - 3);
    const refused = decision.trace.filter((e) => e.verdict === 'refused');
    expect(refused.at(-1).fields.why).toBe('lease-refused');
  });

  it('a mixed-shape cohort serves and emits no refusal', () => {
    // The cohort shape gate is gone (b09a9277): a pool whose accounts report
    // different window sets is the ordinary live case, each account is ranked
    // on its own binding deadline, and the result is a win. SEL.refused would
    // describe a refusal that never happened either way.
    const mismatched = connection('conn_bbbbbbbb', { windows: [{ scope: 'weekly (7d)', remaining: 100, limit: 1000, resetAt: iso(2 * HOUR), observedAt: iso(0), confidence: 'fresh' }] });
    const decision = selectAndReserve(args({ accounts: [healthyA(), mismatched] }));
    expect(decision.unavailable).toBeUndefined();
    expect(decision.trace.some((e) => e.verdict === 'refused')).toBe(false);
    expect(decision.trace[0].verdict).toBe('win');
  });

  it('names the one connection tried and refused before the walk succeeded', () => {
    const accounts = [healthyA(), healthyB()];
    const registry = createLeaseRegistry({ capacityOf: () => 1 });
    registry.reserve(accounts[0].id); // a's only slot is already taken
    // The pin is on the full account, so the ranker leads with it (rule 4 keeps
    // a healthy pin, and load spreads NEW placements only) and the walk has a
    // capacity skip to name. Without the pin the spread would put the free
    // account first and there would be no skip at all, which is the fix
    // working rather than this contract changing.
    const decision = selectAndReserve(
      args({ accounts, registry, repos: fakeRepos({ pin: { connectionId: accounts[0].id } }) }),
    );
    expect(decision.unavailable).toBeUndefined();
    expect(decision.connection.id).toBe(accounts[1].id);
    expect(decision.skipped).toEqual([`${accounts[0].id.slice(0, 8)}:capacity`]);
    const skipped = decision.trace.find((e) => e.verdict === 'skipped');
    expect(skipped.fields.alt).toEqual([`${accounts[0].id.slice(0, 8)}:capacity`]);
    expect(skipped.fields).not.toHaveProperty('more');
  });

  it('carries the refusal enum for the no-accounts and none-eligible exits', () => {
    expect(selectAndReserve(args({ accounts: [] })).trace).toEqual([
      { cls: 'SEL', verdict: 'refused', fields: { why: 'no-accounts' } },
    ]);

    const depleted = connection('conn_aaaaaaaa', { windows: [w(0, iso(1 * HOUR))] });
    const decision = selectAndReserve(args({ accounts: [depleted] }));
    // The ranker's own reason is appended, so an operator reading the refusal
    // knows WHY nothing was eligible rather than only that nothing was.
    expect(decision.reason).toBe('no-eligible-account:all-depleted');
    const refused = decision.trace.find((e) => e.verdict === 'refused');
    expect(refused.fields.why).toBe('none-eligible');
    // The ranking's depleted verdict rides the same trace.
    expect(decision.trace[0].verdict).toBe('depleted');
  });

  it('never prints: the scheduler is pure', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      selectAndReserve(args());
      selectAndReserve(args({ accounts: [] }));
    } finally {
      spy.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('lease registry verdicts', () => {
  it('a refused reservation reports held, cap and retry hint via lastRefusal', () => {
    const registry = createLeaseRegistry({ capacityOf: () => 2 });
    expect(registry.reserve('conn_a')).toBeTruthy();
    expect(registry.reserve('conn_a')).toBeTruthy();
    expect(registry.reserve('conn_a')).toBeNull();
    expect(registry.lastRefusal('conn_a')).toEqual({ held: 2, cap: 2, retryAfterMs: 1000 });
    expect(registry.lastRefusal('conn_b')).toBeNull();
  });

  it('an ungated admission says why: unregistered capacity fails open visibly', () => {
    const registry = createLeaseRegistry({ capacityOf: () => 0 });
    const lease = registry.reserve('conn_a');
    expect(lease.ungated).toBe(true);
    expect(lease.why).toBe('capacity-unregistered');
    expect(lease.held).toBe(1);
  });

  it('a malformed capacity fails open too, but says capacity-malformed', () => {
    const registry = createLeaseRegistry({ capacityOf: () => 'not-a-number' });
    const lease = registry.reserve('conn_a');
    expect(lease.ungated).toBe(true);
    expect(lease.why).toBe('capacity-malformed');
  });

  it('a gated admission carries no ungated marker', () => {
    const registry = createLeaseRegistry({ capacityOf: () => 1 });
    expect(registry.reserve('conn_a').ungated).toBeUndefined();
  });

  it('a lease carries the seq a double-release line prints, and release stays idempotent', () => {
    const registry = createLeaseRegistry({ capacityOf: () => 1 });
    const lease = registry.reserve('conn_a');
    expect(typeof lease.seq).toBe('number');
    expect(registry.release(lease)).toBe(true);
    // The second release returns false; the caller already holds lease.seq
    // for LEASE.double-release {conn, seq}.
    expect(registry.release(lease)).toBe(false);
    expect(registry.inFlight('conn_a')).toBe(0);
  });
});
