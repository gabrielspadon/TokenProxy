import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('open-sse/index.js', () => ({}));
vi.mock('@/lib/localDb', () => ({ getSettings: vi.fn(), getProviderConnections: vi.fn(), updateProviderConnection: vi.fn() }));
vi.mock('@/app/api/usage/[connectionId]/route.js', () => ({ refreshAndUpdateCredentials: vi.fn() }));
import { initDb } from '@/lib/db/index.js';
import { getAdapter } from '@/lib/db/driver.js';
import { retainQuotaUsage, recordQuotaCheckEvent } from '@/lib/db/repos/quotaHistoryRepo.js';
import { runQuotaAutoPingTick } from '@/shared/services/quotaAutoPing.js';
import { QUOTA_AUTOPING_CONFIG as C } from '@/shared/constants/config.js';

const NOW = '2026-09-08T12:00:00.000Z';
const PAST = '2026-09-08T11:00:00.000Z';
const FUTURE = '2026-09-08T18:00:00.000Z';
const PROVIDER = 'synthetic-warm-outcomes';
const freshState = () => ({ running: false, failureCache: {}, resetCache: {}, seenResets: {}, allRunning: {} });
let db, connection, deps, execute;
const history = () => db.all('SELECT * FROM quotaCheckEvents ORDER BY capturedAt, id');
const usage = quotas => ({ quotas, quotaObservation: { id: new Date().toISOString(), observedAt: new Date().toISOString() } });
beforeAll(async () => { await initDb(); db = await getAdapter(); });
beforeEach(() => {
  db.run('DELETE FROM quotaObservations'); db.run('DELETE FROM quotaCheckEvents');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
  C.providers[PROVIDER] = { settingsKey: 'syntheticWarmOutcomes', quotaKey: 'session', expectedWindows: ['session'], authTypes: ['oauth'], pingModel: 'model-small' };
  connection = { id: 'warm-outcomes-account', provider: PROVIDER, authType: 'oauth', accessToken: 'PRIVATE', providerSpecificData: {} };
  execute = vi.fn(async () => ({ response: new Response('', { status: 200 }) }));
  deps = {
    getSettings: async () => ({ [C.providers[connection.provider].settingsKey]: { connections: { [connection.id]: true } } }),
    getProviderConnections: async ({ provider }) => provider === connection.provider ? [connection] : [],
    resolveConnectionProxyConfig: async () => ({}),
    refreshAndUpdateCredentials: async c => ({ connection: c }),
    updateProviderConnection: vi.fn(async (_id, patch) => Object.assign(connection, structuredClone(patch))),
    getUsageForProvider: vi.fn(async () => usage({ session: { remaining: 20, total: 100, unit: 'requests', resourceType: 'request-limit', resetAt: PAST } })),
    getExecutor: () => ({ execute }), retainQuotaUsage, recordQuotaCheckEvent,
  };
});
afterEach(() => { delete C.providers[PROVIDER]; vi.useRealTimers(); vi.restoreAllMocks(); });

