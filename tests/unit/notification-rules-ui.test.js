// The presentation layer's honesty rules: an absent value is drawn as an
// explicit unknown rather than as a zero, snooze never reads as resolved, and
// a rule describes itself from the condition's own declared unit and role.
import { describe, expect, it } from 'vitest';
import {
  ALERT_STATE_LABEL,
  DRY_RUN_STATE_EXPLANATION,
  UNKNOWN,
  alertState,
  evidenceHref,
  humanDuration,
  ruleNumber,
  ruleSentence,
  ruleTimestamp,
  scopeLabel,
} from '@/shared/workspace/notificationRulesModel';
import { CONDITIONS } from '@/lib/notifications/conditions.mjs';

describe('unknowns are never drawn as measurements', () => {
  it('renders an absent number as an explicit unknown, but keeps a real zero', () => {
    expect(ruleNumber(null)).toBe(UNKNOWN);
    expect(ruleNumber(undefined)).toBe(UNKNOWN);
    expect(ruleNumber(NaN)).toBe(UNKNOWN);
    // Zero is a measurement and must survive.
    expect(ruleNumber(0)).toBe('0');
    expect(ruleNumber(1234)).toBe('1,234');
    expect(ruleNumber(12.345)).toBe('12.35');
  });

  it('renders an absent or malformed timestamp as an explicit unknown', () => {
    expect(ruleTimestamp(null)).toBe(UNKNOWN);
    expect(ruleTimestamp('tomorrow')).toBe(UNKNOWN);
    expect(ruleTimestamp('2026-01-01T00:10:00.000Z')).toBe('2026-01-01 00:10:00');
  });

  it('renders a duration in the largest unit that stays exact', () => {
    expect(humanDuration(600)).toBe('10 min');
    expect(humanDuration(3600)).toBe('1 h');
    expect(humanDuration(86_400)).toBe('1 d');
    expect(humanDuration(90)).toBe('90 s');
    expect(humanDuration(0)).toBe(UNKNOWN);
  });
});

describe('rule self-description', () => {
  it('describes a sustained rule with the condition’s own unit and direction', () => {
    const sentence = ruleSentence(
      { threshold: 10, durationSeconds: 900, cooldownSeconds: 3600 },
      CONDITIONS.quota_risk
    );
    expect(sentence).toContain('at or below 10 percent remaining');
    expect(sentence).toContain('for 15 min');
    expect(sentence).toContain('at most once per 1 h');
  });

  it('describes a window rule as "within", not "for"', () => {
    const sentence = ruleSentence(
      { threshold: 3, durationSeconds: 1800, cooldownSeconds: 3600 },
      CONDITIONS.repeated_fallback
    );
    expect(sentence).toContain('at or above 3 switches');
    expect(sentence).toContain('within 30 min');
  });

  it('says so plainly when the condition is not available in this build', () => {
    expect(ruleSentence({ threshold: 1 }, undefined)).toMatch(/not available/i);
  });

  it('labels scope without inventing a subject for a global rule', () => {
    expect(scopeLabel({ scopeKind: 'global' })).toBe('Every subject');
    expect(scopeLabel({ scopeKind: 'connection', scopeId: 'conn-1' })).toBe('Account conn-1');
    expect(scopeLabel({ scopeKind: 'provider', scopeId: 'anthropic' })).toBe('Provider anthropic');
  });
});

describe('alert state', () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();

  it('a snoozed alert is still open, never resolved', () => {
    expect(alertState({ outcome: 'firing', snoozedUntil: future })).toBe('snoozed');
    expect(ALERT_STATE_LABEL.snoozed).toBe('Snoozed');
    // And it is not the acknowledged state.
    expect(alertState({ outcome: 'firing', snoozedUntil: future })).not.toBe('acknowledged');
  });

  it('an elapsed snooze returns to firing', () => {
    expect(alertState({ outcome: 'firing', snoozedUntil: past })).toBe('firing');
  });

  it('acknowledgement outranks a snooze that has not elapsed', () => {
    expect(alertState({ outcome: 'acknowledged', snoozedUntil: future })).toBe('acknowledged');
  });
});

describe('evidence links', () => {
  it('links a firing to the surface that renders the causing records', () => {
    const event = { scopeKey: 'conn-1::session (5h)' };
    expect(evidenceHref('quotaObservation', 'obs-1', event)).toContain('account=conn-1');
    expect(evidenceHref('operationEvent', '42', event)).toContain('event=42');
    expect(evidenceHref('accountSwitch', 's1', event)).toContain('account=conn-1');
  });

  it('returns no link rather than a broken one when there is nothing to point at', () => {
    expect(evidenceHref('quotaObservation', null, { scopeKey: 'conn-1' })).toBeNull();
    expect(evidenceHref('unknownKind', 'x', { scopeKey: 'conn-1' })).toBeNull();
  });
});

describe('dry run wording', () => {
  it('explains every state the evaluator can report', () => {
    for (const state of [
      'fired',
      'not_fired',
      'no_observation',
      'fresh_enough',
      'stale',
      'cooldown',
    ]) {
      expect(DRY_RUN_STATE_EXPLANATION[state]).toBeTruthy();
    }
  });

  it('does not describe an absence of firings as health', () => {
    expect(DRY_RUN_STATE_EXPLANATION.not_fired).not.toMatch(/healthy|fine|ok\b/i);
    expect(DRY_RUN_STATE_EXPLANATION.no_observation).toMatch(/cannot be established/i);
  });
});
