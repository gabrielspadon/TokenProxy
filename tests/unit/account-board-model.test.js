import { describe, expect, it } from 'vitest';
import {
  accountBucket,
  accountCapacity,
  accountSeat,
  accountStateWord,
  capacityReturnsAt,
  capacitySummary,
  credentialModes,
  filterAccounts,
  fleetSummary,
  groupBySeat,
  groupCapacity,
  groupReturnsAt,
  providerList,
  resetShort,
  visibleWindowLines,
  windowHiddenId,
  windowLevel,
  windowLines,
} from '@/app/dashboard/accountBoardModel';

const NOW = Date.parse('2026-09-09T12:00:00Z');
const minutes = (value) => new Date(NOW + value * 60000).toISOString();
const account = (
  overrides = {},
  windows = [{ key: 'session', remainingPercentage: 60, resetAt: minutes(90) }]
) => ({
  id: 'a',
  connectionId: 'a',
  provider: 'codex',
  authType: 'oauth',
  name: 'Account A',
  displayName: 'Account A',
  isActive: true,
  status: 'healthy',
  quotaPauseThresholds: {},
  lastQuotaSnapshot: { fetchedAt: minutes(-2), windows },
  ...overrides,
});

describe('account buckets', () => {
  it('reads an enabled healthy account with headroom as ready', () => {
    expect(accountBucket(account(), NOW)).toBe('ready');
    expect(accountStateWord(account(), NOW)).toBe('Ready');
    expect(accountStateWord(account({ status: 'unqualified' }), NOW)).toBe('Ready');
  });
  it('puts a manual pause and a quota pause in the same bucket with distinct words', () => {
    expect(accountBucket(account({ isActive: false }), NOW)).toBe('paused');
    expect(accountStateWord(account({ isActive: false }), NOW)).toBe('Paused');
    const quotaPaused = account({ quotaPauseThresholds: { session: 70 } });
    expect(accountBucket(quotaPaused, NOW)).toBe('paused');
    expect(accountStateWord(quotaPaused, NOW)).toBe('Quota pause');
  });
  it('flags low quota only from fresh known windows', () => {
    const low = account({}, [{ key: 'session', remainingPercentage: 8, resetAt: minutes(90) }]);
    expect(accountBucket(low, NOW)).toBe('low');
    expect(accountStateWord(low, NOW)).toBe('Low quota');
    const stale = account({
      lastQuotaSnapshot: {
        fetchedAt: minutes(-30),
        windows: [{ key: 'session', remainingPercentage: 8, resetAt: minutes(90) }],
      },
    });
    // Stale evidence is not headroom. This asserted 'ready', which is a claim
    // that the account can take work while the only reading it has is older
    // than the staleness line. Measured on the live fleet 2026-09-11: ten of
    // thirty-one windows were inside that line, so two accounts in the SAME
    // real state sorted differently on refresh timing alone — one
    // weekly-depleted account read 'low' and its twin read 'ready'.
    expect(accountBucket(stale, NOW)).toBe('unknown');
    // A window that is present but unreadable is NOT stale: the account was
    // measured, the number just could not be parsed. It keeps its state word.
    const unknown = account({}, [{ key: 'session', remainingPercentage: null, resetAt: null }]);
    expect(accountBucket(unknown, NOW)).toBe('ready');
    const unlimited = account({}, [{ key: 'session', remainingPercentage: 0, unlimited: true }]);
    expect(accountBucket(unlimited, NOW)).toBe('ready');
  });
  it('treats a threshold above 10 as the low line for that window', () => {
    const reserved = account({ quotaPauseThresholds: { session: 30 } }, [
      { key: 'session', remainingPercentage: 35, resetAt: minutes(90) },
    ]);
    expect(accountBucket(reserved, NOW)).toBe('ready');
    const near = account({ quotaPauseThresholds: { session: 40 } }, [
      { key: 'session', remainingPercentage: 35, resetAt: minutes(90) },
    ]);
    expect(accountBucket(near, NOW)).toBe('paused');
  });
  it('keeps the specific gate word for attention states', () => {
    expect(accountStateWord(account({ isDraining: true }), NOW)).toBe('Draining');
    expect(accountStateWord(account({ status: 'cooldown' }), NOW)).toBe('Cooldown');
    expect(accountStateWord(account({ status: 'degraded' }), NOW)).toBe('Attention');
    expect(accountBucket(account({ status: 'degraded' }), NOW)).toBe('attention');
    expect(accountBucket(account({ isActive: undefined, status: 'unknown' }), NOW)).toBe('unknown');
  });
  it('sums every bucket over the given population', () => {
    const summary = fleetSummary(
      [account(), account({ isActive: false }), account({ status: 'cooldown' })],
      NOW
    );
    expect(summary).toEqual({ ready: 1, low: 0, paused: 1, attention: 1, unknown: 0 });
  });
});

