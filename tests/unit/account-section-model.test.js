// Which section an account falls into on the capacity board.
//
// The board and the router have to agree about the word "depleted", and they
// did not. These assertions are the router's own rules restated in the board's
// units, each citing where it came from:
//   - a replenished window reads full   src/shared/utils/quotaRanking.js:295
//   - the provider agrees past a reset  open-sse/services/accountFallback.js:290
//   - ANY exhausted window benches      src/shared/utils/quotaRanking.js:296
//   - general vs scoped windows         src/shared/utils/quotaRanking.js:132
//   - fresh / stale / unknown evidence  src/shared/utils/quotaRanking.js:312,323
import { describe, expect, it } from 'vitest';
import {
  SECTIONS,
  accountDepleted,
  accountEvidence,
  accountProven,
  accountReturnsAt,
  accountSection,
  accountStateWord,
  orderSection,
  sectionSummary,
  windowHeadroom,
  windowReplenished,
} from '@/app/dashboard/accountBoardModel';

const NOW = Date.parse('2026-09-09T12:00:00Z');
const minutes = (value) => new Date(NOW + value * 60000).toISOString();

const account = (
  overrides = {},
  windows = [{ key: 'weekly', remainingPercentage: 60, resetAt: minutes(3000) }]
) => ({
  id: 'a',
  connectionId: 'a',
  provider: 'codex',
  authType: 'oauth',
  displayName: 'Account A',
  isActive: true,
  status: 'healthy',
  quotaPauseThresholds: {},
  lastQuotaSnapshot: { fetchedAt: minutes(-2), windows },
  ...overrides,
});

describe('one window, read the way the router reads it', () => {
  it('treats a window whose reset has passed as replenished, not as a zero', () => {
    const rolled = { remaining: 0, resetAt: minutes(-5), unlimited: false };
    expect(windowReplenished(rolled, NOW)).toBe(true);
    // The stored zero describes a period that no longer exists.
    expect(windowHeadroom(rolled, NOW)).toBe(100);
    const running = { remaining: 0, resetAt: minutes(90), unlimited: false };
    expect(windowReplenished(running, NOW)).toBe(false);
    expect(windowHeadroom(running, NOW)).toBe(0);
  });
  it('reads an unlimited window as full and an unreadable one as nothing', () => {
    expect(windowHeadroom({ unlimited: true, remaining: 0 }, NOW)).toBe(100);
    expect(windowHeadroom({ remaining: null, resetAt: minutes(90) }, NOW)).toBeNull();
  });
});

describe('depletion', () => {
  it('does NOT call an account depleted once its reset has elapsed', () => {
    // The exact account the board used to file beside genuinely exhausted
    // ones: last read at zero, and its period has since rolled over.
    const rolled = account({}, [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(-30) }]);
    expect(accountDepleted(rolled, NOW)).toBe(false);
    expect(accountSection(rolled, NOW)).toBe('serving');
  });
  it('benches an account on ANY exhausted general window, not only on all of them', () => {
    // Rule 2: every KNOWN hard window must have headroom. A full 5h window
    // beside an exhausted weekly is not usable capacity, and the board used to
    // render this account as serving.
    const mixed = account({}, [
      { key: 'session', remainingPercentage: 80, resetAt: minutes(90) },
      { key: 'weekly', remainingPercentage: 0, resetAt: minutes(3000) },
    ]);
    expect(accountDepleted(mixed, NOW)).toBe(true);
    expect(accountSection(mixed, NOW)).toBe('resting');
    expect(accountStateWord(mixed, NOW)).toBe('Out of quota');
  });
  it('lets a sub-quota run dry without benching the whole connection', () => {
    // spark_weekly and `weekly opus (7d)` are sub-quotas of one plan, not the
    // account's entitlement; taking the connection out of service for every
    // other model on one of them is the bug classifyWindow exists to prevent.
    const spark = account({}, [
      { key: 'weekly', remainingPercentage: 55, resetAt: minutes(3000) },
      { key: 'spark_weekly', remainingPercentage: 0, resetAt: minutes(3000) },
    ]);
    expect(accountDepleted(spark, NOW)).toBe(false);
    expect(accountSection(spark, NOW)).toBe('serving');
  });
  it('still calls a stale exhausted reading depleted while its period is running', () => {
    const stale = account({
      lastQuotaSnapshot: {
        fetchedAt: minutes(-600),
        windows: [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(3000) }],
      },
    });
    expect(accountDepleted(stale, NOW)).toBe(true);
    expect(accountEvidence(stale, NOW)).toBe('stale');
    expect(accountSection(stale, NOW)).toBe('resting');
  });
});

