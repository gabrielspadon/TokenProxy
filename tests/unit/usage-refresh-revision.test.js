import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('open-sse/index.js', () => ({}));
vi.mock('open-sse/executors/index.js', () => ({ getExecutor: vi.fn() }));
import { getExecutor } from 'open-sse/executors/index.js';
import { createProviderConnection, getProviderConnectionById, updateProviderConnection } from '@/lib/db/repos/connectionsRepo.js';
import { refreshAndUpdateCredentials } from '@/app/api/usage/[connectionId]/route.js';
let account, refresh;
beforeEach(async () => {
  account = await createProviderConnection({ provider: 'codex', authType: 'oauth', accessToken: 'fixture-old-access', refreshToken: 'fixture-old-refresh' });
  refresh = vi.fn(async () => ({ accessToken: 'fixture-new-access', refreshToken: 'fixture-rotated-refresh' }));
  getExecutor.mockReturnValue({ needsRefresh: () => true, refreshCredentials: refresh });
});
it('retains a redeemed credential pair through the real repository when its original revision remains current', async () => {
  const result = await refreshAndUpdateCredentials(account);
  expect(result.refreshed).toBe(true);
  expect(result.connection).toEqual(await getProviderConnectionById(account.id));
  expect(await getProviderConnectionById(account.id)).toMatchObject({ accessToken: 'fixture-new-access', refreshToken: 'fixture-rotated-refresh' });
});
it('uses a compatible authoritative winner after a concurrent credential transition', async () => {
  const transition = {
    accessToken: 'fixture-reauth-access',
    refreshToken: 'fixture-reauth-refresh',
    lastQuotaSnapshot: { remainingPercentage: 17, capturedAt: '2026-09-12T10:00:00.000Z' },
  };
  refresh.mockImplementation(async () => {
    await updateProviderConnection(account.id, transition);
    return { accessToken: 'fixture-late-access', refreshToken: 'fixture-late-refresh' };
  });
  const result = await refreshAndUpdateCredentials(account);
  const actual = await getProviderConnectionById(account.id);
  expect(result).toEqual({ connection: actual, refreshed: true });
  expect(actual).toMatchObject(transition);
  expect(actual.accessToken).not.toBe('fixture-late-access');
  expect(actual.refreshToken).not.toBe('fixture-late-refresh');
});
it('rejects a disabled conflict winner without publishing the late rotation', async () => {
  refresh.mockImplementation(async () => {
    await updateProviderConnection(account.id, { isActive: false });
    return { accessToken: 'fixture-late-access', refreshToken: 'fixture-late-refresh' };
  });
  await expect(refreshAndUpdateCredentials(account)).rejects.toMatchObject({
    code: 'CREDENTIAL_SELECTION_CHANGED',
    retryable: false,
  });
  const actual = await getProviderConnectionById(account.id);
  expect(actual.isActive).toBe(false);
  expect(actual.accessToken).not.toBe('fixture-late-access');
  expect(actual.refreshToken).not.toBe('fixture-late-refresh');
});
