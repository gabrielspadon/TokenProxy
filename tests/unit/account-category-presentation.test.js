// The four presentation categories, and the one mapping that decides them.
//
// Three functions used to answer "what is this account" with three
// vocabularies: accountBucket (seven ids), accountSection (five), and
// accountStateWord reading both. The board rendered two same-weight filter
// strips from two of them, so an operator had to work out that "out of quota"
// lived inside "cooling down", and a card carried data-bucket AND data-section
// at once, which let its dot take one hue while its rail took another.
//
// Every case below asserts the category, the word that still distinguishes the
// accounts inside it, and the fact the card leads with. Those three are
// separate surfaces and the defect was that a wrong answer agreed across all
// of them, so pinning one would not have caught it.
import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  accountCategory,
  accountStateReason,
  accountStateWord,
  categorySummary,
  filterAccounts,
  orderCategory,
  windowLevel,
} from '@/app/dashboard/accountBoardModel';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const minutes = (value) => new Date(NOW + value * 60000).toISOString();

// A healthy, serving account with a readable general window. Every case below
// is this minus exactly one thing.
const account = (overrides = {}, windows = [{ key: 'weekly', remainingPercentage: 60, resetAt: minutes(3000) }]) => ({
  id: 'a',
  connectionId: 'a',
  provider: 'claude',
  // getPausedWindow refuses a row that is not quota-eligible
  // (src/shared/utils/quotaPause.js:19), so an account with no authType can
  // never report a quota pause however its thresholds are set.
  authType: 'oauth',
  displayName: 'Account A',
  isActive: true,
  hasCredential: true,
  status: 'healthy',
  quotaPauseThresholds: {},
  lastQuotaSnapshot: { fetchedAt: minutes(-2), windows },
  ...overrides,
});

describe('exactly four categories, and Low quota is not one of them', () => {
  it('declares the four the brief names, in render order', () => {
    expect(CATEGORIES.map((item) => item.id)).toEqual([
      'active',
      'cooldown',
      'paused',
      'unknown',
    ]);
    expect(CATEGORIES.map((item) => item.label)).toEqual([
      'Active',
      'Cooldown',
      'Paused',
      'Unknown',
    ]);
  });

  it('keeps a low window Active, because it can still take work', () => {
    const low = account({}, [{ key: 'weekly', remainingPercentage: 8, resetAt: minutes(3000) }]);
    expect(accountCategory(low, NOW)).toBe('active');
    // The low reading is not lost: it is evidence, on the meter and in the word.
    expect(accountStateWord(low, NOW)).toBe('Low quota');
    expect(windowLevel({ remaining: 8, threshold: 0, unlimited: false }, NOW)).toBe('low');
  });

  it('files a depleted window under Cooldown, since a clock clears it', () => {
    const empty = account({}, [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(600) }]);
    expect(accountCategory(empty, NOW)).toBe('cooldown');
    expect(accountStateWord(empty, NOW)).toBe('Out of quota');
  });
});

describe('ordered precedence, one rung at a time', () => {
  it('puts a missing credential in Unknown ahead of everything else about it', () => {
    // Also switched off AND out of quota. Neither may answer: a row that cannot
    // authenticate cannot serve whatever else is true of it.
    const row = account({ hasCredential: false, isActive: false }, [
      { key: 'weekly', remainingPercentage: 0, resetAt: minutes(600) },
    ]);
    expect(accountCategory(row, NOW)).toBe('unknown');
    expect(accountStateWord(row, NOW)).toBe('No credential');
  });

  it('separates the operator own hold from a failure that switched the account off', () => {
    const mine = account({ isActive: false, status: 'unqualified' });
    expect(accountCategory(mine, NOW)).toBe('paused');
    expect(accountStateWord(mine, NOW)).toBe('Paused');
    expect(accountStateReason(mine, NOW)).toMatch(/Nothing has failed/);

    const killed = account({ isActive: false, errorCode: 401, lastError: 'x-api-key header is required' });
    expect(accountCategory(killed, NOW)).toBe('unknown');
    expect(accountStateWord(killed, NOW)).toBe('Needs sign-in');
  });

  it('keeps a timed hold in Cooldown and a hold needing a person in Unknown', () => {
    expect(accountCategory(account({ status: 'cooldown' }), NOW)).toBe('cooldown');
    const quotaPause = account({ quotaPauseThresholds: { weekly: 80 } });
    expect(accountCategory(quotaPause, NOW)).toBe('cooldown');
    expect(accountStateWord(quotaPause, NOW)).toBe('Quota pause');
    // Degraded needs a test run by a person, so no clock returns it.
    expect(accountCategory(account({ status: 'degraded' }), NOW)).toBe('unknown');
  });

  it('is Active only when something establishes that it can take work', () => {
    expect(accountCategory(account(), NOW)).toBe('active');
    // No window at all, but it has served: proven, so Active.
    const served = account({ activity: { records: 9, failed: 1 } }, []);
    expect(accountCategory(served, NOW)).toBe('active');
    // No window and nothing proving it. An absence of evidence is not capacity.
    const untested = account({ status: 'unqualified' }, []);
    expect(accountCategory(untested, NOW)).toBe('unknown');
    const allFailed = account({ status: 'unqualified', activity: { records: 4, failed: 4 } }, []);
    expect(accountCategory(allFailed, NOW)).toBe('unknown');
  });

  it('does not read a replenished window as empty', () => {
    // Recorded at 0%, but its period already rolled over, so the provider has
    // handed it a fresh one. The router reads it as full and so must the board.
    const rolled = account({}, [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(-30) }]);
    expect(accountCategory(rolled, NOW)).toBe('active');
  });
});

