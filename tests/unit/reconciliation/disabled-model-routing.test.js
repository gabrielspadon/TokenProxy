import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ connections: [], settings: {}, policyUnreadable: false }));
const core = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const quota = vi.hoisted(() => ({ evaluateQuota: vi.fn(async () => ({ paused: false })) }));
vi.mock('@/lib/localDb', async (original) => ({
  ...await original(),
  getProviderConnections: vi.fn(async (filter = {}) => state.connections.filter((c) =>
    (!filter.provider || filter.provider === c.provider) && (!filter.isActive || c.isActive !== false))),
  getSettings: vi.fn(async () => state.settings),
}));
vi.mock('@/lib/network/connectionProxy', () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({ kind: 'usable' })),
  toConnectionProxyOptions: vi.fn(() => ({ connectionProxyEnabled: false })),
  pickProxyPoolId: vi.fn(() => null),
}));
vi.mock('@/sse/services/quotaGuard.js', () => quota);
vi.mock('@/lib/disabledModelsDb', async (original) => {
  const actual = await original();
  return { ...actual, getDisabledModels: async () => {
    if (state.policyUnreadable) throw new Error('Offline policy read failure');
    return actual.getDisabledModels();
  } };
});
vi.mock('@/lib/admin/state.js', () => ({ readAllDrainDocs: vi.fn(async () => ({})) }));
vi.mock('@/sse/services/tokenRefresh.js', () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(async () => {}),
}));
vi.mock('open-sse/handlers/chatCore.js', () => core);
vi.mock('open-sse/index.js', () => ({}));
vi.mock('@/sse/utils/logger.js', () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn(() => 'test-key'),
}));

const MODEL = 'claude-fable-5';
let adapter, db, api, auth, models, chat;
const account = (id, provider = 'claude') => ({
  id, provider, name: id, isActive: true, authType: 'apikey', apiKey: 'fake-offline-key',
  maxConcurrent: 4, providerSpecificData: {},
});
const agent = (session = 'agent-a') => ({
  clientApiKey: 'fake-offline-client', clientHeaders: { 'x-session-id': session },
  clientBody: { messages: [{ role: 'user', content: 'Offline routing test' }] },
});
async function select(session = 'agent-a', extra = {}, provider = 'claude', model = MODEL) {
  const credentials = await auth.getProviderCredentials(provider, null, model, { ...agent(session), ...extra });
  if (credentials?.accountLease) auth.releaseAccountLease(credentials.accountLease);
  return credentials;
}
async function disable(providerAlias, ids, connectionId) {
  const response = await api.POST(new Request('http://localhost/api/models/disabled', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerAlias, ids, connectionId }),
  }));
  expect(response.status).toBe(200);
}
async function enable(providerAlias, connectionId) {
  const query = new URLSearchParams({ providerAlias, connectionId });
  expect((await api.DELETE(new Request(`http://localhost/api/models/disabled?${query}`))).status).toBe(200);
}

beforeAll(async () => {
  // The required Vitest config/setup installs a private directory before imports.
  expect(process.env.DATA_DIR).toMatch(/tokenproxy-test-file-/);
  ({ getAdapter: adapter } = await import('@/lib/db/driver.js'));
  adapter = await adapter();
  db = await import('@/lib/db/index.js');
  api = await import('@/app/api/models/disabled/route.js');
  auth = await import('@/sse/services/auth.js');
  models = await import('@/sse/services/model.js');
  ({ handleChat: chat } = await import('@/sse/handlers/chat.js'));
});
beforeEach(async () => {
  adapter.run('DELETE FROM kv WHERE scope IN (?, ?)', ['disabledModels', 'modelAliases']);
  adapter.run('DELETE FROM sessionAffinity');
  adapter.run('DELETE FROM accountSwitches');
  adapter.run('DELETE FROM providerNodes');
  const { invalidateDisabledModelsCache } = await import('@/lib/db/repos/disabledModelsRepo.js');
  invalidateDisabledModelsCache();
  state.connections = [account('account-a'), account('account-b')];
  state.settings = {};
  state.policyUnreadable = false;
  vi.clearAllMocks();
  core.handleChatCore.mockImplementation(async ({ modelInfo }) => ({
    success: true,
    response: new Response(JSON.stringify({ model: modelInfo.model, choices: [{ message: { content: 'offline' } }] }), {
      headers: { 'content-type': 'application/json' },
    }),
  }));
});
afterAll(() => { adapter?.close?.(); });