describe('capacity axis', () => {
  const seat = (id, windows, overrides = {}) =>
    account({ id, connectionId: id, displayName: id, ...overrides }, windows);
  it('licenses serving only from a live window with headroom', () => {
    expect(accountCapacity(account(), NOW)).toBe('serving');
    const drained = account({}, [{ key: 'session', remainingPercentage: 0, resetAt: minutes(90) }]);
    expect(accountCapacity(drained, NOW)).toBe('returns');
    // One window with room is enough, even beside an exhausted one.
    const mixed = account({}, [
      { key: 'session', remainingPercentage: 0, resetAt: minutes(90) },
      { key: 'weekly', remainingPercentage: 40, resetAt: minutes(3000) },
    ]);
    expect(accountCapacity(mixed, NOW)).toBe('serving');
  });
  it('separates an unmeasured account from a depleted one', () => {
    const stale = account({
      lastQuotaSnapshot: {
        fetchedAt: minutes(-30),
        windows: [{ key: 'session', remainingPercentage: 0, resetAt: minutes(90) }],
      },
    });
    expect(accountCapacity(stale, NOW)).toBe('no-evidence');
    const unlimited = account({}, [{ key: 'session', remainingPercentage: 0, unlimited: true }]);
    expect(accountCapacity(unlimited, NOW)).toBe('no-evidence');
    expect(accountCapacity(account({}, []), NOW)).toBe('no-evidence');
  });
  it('reports the latest reset among an account’s depleted windows', () => {
    const both = account({}, [
      { key: 'session', remainingPercentage: 0, resetAt: minutes(90) },
      { key: 'weekly', remainingPercentage: 0, resetAt: minutes(3000) },
    ]);
    expect(capacityReturnsAt(both, NOW)).toBe(Date.parse(minutes(3000)));
    expect(capacityReturnsAt(account(), NOW)).toBeNull();
  });
  it('counts every account once across the capacity states', () => {
    const drained = account({}, [{ key: 'session', remainingPercentage: 0, resetAt: minutes(90) }]);
    expect(capacitySummary([account(), drained, account({}, [])], NOW)).toEqual({
      serving: 1,
      returns: 1,
      'no-evidence': 1,
    });
  });
  it('splits a login name into its login and its seat', () => {
    expect(accountSeat({ displayName: 'ops@example.test (org)' })).toEqual({
      login: 'ops@example.test',
      seat: 'org',
    });
    expect(accountSeat({ displayName: 'ops@example.test' })).toEqual({
      login: 'ops@example.test',
      seat: null,
    });
  });
  it('groups distinct seats of one login without merging them', () => {
    const groups = groupBySeat([
      seat('ops (org)', [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(3000) }]),
      seat('ops (personal)', [{ key: 'weekly', remainingPercentage: 55, resetAt: minutes(5000) }]),
      seat('other', [{ key: 'session', remainingPercentage: 20, resetAt: minutes(90) }]),
    ]);
    expect(groups.map((group) => group.login)).toEqual(['ops', 'other']);
    const ops = groups.find((group) => group.login === 'ops');
    // Both seats survive the grouping; collapsing them would hide the 55%.
    expect(ops.seats.map((item) => item.seatLabel)).toEqual(['org', 'personal']);
  });
  it('reads a login as serving when any one of its seats can take work', () => {
    const group = groupBySeat([
      seat('ops (org)', [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(3000) }]),
      seat('ops (personal)', [{ key: 'weekly', remainingPercentage: 55, resetAt: minutes(5000) }]),
    ])[0];
    expect(groupCapacity(group, NOW)).toBe('serving');
    const drained = groupBySeat([
      seat('ops (org)', [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(3000) }]),
      seat('ops (personal)', [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(5000) }]),
    ])[0];
    expect(groupCapacity(drained, NOW)).toBe('returns');
    const blind = groupBySeat([seat('ops (org)', [])])[0];
    expect(groupCapacity(blind, NOW)).toBe('no-evidence');
  });
  it('takes the earliest seat return, the opposite of the within-account rule', () => {
    const drained = groupBySeat([
      seat('ops (org)', [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(3000) }]),
      seat('ops (personal)', [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(5000) }]),
    ])[0];
    expect(groupReturnsAt(drained, NOW)).toBe(Date.parse(minutes(3000)));
    const serving = groupBySeat([seat('ops (org)', undefined)])[0];
    expect(groupReturnsAt(serving, NOW)).toBeNull();
  });
});