describe('evidence bands', () => {
  it('names a current reading fresh, an old one stale, and no reading unknown', () => {
    expect(accountEvidence(account(), NOW)).toBe('fresh');
    const old = account({
      lastQuotaSnapshot: {
        fetchedAt: minutes(-30),
        windows: [{ key: 'weekly', remainingPercentage: 60, resetAt: minutes(3000) }],
      },
    });
    expect(accountEvidence(old, NOW)).toBe('stale');
    expect(accountEvidence(account({}, []), NOW)).toBe('unknown');
  });
  it('demotes to stale when one general window could not be read at all', () => {
    const partial = account({}, [
      { key: 'weekly', remainingPercentage: 60, resetAt: minutes(3000) },
      { key: 'session', remainingPercentage: null, resetAt: minutes(90) },
    ]);
    expect(accountEvidence(partial, NOW)).toBe('stale');
  });
  it('ignores a sub-quota when deciding how much is known about the account', () => {
    const spark = account({}, [
      { key: 'weekly', remainingPercentage: 60, resetAt: minutes(3000) },
      { key: 'spark_weekly', remainingPercentage: null, resetAt: null },
    ]);
    expect(accountEvidence(spark, NOW)).toBe('fresh');
  });
});

describe('an account with no quota evidence', () => {
  const blind = (overrides) => account({ ...overrides }, []);
  it('is listed only when something proves it works', () => {
    expect(accountProven(blind({ status: 'healthy' }))).toBe(true);
    expect(accountSection(blind({ status: 'healthy' }), NOW)).toBe('serving');
    const served = blind({ status: 'unqualified', activity: { records: 12, failed: 3 } });
    expect(accountProven(served)).toBe(true);
    expect(accountSection(served, NOW)).toBe('serving');
  });
  it('is not listed when nothing does', () => {
    const untested = blind({ status: 'unqualified' });
    expect(accountProven(untested)).toBe(false);
    expect(accountSection(untested, NOW)).toBe('unverified');
    // Enabled is not a proof, and neither is a run of attempts that all failed.
    const allFailed = blind({ status: 'unqualified', activity: { records: 4, failed: 4 } });
    expect(accountProven(allFailed)).toBe(false);
    expect(accountSection(allFailed, NOW)).toBe('unverified');
  });
});

describe('gates and return times', () => {
  it('files a held account under cooling down whatever its quota says', () => {
    for (const held of [
      { isActive: false },
      { status: 'cooldown' },
      { isDraining: true },
      { status: 'degraded' },
    ])
      expect(accountSection(account(held), NOW)).toBe('resting');
    // A quota pause is the operator's own threshold firing.
    const paused = account({ quotaPauseThresholds: { weekly: 70 } });
    expect(accountSection(paused, NOW)).toBe('resting');
  });
  it('returns when the LAST exhausted window rolls, not the first', () => {
    const both = account({}, [
      { key: 'session', remainingPercentage: 0, resetAt: minutes(90) },
      { key: 'weekly', remainingPercentage: 0, resetAt: minutes(3000) },
    ]);
    expect(accountReturnsAt(both, NOW)).toBe(Date.parse(minutes(3000)));
    // A recorded cooldown is a deadline of the same kind and joins the maximum.
    const cooling = account({ status: 'cooldown', rateLimitedUntil: minutes(4000) }, [
      { key: 'weekly', remainingPercentage: 0, resetAt: minutes(3000) },
    ]);
    expect(accountReturnsAt(cooling, NOW)).toBe(Date.parse(minutes(4000)));
    // An elapsed reset is not a return time; it already happened.
    expect(accountReturnsAt(account(), NOW)).toBeNull();
  });
});

describe('sections', () => {
  const seat = (id, windows, overrides = {}) =>
    account({ id, connectionId: id, displayName: id, ...overrides }, windows);
  it('places every account in exactly one section', () => {
    const counts = sectionSummary(
      [
        account(),
        account({ id: 'b', connectionId: 'b' }, [
          { key: 'weekly', remainingPercentage: 0, resetAt: minutes(3000) },
        ]),
        account({ id: 'c', connectionId: 'c', status: 'unqualified' }, []),
      ],
      NOW
    );
    expect(counts).toEqual({ serving: 1, resting: 1, unverified: 1 });
    expect(Object.keys(counts)).toEqual(SECTIONS.map((item) => item.id));
  });
  it('orders serving by headroom, most first, with a proof-only account last', () => {
    const order = orderSection(
      [
        seat('thin', [{ key: 'weekly', remainingPercentage: 12, resetAt: minutes(3000) }]),
        seat('blind', []),
        seat('fat', [{ key: 'weekly', remainingPercentage: 91, resetAt: minutes(3000) }]),
      ],
      'serving',
      NOW
    );
    expect(order.map((item) => item.id)).toEqual(['fat', 'thin', 'blind']);
  });
  it('orders cooling down by soonest return, with no known return last', () => {
    const order = orderSection(
      [
        seat('late', [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(5000) }]),
        seat('never', [], { isActive: false }),
        seat('soon', [{ key: 'session', remainingPercentage: 0, resetAt: minutes(90) }]),
      ],
      'resting',
      NOW
    );
    expect(order.map((item) => item.id)).toEqual(['soon', 'late', 'never']);
  });
});
