import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('open-sse/index.js', () => ({}));
vi.mock('open-sse/services/usage.js', () => ({ getUsageForProvider: vi.fn() }));
import { getUsageForProvider } from 'open-sse/services/usage.js';
import { createProviderConnection, getProviderConnectionById, updateProviderConnection } from '@/lib/db/repos/connectionsRepo.js';
import { GET } from '@/app/api/usage/[connectionId]/route.js';
import { bindQuotaSnapshot } from '@/sse/services/quotaEvidenceIdentity.js';
import { resolveConnectionProxyConfig, toConnectionProxyOptions } from '@/lib/network/connectionProxy.js';
import { getProviderCredentials } from '@/sse/services/auth.js';
import { releaseAccountLease } from '@/sse/services/accountLeaseRegistry.js';

let account;
const usage = remainingPercentage => ({ quotas: { weekly: { remainingPercentage, total: 100 } } });
const request = () => new Request(`http://localhost/api/usage/${account.id}`);
const params = () => ({ params: Promise.resolve({ connectionId: account.id }) });
beforeEach(async () => {
  vi.clearAllMocks();
  account = await createProviderConnection({ provider: 'claude', authType: 'access_token',
    accessToken: 'fixture-old-access', providerSpecificData: { proxyPoolId: '__none__' } });
});

it('retains the exact credential and resolved route identity with a published quota observation', async () => {
  getUsageForProvider.mockResolvedValue(usage(90));
  expect((await GET(request(), params())).status).toBe(200);
  const saved = await getProviderConnectionById(account.id);
  const proxy = toConnectionProxyOptions(await resolveConnectionProxyConfig(account.providerSpecificData));
  expect(saved.lastQuotaSnapshot).toEqual(bindQuotaSnapshot(account, proxy, saved.lastQuotaSnapshot));
  expect(saved.lastQuotaSnapshot.windows[0].remainingPercentage).toBe(90);
});

it('does not overwrite the current quota when an old credential read finishes after rotation', async () => {
  const entered = Promise.withResolvers(), fetched = Promise.withResolvers();
  getUsageForProvider.mockImplementation(() => { entered.resolve(); return fetched.promise; });
  const pending = GET(request(), params());
  await entered.promise;
  const current = await updateProviderConnection(account.id, { accessToken: 'fixture-new-access' });
  const proxy = toConnectionProxyOptions(await resolveConnectionProxyConfig(current.providerSpecificData));
  const snapshot = bindQuotaSnapshot(current, proxy, { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'weekly', remainingPercentage: 95, resetAt: null, unlimited: false }] });
  await updateProviderConnection(account.id, { lastQuotaSnapshot: snapshot }, { expectedCredentials: current });
  fetched.resolve(usage(0));
  expect((await pending).status).toBe(200);
  expect((await getProviderConnectionById(account.id)).lastQuotaSnapshot).toEqual(snapshot);
});

it.each(['legacy', 'credential', 'route'])('rechecks %s model depletion before exact-account admission', async variant => {
  const model = 'gemini-2.5-pro';
  let selectedAccount = await createProviderConnection({ provider: 'antigravity', authType: 'oauth',
    accessToken: 'fixture-selected-access', isActive: true, providerSpecificData: { proxyPoolId: '__none__' } });
  const proxy = toConnectionProxyOptions(await resolveConnectionProxyConfig(selectedAccount.providerSpecificData));
  const snapshot = { fetchedAt: new Date().toISOString(), windows: [{ key: model,
    remainingPercentage: 0, resetAt: new Date(Date.now() + 3600000).toISOString(), unlimited: false }] };
  const oldSnapshot = variant === 'legacy' ? snapshot : bindQuotaSnapshot(selectedAccount,
    variant === 'route' ? { ...proxy, connectionProxyUrl: 'http://old-route.test:8080' } : proxy, snapshot);
  selectedAccount = await updateProviderConnection(selectedAccount.id, { lastQuotaSnapshot: oldSnapshot,
    ...(variant === 'credential' ? { accessToken: 'fixture-rotated-access' } : {}) });
  getUsageForProvider.mockResolvedValue({ quotas: { [model]: { remainingPercentage: 80, total: 100,
    resetAt: new Date(Date.now() + 3600000).toISOString() } } });
  const selected = await getProviderCredentials('antigravity', null, model,
    { preferredConnectionId: selectedAccount.id, strictPreferredConnection: true });
  try {
    expect(selected?.connectionId).toBe(selectedAccount.id);
    expect(getUsageForProvider).toHaveBeenCalled();
    expect(selected.accessToken).toBe(selectedAccount.accessToken);
  } finally { releaseAccountLease(selected?.accountLease); }
});
