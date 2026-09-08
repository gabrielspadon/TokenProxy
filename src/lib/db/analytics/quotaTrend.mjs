import { quotaIntervalEvidence } from './quotaReplenishment.mjs';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const QUOTA_TREND_METHOD = Object.freeze({
  version: 'observed-interval-median-v1',
  minimumSamples: 5,
  minimumSpanMs: 15 * MINUTE,
  maximumGapIntervals: 4,
  staleCadenceMultiplier: 2,
  minimumStaleMs: 5 * MINUTE,
  maximumStaleMs: HOUR,
  rateRange: 'observed-minimum-maximum',
});
const numeric = (value) => typeof value === 'number' && Number.isFinite(value);
const instant = (value) => (typeof value === 'string' && value.trim() ? Date.parse(value) : NaN);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const timestamp = (value) =>
  Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : null;

// This is a dated, local sensitivity calculation. It does not predict provider
// replenishment, infer present balances, or combine unlike quota resources.
export function analyzeQuotaSeries(rows, { asOf, measurement = 'absolute' } = {}) {
  if (!['absolute', 'percentage'].includes(measurement) || !Number.isFinite(instant(asOf))) {
    throw new TypeError('Invalid quota analysis options');
  }
  const unit = measurement === 'percentage' ? 'percentage points' : (rows[0]?.unit ?? null);
  const points = rows.map((row) => ({
    id: row.id,
    observedAt: row.observedAt,
    capturedAt: row.capturedAt,
    time: instant(row.observedAt),
    value: measurement === 'percentage' ? row.percentage : row.remaining,
    limit: measurement === 'percentage' ? 100 : row.limit,
    resetAt: row.resetAt,
    windowType: row.windowType,
  }));
  const result = {
    method: QUOTA_TREND_METHOD,
    asOf,
    measurement,
    unit,
    sampleCount: rows.length,
    segmentSampleCount: 0,
    spanMs: null,
    observationAgeMs: null,
    staleAfterMs: null,
    last: null,
    rate: null,
    resetAt: null,
    increases: [],
    conflictingTimes: [],
    evidence: quotaIntervalEvidence(rows, { asOf, measurement }),
    state: 'insufficient_samples',
  };
  if (!rows.length) return result;
  const timed = points
    .filter((point) => Number.isFinite(point.time))
    .sort((a, b) => a.time - b.time || String(a.id).localeCompare(String(b.id)));
  const distinct = [];
  for (const point of timed) {
    const previous = distinct.at(-1);
    if (point.time === previous?.time) {
      if (
        point.value !== previous.value ||
        point.limit !== previous.limit ||
        point.resetAt !== previous.resetAt
      ) {
        if (!result.conflictingTimes.includes(point.observedAt))
          result.conflictingTimes.push(point.observedAt);
      }
    } else distinct.push(point);
  }
  const last = distinct.at(-1);
  if (last) {
    result.last = {
      id: last.id,
      value: numeric(last.value) ? last.value : null,
      observedAt: last.observedAt,
      capturedAt: last.capturedAt,
    };
    result.observationAgeMs = instant(asOf) - last.time;
    result.resetAt = Number.isFinite(instant(last.resetAt))
      ? new Date(last.resetAt).toISOString()
      : null;
  }
  const stop = (state) => ({ ...result, state });
  if (timed.length !== points.length) return stop('unknown_observation_time');
  if (result.conflictingTimes.length) return stop('ambiguous_observations');
  if (result.observationAgeMs < 0) return stop('future_observation');
  if (!unit || !numeric(last?.value)) return stop('missing_measurement');
  if (last.value < 0 || (numeric(last.limit) && (last.limit < 0 || last.value > last.limit)))
    return stop('inconsistent_measurement');

  let segment = [];
  for (const point of distinct) {
    if (
      !numeric(point.value) ||
      point.value < 0 ||
      (numeric(point.limit) && point.value > point.limit)
    ) {
      segment = [];
      continue;
    }
    const previous = segment.at(-1);
    if (previous && point.value > previous.value && point.limit === previous.limit) {
      result.increases.push({
        beforeId: previous.id,
        afterId: point.id,
        observedAt: point.observedAt,
        amount: point.value - previous.value,
        unit,
        resetConfirmed: false,
      });
    }
    if (
      previous &&
      (point.value > previous.value ||
        point.limit !== previous.limit ||
        point.resetAt !== previous.resetAt)
    )
      segment = [];
    segment.push(point);
  }
  result.segmentSampleCount = segment.length;
  if (segment.length < QUOTA_TREND_METHOD.minimumSamples) return stop('insufficient_samples');
  result.spanMs = last.time - segment[0].time;
  if (result.spanMs < QUOTA_TREND_METHOD.minimumSpanMs) return stop('short_span');
  const intervals = segment.slice(1).map((point, index) => point.time - segment[index].time);
  const cadence = median(intervals);
  result.staleAfterMs = Math.min(
    QUOTA_TREND_METHOD.maximumStaleMs,
    Math.max(QUOTA_TREND_METHOD.minimumStaleMs, cadence * QUOTA_TREND_METHOD.staleCadenceMultiplier)
  );
  if (result.observationAgeMs > result.staleAfterMs) return stop('stale');
  if (Math.max(...intervals) > cadence * QUOTA_TREND_METHOD.maximumGapIntervals)
    return stop('observation_gap');
  if (last.windowType === 'rolling') return stop('rolling_replenishment_unknown');
  if (result.resetAt && instant(result.resetAt) <= instant(asOf)) return stop('reset_elapsed');
  const rates = segment
    .slice(1)
    .map((point, index) => ((segment[index].value - point.value) * HOUR) / intervals[index]);
  result.rate = {
    median: median(rates),
    minimum: Math.min(...rates),
    maximum: Math.max(...rates),
    unit: `${unit}/hour`,
  };
  if (
    !Object.values(result.rate)
      .filter((value) => typeof value === 'number')
      .every(Number.isFinite)
  )
    return stop('inconsistent_measurement');
  return stop(result.rate.median > 0 ? 'available' : 'no_observed_consumption');
}

