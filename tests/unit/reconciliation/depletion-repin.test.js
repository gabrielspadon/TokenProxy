import { describe, it, expect } from 'vitest';
import { decideRepin, TRIGGERS } from '@/shared/utils/repinPolicy.js';
import { rankAccounts, selectAccount } from '@/shared/utils/quotaRanking.js';

// G3 / Account Scheduling Contract rules 4 and 5 (RECONCILIATION.md:99-100):
// exhaust account one, then two, use three; then reset two and return to two,
// reset one and return to one.
//
// Fake clock throughout. Nothing reads Date.now() and nothing sleeps, so
// "account two reset" is expressed the only way the running system can know it:
// the clock passes that window's resetAt. quotaRanking's eligibility already
// treats `resetAt <= now` as replenished, which is the mechanism rule 5 rides.
//
// A DEPLETED account is `remaining: 0`. An account whose remaining equals its
// limit is untouched and is the most usable account there is.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const w = (scope, remaining, limit, resetAt, confidence = 'fresh') => ({
  scope,
  remaining,
  limit,
  resetAt,
  observedAt: iso(0),
  confidence,
});

const LIMIT = 300;
// One shared window shape across the cohort. A differing shape trips the cohort
// gate and no ranking runs at all, which would make every case below vacuous.
const acct = (id, priority, remaining, resetOffsetMs) => ({
  id,
  priority,
  windows: [w('session (5h)', remaining, LIMIT, iso(resetOffsetMs))],
});

// Operator-declared order: one, then two, then three. Rule 5's "earliest
// restored account" is this order, not the ranker's urgency order — rule 3
// fixes the ranker on expiring entitlement and demotes priority to a tie-break,
// so the two orderings are deliberately allowed to disagree.
const one = (remaining, resetOffsetMs) => acct('one', 1, remaining, resetOffsetMs);
const two = (remaining, resetOffsetMs) => acct('two', 2, remaining, resetOffsetMs);
const three = (remaining, resetOffsetMs) => acct('three', 3, remaining, resetOffsetMs);

// The timeline every case below is a snapshot of. Reset offsets are chosen so
// account two's window rolls over BEFORE account one's, which is the only way
// "reset two first, then reset one" is expressible with a real clock.
const ALL_FRESH = [one(LIMIT, 5 * HOUR), two(LIMIT, 6 * HOUR), three(LIMIT, 7 * HOUR)];
const ONE_SPENT = [one(0, 5 * HOUR), two(LIMIT, 6 * HOUR), three(LIMIT, 7 * HOUR)];
const ONE_TWO_SPENT = [one(0, 5 * HOUR), two(0, 6 * HOUR), three(LIMIT, 7 * HOUR)];
// Account two's 6h window has rolled over; account one's now runs to 8h and has
// not. Two is restored, one is still depleted.
const TWO_RESTORED = [one(0, 8 * HOUR), two(0, 6 * HOUR), three(200, 7 * HOUR)];
// Account one's window has now rolled over too, while two is live on a fresh
// 11h window it has been spending.
const ONE_RESTORED = [one(0, 8 * HOUR), two(150, 11 * HOUR), three(200, 7 * HOUR)];

describe('sequential depletion: one, then two, then three', () => {
  it('pins an unpinned session to the ranker winner and calls it the initial pin', () => {
    expect(selectAccount(ALL_FRESH, { now: NOW })).toBe('one');
    expect(decideRepin({ pin: null, accounts: ALL_FRESH, now: NOW })).toMatchObject({
      action: 'repin',
      from: null,
      connectionId: 'one',
      trigger: TRIGGERS.INITIAL_PIN,
    });
  });

  it('holds account one for every request while one has headroom', () => {
    // The failure this guards is round-robin: the same healthy pin must survive
    // repeated decisions, not rotate through the cohort.
    const pin = { connectionId: 'one', pinnedAt: iso(0) };
    const seen = new Set();
    for (let i = 0; i < 10; i += 1) {
      const accounts = [one(LIMIT - i * 10, 5 * HOUR), two(LIMIT, 6 * HOUR), three(LIMIT, 7 * HOUR)];
      const d = decideRepin({ pin, accounts, now: NOW + i * 60_000 });
      expect(d.action).toBe('keep');
      seen.add(d.connectionId);
    }
    expect([...seen]).toEqual(['one']);
  });

  it('moves to account two only once one is exhausted, and names exhaustion', () => {
    const at = NOW + HOUR;
    expect(rankAccounts(ONE_SPENT, { now: at }).eligible.map((r) => r.id)).toEqual(['two', 'three']);
    expect(
      decideRepin({ pin: { connectionId: 'one', pinnedAt: iso(0) }, accounts: ONE_SPENT, now: at })
    ).toMatchObject({
      action: 'repin',
      from: 'one',
      connectionId: 'two',
      trigger: TRIGGERS.EXHAUSTION,
    });
  });

  it('moves to account three only once one AND two are exhausted', () => {
    const at = NOW + 2 * HOUR;
    expect(selectAccount(ONE_TWO_SPENT, { now: at })).toBe('three');
    expect(
      decideRepin({
        pin: { connectionId: 'two', pinnedAt: iso(HOUR) },
        accounts: ONE_TWO_SPENT,
        now: at,
      })
    ).toMatchObject({
      action: 'repin',
      from: 'two',
      connectionId: 'three',
      trigger: TRIGGERS.EXHAUSTION,
    });
  });

  it('stays on three while one and two are still depleted', () => {
    const accounts = [one(0, 5 * HOUR), two(0, 6 * HOUR), three(200, 7 * HOUR)];
    const d = decideRepin({
      pin: { connectionId: 'three', pinnedAt: iso(2 * HOUR) },
      accounts,
      now: NOW + 3 * HOUR,
    });
    expect(d.action).toBe('keep');
    expect(d.connectionId).toBe('three');
  });

  it('keeps the pin rather than spraying when every account is depleted', () => {
    const d = decideRepin({
      pin: { connectionId: 'three', pinnedAt: iso(2 * HOUR) },
      accounts: [one(0, 5 * HOUR), two(0, 6 * HOUR), three(0, 7 * HOUR)],
      now: NOW + 3 * HOUR,
    });
    expect(d.action).toBe('keep');
    expect(d.reason).toMatch(/all-depleted/);
  });
});

