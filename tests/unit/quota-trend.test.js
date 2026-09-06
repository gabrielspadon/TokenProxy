import { describe, expect, it } from 'vitest';
import { analyzeQuotaSeries, projectQuotaScenario } from '@/lib/db/analytics/quotaTrend.mjs';

const minute = 60_000;
const start = Date.parse('2026-09-06T10:00:00Z');
const at = (minutes) => new Date(start + minutes * minute).toISOString();
function samples(values = [100, 90, 80, 70, 60], extra = {}) {
  return values.map((remaining, i) => ({
    id: `sample-${i}`,
    observedAt: at(i * 5),
    capturedAt: at(i * 5 + 1),
    remaining,
    limit: 100,
    unit: 'requests',
    percentage: remaining,
    resetAt: at(180),
    ...extra,
  }));
}
const analyze = (rows, asOf = at(22)) =>
  analyzeQuotaSeries(rows, { asOf, measurement: 'absolute' });

describe('quota trend evidence', () => {
  it('uses all distinct observed intervals and exposes a dated balance and rate units', () => {
    const result = analyze(samples());
    expect(result).toMatchObject({
      state: 'available',
      measurement: 'absolute',
      unit: 'requests',
      sampleCount: 5,
      segmentSampleCount: 5,
      last: { id: 'sample-4', value: 60, observedAt: at(20) },
      rate: { median: 120, minimum: 120, maximum: 120, unit: 'requests/hour' },
      observationAgeMs: 2 * minute,
      staleAfterMs: 10 * minute,
    });
    expect(projectQuotaScenario(result, { multiplier: 2 })).toMatchObject({
      state: 'available',
      exhaustionAt: at(35),
      earliestAt: at(35),
      latestAt: at(35),
      beforeReset: true,
    });
  });
  it('does not equate percentage points with tokens, money or a synthetic absolute denominator', () => {
    const rows = samples().map((row) => ({ ...row, unit: null, remaining: null, limit: null }));
    const result = analyzeQuotaSeries(rows, { asOf: at(22), measurement: 'percentage' });
    expect(result.unit).toBe('percentage points');
    expect(result.rate.unit).toBe('percentage points/hour');
    expect(result.last.value).toBe(60);
    expect(analyze(rows).state).toBe('missing_measurement');
  });
  it('requires five distinct samples and 15 minutes of observation', () => {
    expect(analyze(samples().slice(1)).state).toBe('insufficient_samples');
    expect(
      analyze(
        samples().map((row, i) => ({ ...row, observedAt: at(i) })),
        at(5)
      ).state
    ).toBe('short_span');
    const duplicate = { ...samples()[4], id: 'duplicate' };
    expect(analyze([...samples(), duplicate]).segmentSampleCount).toBe(5);
  });
  it('preserves contradictory observations at one timestamp and refuses a forecast', () => {
    expect(
      analyze([...samples(), { ...samples()[2], id: 'conflict', remaining: 79 }])
    ).toMatchObject({
      state: 'ambiguous_observations',
      conflictingTimes: [at(10)],
    });
  });
  it('keeps zero-rate intervals and represents an unbounded slow horizon honestly', () => {
    const result = analyze(samples([100, 100, 80, 80, 60]));
    expect(result.rate).toMatchObject({ minimum: 0, median: 120, maximum: 240 });
    expect(projectQuotaScenario(result)).toMatchObject({
      earliestAt: at(35),
      exhaustionAt: at(50),
      latestAt: null,
    });
    expect(analyze(samples([60, 60, 60, 60, 60])).state).toBe('no_observed_consumption');
  });
  it('separates observed replenishment from proof of a reset and starts a fresh segment', () => {
    const result = analyze(samples([100, 80, 60, 90, 70]));
    expect(result).toMatchObject({ state: 'insufficient_samples', segmentSampleCount: 2 });
    expect(result.increases).toEqual([
      {
        beforeId: 'sample-2',
        afterId: 'sample-3',
        observedAt: at(15),
        amount: 30,
        unit: 'requests',
        resetConfirmed: false,
      },
    ]);
  });
  it.each(['limit', 'resetAt'])('starts a new segment when %s changes', (field) => {
    const rows = samples();
    rows[4][field] = field === 'limit' ? 200 : at(360);
    expect(analyze(rows)).toMatchObject({ state: 'insufficient_samples', segmentSampleCount: 1 });
  });
  it('breaks at missing measurements, unknown time and a large observation gap', () => {
    const rows = samples();
    rows[2].remaining = null;
    expect(analyze(rows).segmentSampleCount).toBe(2);
    expect(
      analyze([...samples(), { ...samples()[4], id: 'untimed', observedAt: null }]).state
    ).toBe('unknown_observation_time');
    expect(
      analyze(
        samples().map((row, i) => ({ ...row, observedAt: at(i === 4 ? 70 : i * 5) })),
        at(71)
      ).state
    ).toBe('observation_gap');
  });
  it('rejects stale, future and rolling-window extrapolation without inventing a current balance', () => {
    expect(analyze(samples(), at(31))).toMatchObject({ state: 'stale', last: { value: 60 } });
    expect(analyze(samples(), at(19)).state).toBe('future_observation');
    expect(analyze(samples(undefined, { windowType: 'rolling' })).state).toBe(
      'rolling_replenishment_unknown'
    );
  });
  it('does not project past a known reset as evidence of availability or replenishment', () => {
    const result = analyze(samples(undefined, { resetAt: at(40) }));
    expect(projectQuotaScenario(result)).toMatchObject({
      state: 'reset_before_exhaustion',
      exhaustionAt: null,
      projectedWithoutResetAt: at(50),
      resetAt: at(40),
    });
    expect(analyze(samples(undefined, { resetAt: at(21) })).state).toBe('reset_elapsed');
  });
  it('validates scenario controls and cannot infer redistribution onto other accounts', () => {
    expect(projectQuotaScenario(analyze(samples()), { available: false })).toMatchObject({
      state: 'account_excluded',
      exhaustionAt: null,
    });
    for (const multiplier of [0, -1, Infinity, NaN, '2', 11])
      expect(() => projectQuotaScenario(analyze(samples()), { multiplier })).toThrow();
    expect(() => projectQuotaScenario(analyze(samples()), { available: 'false' })).toThrow();
  });
  it('rejects inconsistent absolute balances and never converts null to zero', () => {
    expect(analyze(samples(undefined, { limit: 10 })).state).toBe('inconsistent_measurement');
    expect(analyze(samples(undefined, { remaining: null })).state).toBe('missing_measurement');
    expect(analyze(samples([20, 15, 10, 5, 0])).last.value).toBe(0);
  });
});
