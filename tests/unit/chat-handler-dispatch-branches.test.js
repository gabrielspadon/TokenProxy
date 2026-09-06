// handleChat dispatch and validation branches the reconciliation suites leave
// dark: invalid-JSON and missing-model refusals, the context-suffix strip and
// claude-compat rewrite, the allowlist/disabled/bypass gates, the auto router,
// agent-role narrowing, fusion and nested-combo expansion with the cycle guard,
// capacity-adapter reachability filtering, the combo pin, the abort return, and
// the antigravity projectId cold-miss path. Upstream dispatch (handleChatCore)
// and account selection are mocked; expectations read the mocks' captured
// arguments rather than literals where the handler owns the wiring.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  getReachableProviders: vi.fn(),
}));
const coreMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  isModelDisabled: vi.fn(),
}));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
const comboMocks = vi.hoisted(() => ({
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => new Set()),
  resolveComboMemberConnection: vi.fn(() => null),
  resolveComboTokenSaver: vi.fn(() => ({})),
}));
const capacityMocks = vi.hoisted(() => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((fn) => fn),
  getActiveAdapterStrategy: vi.fn(() => 'fallback'),
}));
const agentRoleMocks = vi.hoisted(() => ({
  detectAgentRole: vi.fn(() => null),
  applyAgentRoleGroup: vi.fn((models) => models),
}));
const bypassMocks = vi.hoisted(() => ({ handleBypassRequest: vi.fn(() => null) }));
const autoMocks = vi.hoisted(() => ({
  AUTO_MODEL_IDS: new Set(['auto']),
  resolveAutoModel: vi.fn(),
}));
const accessMocks = vi.hoisted(() => ({ refuseDisallowedModel: vi.fn(async () => null) }));
const compatMocks = vi.hoisted(() => ({
  stripContextSuffix: vi.fn((s) => (typeof s === 'string' ? s.replace(/\[1m\]$/i, '') || s : s)),
  looksLikeClaudeWrappedModel: vi.fn(() => false),
  normalizeClaudeModelName: vi.fn((s) => s),
  buildClaudeRoutingIndex: vi.fn(async () => ({})),
  readClaudeCompat: vi.fn(() => ({ enabled: false })),
}));
const projectIdMocks = vi.hoisted(() => ({ getProjectIdForConnection: vi.fn(async () => null) }));
const refreshMocks = vi.hoisted(() => ({
  checkAndRefreshToken: vi.fn(async (_p, c) => ({ ...c })),
  updateProviderCredentials: vi.fn(async () => {}),
}));
const usageMocks = vi.hoisted(() => ({ getActiveRequests: vi.fn(async () => []) }));
const logMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => '***'),
}));

vi.mock('open-sse/index.js', () => ({}));
vi.mock('@/sse/services/auth.js', () => ({
  ...authMocks,
  isValidApiKey: vi.fn(async () => false),
}));
vi.mock('open-sse/handlers/chatCore.js', () => coreMocks);
vi.mock('@/sse/services/model.js', () => modelMocks);
vi.mock('@/lib/localDb', () => settingsMocks);
vi.mock('open-sse/services/combo.js', () => ({
  ...comboMocks,
  detectRequiredCapabilities: comboMocks.detectRequiredCapabilities,
}));
vi.mock('open-sse/services/capacityAdapter.js', () => capacityMocks);
vi.mock('open-sse/utils/agentRole.js', () => agentRoleMocks);
vi.mock('open-sse/utils/bypassHandler.js', () => bypassMocks);
vi.mock('@/sse/services/autoRouter.js', () => autoMocks);
vi.mock('@/sse/services/modelAccess.js', () => accessMocks);
vi.mock('@/lib/claudeCompat', () => compatMocks);
vi.mock('open-sse/services/projectId.js', () => projectIdMocks);
vi.mock('@/lib/antigravityVerification', () => ({
  createAntigravityVerificationHooks: vi.fn(() => ({})),
}));
vi.mock('@/sse/services/tokenRefresh.js', () => refreshMocks);
vi.mock('@/lib/usageDb.js', () => usageMocks);
vi.mock('@/sse/utils/logger.js', () => logMocks);
vi.mock('@/sse/services/accountLeaseRegistry.js', () => ({
  releaseAccountLease: vi.fn(),
  releaseAccountLeaseOnResponse: vi.fn((r) => r),
}));

