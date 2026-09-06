import { describe, expect, it } from 'vitest';
import { createRoutingCapture, simulateRouting, validateRoutingCapture, validateSimulation } from '@/lib/routingSimulation.js';
import { configHash, CONFIG_SCOPE } from '@/lib/db/helpers/configHistory.js';
import { getCapabilitiesForModel } from 'open-sse/providers/capabilities.js';
import { isModelLockActive } from 'open-sse/services/accountFallback.js';

const NOW = Date.parse('2026-09-06T16:00:00.000Z');
const model = 'claude-fable-5';
const input = { model: `cc/${model}` };
const document = { combos: [], aliases: {}, settings: {} };
const window = (key, remainingPercentage, hours) => ({ key, remainingPercentage, resetAt: new Date(NOW + hours * 3600000).toISOString() });
const account = (id, windows = [], extra = {}) => ({ id, provider: 'claude', isActive: true, authType: 'oauth', maxConcurrent: 2,
  lastQuotaSnapshot: windows.length ? { windows, fetchedAt: new Date(NOW).toISOString() } : null, ...extra });
export function fixture(accounts, extra = {}) {
  return createRoutingCapture({ capturedAt: new Date(NOW).toISOString(), scope: { requestedModel: input.model, provider: 'claude', model },
    accounts, disabledModels: {}, providerNodes: [], settings: { providerStrategies: {}, disabledProviders: {} },
    drains: Object.fromEntries(accounts.map(a => [a.id, false])),
    activeLoad: Object.fromEntries(accounts.map(a => [a.id, { pins: 0, inFlight: 0 }])), pin: null, affinitySource: 'assumed-new-session',
    capabilities: getCapabilitiesForModel('claude', model), configuration: { scope: CONFIG_SCOPE, currentHash: configHash(document), document }, ...extra });
}
function run(capture, request = input) { return simulateRouting({ capture, input: request }); }

