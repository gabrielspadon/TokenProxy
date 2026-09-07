// The evaluator. Pure functions over already-fetched rows, deliberately with no
// database handle, so the SAME code decides a live firing and a dry run. A dry
// run is therefore not a simulation of the evaluator; it is the evaluator, fed
// the retained historical population instead of the trailing window.
//
// Two semantics, declared per condition in conditions.mjs:
//
//   sustained — the predicate must hold across consecutive retained samples
//     spanning at least durationSeconds. A condition true for less than that
//     does not fire. Evidence that goes quiet does not keep a sustain alive:
//     a gap longer than the series' own observed cadence allows breaks it,
//     reusing QUOTA_TREND_METHOD rather than inventing a second staleness rule.
//
//   window — qualifying records are counted inside a trailing window of
//     durationSeconds. The count is the measurement; it fires at the instant
//     the count reaches the threshold.
//
// Cooldown applies identically to both: after a firing at T, the same rule on
// the same scope key cannot fire again before T + cooldownSeconds.

import { QUOTA_TREND_METHOD } from '../db/analytics/quotaTrend.mjs';
import { conditionFor } from './conditions.mjs';

const instant = (value) => (typeof value === 'string' && value.trim() ? Date.parse(value) : NaN);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// How long a series may stay silent before a sustain is considered broken.
// Derived from the samples themselves, exactly as the quota workbench derives
// its own staleness bound, so the two cannot disagree about what "quiet" means.
export function sustainGapAllowanceMs(times) {
  if (times.length < 2) return QUOTA_TREND_METHOD.maximumStaleMs;
  const intervals = times.slice(1).map((time, index) => time - times[index]);
  return Math.min(
    QUOTA_TREND_METHOD.maximumStaleMs,
    Math.max(
      QUOTA_TREND_METHOD.minimumStaleMs,
      median(intervals) * QUOTA_TREND_METHOD.staleCadenceMultiplier
    )
  );
}

export function breaches(condition, value, threshold) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return condition.direction === 'below' ? value <= threshold : value >= threshold;
}

/**
 * Walk one scope key's samples and return every instant at which the rule would
 * fire, cooldown applied.
 *
 * @param {object} rule - { conditionKind, threshold, durationSeconds, cooldownSeconds }
 * @param {Array<{at: string, value: number, ref: string}>} samples - time-ordered.
 * @param {object} options
 * @param {number|null} options.lastFiredAt - epoch ms of the most recent prior
 *   firing for this rule+scope, so cooldown survives across evaluation runs.
 * @returns {Array<{firedAt, breachStartedAt, observedValue, refs, sampleCount}>}
 */
export function evaluateSustained(rule, samples, { lastFiredAt = null } = {}) {
  const condition = conditionFor(rule.conditionKind);
  const durationMs = rule.durationSeconds * 1000;
  const cooldownMs = rule.cooldownSeconds * 1000;
  const ordered = samples
    .map((sample) => ({ ...sample, time: instant(sample.at) }))
    .filter((sample) => Number.isFinite(sample.time))
    .sort((a, b) => a.time - b.time);
  const allowance = sustainGapAllowanceMs(ordered.map((sample) => sample.time));

  const firings = [];
  let cooldownUntil = Number.isFinite(lastFiredAt) ? lastFiredAt + cooldownMs : -Infinity;
  let run = [];
  for (const sample of ordered) {
    const previous = run.at(-1);
    // A silent stretch is not evidence of a continuing breach.
    if (previous && sample.time - previous.time > allowance) run = [];
    if (!breaches(condition, sample.value, rule.threshold)) {
      run = [];
      continue;
    }
    run.push(sample);
    const start = run[0];
    if (sample.time - start.time < durationMs) continue;
    if (sample.time < cooldownUntil) continue;
    firings.push({
      firedAt: new Date(sample.time).toISOString(),
      breachStartedAt: new Date(start.time).toISOString(),
      observedValue: sample.value,
      refs: run.map((entry) => entry.ref).filter(Boolean),
      sampleCount: run.length,
    });
    cooldownUntil = sample.time + cooldownMs;
    // The sustain continues; only the cooldown gates the next firing, so a
    // breach that never clears alerts once per cooldown rather than per sample.
  }
  return firings;
}