describe('disabled model policy reaches real account selection', () => {
  it.each(['cc', 'claude'])('enforces an account disable written under %s for either provider spelling', async (alias) => {
    await disable(alias, [MODEL], 'account-a');
    expect((await select('one', {}, 'cc')).connectionId).toBe('account-b');
    expect((await select('two', {}, 'claude')).connectionId).toBe('account-b');
    expect(quota.evaluateQuota.mock.calls.flat().some((c) => c.id === 'account-a')).toBe(false);
  });

  it('inherits provider disables and honors an explicit empty account override through the HTTP API', async () => {
    await disable('claude', [MODEL]);
    expect(await select()).toBeNull();
    await enable('cc', 'account-b');
    expect(await db.getDisabledByProvider('cc', 'account-b')).toEqual([]);
    expect(await models.isModelDisabled(`cc/${MODEL}`)).toBe(false);
    expect((await select()).connectionId).toBe('account-b');
    expect(await select('strict', { preferredConnectionId: 'account-a', strictPreferredConnection: true })).toBeNull();
  });

  it('preserves a healthy pin, moves only when its model is explicitly disabled, and stays after recovery', async () => {
    const first = await select();
    const other = first.connectionId === 'account-a' ? 'account-b' : 'account-a';
    await disable('cc', ['claude-sonnet-5'], first.connectionId);
    expect((await select()).connectionId).toBe(first.connectionId);
    await disable('claude', [MODEL], first.connectionId);
    expect((await select()).connectionId).toBe(other);
    await enable('cc', first.connectionId);
    await enable('claude', first.connectionId);
    expect((await select()).connectionId).toBe(other);
    expect(adapter.all('SELECT DISTINCT model FROM sessionAffinity')).toEqual([{ model: MODEL }]);
  });

  it('does not let same-account retry or a temporary lock hold an explicitly disabled pin', async () => {
    const first = await select();
    const { buildModelFailureUpdate, getModelLockKey } = await import('open-sse/services/accountFallback.js');
    const pinned = state.connections.find((c) => c.id === first.connectionId);
    const until = new Date(Date.now() + 60_000).toISOString();
    pinned[getModelLockKey(MODEL)] = until;
    Object.assign(pinned, buildModelFailureUpdate(MODEL, {
      status: 429, clientErrorStatus: 429, message: 'Temporary rate limit', until,
    }));
    const alsoLocked = state.connections.find((c) => c.id !== first.connectionId);
    alsoLocked[getModelLockKey(MODEL)] = until;
    Object.assign(alsoLocked, buildModelFailureUpdate(MODEL, { status: 429, message: 'Rate limit', until }));
    state.connections.push(account('account-c'));
    await disable('cc', [MODEL], first.connectionId);
    const next = await select();
    expect(next?.connectionId).toBe('account-c');
    expect(await select('strict', {
      preferredConnectionId: first.connectionId, strictPreferredConnection: true,
      ignoreModelLockConnId: first.connectionId,
    })).toBeNull();
  });

  it('keeps parallel agents on the only permitted account without changing model', async () => {
    await disable('cc', [MODEL], 'account-a');
    const selected = await Promise.all(['a', 'b', 'c'].map((session) => select(session)));
    expect(selected.map((c) => c.connectionId)).toEqual(['account-b', 'account-b', 'account-b']);
    expect(adapter.all('SELECT DISTINCT model FROM sessionAffinity')).toEqual([{ model: MODEL }]);
  });

  it('leaves OAuth enabled when only the no-auth provider switch is set', async () => {
    state.settings = { disabledProviders: { claude: true } };
    expect((await select()).connectionId).toBeDefined();
    await disable('oc', ['big-pickle']);
    expect(await select('free', {}, 'opencode', 'big-pickle')).toBeNull();
  });

  it('maps a configured node prefix to its credential provider ID', async () => {
    await db.createProviderNode({ id: 'custom-node-id', type: 'openai-compatible', prefix: 'corp', name: 'Offline node' });
    state.connections = [account('account-a', 'custom-node-id'), account('account-b', 'custom-node-id')];
    await disable('corp', ['vendor/model']);
    expect(await models.isModelDisabled('corp/vendor/model')).toBe(true);
    expect(await select('custom', {}, 'custom-node-id', 'vendor/model')).toBeNull();
    await enable('custom-node-id', 'account-b');
    expect(await models.isModelDisabled('corp/vendor/model')).toBe(false);
    expect((await select('custom', {}, 'custom-node-id', 'vendor/model')).connectionId).toBe('account-b');
  });

  it('refuses admission if the configured policy cannot be read', async () => {
    await disable('cc', [MODEL], 'account-a');
    state.policyUnreadable = true;
    await expect(select()).rejects.toThrow('Offline policy read failure');
    expect(quota.evaluateQuota).not.toHaveBeenCalled();
    expect(adapter.all('SELECT connectionId FROM sessionAffinity')).toEqual([]);
    expect(auth._getProviderSelectionQueueSize()).toBe(0);
  });
});

describe('direct requests and combo filtering respect the same policy', () => {
  it('refuses when every account has its own disable and no provider default exists', async () => {
    await disable('cc', [MODEL], 'account-a');
    await disable('claude', [MODEL], 'account-b');
    expect(await models.isModelDisabled(`cc/${MODEL}`)).toBe(true);
    expect(await select()).toBeNull();
    expect(core.handleChatCore).not.toHaveBeenCalled();
  });
  it.each([`cc/${MODEL}`, `claude/${MODEL}`, 'my-fable-alias'])('refuses disabled resolved model %s before generation', async (requested) => {
    await db.setModelAlias('my-fable-alias', `cc/${MODEL}`);
    await disable('claude', [MODEL]);
    const response = await chat(new Request('http://localhost/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: requested, messages: [{ role: 'user', content: 'Offline test' }], stream: false }),
    }));
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toContain('disabled');
    expect(core.handleChatCore).not.toHaveBeenCalled();
  });

  it('allows an explicit account override through the direct request preflight', async () => {
    await disable('cc', [MODEL]);
    await enable('claude', 'account-b');
    const response = await chat(new Request('http://localhost/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': 'direct' },
      body: JSON.stringify({ model: `cc/${MODEL}`, messages: [{ role: 'user', content: 'Offline test' }], stream: false }),
    }));
    expect(response.status).toBe(200);
    expect(core.handleChatCore).toHaveBeenCalledTimes(1);
    expect(core.handleChatCore.mock.calls[0][0]).toMatchObject({
      modelInfo: { provider: 'claude', model: MODEL }, credentials: { connectionId: 'account-b' },
    });
  });

  it('filters all disabled combo members without resurrecting them, but retains an account override', async () => {
    const member = `claude/${MODEL}`;
    await disable('cc', [MODEL]);
    expect(await models.filterDisabledComboMembers([member], 'offline-combo')).toEqual([]);
    await enable('claude', 'account-b');
    expect(await models.filterDisabledComboMembers([member], 'offline-combo')).toEqual([member]);
  });
});
