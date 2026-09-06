import { describe, expect, it } from 'vitest';
import { economicRange, economicTrendRows } from '../../src/shared/components/workspace/economicsTrend';
import { groupName } from '../../src/shared/components/workspace/economics';

describe('economic time observations', () => {
  it('uses actual health account display names instead of mislabeling configured accounts as historical', () => {
    expect(groupName({ connectionId: 'configured' }, 'account', [{ connectionId: 'configured', displayName: 'Personal account' }])).toBe('Personal account');
  });
  it('preserves observed zero, unknown samples, invalid quantities and unobserved time gaps', () => {
    const rows = economicTrendRows([
      { bucketStartMs: 60000, recordedCostUsd: 0, costSamples: 1, outputTokens: 0, outputSamples: 0, cacheReadTokens: Infinity, cacheReadSamples: 1 },
      { bucketStartMs: 180000, recordedCostUsd: 0, costSamples: 0, cacheReadTokens: 500, cacheReadSamples: 1, inconsistentCacheRows: 2 },
    ], 60000);
    expect(rows).toHaveLength(3);
    expect(rows[0].values).toEqual([0, null, null, null, null]);
    expect(rows[1]).toMatchObject({ bucketStartMs: 120000, gap: true, values: [null, null, null, null, null] });
    expect(rows[2].values).toEqual([null, null, 500, null, null]);
    expect(rows[2].inconsistentCacheRows).toBe(2);
  });
  it('clamps partial buckets to the current exact scope without expanding or emptying a selection', () => {
    const filters = { start: '2026-09-06T10:01:00Z', end: '2026-09-06T10:07:00Z' };
    expect(economicRange(Date.parse('2026-09-06T10:00:00Z'), Date.parse('2026-09-06T10:08:00Z'), filters))
      .toEqual(['2026-09-06T10:01:00.000Z', '2026-09-06T10:07:00.000Z']);
    expect(economicRange(NaN, 0)).toBeNull();
    expect(economicRange(2, 1)).toBeNull();
    expect(economicRange(0, 1, filters)).toBeNull();
  });
});
