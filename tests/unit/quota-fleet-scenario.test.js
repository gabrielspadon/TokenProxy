import { describe, expect, it } from 'vitest';
import { createFleetCapture, compareFleetScenario } from '@/lib/quotaFleetScenario.js';
import { createRoutingCapture } from '@/lib/routingSimulation.js';
import { configHash, CONFIG_SCOPE } from '@/lib/db/helpers/configHistory.js';
import { quotaIntervalEvidence } from '@/lib/db/analytics/quotaReplenishment.mjs';
const now = '2026-09-08T10:25:00.000Z';
const at = minutes => new Date(Date.parse('2026-09-08T10:00:00Z') + minutes * 60000).toISOString();
const document = { combos: [], aliases: {}, settings: {} };
const input = { model: 'cx/test' };
function fixture({ pin = null, disabled = {}, rolling = false } = {}) {
  const accounts = ['a', 'b'].map(id => ({ id, provider: 'codex', isActive: true, authType: 'oauth', maxConcurrent: 2 }));
  const routing = createRoutingCapture({ capturedAt: now, scope: { requestedModel: input.model, model: 'test', provider: 'codex' }, accounts,
    settings: { disabledProviders: {}, providerStrategies: {} }, disabledModels: disabled, providerNodes: [],
    drains: { a: false, b: false }, activeLoad: { a: { pins: 0, inFlight: 0 }, b: { pins: 0, inFlight: 0 } },
    pin, affinitySource: pin ? 'captured-session' : 'assumed-new-session', capabilities: {},
    configuration: { scope: CONFIG_SCOPE, currentHash: configHash(document), document } });
  const histories = accounts.map(account => ({ connectionId: account.id, complete: true, total: 30,
    series: ['hourly', 'weekly', 'monthly', 'spark_hourly', 'spark_weekly', 'spark_monthly'].map((scope, index) => ({
      id: `${account.id}-${scope}`, scope, source: 'provider-usage', observationKind: 'observed', resourceType: index === 5 ? 'monetary-budget' : 'subscription-quota',
      unit: index === 5 ? 'USD' : 'credits', windowType: rolling ? 'rolling' : 'fixed', windowDurationMs: 3600000, measurement: 'absolute',
      points: [100, 90, 80, 70, 60].map((value, i) => ({ id: `${account.id}-${scope}-${i}`, observedAt: at(i * 5), capturedAt: at(i * 5), value, limit: 100,
        percentage: value, resetAt: at(180), confidence: 'reported' })) })) }));
  return createFleetCapture({ routing, histories, period: { start: at(0), end: now } });
}

