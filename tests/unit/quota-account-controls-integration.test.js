import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('open-sse/index.js', () => ({}));
vi.mock('@/app/api/usage/[connectionId]/route.js', () => ({ refreshAndUpdateCredentials: vi.fn() }));
const { getAdapter } = await import('@/lib/db/driver.js');
const repo = await import('@/lib/db/repos/connectionsRepo.js');
const { createQuotaCheckQueue } = await import('@/lib/db/repos/quotaCheckQueue.js');
const { QUOTA_AUTOPING_CONFIG: config } = await import('@/shared/constants/config.js');
await import('@/shared/services/quotaAutoPing.js');
const state = global.__quotaAutoPing, db = await getAdapter();
const provider = 'quota-controls-fixture';
let connection, queue, cancel, getSettings;
beforeEach(async () => {
  state.queue = null; state.activeCheck = null;
  for (const table of ['quotaCheckJobs', 'quotaCheckEvents', 'providerConnections']) db.run(`DELETE FROM ${table}`);
  connection = await repo.createProviderConnection({ provider, authType: 'oauth', name: 'Fixture', isActive: true });
  config.providers[provider] = { settingsKey: 'quotaControlFixture', authTypes: ['oauth'] };
  getSettings = vi.fn(async () => ({ quotaControlFixture: { connections: { [connection.id]: true } } }));
  queue = createQuotaCheckQueue(db);
  queue.reconcile([{ id: connection.id, provider }]);
  const claim = queue.claim(queue.list().items[0].id);
  cancel = vi.fn();
  Object.assign(state, { queue, deps: { getSettings, getProviderConnections: repo.getProviderConnections }, activeCheck: { claim, cancel } });
});
afterEach(() => { state.queue = null; state.deps = null; state.activeCheck = null; delete config.providers[provider]; vi.restoreAllMocks(); });

it.each([{ isActive: false }, { authType: 'apikey' }])('commits %j then invalidates the matching quota claim', async patch => {
  await repo.updateProviderConnection(connection.id, patch);
  expect(await repo.getProviderConnectionById(connection.id)).toMatchObject(patch);
  expect(queue.list().items[0].status).toBe('cancelled');
  expect(cancel).toHaveBeenCalledOnce();
});
it.each(['deleteProviderConnection', 'deleteProviderConnectionsByProvider'])('cancels queued work after %s succeeds', async operation => {
  await repo[operation](operation === 'deleteProviderConnection' ? connection.id : provider);
  expect(await repo.getProviderConnectionById(connection.id)).toBeNull();
  expect(queue.list().items[0]).toMatchObject({ status: 'cancelled', cancelReason: 'account-missing' });
  expect(cancel).toHaveBeenCalledOnce();
});
it('does not rescan scheduling on unrelated edits or refused writes', async () => {
  await repo.updateProviderConnection(connection.id, { name: 'Changed' });
  expect(getSettings).not.toHaveBeenCalled();
  await expect(repo.updateProviderConnection(connection.id, { isActive: false }, { expectedControls: { isActive: false } })).rejects.toMatchObject({ code: 'CONTROL_CONFLICT' });
  expect(queue.list().items[0].status).toBe('running');
  expect(cancel).not.toHaveBeenCalled();
});
it('retains the confirmed account change and revokes active work when inventory cannot be read', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  getSettings.mockRejectedValue(new Error('Unavailable inventory'));
  await expect(repo.updateProviderConnection(connection.id, { isActive: false })).resolves.toMatchObject({ isActive: false });
  expect(cancel).toHaveBeenCalledWith('ownership-lost');
});
