// Duration and cooldown semantics, stated as tests rather than as prose.
// These run against the pure evaluator, which is the same code the live path
// and the dry run both use.
import { describe, expect, it } from 'vitest';
import {
  breaches,
  evaluateRule,
  evaluateStaleness,
  evaluateSustained,
  evaluateWindow,
  sustainGapAllowanceMs,
} from '@/lib/notifications/evaluate.mjs';
import {
  CONDITIONS,
  UNAVAILABLE_CONDITIONS,
  conditionFor,
} from '@/lib/notifications/conditions.mjs';

const MINUTE = 60_000;
const base = new Date('2026-01-01T00:00:00.000Z').getTime();
const at = (minutes) => new Date(base + minutes * MINUTE).toISOString();

// A quota rule: fire when headroom sits at or below 10% for 10 minutes,
// no more than once an hour.
const quotaRule = {
  id: 'r1',
  revision: 1,
  conditionKind: 'quota_risk',
  threshold: 10,
  durationSeconds: 600,
  cooldownSeconds: 3600,
};

// Samples every 2 minutes, so the cadence-derived gap allowance is generous
// enough that an uninterrupted series never trips the staleness break.
const series = (values, { step = 2 } = {}) =>
  values.map((value, index) => ({ at: at(index * step), value, ref: `obs-${index}` }));

describe('duration semantics', () => {
  it('does not fire while the condition has held for less than the duration', () => {
    // Breaching from minute 0, but the last sample is at minute 8 < 10.
    const samples = series([5, 5, 5, 5, 5]);
    expect(evaluateSustained(quotaRule, samples)).toEqual([]);
  });

  it('fires once the condition has held for exactly the duration', () => {
    // Minute 0 through minute 10 inclusive: span is exactly 600s.
    const samples = series([5, 5, 5, 5, 5, 5]);
    const firings = evaluateSustained(quotaRule, samples);
    expect(firings).toHaveLength(1);
    expect(firings[0].breachStartedAt).toBe(at(0));
    expect(firings[0].firedAt).toBe(at(10));
    expect(firings[0].observedValue).toBe(5);
    // Evidence links to every observation in the sustaining run.
    expect(firings[0].refs).toEqual(['obs-0', 'obs-1', 'obs-2', 'obs-3', 'obs-4', 'obs-5']);
  });

  it('a value that recovers restarts the sustain, so a later breach must earn the full duration again', () => {
    //              0  2  4   6(clears) 8  10 12 14 16
    const samples = series([5, 5, 5, 80, 5, 5, 5, 5, 5]);
    const firings = evaluateSustained(quotaRule, samples);
    // The second run starts at minute 8 and reaches 10 minutes at minute 18,
    // which is past the last sample (minute 16), so nothing fires.
    expect(firings).toEqual([]);
  });

  it('a gap longer than the observed cadence allowance breaks the sustain', () => {
    // Two minute cadence, then a two hour silence, then more breaching samples.
    const samples = [
      { at: at(0), value: 5, ref: 'a' },
      { at: at(2), value: 5, ref: 'b' },
      { at: at(4), value: 5, ref: 'c' },
      { at: at(124), value: 5, ref: 'd' },
      { at: at(126), value: 5, ref: 'e' },
    ];
    // Silence is not evidence that the breach persisted through it.
    expect(evaluateSustained(quotaRule, samples)).toEqual([]);
  });

  it('derives the gap allowance from the samples, held between the shared floor and cap', () => {
    // A brisk cadence is floored at QUOTA_TREND_METHOD.minimumStaleMs (5 min),
    // so a momentary lull in fast sampling does not break a sustain.
    expect(sustainGapAllowanceMs([base, base + MINUTE, base + 2 * MINUTE])).toBe(5 * MINUTE);
    // A cadence above the floor is used as measured: 10 min * 2 = 20 min.
    expect(sustainGapAllowanceMs([base, base + 10 * MINUTE, base + 20 * MINUTE])).toBe(20 * MINUTE);
    // A very slow cadence is capped rather than growing without bound.
    expect(sustainGapAllowanceMs([base, base + 600 * MINUTE])).toBe(60 * MINUTE);
    // Too few samples to infer a cadence falls back to the cap.
    expect(sustainGapAllowanceMs([base])).toBe(60 * MINUTE);
  });
});

describe('cooldown semantics', () => {
  it('a rule in cooldown does not re-fire', () => {
    // Breaching continuously for two hours at a 2 minute cadence.
    const samples = series(Array(61).fill(5));
    const firings = evaluateSustained(quotaRule, samples);
    // First at minute 10, then not again until at least minute 70.
    expect(firings.map((firing) => firing.firedAt)).toEqual([at(10), at(70)]);
  });

  it('honours a firing recorded by an earlier evaluation run', () => {
    const samples = series(Array(20).fill(5));
    // Already fired at minute 5; cooldown runs to minute 65, past every sample.
    const firings = evaluateSustained(quotaRule, samples, {
      lastFiredAt: base + 5 * MINUTE,
    });
    expect(firings).toEqual([]);
  });

  it('fires again once the prior cooldown has elapsed', () => {
    const samples = series(Array(40).fill(5));
    const firings = evaluateSustained(quotaRule, samples, {
      lastFiredAt: base - 55 * MINUTE,
    });
    // Cooldown ends at minute 5; the sustain is satisfied from minute 10.
    expect(firings[0].firedAt).toBe(at(10));
  });
});