describe('retained fleet counterfactuals', () => {
  it('compares scaled demand on identical capture without adding overlapping product windows', () => {
    const capture = fixture(), before = JSON.stringify(capture);
    const result = compareFleetScenario({ capture, input, scenario: { multiplier: 2, hours: 2 } });
    expect(result.accounts[0].products).toHaveLength(2);
    expect(result.accounts[0].products[0].windows).toHaveLength(3);
    const window = result.accounts[0].products[0].windows[0];
    expect(window.original.exhaustionAt).toBe(at(50));
    expect(window.adjusted.exhaustionAt).toBe(at(35));
    expect(result.accounts[0].products[1].windows.find(w => w.unit === 'USD').resourceType).toBe('monetary-budget');
    expect(result).toMatchObject({ monetarySavings: null, redistributedDemand: null, served: null, providerCalls: 0 });
    expect(JSON.stringify(capture)).toBe(before);
    expect(new URL(window.contributingRecords[0].href, 'http://localhost').searchParams.get('id')).toBe('a-hourly-0');
  });
  it('excludes unavailable accounts through the gateway and refuses disabled model eligibility', () => {
    const result = compareFleetScenario({ capture: fixture({ disabled: { 'codex::b': ['test'] } }), input, scenario: { excludedConnectionIds: ['a'] } });
    expect(result.changed.status).toBe('refused');
    expect(result.accounts[0].products[0].windows[0].adjusted.state).toBe('account_excluded');
    expect(result.accounts[1].eligibility).toBe('model-disabled');
  });
  it('compares supported preferences for new sessions and preserves existing session continuity', () => {
    expect(compareFleetScenario({ capture: fixture(), input, scenario: { preferredConnectionId: 'b' } }).changed.connectionId).toBe('b');
    const capture = fixture({ pin: { connectionId: 'a', pinnedAt: at(0), expiresAt: null } });
    const result = compareFleetScenario({ capture, input, scenario: { preferredConnectionId: 'b' } });
    expect(result.changed.connectionId).toBe('a');
    expect(result.preferenceSuppressedBySession).toBe(true);
    expect(compareFleetScenario({ capture, input, scenario: { excludedConnectionIds: ['a'] } }).changed.connectionId).toBe('b');
  });
  it('keeps stale, incomplete and rolling histories unavailable for point forecasts', () => {
    const rolling = compareFleetScenario({ capture: fixture({ rolling: true }), input });
    const window = rolling.accounts[0].products[0].windows[0];
    expect(window.adjusted.exhaustionAt).toBeNull();
    expect(window.adjusted.state).toBe('rolling_replenishment_unknown');
    expect(window.evidence.rollingReleaseEnvelopes[0]).toMatchObject({ earliestAt: at(60), latestAt: at(65), guaranteedAmount: null });
    const capture = fixture();
    capture.histories[0] = { connectionId: 'a', complete: false, total: 5001, series: [] };
    const sealed = createFleetCapture(capture);
    expect(compareFleetScenario({ capture: sealed, input }).accounts[0]).toMatchObject({ evidenceComplete: false, products: [] });
  });
  it('rejects tampering, mismatched history population, unbounded controls and unknown exclusions', () => {
    const capture = fixture();
    expect(() => compareFleetScenario({ capture: { ...capture, captureId: 'changed' }, input })).toThrow('integrity');
    for (const scenario of [{ multiplier: 0 }, { multiplier: '2' }, { hours: 169 }, { excludedConnectionIds: ['absent'] }, { unsupported: true }]) {
      expect(() => compareFleetScenario({ capture, input, scenario })).toThrow();
    }
    expect(() => createFleetCapture({ ...capture, histories: [] })).toThrow();
    capture.histories[0].total = 31;
    expect(() => createFleetCapture(capture)).toThrow();
  });
});

describe('observed replenishment evidence', () => {
  const rows = values => values.map((remaining, i) => ({ id: `p-${i}`, unit: 'credits', remaining, limit: 100, observedAt: at(i * 5), windowType: 'rolling', windowDurationMs: 3600000 }));
  it('separates net depletion and replenishment from unidentifiable gross consumption', () => {
    const evidence = quotaIntervalEvidence(rows([100, 80, 95, 90]), { asOf: now });
    expect(evidence).toMatchObject({ observedDepletion: 25, observedReplenishment: 15, grossConsumption: null, grossReplenishment: null });
    expect(evidence.rollingReleaseEnvelopes).toHaveLength(2);
  });
  it('censors unknown, future, duplicate-time, inferred and changing-denominator intervals', () => {
    const samples = rows([100, 80, 70]); samples[1].remaining = null;
    expect(quotaIntervalEvidence(samples, { asOf: now }).censoredIntervals).toBe(2);
    for (const patch of [{ limit: 200 }, { observedAt: at(0) }, { observedAt: at(90) }, { observationKind: 'inferred' }, { unit: 'USD' }]) {
      const pair = rows([100, 80]); Object.assign(pair[1], patch);
      expect(quotaIntervalEvidence(pair, { asOf: now }).intervals).toHaveLength(0);
    }
  });
  it('exposes partially elapsed rolling releases as censored intervals and never confirms a deadline', () => {
    const pair = rows([100, 80]); pair[0].resetAt = at(1);
    const evidence = quotaIntervalEvidence(pair, { asOf: at(62) });
    expect(evidence.rollingReleaseEnvelopes[0].status).toBe('partially-elapsed-censored');
    expect(evidence.knownResetDeadlines[0].completed).toBe(false);
    expect(evidence.intervals[0].crossedReportedReset).toBe(false);
  });
});