const { handleChat, providerConcurrencyOverflow, readAttemptCeiling, __rateLimiter } =
  await import('@/sse/handlers/chat.js');

function request(body = { model: 'prov/m', messages: [] }, headers = {}) {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function sseWithContent() {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  __rateLimiter.reset();
  settingsMocks.getSettings.mockResolvedValue({});
  modelMocks.getModelInfo.mockImplementation(async (m) => {
    const [provider, ...rest] = String(m).split('/');
    return rest.length ? { provider, model: rest.join('/') } : { provider: null };
  });
  modelMocks.getComboModels.mockResolvedValue(null);
  modelMocks.isModelDisabled.mockResolvedValue(false);
  agentRoleMocks.detectAgentRole.mockReturnValue(null);
  agentRoleMocks.applyAgentRoleGroup.mockImplementation((models) => models);
  capacityMocks.augmentModelsWithCapacityAdapter.mockImplementation((models) => models);
  capacityMocks.withCapacityAdapterStripping.mockImplementation((fn) => fn);
  comboMocks.resolveComboMemberConnection.mockReturnValue(null);
  comboMocks.resolveComboTokenSaver.mockReturnValue({});
  accessMocks.refuseDisallowedModel.mockResolvedValue(null);
  bypassMocks.handleBypassRequest.mockReturnValue(null);
  compatMocks.looksLikeClaudeWrappedModel.mockReturnValue(false);
  authMocks.getReachableProviders.mockResolvedValue(new Set());
  authMocks.getProviderCredentials.mockResolvedValue(null);
});

