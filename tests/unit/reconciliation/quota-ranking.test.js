import { describe, it, expect } from 'vitest';
import {
  rankAccounts,
  selectAccount,
  classifyWindow,
  windowHorizonMs,
  normalizeAccountWindows,
} from '@/shared/utils/quotaRanking.js';

// Fake clock. Every case below is anchored here and no test reads Date.now(),
// so a ranking result is a function of its inputs alone — a ranking test that
// drifts with wall time proves nothing about the ranker.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const w = (scope, remaining, limit, resetAt, confidence = 'fresh') => ({
  scope,
  remaining,
  limit,
  resetAt,
  observedAt: iso(0),
  confidence,
});

describe('quotaRanking: window classification and horizons', () => {
  it('reads a parenthetical duration in preference to the bare name', () => {
    expect(windowHorizonMs('session (5h)')).toBe(5 * HOUR);
    expect(windowHorizonMs('weekly (7d)')).toBe(7 * DAY);
    expect(windowHorizonMs('monthly (30d)')).toBe(30 * DAY);
  });

  it('falls back on the bare window name when no duration is given', () => {
    expect(windowHorizonMs('weekly')).toBe(7 * DAY);
    expect(windowHorizonMs('hourly')).toBe(HOUR);
  });

  it('treats a per-model sub-quota as scoped and ignores it for ranking', () => {
    expect(classifyWindow('per-model opus')).toBe('scoped');
    expect(classifyWindow('session (5h)')).toBe('general');
    expect(classifyWindow('gibberish')).toBeNull();
  });

  it('drops scoped windows but keeps the account rankable on its general ones', () => {
    const r = normalizeAccountWindows([
      w('session (5h)', 100, 300, iso(HOUR)),
      { scope: 'per-model sonnet', remaining: 0, limit: 10, resetAt: iso(HOUR) },
    ]);
    expect(r.ok).toBe(true);
    expect(r.windows.map((x) => x.scope)).toEqual(['session (5h)']);
  });

  // A period name QUALIFIED by anything else is a BRANCH of that period, never
  // the account's entitlement in it. Anthropic reports `weekly opus (7d)` and
  // `weekly sonnet (7d)` beside the plan-wide `weekly (7d)`
  // (open-sse/services/usage/claude.js), and codex reports `spark_session` /
  // `spark_weekly` (open-sse/services/usage/codex.js). Ranking either as
  // general let ONE model's exhausted sub-quota set usable=false for the whole
  // connection, taking it out of service for every other model.
  it('classifies a qualified period name as a sub-quota, not entitlement', () => {
    expect(classifyWindow('weekly opus (7d)')).toBe('scoped');
    expect(classifyWindow('weekly sonnet (7d)')).toBe('scoped');
    expect(classifyWindow('review_weekly')).toBe('scoped');
    // The plan-wide windows beside them are untouched.
    expect(classifyWindow('weekly (7d)')).toBe('general');
    expect(classifyWindow('weekly')).toBe('general');
    expect(classifyWindow('session (5h)')).toBe('general');
    expect(classifyWindow('Ratelimit')).toBe('general');
  });

  // `\b` treats `_` as a word character, so `\bsession\b` could not see the
  // name inside `spark_session` and the codex spark windows landed as
  // UNCLASSIFIABLE. Unreadable never benched the account, but it erased the
  // codex lane's real deadline ordering.
  it('reads a period name across an underscore boundary', () => {
    expect(classifyWindow('spark_session')).toBe('scoped');
    expect(classifyWindow('spark_weekly')).toBe('scoped');
    expect(windowHorizonMs('spark_weekly')).toBe(7 * DAY);
  });

  it('a per-model weekly at zero does not deplete the whole account', () => {
    const windows = [
      w('weekly (7d)', 500, 1000, iso(3 * DAY)),
      w('weekly opus (7d)', 0, 100, iso(3 * DAY)),
    ];
    const r = normalizeAccountWindows(windows);
    expect(r.ok).toBe(true);
    expect(r.windows.map((x) => x.scope)).toEqual(['weekly (7d)']);
    const ranked = rankAccounts([{ id: 'a', windows }], { now: NOW });
    expect(ranked.eligible.map((x) => x.id)).toEqual(['a']);
    expect(ranked.reason).toBeNull();
  });
});

