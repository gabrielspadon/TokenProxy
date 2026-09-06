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

async function send(handler, model, headers = {}) {
  const response = await handler(new Request('http://localhost/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': 'exact-agent', ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Offline test' }], input: 'Offline test',
      query: 'Offline test', documents: ['Offline document'], stream: false }),
  }));
  // Finish consuming the request as a client would, including lease release.
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
}

describe('operator edits preserve equivalent persisted scopes', () => {
  it('does not treat a malformed historical list as an explicit empty override', async () => {
    await disable('cc', [MODEL]);
    adapter.run('INSERT INTO kv(scope, key, value) VALUES (?, ?, ?)', ['disabledModels', 'claude::account-a', 'null']);
    await disable('claude', ['claude-sonnet-5'], 'account-a');
    expect(await db.getDisabledByProvider('claude', 'account-a')).toEqual([MODEL, 'claude-sonnet-5']);
    expect(await select()).toBeNull();
  });

  it('keeps an inherited alias disable while adding another model through the canonical API', async () => {
    await disable('cc', [MODEL]);
    await disable('claude', ['claude-sonnet-5'], 'account-a');
    expect(await db.getDisabledByProvider('cc', 'account-a')).toEqual([MODEL, 'claude-sonnet-5']);
    expect(await db.getDisabledByProvider('claude', 'account-a')).toEqual([MODEL, 'claude-sonnet-5']);
    const response = await send(chat, `cc/${MODEL}`);
    expect(response.status).toBe(404);
    expect(core.handleChatCore).not.toHaveBeenCalled();
  });

  it('reconciles conflicting legacy rows when enabling one account and leaves others disabled', async () => {
    for (const [key, ids] of Object.entries({ cc: [MODEL], 'cc::account-a': [MODEL], 'claude::account-a': [] })) {
      adapter.run('INSERT INTO kv(scope, key, value) VALUES (?, ?, ?)', ['disabledModels', key, JSON.stringify(ids)]);
    }
    await enable('claude', 'account-a');
    const response = await send(chat, `cc/${MODEL}`);
    expect(response.status).toBe(200);
    expect(core.handleChatCore.mock.calls[0][0]).toMatchObject({
      modelInfo: { provider: 'claude', model: MODEL }, credentials: { connectionId: 'account-a' },
    });
    expect(await db.getDisabledByProvider('cc', 'account-b')).toEqual([MODEL]);
    expect(await select('blocked', { preferredConnectionId: 'account-b', strictPreferredConnection: true })).toBeNull();
  });

  it('cannot repopulate an old cache across a completed concurrent operator write', async () => {
    const repo = await import('@/lib/db/repos/disabledModelsRepo.js');
    repo.invalidateDisabledModelsCache();
    await Promise.all([repo.getDisabledModels(), repo.disableModels('cc', [MODEL])]);
    expect(await models.isModelDisabled(`cc/${MODEL}`)).toBe(true);
    expect(await select()).toBeNull();
  });

  it('keeps native slash IDs and synchronizes only the edited legacy scope', async () => {
    await db.createProviderNode({ id: 'custom-node-id', type: 'openai-compatible', prefix: 'corp', name: 'Offline node' });
    const values = { corp: ['vendor/model'], 'corp::account-a': ['vendor/model', 'second/model'],
      'custom-node-id::account-a': [], 'corp::account-b': ['vendor/model'], other: ['vendor/model'] };
    for (const [key, ids] of Object.entries(values)) {
      adapter.run('INSERT INTO kv(scope, key, value) VALUES (?, ?, ?)', ['disabledModels', key, JSON.stringify(ids)]);
    }
    const query = new URLSearchParams({ providerAlias: 'custom-node-id', connectionId: 'account-a', id: 'corp/vendor/model' });
    expect((await api.DELETE(new Request(`http://localhost/api/models/disabled?${query}`))).status).toBe(200);
    const actual = Object.fromEntries(adapter.all('SELECT key, value FROM kv WHERE scope = ?', ['disabledModels'])
      .map(({ key, value }) => [key, JSON.parse(value)]));
    expect(actual).toEqual({ ...values, 'corp::account-a': ['second/model'], 'custom-node-id::account-a': ['second/model'] });
    const read = new URLSearchParams({ providerAlias: 'corp', connectionId: 'account-a' });
    expect(await (await api.GET(new Request(`http://localhost/api/models/disabled?${read}`))).json()).toEqual({ ids: ['second/model'] });
  });

  it('does not write a built-in disable into a configured node that shadows its alias', async () => {
    await db.createProviderNode({ id: 'custom-node-id', type: 'openai-compatible', prefix: 'cc', name: 'Offline node' });
    state.connections = [account('account-a'), account('node-account', 'custom-node-id')];
    await disable('claude', [MODEL]);
    expect(await models.isModelDisabled(`claude/${MODEL}`)).toBe(true);
    expect(await models.isModelDisabled(`cc/${MODEL}`)).toBe(false);
    const response = await send(chat, `cc/${MODEL}`);
    expect(response.status).toBe(200);
    expect(core.handleChatCore.mock.calls[0][0]).toMatchObject({
      modelInfo: { provider: 'custom-node-id', model: MODEL }, credentials: { connectionId: 'node-account' },
    });
  });

  it('does not apply a configured node prefix disable to the built-in provider it shadows', async () => {
    await db.createProviderNode({ id: 'custom-node-id', type: 'openai-compatible', prefix: 'cc', name: 'Offline node' });
    state.connections = [account('account-a'), account('node-account', 'custom-node-id')];
    await disable('cc', [MODEL]);
    expect(await models.isModelDisabled(`cc/${MODEL}`)).toBe(true);
    expect(await models.isModelDisabled(`claude/${MODEL}`)).toBe(false);
    expect(await db.getDisabledByProvider('claude')).toEqual([]);
    const response = await send(chat, `claude/${MODEL}`);
    expect(response.status).toBe(200);
    expect(core.handleChatCore.mock.calls[0][0]).toMatchObject({
      modelInfo: { provider: 'claude', model: MODEL }, credentials: { connectionId: 'account-a' },
    });
  });
});

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