describe('truthful quota warming outcomes', () => {
  it.each([400, 401, 403, 404, 429])('does not mark HTTP %s as an accepted warming request', async status => {
    execute.mockResolvedValue({ response: new Response('', { status }) });
    await runQuotaAutoPingTick(deps, freshState());
    expect(history().find(e => e.eventType === 'warm-outcome')).toMatchObject({ scope: 'session', targetModel: 'model-small', outcome: 'rejected', code: `http_${status}` });
    expect(history().some(e => e.eventType === 'warm-recorded')).toBe(false);
    expect(connection.autoPingWindows?.session?.lastWarmedAt).toBeUndefined();
    expect(connection.lastPingAt).toBeUndefined();
  });
  it.each([500, 503])('retains HTTP %s uncertainty across scheduler restart without another dispatch', async status => {
    execute.mockResolvedValue({ response: new Response('', { status }) });
    await runQuotaAutoPingTick(deps, freshState());
    expect(history().find(e => e.eventType === 'warm-outcome')).toMatchObject({ outcome: 'uncertain', code: `http_${status}` });
    expect(connection.autoPingWindows.session).toMatchObject({ lastAttemptOutcome: 'uncertain', lastAttemptedAt: NOW });
    vi.setSystemTime('2026-09-09T12:00:00.000Z');
    await runQuotaAutoPingTick(deps, freshState());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(history().some(e => e.eventType === 'warm-recorded')).toBe(false);
  });
  it('persists the dispatch guard before entering the upstream executor and retains interrupted streams', async () => {
    execute.mockImplementation(async () => {
      expect(connection.autoPingWindows.session.lastAttemptOutcome).toBe('dispatching');
      return { response: { status: 200, body: new ReadableStream({ start(controller) { controller.error(new Error('PRIVATE')); } }) } };
    });
    await runQuotaAutoPingTick(deps, freshState());
    expect(history().find(e => e.eventType === 'warm-outcome')).toMatchObject({ outcome: 'uncertain', code: 'warm_exception' });
    expect(JSON.stringify(history())).not.toContain('PRIVATE');
    await runQuotaAutoPingTick(deps, freshState());
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch if the durable pre-dispatch guard cannot be saved', async () => {
    deps.persistWarmState = async () => { throw new Error('PRIVATE'); };
    await runQuotaAutoPingTick(deps, freshState());
    expect(execute).not.toHaveBeenCalled();
    expect(history().find(e => e.code === 'state_write_failed')).toBeDefined();
  });
  it('retains the exact sample, resource and unit for an accepted target', async () => {
    await runQuotaAutoPingTick(deps, freshState());
    const observed = db.get('SELECT * FROM quotaObservations WHERE connectionId=?', [connection.id]);
    expect(history().find(e => e.eventType === 'warm-outcome')).toMatchObject({ outcome: 'accepted', scope: 'session', observationId: observed.id, resourceType: 'request-limit', unit: 'requests' });
    expect(history().find(e => e.eventType === 'warm-recorded')).toMatchObject({ outcome: 'accepted', observationId: observed.id });
    expect(connection.lastPingAt).toBe(NOW);
  });
  it('keeps accepted targets protected if the final compatibility-state write fails', async () => {
    const save = deps.updateProviderConnection;
    deps.updateProviderConnection = vi.fn(async (id, patch) => {
      if (patch.lastPingAt) throw new Error('final write failed');
      return save(id, patch);
    });
    await runQuotaAutoPingTick(deps, freshState());
    await runQuotaAutoPingTick(deps, freshState());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(connection.autoPingWindows.session.lastWarmedAt).toBe(NOW);
  });
  it('does not invent resource identity for an absent window', async () => {
    deps.getUsageForProvider.mockResolvedValue(usage({}));
    await runQuotaAutoPingTick(deps, freshState());
    expect(history().find(e => e.eventType === 'warm-outcome')).toMatchObject({ outcome: 'accepted', observationId: null, resourceType: null, unit: null });
  });
  it('keeps partial Antigravity outcomes on their actual target and stops after an uncertain response', async () => {
    connection.provider = 'antigravity';
    const [first, second] = C.providers.antigravity.quotaKeys;
    expect(second).toBeDefined();
    deps.getUsageForProvider.mockResolvedValue(usage({}));
    execute.mockResolvedValueOnce({ response: new Response('', { status: 200 }) }).mockResolvedValueOnce({ response: new Response('', { status: 503 }) });
    await runQuotaAutoPingTick(deps, freshState());
    expect(execute.mock.calls.map(([request]) => request.model)).toEqual([first, second]);
    expect(history().filter(e => e.eventType === 'warm-recorded').map(e => e.scope)).toEqual([first]);
    expect(connection.autoPingWindows[first].lastAttemptOutcome).toBe('accepted');
    expect(connection.autoPingWindows[second].lastAttemptOutcome).toBe('uncertain');
  });
  it('does not dispatch Antigravity families whose quota clock is already running', async () => {
    connection.provider = 'antigravity';
    const [cold, ...running] = C.providers.antigravity.quotaKeys;
    deps.getUsageForProvider.mockResolvedValue(usage(Object.fromEntries(running.map(scope => [scope, { remaining: 90, resetAt: FUTURE }]))));
    await runQuotaAutoPingTick(deps, freshState());
    expect(execute.mock.calls.map(([request]) => request.model)).toEqual([cold]);
    expect(history().filter(e => e.eventType === 'warm-recorded').map(e => e.scope)).toEqual([cold]);
  });
});