describe('Unknown is about evidence, never about quota', () => {
  it('never files an account with a readable quota reading under Unknown', () => {
    for (const remaining of [0, 1, 8, 20, 55, 100]) {
      const row = account({}, [{ key: 'weekly', remainingPercentage: remaining, resetAt: minutes(600) }]);
      expect(accountCategory(row, NOW)).not.toBe('unknown');
    }
  });

  it('gives each Unknown account its own reason, so the word is never the whole answer', () => {
    const rows = [
      account({ hasCredential: false }),
      account({ isActive: false, errorCode: 401 }),
      account({ status: 'degraded' }),
      account({ status: 'unqualified' }, []),
    ];
    expect(rows.map((row) => accountCategory(row, NOW))).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
    const words = rows.map((row) => accountStateWord(row, NOW));
    expect(new Set(words).size).toBe(words.length);
    for (const row of rows) expect(accountStateReason(row, NOW)).toBeTruthy();
  });
});

describe('one mapping drives counts, filter and order', () => {
  const fleet = [
    account({ id: 'x', connectionId: 'x' }),
    account({ id: 'y', connectionId: 'y' }, [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(600) }]),
    account({ id: 'z', connectionId: 'z', isActive: false, status: 'unqualified' }),
    account({ id: 'w', connectionId: 'w', hasCredential: false }),
  ];

  it('counts every account exactly once across the four categories', () => {
    const counts = categorySummary(fleet, NOW);
    expect(Object.keys(counts)).toEqual(CATEGORIES.map((item) => item.id));
    expect(counts).toEqual({ active: 1, cooldown: 1, paused: 1, unknown: 1 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(fleet.length);
  });

  it('filters on the same mapping the counts came from', () => {
    for (const item of CATEGORIES) {
      const matched = filterAccounts(fleet, { category: item.id }, NOW);
      expect(matched).toHaveLength(categorySummary(fleet, NOW)[item.id]);
      for (const row of matched) expect(accountCategory(row, NOW)).toBe(item.id);
    }
  });

  it('orders Cooldown by soonest return, because that is what is being waited on', () => {
    const later = account({ id: 'l', connectionId: 'l', displayName: 'Later' }, [
      { key: 'weekly', remainingPercentage: 0, resetAt: minutes(900) },
    ]);
    const sooner = account({ id: 's', connectionId: 's', displayName: 'Sooner' }, [
      { key: 'weekly', remainingPercentage: 0, resetAt: minutes(120) },
    ]);
    expect(orderCategory([later, sooner], 'cooldown', NOW).map((row) => row.displayName)).toEqual([
      'Sooner',
      'Later',
    ]);
  });

  it('orders Active by most headroom, because that is where work goes next', () => {
    const tight = account({ id: 't', connectionId: 't', displayName: 'Tight' }, [
      { key: 'weekly', remainingPercentage: 12, resetAt: minutes(3000) },
    ]);
    const roomy = account({ id: 'r', connectionId: 'r', displayName: 'Roomy' }, [
      { key: 'weekly', remainingPercentage: 90, resetAt: minutes(3000) },
    ]);
    expect(orderCategory([tight, roomy], 'active', NOW).map((row) => row.displayName)).toEqual([
      'Roomy',
      'Tight',
    ]);
  });
});