/**
 * Count qualifying records in a trailing window and fire when the count reaches
 * the threshold.
 *
 * @param {Array<{at: string, ref: string}>} records - time-ordered occurrences.
 */
export function evaluateWindow(rule, records, { lastFiredAt = null } = {}) {
  const durationMs = rule.durationSeconds * 1000;
  const cooldownMs = rule.cooldownSeconds * 1000;
  const ordered = records
    .map((record) => ({ ...record, time: instant(record.at) }))
    .filter((record) => Number.isFinite(record.time))
    .sort((a, b) => a.time - b.time);

  const firings = [];
  let cooldownUntil = Number.isFinite(lastFiredAt) ? lastFiredAt + cooldownMs : -Infinity;
  for (let index = 0; index < ordered.length; index += 1) {
    const now = ordered[index].time;
    // Trailing window is half-open on the left: a record exactly durationMs old
    // has left the window.
    const inWindow = [];
    for (let back = index; back >= 0 && now - ordered[back].time < durationMs; back -= 1) {
      inWindow.unshift(ordered[back]);
    }
    if (inWindow.length < rule.threshold) continue;
    if (now < cooldownUntil) continue;
    firings.push({
      firedAt: new Date(now).toISOString(),
      breachStartedAt: new Date(inWindow[0].time).toISOString(),
      observedValue: inWindow.length,
      refs: inWindow.map((record) => record.ref).filter(Boolean),
      sampleCount: inWindow.length,
    });
    cooldownUntil = now + cooldownMs;
  }
  return firings;
}

/**
 * Staleness is the one condition measured against the clock rather than against
 * a sample value: the quantity is the AGE of the newest retained observation,
 * which grows without any new record arriving. The predicate (age >= threshold)
 * therefore becomes true at lastObservedAt + threshold, and has been true for
 * durationSeconds once the clock reaches lastObservedAt + threshold + duration.
 *
 * Absence of any observation is reported as unknown, never as fresh.
 */
export function evaluateStaleness(rule, { lastObservedAt, lastRef }, { asOf, lastFiredAt = null }) {
  const observed = instant(lastObservedAt);
  const now = instant(asOf);
  if (!Number.isFinite(now)) throw new TypeError('Staleness evaluation requires asOf');
  if (!Number.isFinite(observed)) {
    return { state: 'no_observation', firings: [] };
  }
  const thresholdMs = rule.threshold * 60_000;
  const durationMs = rule.durationSeconds * 1000;
  const becameStaleAt = observed + thresholdMs;
  const firesAt = becameStaleAt + durationMs;
  if (now < firesAt) return { state: 'fresh_enough', firings: [] };
  if (Number.isFinite(lastFiredAt) && firesAt < lastFiredAt + rule.cooldownSeconds * 1000) {
    return { state: 'cooldown', firings: [] };
  }
  return {
    state: 'stale',
    firings: [
      {
        firedAt: new Date(firesAt).toISOString(),
        breachStartedAt: new Date(becameStaleAt).toISOString(),
        observedValue: (now - observed) / 60_000,
        refs: lastRef ? [lastRef] : [],
        sampleCount: 1,
      },
    ],
  };
}

// Dispatch on the condition's declared role so a caller never picks the wrong
// semantics for a kind.
export function evaluateRule(rule, input, options = {}) {
  const condition = conditionFor(rule.conditionKind);
  if (condition.kind === 'stale_telemetry') return evaluateStaleness(rule, input, options);
  const firings =
    condition.durationRole === 'window'
      ? evaluateWindow(rule, input, options)
      : evaluateSustained(rule, input, options);
  return { state: firings.length ? 'fired' : 'not_fired', firings };
}
