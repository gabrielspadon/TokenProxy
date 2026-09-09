import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('open-sse/index.js', () => ({}));
vi.mock('open-sse/services/usage.js', () => ({ getUsageForProvider: vi.fn() }));
vi.mock('open-sse/executors/index.js', () => ({ getExecutor: vi.fn() }));
vi.mock('@/app/api/usage/[connectionId]/route.js', () => ({ refreshAndUpdateCredentials: vi.fn(async connection => ({ connection })) }));
vi.mock('@/lib/network/connectionProxy', () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})), toConnectionProxyOptions: vi.fn(() => ({})) }));
import { getUsageForProvider } from 'open-sse/services/usage.js';
import { getExecutor } from 'open-sse/executors/index.js';
import { initDb } from '@/lib/db/index.js';
import { getAdapter } from '@/lib/db/driver.js';
import { runMigrationOnce } from '@/lib/db/migrate.js';
import { createBetterSqliteAdapter } from '@/lib/db/adapters/betterSqliteAdapter.js';
import { createProviderConnection, getProviderConnectionById } from '@/lib/db/repos/connectionsRepo.js';
import { updateSettings } from '@/lib/db/repos/settingsRepo.js';
import { decryptSecretJson } from '@/lib/db/helpers/secretCol.js';
import { openAnalyticsReadOnly } from '@/lib/db/analytics/readOnly.mjs';
import { DATA_FILE } from '@/lib/db/paths.js';
import { runQuotaAutoPingTick } from '@/shared/services/quotaAutoPing.js';
import { QUOTA_AUTOPING_CONFIG as C } from '@/shared/constants/config.js';

const NOW = '2026-09-08T12:00:00.000Z';
const PROVIDER = 'synthetic-warm-durability';
const freshState = () => ({ running: false, failureCache: {}, resetCache: {}, seenResets: {}, allRunning: {} });
let db, connection, execute;
beforeAll(async () => { await initDb(); db = await getAdapter(); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.run('DELETE FROM providerConnections'); db.run('DELETE FROM quotaObservations'); db.run('DELETE FROM quotaCheckEvents');
  C.providers[PROVIDER] = { settingsKey: 'syntheticWarmDurability', quotaKey: 'session', expectedWindows: ['session'], authTypes: ['oauth'], pingModel: 'synthetic-model' };
  connection = await createProviderConnection({ provider: PROVIDER, authType: 'oauth', name: 'Synthetic account' });
  await updateSettings({ syntheticWarmDurability: { connections: { [connection.id]: true } } });
  getUsageForProvider.mockImplementation(async () => ({
    quotaObservation: { id: new Date().toISOString(), observedAt: new Date().toISOString() },
    quotas: { session: { remaining: 10, total: 100, unit: 'requests', resourceType: 'request-limit', resetAt: '2026-09-08T11:00:00.000Z' } },
  }));
  execute = vi.fn(); getExecutor.mockReturnValue({ execute });
});
afterEach(() => { delete C.providers[PROVIDER]; vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(() => { db.close(); global._dbAdapter.instance = null; global._dbAdapter.initPromise = null; });

describe('default quota scheduler persistence', () => {
  it.each([200, 503])('commits its guard before HTTP %s dispatch and cannot replay after database reopen', async status => {
    let guard;
    execute.mockImplementation(async () => {
      const reader = await openAnalyticsReadOnly(DATA_FILE, db.driver);
      try {
        const row = reader.get('SELECT data FROM providerConnections WHERE id=?', [connection.id]);
        guard = decryptSecretJson(row.data).autoPingWindows.session.lastAttemptOutcome;
      } finally { reader.close(); }
      return { response: new Response('', { status }) };
    });
    await runQuotaAutoPingTick(undefined, freshState());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(guard).toBe('dispatching');
    db.close();
    db = createBetterSqliteAdapter(DATA_FILE);
    await runMigrationOnce(db);
    global._dbAdapter.instance = db;
    const persisted = await getProviderConnectionById(connection.id);
    expect(persisted.autoPingWindows.session.lastAttemptOutcome).toBe(status === 200 ? 'accepted' : 'uncertain');
    vi.setSystemTime('2026-09-09T12:00:00.000Z');
    await runQuotaAutoPingTick(undefined, freshState());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.get('SELECT outcome,unit,resourceType,observationId FROM quotaCheckEvents WHERE eventType=?', ['warm-outcome'])).toMatchObject({
      outcome: status === 200 ? 'accepted' : 'uncertain', unit: 'requests', resourceType: 'request-limit', observationId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