describe('board filters and labels', () => {
  it('filters by bucket and by a case-insensitive needle over name, email, provider and id', () => {
    const accounts = [
      account(),
      account({
        id: 'b',
        connectionId: 'b',
        displayName: 'Batch',
        email: 'ops@example.test',
        isActive: false,
      }),
    ];
    expect(filterAccounts(accounts, { bucket: 'paused' }, NOW).map((item) => item.id)).toEqual([
      'b',
    ]);
    expect(filterAccounts(accounts, { query: 'OPS@' }, NOW).map((item) => item.id)).toEqual(['b']);
    expect(filterAccounts(accounts, { query: 'codex' }, NOW)).toHaveLength(2);
    expect(filterAccounts(accounts, { query: '  ' }, NOW)).toHaveLength(2);
  });
  it('composes the capacity axis with the health axis rather than replacing it', () => {
    const drained = account({ id: 'c', connectionId: 'c', isActive: false }, [
      { key: 'session', remainingPercentage: 0, resetAt: minutes(90) },
    ]);
    const accounts = [account(), drained];
    expect(filterAccounts(accounts, { capacity: 'returns' }, NOW).map((item) => item.id)).toEqual([
      'c',
    ]);
    expect(filterAccounts(accounts, { capacity: 'serving' }, NOW).map((item) => item.id)).toEqual([
      'a',
    ]);
    // Both axes at once narrow to the intersection; the drained account is
    // also paused, so it survives both filters together.
    expect(
      filterAccounts(accounts, { capacity: 'returns', bucket: 'paused' }, NOW).map((i) => i.id)
    ).toEqual(['c']);
    expect(filterAccounts(accounts, { capacity: 'returns', bucket: 'ready' }, NOW)).toHaveLength(0);
  });
  it('flattens product groups into labelled lines', () => {
    const codex = account({}, [
      { key: 'spark_weekly', remainingPercentage: 50 },
      { key: 'session', remainingPercentage: 60 },
      { key: 'Weekly (7d)', remainingPercentage: 20 },
    ]);
    expect(windowLines(codex).map((line) => line.label)).toEqual([
      'Session (5h)',
      'Codex Spark · Weekly (7d)',
      'Weekly (7d)',
    ]);
  });
  it('shortens reset labels without inventing a replenishment', () => {
    expect(resetShort({ resetAt: minutes(95) }, NOW)).toBe('in 1h 35m');
    expect(resetShort({ resetAt: minutes(-1) }, NOW)).toBe('passed');
    expect(resetShort({ resetAt: null }, NOW)).toBe('');
  });
  it('lists providers once, sorted', () => {
    expect(
      providerList([account({ provider: 'openai' }), account(), account({ provider: 'openai' })])
    ).toEqual(['codex', 'openai']);
  });
  it('derives credential modes from a registry entry', () => {
    expect(credentialModes({ authModes: ['oauth', 'apikey'] })).toEqual(['oauth', 'apikey']);
    expect(credentialModes({ hasOAuth: true })).toEqual(['oauth', 'apikey']);
    expect(credentialModes({ noAuth: true })).toEqual(['none']);
    expect(credentialModes({ authType: 'cookie' })).toEqual(['cookie']);
    expect(credentialModes({})).toEqual(['apikey']);
  });
});

