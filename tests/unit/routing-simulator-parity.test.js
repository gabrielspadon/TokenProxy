import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ accounts: [], disabledModels: {}, drains: {}, settings: {}, pin: null, pins: {}, calls: 0 }));
vi.mock('@/lib/localDb', () => ({ getProviderConnections: async ({ provider, isActive } = {}) => {
  state.calls++; return state.accounts.filter(a => (!provider || a.provider === provider) && (!isActive || a.isActive));
}, getSettings: async () => { state.calls++; return state.settings; }, getProxyPools: async () => [],
validateApiKey: async () => true, updateProviderConnection: async () => {}, updateConnectionProxyPoolSnapshotIfBound: async () => {}, updateProviderStrategyProxyPoolSnapshotIfBound: async () => {} }));
vi.mock('@/lib/disabledModelsDb', () => ({ getDisabledModels: async () => { state.calls++; return state.disabledModels; } }));
vi.mock('@/lib/db/repos/nodesRepo.js', () => ({ getProviderNodes: async () => [] }));
vi.mock('@/lib/admin/state.js', () => ({ readAllDrainDocs: async () => { state.calls++; return state.drains; } }));
vi.mock('@/lib/network/connectionProxy', () => ({ resolveConnectionProxyConfig: async () => ({ kind: 'usable' }),
  toConnectionProxyOptions: () => ({}), pickProxyPoolId: () => null }));
