import { describe, expect, it } from 'vitest';
import {
  accountBucket,
  accountStateWord,
  credentialModes,
  filterAccounts,
  fleetSummary,
  providerList,
  resetShort,
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
    expect(accountBucket(stale, NOW)).toBe('ready');
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
  it('flattens product groups into labelled lines', () => {
    const codex = account({}, [
      { key: 'spark_weekly', remainingPercentage: 50 },
      { key: 'session', remainingPercentage: 60 },
      { key: 'Weekly (7d)', remainingPercentage: 20 },
    ]);
    expect(windowLines(codex).map((line) => line.label)).toEqual([
      'Session',
      'Codex Spark · Weekly',
      'Weekly (7d)',
    ]);
  });
  it('shortens reset labels without inventing a replenishment', () => {
    expect(resetShort({ resetAt: minutes(95) }, NOW)).toBe('resets in 1h 35m');
    expect(resetShort({ resetAt: minutes(-1) }, NOW)).toBe('reset passed');
    expect(resetShort({ resetAt: null }, NOW)).toBe('no reset time');
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
