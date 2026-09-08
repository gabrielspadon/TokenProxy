import { configHash } from './db/helpers/configHistory.js';
import { simulateRouting, validateRoutingCapture, validateSimulationInput, SimulationError } from './routingSimulation.js';
import { analyzeQuotaSeries, projectQuotaScenario } from './db/analytics/quotaTrend.mjs';
import { groupQuotaProducts } from '@/app/dashboard/quotaProductGroups.js';

export const FLEET_LIMITS = Object.freeze({ accounts: 20, observations: 5000, bodyBytes: 4 * 1024 * 1024 });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = () => { throw new SimulationError('invalid_fleet_scenario'); };
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

export function createFleetCapture({ routing, histories, period }) {
  validateRoutingCapture(routing);
  if (!shape(period, ['start', 'end']) || !Number.isFinite(Date.parse(period.start)) || !Number.isFinite(Date.parse(period.end)) || period.start >= period.end || period.end > routing.capturedAt) fail();
  if (!Array.isArray(histories) || histories.length !== routing.accounts.length || histories.length > FLEET_LIMITS.accounts) fail();
  let count = 0;
  const ids = new Set();
  for (const history of histories) {
    if (!shape(history, ['connectionId', 'complete', 'total', 'series']) || !routing.accounts.some(account => account.id === history.connectionId)
      || ids.has(history.connectionId) || typeof history.complete !== 'boolean' || !Number.isSafeInteger(history.total) || history.total < 0
      || !Array.isArray(history.series) || history.series.length > 64) fail();
    ids.add(history.connectionId);
    for (const series of history.series) {
      if (!shape(series, ['id', 'scope', 'source', 'observationKind', 'resourceType', 'unit', 'windowType', 'windowDurationMs', 'measurement', 'points'])
        || !['absolute', 'percentage'].includes(series.measurement) || !Array.isArray(series.points)) fail();
      for (const key of ['id', 'scope', 'source', 'observationKind']) if (typeof series[key] !== 'string' || !series[key] || series[key].length > 512) fail();
      for (const key of ['resourceType', 'unit', 'windowType']) if (series[key] !== null && (typeof series[key] !== 'string' || series[key].length > 512)) fail();
      if (series.windowDurationMs !== null && (!Number.isSafeInteger(series.windowDurationMs) || series.windowDurationMs <= 0)) fail();
      for (const point of series.points) {
        if (!shape(point, ['id', 'observedAt', 'capturedAt', 'value', 'limit', 'percentage', 'resetAt', 'confidence']) || typeof point.id !== 'string' || point.id.length > 512) fail();
        for (const key of ['value', 'limit', 'percentage']) if (point[key] !== null && !finite(point[key])) fail();
        for (const key of ['observedAt', 'capturedAt', 'resetAt']) if (point[key] !== null && (typeof point[key] !== 'string' || !Number.isFinite(Date.parse(point[key])))) fail();
        if (!point.capturedAt || point.capturedAt < period.start || point.capturedAt >= period.end) fail();
      }
      count += series.points.length;
    }
    const rows = history.series.reduce((sum, series) => sum + series.points.length, 0);
    if (history.complete && rows !== history.total || !history.complete && rows !== 0) fail();
  }
  if (count > FLEET_LIMITS.observations) throw new SimulationError('fleet_observation_limit', 413);
  const value = { version: 1, routing, histories, period };
  return { ...value, captureId: configHash(value) };
}