describe('window visibility', () => {
  const claude = (session, weekly, extra = {}) =>
    account({ provider: 'claude', quotaPauseThresholds: { 'session (5h)': 20 }, ...extra }, [
      { key: 'session (5h)', remainingPercentage: session, resetAt: minutes(90) },
      { key: 'weekly (7d)', remainingPercentage: weekly, resetAt: minutes(3000) },
    ]);
  it('grades a window green, yellow, red or depleted', () => {
    const line = (remaining, threshold = 0) => ({ remaining, threshold, unlimited: false });
    expect(windowLevel(line(80))).toBe('good');
    expect(windowLevel(line(51))).toBe('good');
    expect(windowLevel(line(50))).toBe('warn');
    expect(windowLevel(line(21))).toBe('warn');
    expect(windowLevel(line(20))).toBe('low');
    expect(windowLevel(line(25, 30))).toBe('low');
    expect(windowLevel(line(0))).toBe('depleted');
    expect(windowLevel({ remaining: 50, unlimited: true })).toBeNull();
    expect(windowLevel({ remaining: null })).toBeNull();
  });
  it('hides the session window while the weekly window is depleted and shows it again after', () => {
    const none = new Set();
    const depleted = visibleWindowLines(claude(70, 0), none, NOW);
    expect(depleted.shown.map((line) => line.key)).toEqual(['weekly (7d)']);
    expect(depleted.hidden).toMatchObject([{ key: 'session (5h)', reason: 'depleted' }]);
    const recovered = visibleWindowLines(claude(70, 12), none, NOW);
    expect(recovered.shown.map((line) => line.key)).toEqual(['session (5h)', 'weekly (7d)']);
    expect(recovered.hidden).toEqual([]);
  });
  it('does not let a stale depleted weekly window hide anything', () => {
    const stale = claude(70, 0, {
      lastQuotaSnapshot: {
        fetchedAt: minutes(-600),
        windows: [
          { key: 'session (5h)', remainingPercentage: 70, resetAt: minutes(90) },
          { key: 'weekly (7d)', remainingPercentage: 0, resetAt: minutes(3000) },
        ],
      },
    });
    expect(visibleWindowLines(stale, new Set(), NOW).hidden).toEqual([]);
  });
  it('keeps a manual hide until the person shows the window again, whatever the weekly does', () => {
    const hidden = new Set([windowHiddenId(claude(70, 80), 'weekly (7d)')]);
    const lines = visibleWindowLines(claude(70, 80), hidden, NOW);
    expect(lines.shown.map((line) => line.key)).toEqual(['session (5h)']);
    expect(lines.hidden).toMatchObject([{ key: 'weekly (7d)', reason: 'manual' }]);
    expect(visibleWindowLines(claude(70, 80), new Set(), NOW).hidden).toEqual([]);
  });
  it('scopes the depletion rule to one product', () => {
    const codex = account({}, [
      { key: 'session', remainingPercentage: 50, resetAt: minutes(90) },
      { key: 'weekly', remainingPercentage: 40, resetAt: minutes(3000) },
      { key: 'spark_session', remainingPercentage: 90, resetAt: minutes(90) },
      { key: 'spark_weekly', remainingPercentage: 0, resetAt: minutes(3000) },
    ]);
    const lines = visibleWindowLines(codex, new Set(), NOW);
    expect(lines.shown.map((line) => line.key)).toEqual(['session', 'weekly', 'spark_weekly']);
    expect(lines.hidden.map((line) => line.key)).toEqual(['spark_session']);
  });
});
