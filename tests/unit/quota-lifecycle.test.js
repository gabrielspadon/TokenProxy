import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('open-sse/index.js', () => ({}));
vi.mock('@/app/api/usage/[connectionId]/route.js', () => ({ refreshAndUpdateCredentials: vi.fn() }));
import { getAdapter } from '@/lib/db/driver.js';
import { createQuotaCheckQueue } from '@/lib/db/repos/quotaCheckQueue.js';
import { retainQuotaUsage, recordQuotaCheckEvent } from '@/lib/db/repos/quotaHistoryRepo.js';
import { configureQuotaAutoPing, notifyQuotaAccountChanged, runQuotaAutoPingTick, stopQuotaAutoPing } from '@/shared/services/quotaAutoPing.js';
import { QUOTA_AUTOPING_CONFIG as C } from '@/shared/constants/config.js';

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const provider = 'synthetic-lifecycle';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const freshState = () => ({ running: false, failureCache: {}, resetCache: {}, seenResets: {}, allRunning: {} });
let db, queue, state, deps, account, settings, execute;
beforeAll(async () => { db = await getAdapter(); });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.run('DELETE FROM quotaCheckJobs'); db.run('DELETE FROM quotaCheckEvents'); db.run('DELETE FROM quotaObservations');
  queue = createQuotaCheckQueue(db); state = freshState();
  C.providers[provider] = { settingsKey: 'syntheticLifecycle', quotaKey: 'session', expectedWindows: ['session'], authTypes: ['oauth'], pingModel: 'synthetic-model' };
  account = { id: 'lifecycle-account', provider, isActive: true, authType: 'oauth' };
  settings = { syntheticLifecycle: { connections: { [account.id]: true } } };
  execute = vi.fn(async () => ({ response: new Response('', { status: 200 }) }));
  deps = {
    getQuotaCheckQueue: async () => queue, getSettings: async () => settings,
    getProviderConnections: async ({ provider: requested }) => requested === provider && account ? [account] : [],
    updateProviderConnection: async (_id, patch) => Object.assign(account, structuredClone(patch)),
    resolveConnectionProxyConfig: async () => ({}), refreshAndUpdateCredentials: async connection => ({ connection }),
    getUsageForProvider: async () => ({ quotaObservation: { id: String(Date.now()), observedAt: new Date().toISOString() }, quotas: { session: { remaining: 10, unit: 'requests', resourceType: 'request-limit', resetAt: '2026-09-08T11:00:00.000Z' } } }),
    getExecutor: () => ({ execute }), retainQuotaUsage, recordQuotaCheckEvent,
  };
});
afterEach(async () => { await stopQuotaAutoPing(state); delete C.providers[provider]; vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(() => db.close());

it('stops a manual in-progress tick while metadata is pending and never dispatches its late result', async () => {
  const read = deferred(), entered = deferred();
  deps.getUsageForProvider = () => { entered.resolve(); return read.promise; };
  const tick = runQuotaAutoPingTick(deps, state);
  await entered.promise;
  await stopQuotaAutoPing(state);
  expect(queue.list().items[0]).toMatchObject({ status: 'cancelled', cancelReason: 'scheduler-stopped' });
  read.resolve({ quotas: {} }); await tick;
  expect(execute).not.toHaveBeenCalled();
});

it.each(['setting-disabled', 'account-inactive', 'account-missing', 'auth-unsupported'])('persists %s seen between quota read and dispatch', async reason => {
  const read = deps.getUsageForProvider;
  deps.getUsageForProvider = async () => {
    const result = await read();
    if (reason === 'setting-disabled') settings.syntheticLifecycle.connections[account.id] = false;
    if (reason === 'account-inactive') account.isActive = false;
    if (reason === 'auth-unsupported') account.authType = 'apikey';
    if (reason === 'account-missing') account = null;
    return result;
  };
  await runQuotaAutoPingTick(deps, state);
  expect(execute).not.toHaveBeenCalled();
  expect(queue.list().items[0]).toMatchObject({ status: 'cancelled', cancelReason: reason });
});

it('aborts an active warming stream and preserves uncertainty without another request', async () => {
  const entered = deferred(); let upstreamSignal, cancelled = 0;
  execute.mockImplementation(async request => {
    upstreamSignal = request.signal; entered.resolve();
    return { response: { status: 200, body: new ReadableStream({ cancel() { cancelled++; } }) } };
  });
  const tick = runQuotaAutoPingTick(deps, state); await entered.promise;
  await stopQuotaAutoPing(state); await tick;
  expect(upstreamSignal.aborted).toBe(true); expect(cancelled).toBe(1);
  expect(account.autoPingWindows.session.lastAttemptOutcome).toBe('uncertain');
  await runQuotaAutoPingTick(deps, freshState());
  expect(execute).toHaveBeenCalledTimes(1);
});

it('cannot warm or complete after a renewal failure', async () => {
  const read = deferred(), entered = deferred();
  deps.getUsageForProvider = () => { entered.resolve(); return read.promise; };
  const complete = vi.spyOn(queue, 'complete'); vi.spyOn(queue, 'renew').mockReturnValue(false);
  const tick = runQuotaAutoPingTick(deps, state); await entered.promise;
  await vi.advanceTimersByTimeAsync(40_000);
  read.resolve({ quotas: {} }); await tick;
  expect(execute).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
});

it('holds the metadata permit after cancellation until the shared collector drains', async () => {
  const read = deferred(), entered = deferred();
  const collector = vi.fn(() => { entered.resolve(); return read.promise; }); deps.getUsageForProvider = collector;
  const tick = runQuotaAutoPingTick(deps, state); await entered.promise;
  await stopQuotaAutoPing(state); await tick;
  await runQuotaAutoPingTick(deps, state);
  expect(collector).toHaveBeenCalledTimes(1); expect(state.pendingMetadata.size).toBe(1);
  read.resolve({ quotas: {} }); await Promise.resolve();
  expect(state.pendingMetadata.size).toBe(0); expect(execute).not.toHaveBeenCalled();
});

it('reconciles a setting opt-out even when no scheduler interval is installed', async () => {
  queue.reconcile([{ id: account.id, provider }]);
  settings.syntheticLifecycle.connections[account.id] = false;
  await configureQuotaAutoPing(settings, deps, state);
  expect(queue.list().items[0]).toMatchObject({ status: 'cancelled', cancelReason: 'setting-disabled' });
  expect(execute).not.toHaveBeenCalled();
});

it('account mutation notification cancels pending metadata without opening a new check', async () => {
  const read = deferred(), entered = deferred();
  deps.getUsageForProvider = () => { entered.resolve(); return read.promise; };
  const tick = runQuotaAutoPingTick(deps, state); await entered.promise;
  account.isActive = false;
  await notifyQuotaAccountChanged(account.id, state); await tick;
  expect(queue.list().items[0]).toMatchObject({ status: 'cancelled', cancelReason: 'account-inactive' });
  read.resolve({ quotas: {} }); await Promise.resolve(); expect(execute).not.toHaveBeenCalled();
});

it('enforces a bounded check deadline while a collector does not answer', async () => {
  const read = deferred(), entered = deferred();
  deps.getUsageForProvider = () => { entered.resolve(); return read.promise; };
  const tick = runQuotaAutoPingTick(deps, state); await entered.promise;
  await vi.advanceTimersByTimeAsync(120_000); await tick;
  expect(queue.list().items[0]).toMatchObject({ status: 'cancelled', cancelReason: 'check-deadline' });
  read.resolve({ quotas: {} }); await Promise.resolve(); expect(execute).not.toHaveBeenCalled();
});

it('rechecks authority after the durable dispatch guard was saved', async () => {
  const save = deps.updateProviderConnection;
  deps.updateProviderConnection = async (id, patch) => {
    const result = await save(id, patch);
    if (patch.autoPingWindows?.session?.lastAttemptOutcome === 'dispatching') settings.syntheticLifecycle.connections[id] = false;
    return result;
  };
  await runQuotaAutoPingTick(deps, state);
  expect(execute).not.toHaveBeenCalled();
  expect(queue.list().items[0]).toMatchObject({ status: 'cancelled', cancelReason: 'setting-disabled' });
});

it('cancels an opted-out check even when every quota is already running and no warming is planned', async () => {
  deps.getUsageForProvider = async () => {
    settings.syntheticLifecycle.connections[account.id] = false;
    return { quotas: { session: { remaining: 100, resetAt: '2026-09-08T18:00:00.000Z' } } };
  };
  await runQuotaAutoPingTick(deps, state);
  expect(queue.list().items[0]).toMatchObject({ status: 'cancelled', cancelReason: 'setting-disabled' });
  expect(execute).not.toHaveBeenCalled();
});

it('bounds each tick to eight metadata checks without overlapping upstream work', async () => {
  const accounts = Array.from({ length: 12 }, (_, index) => ({ ...account, id: `bounded-${index}` }));
  settings.syntheticLifecycle.connections = Object.fromEntries(accounts.map(item => [item.id, true]));
  deps.getProviderConnections = async ({ provider: requested }) => requested === provider ? accounts : [];
  let active = 0, peak = 0;
  const usage = vi.fn(async () => {
    active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
    return { quotas: { session: { remaining: 100, resetAt: '2026-09-08T18:00:00.000Z' } } };
  });
  deps.getUsageForProvider = usage;
  await runQuotaAutoPingTick(deps, state);
  expect(usage).toHaveBeenCalledTimes(8); expect(peak).toBe(1);
  expect(queue.due(200)).toHaveLength(4); expect(execute).not.toHaveBeenCalled();
});

it('records the exact persisted schedule horizon in the history and in the next started check', async () => {
  deps.getUsageForProvider = async () => ({ quotaObservation: { id: 'running', observedAt: new Date().toISOString() }, quotas: { session: { remaining: 10, unit: 'requests', resourceType: 'request-limit', resetAt: '2026-09-08T18:00:00.000Z' } } });
  await runQuotaAutoPingTick(deps, state);
  const job = queue.list().items[0];
  expect(job.targets).toHaveLength(1);
  const scheduled = db.get("SELECT * FROM quotaCheckEvents WHERE jobId=? AND eventType='scheduled' ORDER BY capturedAt DESC,id DESC LIMIT 1", [job.id]);
  expect(scheduled).toMatchObject({ scheduledFor: job.nextCheckAt, scope: 'session', observationId: job.targets[0].observationId, unit: 'requests', code: job.reason });
  vi.setSystemTime(Date.parse(job.nextCheckAt));
  await runQuotaAutoPingTick(deps, freshState());
  const started = db.get("SELECT * FROM quotaCheckEvents WHERE jobId=? AND eventType='started' ORDER BY capturedAt DESC LIMIT 1", [job.id]);
  expect(started.scheduledFor).toBe(job.nextCheckAt); expect(execute).not.toHaveBeenCalled();
});