export function compareFleetScenario({ capture, input, scenario = {} }) {
  if (!shape(capture, ['version', 'routing', 'histories', 'period', 'captureId']) || capture.version !== 1) fail();
  const sealed = createFleetCapture(capture);
  if (sealed.captureId !== capture.captureId) throw new SimulationError('fleet_capture_integrity_mismatch');
  const request = validateSimulationInput(input);
  if (!shape(scenario, ['multiplier', 'hours', 'excludedConnectionIds', 'preferredConnectionId'])) fail();
  const multiplier = scenario.multiplier ?? 1, hours = scenario.hours ?? 24;
  if (!finite(multiplier) || multiplier < 0.1 || multiplier > 10 || !finite(hours) || hours < 1 || hours > 168) fail();
  const excludedConnectionIds = scenario.excludedConnectionIds ?? [];
  const accountIds = capture.routing.accounts.map(account => account.id);
  if (!Array.isArray(excludedConnectionIds) || excludedConnectionIds.some(id => !accountIds.includes(id))
    || scenario.preferredConnectionId !== undefined && !accountIds.includes(scenario.preferredConnectionId)) fail();
  const baseline = simulateRouting({ capture: capture.routing, input: request });
  // An existing successful-session pin owns continuity. Preference changes apply to new sessions only.
  const preservesPin = baseline.affinity.previousConnectionId !== null;
  const changedInput = { ...request, excludedConnectionIds: [...new Set([...(request.excludedConnectionIds || []), ...excludedConnectionIds])] };
  if (scenario.preferredConnectionId && !preservesPin) changedInput.preferredConnectionId = scenario.preferredConnectionId;
  const changed = simulateRouting({ capture: capture.routing, input: changedInput });
  const end = new Date(Date.parse(capture.routing.capturedAt) + hours * 3_600_000).toISOString();
  const accounts = capture.histories.map(history => {
    const account = capture.routing.accounts.find(item => item.id === history.connectionId);
    const baselineEligible = !baseline.exclusions.some(item => item.connectionId === account.id);
    const scenarioEligible = !changed.exclusions.some(item => item.connectionId === account.id);
    const windows = history.series.map(series => {
      const rows = series.points.map(point => ({ ...point, remaining: point.value, percentage: series.measurement === 'percentage' ? point.value : point.percentage,
        unit: series.unit, windowType: series.windowType, windowDurationMs: series.windowDurationMs, observationKind: series.observationKind }));
      const analysis = analyzeQuotaSeries(rows, { asOf: capture.routing.capturedAt, measurement: series.measurement });
      if (series.observationKind !== 'observed') analysis.state = 'not_observed';
      const original = projectQuotaScenario(analysis, { available: baselineEligible }), adjusted = projectQuotaScenario(analysis, { multiplier, available: scenarioEligible });
      return { key: series.scope, seriesId: series.id, resourceType: series.resourceType, unit: analysis.unit,
        original, adjusted, evidenceState: analysis.state, evidence: analysis.evidence, observedBalance: analysis.last, rate: analysis.rate,
        baselineExhaustsInPeriod: original.exhaustionAt ? original.exhaustionAt >= capture.routing.capturedAt && original.exhaustionAt <= end : null,
        scenarioExhaustsInPeriod: adjusted.exhaustionAt ? adjusted.exhaustionAt >= capture.routing.capturedAt && adjusted.exhaustionAt <= end : null,
        contributingRecords: series.points.map(point => ({ id: point.id, href: `/api/admin/quota/history?${new URLSearchParams({ id: point.id, connectionId: account.id, start: capture.period.start, end: capture.period.end })}` })) };
    });
    return { connectionId: account.id, provider: account.provider, available: scenarioEligible,
      evidenceComplete: history.complete, observationCount: history.total,
      eligibility: changed.exclusions.find(item => item.connectionId === account.id)?.reason ?? 'gateway-candidate-or-affinity-held',
      products: groupQuotaProducts(account.provider, windows) };
  });
  return { version: 1, captureId: capture.captureId, routingCaptureId: capture.routing.captureId, mode: 'offline-captured-state',
    scope: capture.routing.scope, capturedAt: capture.routing.capturedAt, retainedPeriod: { ...capture.period, field: 'capturedAt', endExclusive: true }, projectionPeriod: { start: capture.routing.capturedAt, end, hours },
    scenario: { multiplier, hours, excludedConnectionIds, preferredConnectionId: scenario.preferredConnectionId ?? null },
    baseline: baseline.localSelection, changed: changed.localSelection, affinity: changed.affinity, preferenceSuppressedBySession: preservesPin && Boolean(scenario.preferredConnectionId),
    accounts, monetarySavings: null, redistributedDemand: null, served: null, upstreamVerified: false,
    assumptions: ['Demand scales each retained account trend with unchanged request mix, caching and provider charging.',
      'The gateway policy compares the next request on one captured state; it does not allocate a future request stream.',
      'Excluded-account demand redistribution is unknown because quota history has no model/request attribution or cross-account charging conversion.',
      'Each product has overlapping quota constraints. Window balances and rates are never added into a fleet budget.',
      'Subscription units, request limits, percentage points and money remain separate. No token, byte or monetary savings conversion is inferred.',
      'Exhaustion projections stop at reported resets. Rolling recovery is represented as conditional expiry intervals, never a point reset.',
      'Captured state is content-addressed operator evidence, not signed or transactionally captured. Provider readiness and successful generation remain unknown.'],
    unknownEvidence: [...new Set([...baseline.unknownEvidence, ...changed.unknownEvidence])], providerCalls: 0, writes: 0 };
}
