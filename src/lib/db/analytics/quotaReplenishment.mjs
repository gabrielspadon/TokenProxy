const HOUR = 3_600_000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;
const iso = value => Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : null;

/** Net balance deltas cannot identify simultaneous consumption and replenishment. */
export function quotaIntervalEvidence(rows, { asOf, measurement = 'absolute' } = {}) {
  const end = time(asOf), unit = measurement === 'percentage' ? 'percentage points' : rows[0]?.unit ?? null;
  const sorted = rows.toSorted((a, b) => time(a.observedAt) - time(b.observedAt));
  const result = { unit, intervals: [], observedDepletion: 0, observedReplenishment: 0,
    grossConsumption: null, grossReplenishment: null, censoredIntervals: 0, knownResetDeadlines: [],
    rollingReleaseEnvelopes: [], rateUnit: unit ? `${unit}/hour` : null,
    assumptions: ['Balance changes are net observations; concurrent consumption, replenishment and corrections are not identifiable.',
      'A reported reset is a deadline, not evidence of a completed reset.',
      'Rolling expiry envelopes cover only retained net depletion, conditional on unchanged duration and no balance correction. They are not a total recovery forecast.'] };
  for (const row of sorted) if (Number.isFinite(time(row.resetAt))) result.knownResetDeadlines.push({ observationId: row.id, at: row.resetAt, completed: false, windowType: row.windowType ?? 'unknown' });
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1], after = sorted[i];
    const from = time(before.observedAt), to = time(after.observedAt);
    const a = measurement === 'percentage' ? before.percentage : before.remaining;
    const b = measurement === 'percentage' ? after.percentage : after.remaining;
    const limitA = measurement === 'percentage' ? 100 : before.limit, limitB = measurement === 'percentage' ? 100 : after.limit;
    const valid = Number.isFinite(from) && Number.isFinite(to) && to > from && to <= end && finite(a) && finite(b)
      && a >= 0 && b >= 0 && (!finite(limitA) || a <= limitA) && (!finite(limitB) || b <= limitB)
      && limitA === limitB && before.windowType === after.windowType && before.windowDurationMs === after.windowDurationMs
      && (before.unit ?? null) === (after.unit ?? null)
      && (before.observationKind ?? 'observed') === 'observed' && (after.observationKind ?? 'observed') === 'observed';
    if (!valid) { result.censoredIntervals++; continue; }
    const change = b - a;
    const crossedReset = after.windowType !== 'rolling' && Number.isFinite(time(before.resetAt)) && from < time(before.resetAt) && to >= time(before.resetAt);
    result.intervals.push({ beforeId: before.id, afterId: after.id, start: before.observedAt, end: after.observedAt,
      netChange: change, netChangePerHour: change * HOUR / (to - from), unit, crossedReportedReset: crossedReset,
      kind: change > 0 ? 'observed-net-replenishment' : change < 0 ? 'observed-net-depletion' : 'unchanged-net-balance' });
    result.observedDepletion += Math.max(0, -change);
    result.observedReplenishment += Math.max(0, change);
    const duration = after.windowDurationMs;
    if (after.windowType === 'rolling' && finite(duration) && duration > 0 && change < 0 && to - from < duration && to + duration > end) {
      result.rollingReleaseEnvelopes.push({ beforeId: before.id, afterId: after.id,
        earliestAt: iso(from + duration), latestAt: iso(to + duration), observedNetDepletion: -change, unit,
        status: from + duration <= end ? 'partially-elapsed-censored' : 'conditional-future-expiry', guaranteedAmount: null });
    }
  }
  return result;
}