vi.mock('@/lib/db/repos/quotaWindowsRepo.js', () => ({ putWindows: async () => { state.calls++; }, getWindows: async () => [] }));
vi.mock('@/sse/services/quotaGuard.js', async () => {
  const { getPausedWindow } = await import('@/shared/utils/quotaPause.js');
  return { evaluateQuota: async c => { state.calls++; return { snapshot: c.lastQuotaSnapshot, rawUsage: null, paused: Boolean(getPausedWindow(c)) }; } };
});
vi.mock('@/sse/services/schedulerRepos.js', () => ({ createSchedulerRepos: async () => ({
  transaction: fn => fn(), getPin: () => state.pin, countActivePins: () => state.pins,
  setPin: value => { state.calls++; state.pin = { connectionId: value.connectionId, pinnedAt: value.at }; },
  touchPin: () => { state.calls++; }, recordSwitch: receipt => { state.calls++; return receipt; },
}) }));
vi.mock('@/sse/utils/logger.js', () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/shared/observability/decide.js', () => ({ decide: vi.fn() }));

import { getProviderCredentials, releaseAccountLease } from '@/sse/services/auth.js';
import { leaseRegistry, registerAccountCapacity } from '@/sse/services/accountLeaseRegistry.js';
import { createRoutingCapture, simulateRouting } from '@/lib/routingSimulation.js';
import { configHash, CONFIG_SCOPE } from '@/lib/db/helpers/configHistory.js';
import { effectiveCapacity } from '@/shared/utils/accountCapacity.js';

const NOW = Date.parse('2026-09-06T16:00:00.000Z'), MODEL = 'claude-fable-5';
const document = { combos: [], aliases: {}, settings: {} };
let held = [];
afterEach(() => { held.forEach(lease => leaseRegistry.release(lease)); held = []; vi.useRealTimers(); vi.unstubAllGlobals(); });
const win = (key, percentage, hours) => ({ key, remainingPercentage: percentage, resetAt: new Date(NOW + hours * 3600000).toISOString() });

async function parity(accounts, { pin = null, disabledModels = {}, drains = {}, load = {}, preferredConnectionId, strictPreferredConnection, excluded = [] } = {}) {
  Object.assign(state, { accounts, pin, disabledModels, drains, settings: {}, calls: 0,
    pins: Object.fromEntries(accounts.map(a => [a.id, load[a.id]?.pins ?? 0])) });
  for (const a of accounts) {
    registerAccountCapacity(a.id, effectiveCapacity(a).limit);
    for (let i = 0; i < (load[a.id]?.inFlight ?? 0); i++) {
      const lease = leaseRegistry.reserve(a.id); if (lease) held.push(lease);
    }
  }
  const capture = createRoutingCapture({ capturedAt: new Date(NOW).toISOString(), scope: { requestedModel: `cc/${MODEL}`, provider: 'claude', model: MODEL },
    accounts, disabledModels, providerNodes: [], settings: { disabledProviders: {}, providerStrategies: {} },
    drains: Object.fromEntries(accounts.map(a => [a.id, drains[a.id]?.isDraining === true])),
    activeLoad: Object.fromEntries(accounts.map(a => [a.id, { pins: state.pins[a.id], inFlight: leaseRegistry.inFlight(a.id) }])),
    pin: pin ? { ...pin, pinnedAt: pin.pinnedAt ?? null, expiresAt: null } : null,
    affinitySource: pin ? 'captured-session' : 'assumed-new-session', capabilities: {},
    configuration: { scope: CONFIG_SCOPE, currentHash: configHash(document), document } });
  const input = { model: `cc/${MODEL}`, ...(preferredConnectionId ? { preferredConnectionId } : {}),
    ...(strictPreferredConnection === undefined ? {} : { strictPreferredConnection }), excludedConnectionIds: excluded };
  const before = state.calls, leasesBefore = leaseRegistry.snapshot();
  const simulation = simulateRouting({ capture, input });
  expect(state.calls).toBe(before);
  expect(leaseRegistry.snapshot()).toEqual(leasesBefore);
  const actual = await getProviderCredentials('claude', new Set(excluded), MODEL, { preferredConnectionId, strictPreferredConnection,
    clientApiKey: 'mock-client-key', clientHeaders: { 'x-session-id': 'parity-session' }, clientBody: {} });
  expect(simulation.localSelection.connectionId, JSON.stringify({ input, accounts, pin, simulation: simulation.localSelection })).toBe(actual?.connectionId ?? null);
  if (simulation.localSelection.status === 'wait') expect(actual?.mustWait).toBe(true);
  if (actual?.accountLease) releaseAccountLease(actual.accountLease);
  held.forEach(lease => leaseRegistry.release(lease)); held = [];
  expect(leaseRegistry.inFlight()).toBe(0);
  return simulation;
}
describe('real credential selector parity with frozen quota transport', () => {
  it('covers bounded randomized eligibility, quota horizons, pins, capacity and policy fixtures', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No provider transport permitted'); }));
    let seed = 4171;
    const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let trial = 0; trial < 240; trial++) {
      const accounts = Array.from({ length: 1 + random(6) }, (_, i) => {
        const windows = random(4) === 0 ? [] : [win('monthly (30d)', random(3) ? 70 : 0, 10 + random(500)), win('weekly (7d)', 20 + random(80), 1 + random(150)), win('session (5h)', 20 + random(80), 1 + random(4))];
        if (random(9) === 0) windows.push(win('weekly fable (7d)', 0, 10));
        return { id: `trial-${trial}-${i}`, provider: 'claude', isActive: random(8) !== 0, authType: 'oauth', accessToken: 'synthetic', refreshToken: 'synthetic', priority: random(4), maxConcurrent: 2,
          providerSpecificData: { enabledModels: random(8) ? [] : ['claude-sonnet-5'] },
          quotaPauseThresholds: random(5) ? {} : { 'monthly (30d)': 10 }, lastQuotaSnapshot: { windows, fetchedAt: new Date(NOW).toISOString() } };
      });
      const pin = random(2) ? { connectionId: accounts[random(accounts.length)].id } : null;
      const drains = Object.fromEntries(accounts.filter(() => random(9) === 0).map(a => [a.id, { isDraining: true }]));
      const load = Object.fromEntries(accounts.map(a => [a.id, { pins: random(8), inFlight: random(3) }]));
      const disabledModels = Object.fromEntries(accounts.filter(() => random(10) === 0).map(a => [`cc::${a.id}`, [MODEL]]));
      const preferredConnectionId = random(4) === 0 ? accounts[random(accounts.length)].id : undefined;
      await parity(accounts, { pin, drains, load, disabledModels, preferredConnectionId, strictPreferredConnection: Boolean(preferredConnectionId) && random(2) === 1 });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps a pinned account with a temporary failure, and respects operator exclusions and model allowlists', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const until = new Date(NOW + 60000).toISOString();
    const accounts = ['a', 'b'].map(id => ({ id, provider: 'claude', isActive: true, authType: 'oauth', accessToken: 'synthetic', refreshToken: 'synthetic', maxConcurrent: 2 }));
    accounts[0][`modelLock_${MODEL}`] = until;
    accounts[0][`modelFailure_${MODEL}`] = { until, status: 429, message: 'Rate limit exceeded' };
    const base = { pin: { connectionId: 'a' } };
    // The failure record is retained and the pin is kept: a temporary failure
    // no longer parks the session on a cooldown, it just gets tried again.
    expect((await parity(accounts, base)).localSelection.reason).toBe('pinned');
    expect((await parity(accounts, base)).localSelection.connectionId).toBe('a');
    expect((await parity(accounts, { ...base, excluded: ['a'] })).localSelection.connectionId).toBe('b');
    expect((await parity(accounts, { ...base, disabledModels: { 'cc::a': [MODEL] } })).localSelection.connectionId).toBe('b');
    accounts[0].providerSpecificData = { enabledModels: ['claude-sonnet-5'] };
    expect((await parity(accounts, base)).localSelection.connectionId).toBe('b');
  });
});