describe('quotaRanking: compound window shapes (Acceptance: Compound windows)', () => {
  it('5h + 7d — the account whose LONGEST window resets soonest wins', () => {
    // b's 7d window resets first, so its entitlement is the one about to be
    // wasted, even though a's 5h window resets sooner.
    const accounts = [
      {
        id: 'a',
        windows: [
          w('session (5h)', 100, 300, iso(HOUR)),
          w('weekly (7d)', 1000, 5000, iso(6 * DAY)),
        ],
      },
      {
        id: 'b',
        windows: [
          w('session (5h)', 100, 300, iso(4 * HOUR)),
          w('weekly (7d)', 1000, 5000, iso(2 * DAY)),
        ],
      },
    ];
    const res = rankAccounts(accounts, { now: NOW });
    expect(res.degraded).toBe(false);
    expect(res.winner.id).toBe('b');
    expect(res.ranked.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it("7d only — a single-shape cohort still ranks by that window's reset", () => {
    const accounts = [
      { id: 'a', windows: [w('weekly (7d)', 500, 5000, iso(5 * DAY))] },
      { id: 'b', windows: [w('weekly (7d)', 500, 5000, iso(1 * DAY))] },
      { id: 'c', windows: [w('weekly (7d)', 500, 5000, iso(3 * DAY))] },
    ];
    expect(rankAccounts(accounts, { now: NOW }).ranked.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('5h + 7d + 30d — the 30d window is compared first and binds the result', () => {
    // a wins on both shorter windows, but b's 30d window resets sooner, and the
    // longest window is compared first. Burning a's short entitlement against a
    // 30d window that is not close to resetting would overspend the long one.
    const accounts = [
      {
        id: 'a',
        windows: [
          w('session (5h)', 200, 300, iso(1 * HOUR)),
          w('weekly (7d)', 4000, 5000, iso(1 * DAY)),
          w('monthly (30d)', 40_000, 90_000, iso(29 * DAY)),
        ],
      },
      {
        id: 'b',
        windows: [
          w('session (5h)', 200, 300, iso(4 * HOUR)),
          w('weekly (7d)', 4000, 5000, iso(6 * DAY)),
          w('monthly (30d)', 40_000, 90_000, iso(3 * DAY)),
        ],
      },
    ];
    const res = rankAccounts(accounts, { now: NOW });
    expect(res.winner.id).toBe('b');
  });

  it('falls through to the next-longest window when the longest ties', () => {
    const accounts = [
      {
        id: 'a',
        windows: [
          w('session (5h)', 100, 300, iso(4 * HOUR)),
          w('weekly (7d)', 900, 5000, iso(3 * DAY)),
        ],
      },
      {
        id: 'b',
        windows: [
          w('session (5h)', 100, 300, iso(1 * HOUR)),
          w('weekly (7d)', 900, 5000, iso(3 * DAY)),
        ],
      },
    ];
    expect(selectAccount(accounts, { now: NOW })).toBe('b');
  });
});

describe('quotaRanking: eligibility requires headroom in EVERY known hard window', () => {
  it('an account with headroom in one scope and none in another is ineligible', () => {
    // a has a full 5h window but its 7d window is spent. Contract rule 2: every
    // known hard window must have headroom, so the fresh short window does not
    // rescue it. `remaining: 0` is what spent means; a window at
    // remaining == limit is UNTOUCHED and is the most usable window there is.
    const accounts = [
      {
        id: 'a',
        windows: [
          w('session (5h)', 300, 300, iso(1 * HOUR)),
          w('weekly (7d)', 0, 5000, iso(6 * DAY)),
        ],
      },
      {
        id: 'b',
        windows: [
          w('session (5h)', 50, 300, iso(4 * HOUR)),
          w('weekly (7d)', 100, 5000, iso(6 * DAY)),
        ],
      },
    ];
    const res = rankAccounts(accounts, { now: NOW });
    expect(res.winner.id).toBe('b');
    expect(res.eligible.map((r) => r.id)).toEqual(['b']);
    expect(res.ineligible.map((r) => r.id)).toEqual(['a']);
  });

  it('a depleted window whose resetAt has already elapsed counts as replenished', () => {
    // Reset-aware repin (rule 5) needs this: a stale depleted reading about a
    // window that has since rolled over must not strand the account forever.
    const accounts = [
      { id: 'a', windows: [w('weekly (7d)', 0, 5000, iso(-HOUR))] },
      { id: 'b', windows: [w('weekly (7d)', 0, 5000, iso(6 * DAY))] },
    ];
    const res = rankAccounts(accounts, { now: NOW });
    expect(res.winner.id).toBe('a');
    expect(res.ineligible.map((r) => r.id)).toEqual(['b']);
  });

  it('reports every account depleted without calling it a refusal to rank', () => {
    const accounts = [
      { id: 'a', windows: [w('weekly (7d)', 0, 5000, iso(6 * DAY))] },
      { id: 'b', windows: [w('weekly (7d)', 0, 5000, iso(5 * DAY))] },
    ];
    const res = rankAccounts(accounts, { now: NOW });
    // Ranking RAN and eligibility answered: nothing has headroom. That is a
    // different fact from `degraded`, which now means only "no account carried
    // a deadline at all", and conflating the two is what let a caller read an
    // empty eligible set as permission to fall back to list order.
    expect(res.degraded).toBe(false);
    expect(res.reason).toBe('all-depleted');
    expect(res.winner).toBeNull();
    expect(res.eligible).toEqual([]);
    // Still retained as failover inventory (§10), never deactivated.
    expect(res.ranked).toHaveLength(2);
  });
});

describe('quotaRanking: tie-break path', () => {
  it('uses configured priority ONLY when every reset timestamp is identical', () => {
    const accounts = [
      { id: 'a', priority: 9, windows: [w('weekly (7d)', 900, 5000, iso(3 * DAY))] },
      { id: 'b', priority: 1, windows: [w('weekly (7d)', 900, 5000, iso(3 * DAY))] },
      { id: 'c', priority: 5, windows: [w('weekly (7d)', 900, 5000, iso(3 * DAY))] },
    ];
    expect(rankAccounts(accounts, { now: NOW }).ranked.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('never lets priority override a sooner-resetting longest window', () => {
    const accounts = [
      { id: 'a', priority: 1, windows: [w('weekly (7d)', 900, 5000, iso(6 * DAY))] },
      { id: 'b', priority: 99, windows: [w('weekly (7d)', 900, 5000, iso(1 * DAY))] },
    ];
    expect(selectAccount(accounts, { now: NOW })).toBe('b');
  });

  it('prefers the previous pin over priority on an exact reset tie (no round-robin)', () => {
    const accounts = [
      { id: 'a', priority: 1, windows: [w('weekly (7d)', 900, 5000, iso(3 * DAY))] },
      { id: 'b', priority: 2, windows: [w('weekly (7d)', 900, 5000, iso(3 * DAY))] },
    ];
    expect(selectAccount(accounts, { now: NOW, previousPinId: 'b' })).toBe('b');
    // and the pin is genuinely load-bearing, not a coincidence of input order
    expect(selectAccount(accounts, { now: NOW })).toBe('a');
  });

  it('a missing priority is unbounded, so a configured one outranks it', () => {
    const accounts = [
      { id: 'a', windows: [w('weekly (7d)', 900, 5000, iso(3 * DAY))] },
      { id: 'b', priority: 7, windows: [w('weekly (7d)', 900, 5000, iso(3 * DAY))] },
    ];
    expect(selectAccount(accounts, { now: NOW })).toBe('b');
  });

  it('orders unknown-confidence evidence behind fresh evidence, without dropping it', () => {
    const accounts = [
      { id: 'a', windows: [w('weekly (7d)', 900, 5000, iso(1 * DAY), 'unknown')] },
      { id: 'b', windows: [w('weekly (7d)', 900, 5000, iso(6 * DAY), 'fresh')] },
    ];
    const res = rankAccounts(accounts, { now: NOW });
    expect(res.winner.id).toBe('b');
    expect(res.eligible.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('quotaRanking: null resetAt is not usable entitlement (overlay-spec §1, strict)', () => {
  it('falls an account with a null resetAt out of ranking rather than sorting it first', () => {
    const r = normalizeAccountWindows([w('weekly (7d)', 0, 5000, null)]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-resetAt:weekly (7d)');
  });

  it('ranks a member with a null resetAt LAST instead of taking the pool down with it', () => {
    const accounts = [
      { id: 'a', windows: [w('weekly (7d)', 900, 5000, iso(6 * DAY))] },
      { id: 'b', windows: [w('weekly (7d)', 0, 5000, null)] },
    ];
    const res = rankAccounts(accounts, { now: NOW, previousPinId: 'a' });
    // The pool still ranks. An account we cannot read is a worse bet than one
    // we can, so it sorts behind every readable account — but an evidence gap
    // is not evidence of depletion, so it is never taken out of service, and
    // it never drags a readable sibling out of ranking either.
    expect(res.degraded).toBe(false);
    expect(res.winner.id).toBe('a');
    expect(res.ranked.map((r) => r.id)).toEqual(['a', 'b']);
    expect(res.eligible.map((r) => r.id)).toEqual(['a', 'b']);
    const b = res.ranked.find((r) => r.id === 'b');
    expect(b.evidenceBand).toBe(2);
    expect(b.reason).toContain('bad-resetAt');
  });

  it('rejects an unparseable resetAt on the same strict grounds', () => {
    expect(normalizeAccountWindows([w('weekly (7d)', 10, 100, 'not-a-date')]).ok).toBe(false);
    expect(normalizeAccountWindows([w('weekly (7d)', 10, 100, '')]).ok).toBe(false);
  });
});

describe('quotaRanking: mixed window shapes and clock injection', () => {
  it('ranks a mixed-shape pool on each account own binding window', () => {
    // A reports one window, B reports two. This is not an anomaly, it is what
    // a real pool looks like: plan tier and recent usage both change which
    // windows a provider reports, and an account that has not touched its 5h
    // window in the current period reports no 5h window at all. Requiring one
    // shared shape refused to rank roughly a third of live switches.
    const accounts = [
      { id: 'a', windows: [w('weekly (7d)', 900, 5000, iso(3 * DAY))] },
      {
        id: 'b',
        windows: [w('session (5h)', 90, 300, iso(HOUR)), w('weekly (7d)', 900, 5000, iso(3 * DAY))],
      },
    ];
    const res = rankAccounts(accounts, { now: NOW });
    expect(res.degraded).toBe(false);
    // Both main quotas reset at 3d, so the binding key ties and the nearest
    // deadline of any horizon decides: B holds 90 units that are gone in an
    // hour, so B is what has to be spent first or lost.
    expect(res.ranked.map((r) => r.bindingResetAt)).toEqual([
      Date.parse(iso(3 * DAY)),
      Date.parse(iso(3 * DAY)),
    ]);
    expect(res.eligible.map((r) => r.id)).toEqual(['b', 'a']);
    expect(res.winner.id).toBe('b');
  });

  it('degrades ONLY when no account anywhere carries a deadline', () => {
    const res = rankAccounts([{ id: 'a', windows: [] }, { id: 'b', windows: [] }], {
      now: NOW,
      previousPinId: 'b',
    });
    expect(res.degraded).toBe(true);
    expect(res.reason).toBe('no-quota-evidence');
    // An ordering fallback, never an eligibility one: with no evidence there
    // is nothing that could prove either account depleted, so both stay
    // routable and the previous pin leads.
    expect(res.eligible.map((r) => r.id)).toEqual(['b', 'a']);
    expect(res.winner.id).toBe('b');
  });

  it('short-circuits a single-member cohort with no ranking work', () => {
    const res = rankAccounts([{ id: 'solo', windows: [w('weekly (7d)', 10, 100, iso(DAY))] }], {
      now: NOW,
    });
    expect(res.degraded).toBe(false);
    expect(res.winner.id).toBe('solo');
  });

  it('refuses to run without an injected clock', () => {
    const accounts = [{ id: 'a', windows: [w('weekly (7d)', 10, 100, iso(DAY))] }];
    expect(() => rankAccounts(accounts, {})).toThrow(TypeError);
    expect(() => rankAccounts(accounts, { now: 'whenever' })).toThrow(/injected/);
  });

  it('accepts a Date as well as an epoch number, with identical results', () => {
    const accounts = [
      { id: 'a', windows: [w('weekly (7d)', 900, 5000, iso(6 * DAY))] },
      { id: 'b', windows: [w('weekly (7d)', 900, 5000, iso(1 * DAY))] },
    ];
    expect(selectAccount(accounts, { now: new Date(NOW) })).toBe(
      selectAccount(accounts, { now: NOW })
    );
  });

  it('is a total order — the same inputs always produce the same ranking', () => {
    const accounts = [
      { id: 'a', windows: [w('weekly (7d)', 900, 5000, iso(3 * DAY))] },
      { id: 'b', windows: [w('weekly (7d)', 900, 5000, iso(3 * DAY))] },
      { id: 'c', windows: [w('weekly (7d)', 900, 5000, iso(3 * DAY))] },
    ];
    const once = rankAccounts(accounts, { now: NOW }).ranked.map((r) => r.id);
    for (let i = 0; i < 5; i += 1) {
      expect(rankAccounts(accounts, { now: NOW }).ranked.map((r) => r.id)).toEqual(once);
    }
  });

  it('returns no winner for an empty cohort instead of throwing', () => {
    const res = rankAccounts([], { now: NOW });
    expect(res.winner).toBeNull();
    expect(res.reason).toBe('empty-cohort');
  });
});
