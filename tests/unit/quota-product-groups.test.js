import { describe, expect, it } from 'vitest';
import { groupQuotaProducts } from '@/app/dashboard/quotaProductGroups.js';

const windows = keys => keys.map(key => ({ key, remaining: 42, unlimited: false, resetAt: '2026-09-08T12:00:00Z', observedAt: '2026-09-08T10:00:00Z', threshold: 10 }));
const identity = groups => groups.map(group => [group.id, group.label, group.windows.map(window => [window.key, window.label])]);

describe('quota product display groups', () => {
  it('groups the requested synthetic three-period General and Spark example as two products', () => {
    const groups = groupQuotaProducts('codex', windows(['monthly', 'spark_monthly', 'weekly', 'spark_weekly', 'hourly', 'spark_hourly']));
    expect(groups.map(group => [group.label, group.windows.map(window => window.label)])).toEqual([
      ['General', ['Hourly', 'Weekly', 'Monthly']], ['Codex Spark', ['Hourly', 'Weekly', 'Monthly']],
    ]);
  });

  it('renders six adapter-supported windows as two products without dropping collisions', () => {
    const input = windows(['spark_weekly_secondary', 'weekly_secondary', 'spark_weekly', 'session', 'weekly', 'spark_session']);
    const groups = groupQuotaProducts('codex', input);
    expect(groups.map(group => [group.label, group.windows.length])).toEqual([['General', 3], ['Codex Spark', 3]]);
    expect(groups[0].windows.map(window => window.label)).toEqual(['Session', 'Weekly', 'Weekly (secondary)']);
    expect(groups.flatMap(group => group.windows.map(window => window.key)).sort()).toEqual(input.map(window => window.key).sort());
  });

  it('keeps actual Codex review and Spark families separate, including primary collisions', () => {
    const groups = groupQuotaProducts('codex', windows(['review_session', 'spark_session_primary', 'weekly', 'review_weekly', 'spark_session', 'session_primary']));
    expect(groups.map(group => group.id)).toEqual(['general', 'spark', 'review']);
    expect(groups[1].windows.map(window => window.label)).toEqual(['Session', 'Session (primary)']);
    expect(groups[2].label).toBe('Code review');
  });

  it('does not infer a product from unfamiliar provider keys or future periods', () => {
    const keys = ['hourly', 'monthly', 'spark_monthly', 'session', 'weekly', 'spark_session', 'model_weekly', 'day', '__proto__'];
    for (const provider of ['future-provider', '__proto__', 'antigravity']) {
      const groups = groupQuotaProducts(provider, windows(keys));
      expect(groups).toHaveLength(keys.length);
      expect(groups.every(group => group.label === group.windows[0].key && group.windows[0].label === group.label)).toBe(true);
    }
    expect(groupQuotaProducts('codex', windows(['monthly_other', 'spark_pool', 'review_future']))).toHaveLength(3);
  });

  it('preserves unknown, unlimited, zero, raw precision, thresholds and timestamps', () => {
    const input = windows(['session', 'weekly', 'weekly_secondary']);
    Object.assign(input[0], { remaining: null, resetAt: null, observedAt: undefined });
    Object.assign(input[1], { remaining: 0, unlimited: true, threshold: 95 });
    Object.assign(input[2], { remaining: 12.345678, resetAt: 'invalid' });
    const output = groupQuotaProducts('codex', input).flatMap(group => group.windows);
    for (const original of input) {
      const { label, order, ...actual } = output.find(window => window.key === original.key);
      expect(label).toBeTruthy();
      expect(order).toBeTypeOf('number');
      expect(actual).toEqual(original);
    }
  });

  it('does not mutate frozen input and keeps order stable as readings and resets change', () => {
    const input = Object.freeze(windows(['spark_weekly', 'session', 'review_weekly', 'weekly']).map(Object.freeze));
    const first = groupQuotaProducts('codex', input);
    const refreshed = [...input].reverse().map((window, index) => ({ ...window, remaining: index * 10, resetAt: `2027-01-0${index + 1}T00:00:00Z` }));
    expect(identity(groupQuotaProducts('codex', refreshed))).toEqual(identity(first));
    expect(first[0].windows[0]).not.toBe(input[1]);
    expect(groupQuotaProducts('codex', [])).toEqual([]);
  });

  it.each(['minimax', 'minimax-cn'])('groups only exact adapter duration suffixes for %s', provider => {
    const groups = groupQuotaProducts(provider, windows(['M-series (7d)', 'M-series (5h)', 'Other Model (5h)', 'M-series (30d)']));
    expect(groups.map(group => [group.label, group.windows.length])).toEqual([['M-series', 2], ['Other Model', 1], ['M-series (30d)', 1]]);
    expect(groups[0].windows.map(window => window.label)).toEqual(['Session (5h)', 'Weekly (7d)']);
  });

  it('keeps Claude model scopes apart from the general account quota', () => {
    const groups = groupQuotaProducts('claude', windows(['weekly sonnet (7d)', 'weekly (7d)', 'session (5h)', 'weekly opus (7d)', 'spark_session']));
    expect(groups.map(group => [group.label, group.windows.length])).toEqual([['General', 2], ['opus', 1], ['sonnet', 1], ['spark_session', 1]]);
  });

  it.each([
    ['ollama', ['Session (5h)', 'Weekly (7d)']],
    ['opencode-go', ['Monthly', 'Weekly', 'Rolling (5h)']],
    ['kimi', ['Weekly', 'Ratelimit']],
    ['glm', ['session', 'session (2)']],
    ['glm-cn', ['session', 'session (3)']],
  ])('groups known general account windows for %s', (provider, keys) => {
    const groups = groupQuotaProducts(provider, windows(keys));
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('General');
    expect(groups[0].windows).toHaveLength(keys.length);
    expect(groupQuotaProducts('codex', windows(keys)).flatMap(group => group.windows)).toHaveLength(keys.length);
  });
});