export function projectQuotaScenario(analysis, { multiplier = 1, available = true } = {}) {
  if (!numeric(multiplier) || multiplier < 0.1 || multiplier > 10 || typeof available !== 'boolean')
    throw new TypeError('Invalid quota scenario');
  const result = {
    state: available ? analysis.state : 'account_excluded',
    multiplier,
    available,
    basis: 'constant-observed-consumption-scaled-linearly',
    balanceObservedAt: analysis.last?.observedAt ?? null,
    exhaustionAt: null,
    earliestAt: null,
    latestAt: null,
    projectedWithoutResetAt: null,
    resetAt: analysis.resetAt,
    beforeReset: null,
    deadlineBeforeAsOf: false,
  };
  if (!available || analysis.state !== 'available') return result;
  const horizon = (rate) =>
    rate > 0
      ? timestamp(
          instant(analysis.last.observedAt) + (analysis.last.value / (rate * multiplier)) * HOUR
        )
      : null;
  const central = horizon(analysis.rate.median),
    earliest = horizon(analysis.rate.maximum),
    latest = horizon(analysis.rate.minimum);
  result.projectedWithoutResetAt = central;
  if (!central) return { ...result, state: 'unrepresentable_horizon' };
  result.beforeReset =
    analysis.resetAt && central ? instant(central) < instant(analysis.resetAt) : null;
  if (result.beforeReset === false) return { ...result, state: 'reset_before_exhaustion' };
  result.exhaustionAt = central;
  result.earliestAt = earliest;
  // A range extending beyond a recorded reset is not a forecast of that cycle.
  result.latestAt =
    latest && (!analysis.resetAt || instant(latest) < instant(analysis.resetAt)) ? latest : null;
  result.deadlineBeforeAsOf = central ? instant(central) < instant(analysis.asOf) : false;
  return result;
}