describe('reset-aware repin: the decision point is depletion, and earliest means deadline', () => {
  // WHAT CHANGED, AND WHY (2026-09-04). Two rules used to live here that no
  // longer do.
  //
  // The first preempted a HEALTHY pin as soon as any account had become
  // eligible since `pinnedAt`. A switch abandons the pinned account's
  // prompt-cache prefix, so the next request re-primes the whole conversation
  // at full input price: the operator pays cash for a session that was serving
  // perfectly well. So a healthy pin is now kept, full stop, and the choice is
  // re-made only when the pinned account can no longer serve.
  //
  // The second decided WHERE to move by configured priority, falling back to
  // the account's index in the connection list when no priority was set — the
  // common case, so "the earliest restored account" quietly meant "whichever
  // restored account sits higher in the DB listing". That contradicts rule 3,
  // which fixes priority as a tie-break only, and it got the answer wrong in
  // both directions: it refused a return to a restocked account whose window
  // expires within the hour, and forced one onto a restocked account with a
  // week of runway. Earliest now means earliest DEADLINE, because the deadline
  // is what decides whose tokens get wasted.

  it('keeps a healthy pin even when another account has restocked', () => {
    const at = NOW + 6.5 * HOUR;
    // Two is eligible now only because its reset passed; it was NOT eligible
    // when the pin was made, so the old policy called this a restore and moved.
    expect(rankAccounts(TWO_RESTORED, { now: NOW + 2 * HOUR }).eligible.map((r) => r.id)).toEqual([
      'three',
    ]);
    expect(rankAccounts(TWO_RESTORED, { now: at }).eligible.map((r) => r.id)).toEqual([
      'three',
      'two',
    ]);
    const d = decideRepin({
      pin: { connectionId: 'three', pinnedAt: iso(2 * HOUR) },
      accounts: TWO_RESTORED,
      now: at,
    });
    expect(d.action).toBe('keep');
    expect(d.connectionId).toBe('three');
    expect(d.reason).toBe('pin-healthy');
  });

  it('ranks a just-replenished account by its NEW deadline, not its stale one', () => {
    // The bug this pins. Two replenished at 6h, so its recorded resetAt is in
    // the PAST and was the smallest number in the pool — which sorted the
    // account that had just been handed a fresh five-hour period to the very
    // front, as the most urgent entitlement there is. It is the least urgent:
    // its next deadline is 11h. Three holds 200 units that expire at 7h, so
    // three is what has to be spent first or lost.
    const at = NOW + 6.5 * HOUR;
    const ranked = rankAccounts(TWO_RESTORED, { now: at }).ranked;
    const byId = Object.fromEntries(ranked.map((r) => [r.id, r]));
    expect(byId.two.bindingResetAt).toBe(Date.parse(iso(11 * HOUR)));
    expect(byId.three.bindingResetAt).toBe(Date.parse(iso(7 * HOUR)));
    // A replenished window reads as its full ceiling, not its stale remaining.
    expect(byId.two.windows[0].effectiveRemaining).toBe(LIMIT);
    expect(byId.two.windows[0].replenished).toBe(true);
    expect(rankAccounts(TWO_RESTORED, { now: at }).winner.id).toBe('three');
  });

  it('returns to a restocked account when its deadline lands first', () => {
    // The case the operator described. The session is on B. A was depleted when
    // the pin was made and has since restocked, so A's fresh period runs to
    // 8.5h. C has been available all along and its window runs to 8.8h. B is
    // now out. A's deadline comes first, so the session goes back to A and the
    // receipt says so.
    const a = acct('a', 1, 0, 3.5 * HOUR);
    const b = acct('b', 2, 0, 7 * HOUR);
    const c = acct('c', 3, LIMIT, 8.8 * HOUR);
    const at = NOW + 4 * HOUR;
    expect(rankAccounts([a, b, c], { now: at }).eligible.map((r) => r.id)).toEqual(['a', 'c']);
    expect(
      decideRepin({
        pin: { connectionId: 'b', pinnedAt: iso(0) },
        accounts: [a, b, c],
        now: at,
      })
    ).toMatchObject({
      action: 'repin',
      from: 'b',
      connectionId: 'a',
      trigger: TRIGGERS.RESET,
      reason: 'pinned-window-exhausted:returning-to-restored',
    });
  });

  it('does NOT return to a restocked account whose deadline lands later', () => {
    // Same shape, one number moved: C now runs out at 5h, ahead of the
    // restocked A at 8.5h. Going back to A would waste C's hour, so the session
    // takes C and the receipt calls it plain exhaustion rather than a return.
    // The old policy moved to A here purely because A sat first in the list.
    const a = acct('a', 1, 0, 3.5 * HOUR);
    const b = acct('b', 2, 0, 7 * HOUR);
    const c = acct('c', 3, LIMIT, 5 * HOUR);
    const at = NOW + 4 * HOUR;
    expect(rankAccounts([a, b, c], { now: at }).eligible.map((r) => r.id)).toEqual(['c', 'a']);
    expect(
      decideRepin({
        pin: { connectionId: 'b', pinnedAt: iso(0) },
        accounts: [a, b, c],
        now: at,
      })
    ).toMatchObject({
      action: 'repin',
      from: 'b',
      connectionId: 'c',
      trigger: TRIGGERS.EXHAUSTION,
      reason: 'pinned-window-exhausted',
    });
  });

  it('holds one pin across many requests on unchanged evidence', () => {
    // No round-robin and no drift: the same evidence must produce the same
    // answer every time it is asked, or a settled session pays a cache
    // re-prime for nothing.
    const pin = { connectionId: 'three', pinnedAt: iso(2 * HOUR) };
    for (let i = 0; i <= 5; i += 1) {
      const d = decideRepin({
        pin,
        accounts: TWO_RESTORED,
        now: NOW + 6.5 * HOUR + i * 60_000,
      });
      expect(d.action).toBe('keep');
      expect(d.connectionId).toBe('three');
    }
  });

  it('never lets another account pull a session off a healthy one', () => {
    const accounts = [one(100, 13 * HOUR), two(150, 11 * HOUR), three(0, 10 * HOUR)];
    const d = decideRepin({
      pin: { connectionId: 'one', pinnedAt: iso(8.5 * HOUR) },
      accounts,
      now: NOW + 12 * HOUR,
    });
    expect(d.action).toBe('keep');
    expect(d.connectionId).toBe('one');
    expect(d.trigger).toBeNull();
  });

  it('does not repin to an account that was available all along', () => {
    // One outranks three and is eligible, but three is healthy — this is the
    // anti-spray assertion, and it is what separates the policy from simply
    // calling the ranker on every request.
    expect(selectAccount(ALL_FRESH, { now: NOW + HOUR })).toBe('one');
    const d = decideRepin({
      pin: { connectionId: 'three', pinnedAt: iso(0) },
      accounts: ALL_FRESH,
      now: NOW + HOUR,
    });
    expect(d.action).toBe('keep');
    expect(d.connectionId).toBe('three');
    expect(d.reason).toBe('pin-healthy');
  });

  it('ranks a mixed-shape pool instead of refusing, and still holds the pin', () => {
    // Mismatched window shapes used to trip a cohort gate that refused to rank
    // the whole pool. They are now ranked on each account own binding window.
    const mismatched = [
      one(LIMIT, 5 * HOUR),
      {
        id: 'three',
        priority: 3,
        windows: [
          w('session (5h)', 200, LIMIT, iso(7 * HOUR)),
          w('weekly (7d)', 4000, 5000, iso(6 * 24 * HOUR)),
        ],
      },
    ];
    const res = rankAccounts(mismatched, { now: NOW });
    expect(res.degraded).toBe(false);
    // Missing weekly evidence cannot invent an earlier weekly deadline.
    expect(res.eligible.map((r) => r.id)).toEqual(['three', 'one']);
    const d = decideRepin({
      pin: { connectionId: 'three', pinnedAt: iso(0) },
      accounts: mismatched,
      now: NOW,
    });
    expect(d.action).toBe('keep');
    expect(d.connectionId).toBe('three');
  });

  it('holds the pin when no account carries any deadline at all', () => {
    const blind = [{ id: 'one', windows: [] }, { id: 'three', windows: [] }];
    expect(rankAccounts(blind, { now: NOW }).degraded).toBe(true);
    const d = decideRepin({
      pin: { connectionId: 'three', pinnedAt: iso(0) },
      accounts: blind,
      now: NOW,
    });
    expect(d.action).toBe('keep');
    expect(d.connectionId).toBe('three');
    expect(d.reason).toMatch(/ranking-degraded/);
  });
});