describe('window semantics', () => {
  const fallbackRule = {
    conditionKind: 'repeated_fallback',
    threshold: 3,
    durationSeconds: 1800,
    cooldownSeconds: 3600,
  };

  it('does not fire below the count threshold', () => {
    const records = [0, 5].map((m) => ({ at: at(m), ref: `s${m}` }));
    expect(evaluateWindow(fallbackRule, records)).toEqual([]);
  });

  it('fires at the instant the count reaches the threshold', () => {
    const records = [0, 5, 10].map((m) => ({ at: at(m), ref: `s${m}` }));
    const firings = evaluateWindow(fallbackRule, records);
    expect(firings).toHaveLength(1);
    expect(firings[0].firedAt).toBe(at(10));
    expect(firings[0].observedValue).toBe(3);
    expect(firings[0].refs).toEqual(['s0', 's5', 's10']);
  });

  it('records that have aged out of the window do not count', () => {
    // 30 minute window: minute 0 has left it by minute 31.
    const records = [0, 29, 31].map((m) => ({ at: at(m), ref: `s${m}` }));
    expect(evaluateWindow(fallbackRule, records)).toEqual([]);
  });

  it('applies cooldown to repeated window breaches', () => {
    const records = Array.from({ length: 12 }, (_, index) => ({
      at: at(index * 5),
      ref: `s${index}`,
    }));
    const firings = evaluateWindow(fallbackRule, records);
    // Reaches 3 at minute 10, then cooldown suppresses until minute 70.
    expect(firings.map((firing) => firing.firedAt)).toEqual([at(10)]);
  });
});

describe('staleness semantics', () => {
  const staleRule = {
    conditionKind: 'stale_telemetry',
    threshold: 30, // minutes
    durationSeconds: 300, // held for 5 further minutes
    cooldownSeconds: 3600,
  };

  it('reports no observation rather than treating absence as fresh', () => {
    const result = evaluateStaleness(staleRule, { lastObservedAt: null }, { asOf: at(0) });
    expect(result.state).toBe('no_observation');
    expect(result.firings).toEqual([]);
  });

  it('does not fire before threshold plus duration has elapsed', () => {
    const result = evaluateStaleness(
      staleRule,
      { lastObservedAt: at(0), lastRef: 'obs' },
      { asOf: at(34) }
    );
    expect(result.state).toBe('fresh_enough');
    expect(result.firings).toEqual([]);
  });

  it('fires once the observation is stale for the full duration', () => {
    const result = evaluateStaleness(
      staleRule,
      { lastObservedAt: at(0), lastRef: 'obs' },
      { asOf: at(35) }
    );
    expect(result.state).toBe('stale');
    expect(result.firings[0].breachStartedAt).toBe(at(30));
    expect(result.firings[0].firedAt).toBe(at(35));
    expect(result.firings[0].observedValue).toBe(35);
    expect(result.firings[0].refs).toEqual(['obs']);
  });

  it('respects cooldown', () => {
    const result = evaluateStaleness(
      staleRule,
      { lastObservedAt: at(0), lastRef: 'obs' },
      { asOf: at(35), lastFiredAt: base + 30 * MINUTE }
    );
    expect(result.state).toBe('cooldown');
    expect(result.firings).toEqual([]);
  });
});

describe('direction and dispatch', () => {
  it('quota risk fires below the threshold, failures fire at or above it', () => {
    expect(breaches(CONDITIONS.quota_risk, 9, 10)).toBe(true);
    expect(breaches(CONDITIONS.quota_risk, 10, 10)).toBe(true);
    expect(breaches(CONDITIONS.quota_risk, 11, 10)).toBe(false);
    expect(breaches(CONDITIONS.operation_failure, 3, 3)).toBe(true);
    expect(breaches(CONDITIONS.operation_failure, 2, 3)).toBe(false);
  });

  it('a non-numeric measurement never counts as a breach', () => {
    expect(breaches(CONDITIONS.quota_risk, null, 10)).toBe(false);
    expect(breaches(CONDITIONS.quota_risk, NaN, 10)).toBe(false);
    expect(breaches(CONDITIONS.quota_risk, undefined, 10)).toBe(false);
  });

  it('evaluateRule dispatches on the declared duration role', () => {
    const windowed = evaluateRule(
      {
        conditionKind: 'operation_failure',
        threshold: 2,
        durationSeconds: 1800,
        cooldownSeconds: 3600,
      },
      [0, 5].map((m) => ({ at: at(m), ref: `e${m}` }))
    );
    expect(windowed.state).toBe('fired');
    const sustained = evaluateRule(quotaRule, series([5, 5]));
    expect(sustained.state).toBe('not_fired');
  });

  it('rejects an unknown condition kind rather than defaulting to one', () => {
    expect(() => conditionFor('made_up')).toThrow(/Unsupported condition kind/);
  });
});

describe('condition honesty', () => {
  it('every implemented condition names a real retained source and its evaluator role', () => {
    for (const condition of Object.values(CONDITIONS)) {
      expect(condition.source).toBeTruthy();
      expect(['sustained', 'window']).toContain(condition.durationRole);
      expect(condition.evidenceKind).toBeTruthy();
      expect(condition.unit).toBeTruthy();
    }
  });

  it('compression failure uses explicit execution evidence and counts failed stages', () => {
    const saver = UNAVAILABLE_CONDITIONS.find(
      (entry) => entry.kind === 'compression_saver_failure'
    );
    expect(saver).toBeUndefined();
    expect(CONDITIONS.compression_saver_failure).toMatchObject({ source: 'contextStages', durationRole: 'window', unit: 'failed transformation stages' });
  });
});