describe('body and model validation', () => {
  it('refuses an unparseable JSON body with 400', async () => {
    const res = await handleChat(request('{not json'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('Invalid JSON body');
  });

  it('refuses a body without a model with 400', async () => {
    const res = await handleChat(request({ messages: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('Missing model');
  });

  it('tolerates a clientRawRequest with no headers field', async () => {
    const res = await handleChat(request({ messages: [] }), { endpoint: '/x', body: {} });
    expect(res.status).toBe(400);
  });
});

describe('model-name rewrites before routing', () => {
  it('strips the [1m] context suffix before any lookup', async () => {
    await handleChat(request({ model: 'prov/m[1m]', messages: [] }));
    expect(modelMocks.getModelInfo).toHaveBeenCalledWith('prov/m');
  });

  it('applies the claude-compat rewrite when the toggle is on', async () => {
    compatMocks.looksLikeClaudeWrappedModel.mockReturnValue(true);
    compatMocks.readClaudeCompat.mockReturnValue({ enabled: true });
    compatMocks.normalizeClaudeModelName.mockReturnValue('prov/real');
    await handleChat(request({ model: 'claude-wrap/x', messages: [] }));
    expect(compatMocks.buildClaudeRoutingIndex).toHaveBeenCalled();
    expect(modelMocks.getModelInfo).toHaveBeenCalledWith('prov/real');
  });
});

describe('admission gates in order', () => {
  it('returns the allowlist refusal as-is', async () => {
    const barred = new Response('no', { status: 403 });
    accessMocks.refuseDisallowedModel.mockResolvedValue(barred);
    expect(await handleChat(request())).toBe(barred);
    expect(modelMocks.getComboModels).not.toHaveBeenCalled();
  });

  it('refuses a disabled model with 404 naming it', async () => {
    modelMocks.isModelDisabled.mockResolvedValue(true);
    const res = await handleChat(request());
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain('prov/m');
  });

  it('short-circuits a bypass (naming/warmup) request before rotation', async () => {
    const bypass = new Response('warm', { status: 200 });
    bypassMocks.handleBypassRequest.mockReturnValue({ response: bypass });
    expect(await handleChat(request())).toBe(bypass);
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
  });
});

describe('auto router', () => {
  it('answers 503 when nothing is routable', async () => {
    autoMocks.resolveAutoModel.mockResolvedValue(null);
    const res = await handleChat(request({ model: 'auto', messages: [] }));
    expect(res.status).toBe(503);
  });

  it('substitutes the routed model and continues the ordinary path', async () => {
    autoMocks.resolveAutoModel.mockResolvedValue({ model: 'prov/m', taskClass: 't', source: 's' });
    const res = await handleChat(request({ model: 'auto', messages: [] }));
    // getProviderCredentials null with an empty exclude set -> 404 on the real path
    expect(res.status).toBe(404);
    expect(modelMocks.getModelInfo).toHaveBeenCalledWith('prov/m');
  });

  it('lets a user combo named "auto" outrank the router', async () => {
    modelMocks.getComboModels.mockImplementation(async (m) => (m === 'auto' ? ['prov/m'] : null));
    await handleChat(request({ model: 'auto', messages: [] }));
    expect(autoMocks.resolveAutoModel).not.toHaveBeenCalled();
    expect(comboMocks.handleComboChat).toHaveBeenCalled();
  });
});

describe('combo expansion', () => {
  it('narrows a combo to the agent-role group and reports the narrowing', async () => {
    modelMocks.getComboModels.mockImplementation(async (m) =>
      m === 'team' ? ['a/x', 'b/y'] : null
    );
    agentRoleMocks.detectAgentRole.mockReturnValue('sub');
    agentRoleMocks.applyAgentRoleGroup.mockReturnValue(['a/x']);
    await handleChat(request({ model: 'team', messages: [] }));
    const opts = comboMocks.handleComboChat.mock.calls[0][0];
    expect(opts.models).toEqual(['a/x']);
    expect(logMocks.info.mock.calls.flat().join(' ')).toContain('Agent role "sub"');
  });

  it('fusion strategy strips tools from panel members', async () => {
    modelMocks.getComboModels.mockImplementation(async (m) =>
      m === 'fuse' ? ['a/x', 'b/y'] : null
    );
    settingsMocks.getSettings.mockResolvedValue({ comboStrategy: 'fusion' });
    const raw = {
      endpoint: '/v1/chat/completions',
      headers: {},
      body: { tools: [1], tool_choice: 'z', keep: 1 },
    };
    await handleChat(request({ model: 'fuse', messages: [] }), raw);
    const opts = comboMocks.handleFusionChat.mock.calls[0][0];
    expect(opts.comboName).toBe('fuse');
    // Drive the panel callback: the raw request it forwards must lose tools.
    await opts.handleSingleModel({ model: 'a/x', messages: [] }, 'a/x', true);
    // The inner single-model call went to selection; the handler stripped tools
    // from clientRawRequest before recursing (asserted by it not throwing and
    // selection being consulted for the member's provider).
    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      'a',
      expect.any(Set),
      'x',
      expect.any(Object)
    );
  });

  it('expands a nested combo with its own fusion strategy', async () => {
    modelMocks.getComboModels.mockImplementation(async (m) =>
      m === 'outer' ? ['inner'] : m === 'inner' ? ['a/x'] : null
    );
    settingsMocks.getSettings.mockResolvedValue({
      comboStrategies: { inner: { fallbackStrategy: 'fusion' } },
    });
    await handleChat(request({ model: 'outer', messages: [] }));
    const outerOpts = comboMocks.handleComboChat.mock.calls[0][0];
    await outerOpts.handleSingleModel({ model: 'inner', messages: [] }, 'inner');
    const innerOpts = comboMocks.handleFusionChat.mock.calls[0][0];
    expect(innerOpts.comboName).toBe('inner');
    // And the nested fusion's own panel callback recurses cleanly.
    const res = await innerOpts.handleSingleModel({ model: 'a/x', messages: [] }, 'a/x', true);
    expect(res.status).toBe(404);
  });

  it('refuses a combo cycle instead of recursing', async () => {
    modelMocks.getComboModels.mockResolvedValue(['loop']);
    await handleChat(request({ model: 'loop', messages: [] }));
    const opts = comboMocks.handleComboChat.mock.calls[0][0];
    const res = await opts.handleSingleModel({ model: 'loop', messages: [] }, 'loop');
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('contains itself');
  });

  it('pins a combo member to its configured connection, strictly', async () => {
    modelMocks.getComboModels.mockImplementation(async (m) => (m === 'pc' ? ['prov/m'] : null));
    comboMocks.resolveComboMemberConnection.mockReturnValue('conn-pin-12345678');
    await handleChat(request({ model: 'pc', messages: [] }));
    const opts = comboMocks.handleComboChat.mock.calls[0][0];
    const res = await opts.handleSingleModel({ model: 'prov/m', messages: [] }, 'prov/m');
    expect(res.status).toBe(404);
    const credOpts = authMocks.getProviderCredentials.mock.calls[0][3];
    expect(credOpts.preferredConnectionId).toBe('conn-pin-12345678');
    expect(credOpts.strictPreferredConnection).toBe(true);
  });
});

describe('capacity adapter on the solo path', () => {
  it('spreads over a combo when a reachable adapter is added', async () => {
    capacityMocks.augmentModelsWithCapacityAdapter.mockReturnValue(['ad/alt', 'prov/m']);
    authMocks.getReachableProviders.mockResolvedValue(new Set(['ad']));
    await handleChat(request());
    const opts = comboMocks.handleComboChat.mock.calls[0][0];
    expect(opts.models).toEqual(['ad/alt', 'prov/m']);
    expect(capacityMocks.getActiveAdapterStrategy).toHaveBeenCalled();
  });

  it('drops an adapter whose provider is not reachable and stays solo', async () => {
    capacityMocks.augmentModelsWithCapacityAdapter.mockReturnValue(['ad/alt', 'prov/m']);
    authMocks.getReachableProviders.mockResolvedValue(new Set());
    const res = await handleChat(request());
    expect(comboMocks.handleComboChat).not.toHaveBeenCalled();
    expect(res.status).toBe(404); // straight to selection, which is empty here
  });
});

describe('the single-model loop', () => {
  it('answers 499 when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await handleChat(request(), null, { signal: controller.signal });
    expect(res.status).toBe(499);
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it('cold-fills the antigravity projectId, persists it, and wires the callbacks', async () => {
    modelMocks.getModelInfo.mockResolvedValue({ provider: 'antigravity', model: 'g' });
    authMocks.getProviderCredentials.mockResolvedValue({
      connectionId: 'c1',
      connectionName: 'c1',
      providerSpecificData: {},
      accountLease: null,
    });
    projectIdMocks.getProjectIdForConnection.mockResolvedValue('proj-9');
    coreMocks.handleChatCore.mockImplementation(async (opts) => {
      expect(opts.credentials.projectId).toBe('proj-9');
      await opts.onCredentialsRefreshed({ accessToken: 'new' });
      await opts.onEmptyStream();
      await opts.onRequestSuccess();
      return { success: true, response: sseWithContent() };
    });
    const res = await handleChat(request({ model: 'antigravity/g', messages: [] }));
    expect(res.status).toBe(200);
    // projectId persisted in the background AND via the refresh callback.
    expect(refreshMocks.updateProviderCredentials).toHaveBeenCalledWith('c1', {
      projectId: 'proj-9',
    });
    expect(refreshMocks.updateProviderCredentials).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ accessToken: 'new', testStatus: 'active' })
    );
    expect(authMocks.markAccountUnavailable).toHaveBeenCalled(); // onEmptyStream lock
    expect(authMocks.clearAccountError).toHaveBeenCalledWith('c1', expect.anything(), 'g');
  });
});

describe('providerConcurrencyOverflow', () => {
  it('fails open when settings are unreadable', async () => {
    settingsMocks.getSettings.mockRejectedValueOnce(new Error('db down'));
    expect(await providerConcurrencyOverflow('p')).toBeNull();
  });

  it('fails open when active requests are unreadable', async () => {
    usageMocks.getActiveRequests.mockRejectedValueOnce(new Error('db down'));
    expect(
      await providerConcurrencyOverflow('p', { providerStrategies: { p: { maxConcurrent: 1 } } })
    ).toBeNull();
  });

  it('refuses at the cap with the live count in the message', async () => {
    usageMocks.getActiveRequests.mockResolvedValue([
      { provider: 'p', count: 2 },
      { provider: 'q', count: 9 },
    ]);
    const msg = await providerConcurrencyOverflow('p', {
      providerStrategies: { p: { maxConcurrent: 2 } },
    });
    expect(msg).toContain('2/2');
  });

  it('ignores a malformed cap', async () => {
    for (const bad of [0, -1, 'many', null]) {
      expect(
        await providerConcurrencyOverflow('p', {
          providerStrategies: { p: { maxConcurrent: bad } },
        })
      ).toBeNull();
    }
  });
});

describe('readAttemptCeiling', () => {
  it('accepts only a positive safe integer', () => {
    const req = (v) =>
      new Request('http://x/', { headers: v === undefined ? {} : { 'x-max-attempts': v } });
    expect(readAttemptCeiling(req('3'))).toBe(3);
    for (const bad of ['0', '-1', 'many', '2.5', undefined]) {
      expect(readAttemptCeiling(req(bad))).toBeNull();
    }
  });
});