describe('immutable offline account policy', () => {
  it('orders longest horizons before short resets and load, with healthy pins stable', () => {
    const accounts = [account('short', [window('weekly (7d)', 60, 40), window('session (5h)', 70, 1)]),
      account('long', [window('weekly (7d)', 60, 30), window('session (5h)', 70, 4)])];
    const capture = fixture(accounts, { activeLoad: { short: { pins: 0, inFlight: 0 }, long: { pins: 4, inFlight: 0 } } });
    expect(run(capture).localSelection.connectionId).toBe('long');
    const pinned = fixture(accounts, { pin: { connectionId: 'short', pinnedAt: new Date(NOW - 10000).toISOString(), expiresAt: null }, affinitySource: 'captured-session' });
    expect(run(pinned).localSelection).toMatchObject({ connectionId: 'short', reason: 'pinned' });
    expect(run(pinned).candidates.map(c => c.connectionId)).toEqual(['short']);
  });
  it('waits on a healthy pin at capacity and does not reserve or change captured state', () => {
    const capture = fixture([account('a'), account('b')], { pin: { connectionId: 'a', pinnedAt: null, expiresAt: null }, affinitySource: 'captured-session',
      activeLoad: { a: { pins: 1, inFlight: 2 }, b: { pins: 0, inFlight: 0 } } });
    const before = JSON.stringify(capture);
    const result = run(capture);
    expect(result.localSelection).toMatchObject({ connectionId: null, reason: 'at-capacity', status: 'wait' });
    expect(JSON.stringify(capture)).toBe(before);
    expect(Object.isFrozen(capture.accounts[0])).toBe(true);
    expect(run(capture)).toEqual(result);
  });
  it('uses shorter horizons to break long horizon ties, then load, with capacity spill only for a new pin', () => {
    const a = account('a', [window('monthly (30d)', 80, 500), window('weekly (7d)', 80, 90), window('session (5h)', 80, 4)]);
    const b = account('b', [window('monthly (30d)', 80, 500), window('weekly (7d)', 80, 90), window('session (5h)', 80, 3)]);
    const loads = { a: { pins: 0, inFlight: 0 }, b: { pins: 9, inFlight: 0 } };
    expect(run(fixture([a, b], { activeLoad: loads })).localSelection.connectionId).toBe('b');
    b.lastQuotaSnapshot.windows[2].resetAt = a.lastQuotaSnapshot.windows[2].resetAt;
    expect(run(fixture([a, b], { activeLoad: loads })).localSelection.connectionId).toBe('a');
    loads.a.inFlight = 2;
    expect(run(fixture([a, b], { activeLoad: loads })).localSelection.connectionId).toBe('b');
  });
  it('applies model scoped quota, disable inheritance and explicit account overrides', () => {
    const capture = fixture([account('a', [window('weekly fable (7d)', 0, 30)]), account('b')],
      { disabledModels: { cc: [model], 'claude::b': [] } });
    expect(run(capture).localSelection.connectionId).toBe('b');
    expect(run(capture).exclusions).toContainEqual({ connectionId: 'a', reason: 'model-disabled' });
    const support = fixture([account('a', [], { providerSpecificData: { enabledModels: ['claude-sonnet-5'] } }), account('b')]);
    expect(run(support).exclusions).toContainEqual({ connectionId: 'a', reason: 'account-model-excluded' });
  });
  it('holds temporary pin locks, overrides them for explicit operator disable, and evaluates captured time', () => {
    const until = new Date(NOW + 60000).toISOString();
    const a = account('a', [], { [`modelLock_${model}`]: until, [`modelFailure_${model}`]: { until, status: 429, message: 'burst request limit', failureClass: 'rate' } });
    const extra = { pin: { connectionId: 'a', pinnedAt: null, expiresAt: null }, affinitySource: 'captured-session' };
    const capture = fixture([a, account('b')], extra);
    expect(run(capture).localSelection.reason).toBe('temporary-pin-wait');
    expect(run(capture).affinity.retryAt).toBe(until);
    const disabled = fixture([a, account('b')], { ...extra, disabledModels: { 'cc::a': [model] } });
    expect(run(disabled).localSelection.connectionId).toBe('b');
  });
  it('preserves legacy quota holding nuance and rotates scoped depletion to an eligible alternative', () => {
    const extra = { pin: { connectionId: 'a', pinnedAt: null, expiresAt: null }, affinitySource: 'captured-session' };
    expect(run(fixture([account('a', [window('weekly (7d)', 0, 30)])], extra)).localSelection.connectionId).toBe('a');
    expect(run(fixture([account('a', [window('weekly fable (7d)', 0, 30)]), account('b', [window('weekly (7d)', 80, 50)])], extra)).localSelection.connectionId).toBe('b');
    const recovery = fixture([account('a', [window('weekly (7d)', 0, -1)]), account('b', [window('weekly (7d)', 10, 30)])]);
    expect(run(recovery).localSelection.connectionId).toBe('b');
  });
  it('does not invent hard account gates for context, reasoning or modalities', () => {
    const capture = fixture([account('a')], { capabilities: { contextWindow: 200000, maxOutput: 1000, reasoning: false, vision: false } });
    const result = run(capture, { ...input, contextTokens: 400000, outputTokens: 2000, modality: 'image', requiredCapabilities: ['reasoning', 'vision'] });
    expect(result.localSelection.connectionId).toBe('a');
    expect(result.capabilityFit).toMatchObject({ contextFitsDeclaredWindow: false, outputFitsDeclaredLimit: false, missingOrUnknown: ['reasoning', 'vision'], enforcedAsAccountGate: false });
    expect(result.unknownEvidence).toContain('modality-dispatch-topology');
    expect(result.readiness).toBe('unknown');
    expect(result.served).toBeNull();
  });
  it('strips credentials, names, proxy endpoints and raw errors before sealing', () => {
    const until = new Date(NOW + 10000).toISOString();
    const capture = fixture([account('a', [], { apiKey: 'secret-api-material', accessToken: 'secret-oauth', email: 'private@example.test', name: 'private-name',
      providerSpecificData: { enabledModels: [model], connectionProxyUrl: 'https://user:password@proxy.invalid' },
      [`modelLock_${model}`]: until, [`modelFailure_${model}`]: { until, status: 503, message: 'secret-upstream-error' } })]);
    expect(JSON.stringify(capture)).not.toMatch(/secret-|private-|password|example\.test|proxy\.invalid/);
    expect(validateRoutingCapture(JSON.parse(JSON.stringify(capture)))).toEqual(capture);
  });
  it('preserves absence and unknown primitive quota values instead of manufacturing a model lock', () => {
    for (const value of [undefined, null, '', false, 'unknown', 0, '0', 20]) {
      const raw = account('a', [{ key: model, ...(value === undefined ? {} : { remainingPercentage: value }), resetAt: new Date(NOW + 3600000).toISOString() }], { provider: 'antigravity' });
      const capture = fixture([raw], { scope: { requestedModel: input.model, provider: 'antigravity', model } });
      expect(isModelLockActive(capture.accounts[0], model, NOW)).toBe(isModelLockActive(raw, model, NOW));
      expect(validateRoutingCapture(JSON.parse(JSON.stringify(capture)))).toEqual(capture);
    }
  });
  it('does not make mismatched lock metadata authoritative by normalizing timestamp spelling', () => {
    const raw = account('a', [], { [`modelLock_${model}`]: '2026-09-06T16:01:00Z',
      [`modelFailure_${model}`]: { until: '2026-09-06T16:01:00.000Z', status: 429, message: 'weekly quota exhausted' } });
    const capture = fixture([raw, account('b')], { pin: { connectionId: 'a', pinnedAt: null, expiresAt: null }, affinitySource: 'captured-session' });
    // The gateway uses exact timestamp-string pairing. An unmatched record has
    // unknown status and therefore the established temporary wait classification.
    expect(run(capture).localSelection.reason).toBe('temporary-pin-wait');
  });
  it('rejects tampering, unsupported versions, unrelated models and smuggled fields', () => {
    const capture = fixture([account('a')]);
    for (const mutate of [c => { c.version = 2; }, c => { c.accounts[0].apiKey = 'hidden'; }, c => { c.accounts[0].isActive = false; }, c => { c.scope.model = 'other'; }]) {
      const modified = structuredClone(capture); mutate(modified);
      expect(() => validateRoutingCapture(modified)).toThrow();
    }
    expect(() => run(capture, { model: 'cc/another-model' })).toThrow('capture_model_mismatch');
    expect(() => run(capture, { ...input, messages: [{ content: 'prompt' }] })).toThrow('invalid_fields');
    expect(() => run(capture, { ...input, contextTokens: -1 })).toThrow('invalid_token_count');
    expect(() => fixture(Array.from({ length: 201 }, (_, i) => account(`a${i}`)))).toThrow('invalid_accounts');
    expect(() => fixture([account('a', Array.from({ length: 65 }, () => window('weekly', 50, 1)))])).toThrow('simulation_too_large');
    expect(() => fixture([account('a')], { capturedAt: '1970-01-01T00:00:00Z' })).toThrow('invalid_capture_time');
  });
  it('shares versioned draft validation without activating or claiming combo simulation', () => {
    const capture = fixture([account('a')]);
    const draft = { version: 1, expectedCurrent: capture.configuration.currentHash, draftId: 'draft-1', revision: 2,
      document: { combos: [{ id: 'route', name: 'route', models: [input.model] }], aliases: {}, settings: { comboStrategy: 'fusion' } } };
    const result = validateSimulation({ capture, input, draft });
    expect(result.draftPreview).toMatchObject({ valid: true, mode: 'declarative-only', accountSimulationAppliesDraft: false });
    expect(result.draftPreview.effectivePlans[0]).toMatchObject({ orderedMembers: [input.model], strategy: 'fusion' });
    expect(() => validateSimulation({ capture, input, draft: { ...draft, expectedCurrent: 'stale' } })).toThrow('draft_capture_mismatch');
  });
});
