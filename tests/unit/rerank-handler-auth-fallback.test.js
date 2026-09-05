// handleRerank (src/sse/handlers/rerank.js): request validation at the trust
// boundary, key/model gates, combo expansion, the account-fallback loop, lease
// release on every exit, and usage persistence — the paths where a break means
// unbilled requests or a spent quota on a disallowed model.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  releaseAccountLease: vi.fn(),
  handleRerankCore: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  saveRequestUsage: vi.fn(),
  getSettings: vi.fn(),
  isModelAllowed: vi.fn(),
  resolveClientApiKey: vi.fn(),
  isInternalModelTestAuthorized: vi.fn(),
  recordApiKeyDevice: vi.fn(),
}));

vi.mock('../../src/sse/services/auth.js', () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  isValidApiKey: vi.fn(),
}));
vi.mock('../../src/sse/services/accountLeaseRegistry.js', () => ({
  releaseAccountLease: mocks.releaseAccountLease,
}));
vi.mock('@/lib/auth/clientApiKey', () => ({ resolveClientApiKey: mocks.resolveClientApiKey }));
vi.mock('@/lib/localDb', () => ({ getSettings: mocks.getSettings }));
vi.mock('@/lib/auth/internalCliToken', () => ({
  isInternalModelTestAuthorized: mocks.isInternalModelTestAuthorized,
}));
vi.mock('@/lib/db/repos/apiKeysRepo.js', () => ({ isModelAllowed: mocks.isModelAllowed }));
vi.mock('../../src/sse/services/model.js', () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock('../../open-sse/handlers/rerankCore.js', () => ({
  handleRerankCore: mocks.handleRerankCore,
}));
vi.mock('../../open-sse/utils/error.js', () => ({
  errorResponse: (status, message) => Response.json({ error: message }, { status }),
  unavailableResponse: (status, message, retryAfter, human) =>
    Response.json({ error: message, retry_after: retryAfter, human }, { status }),
}));
vi.mock('../../open-sse/services/combo.js', () => ({
  handleComboChat: vi.fn(async ({ models, handleSingleModel, body }) => {
    // Minimal fallback semantics: first member that succeeds wins.
    let last;
    for (const m of models) {
      last = await handleSingleModel(body, m);
      if (last.status === 200) return last;
    }
    return last;
  }),
}));
vi.mock('../../src/sse/utils/logger.js', () => ({
  request: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  maskKey: (k) => k,
}));
vi.mock('../../src/sse/services/tokenRefresh.js', () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_p, credentials) => credentials,
}));
vi.mock('@/lib/usageDb.js', () => ({ saveRequestUsage: mocks.saveRequestUsage }));
vi.mock('@/sse/services/apiKeyDevices.js', () => ({
  recordApiKeyDevice: mocks.recordApiKeyDevice,
}));

import { handleRerank } from '../../src/sse/handlers/rerank.js';

const post = (body) =>
  handleRerank(
    new Request('http://localhost/v1/rerank', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );

const parse = (m) =>
  m.includes('/')
    ? { provider: m.split('/')[0], model: m.split('/').slice(1).join('/') }
    : { provider: null, model: m };

const okCore = (usage = { total_tokens: 12 }) => ({
  success: true,
  usage,
  response: Response.json({ results: [{ index: 0, relevance_score: 0.9 }] }),
});

const failCore = (status, error = 'boom') => ({
  success: false,
  status,
  error,
  response: Response.json({ error }, { status }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveClientApiKey.mockResolvedValue({ apiKey: null, valid: false });
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.isModelAllowed.mockResolvedValue(true);
  mocks.getModelInfo.mockImplementation(async (m) => parse(m));
  mocks.getComboModels.mockResolvedValue(null);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
  mocks.saveRequestUsage.mockResolvedValue(undefined);
  mocks.getProviderCredentials.mockResolvedValue({
    connectionId: 'conn-1',
    connectionName: 'acct A',
    apiKey: 'k',
    accountLease: { id: 'lease-1' },
  });
  mocks.handleRerankCore.mockResolvedValue(okCore());
});

describe('trust-boundary validation', () => {
  it('400 on invalid JSON body', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid JSON body');
  });

  it('400 on missing model, query, documents — each named', async () => {
    expect((await post({ query: 'q', documents: ['d'] })).status).toBe(400);
    const noQuery = await post({ model: 'cohere/rerank-v3.5', documents: ['d'] });
    expect((await noQuery.json()).error).toContain('query');
    const noDocs = await post({ model: 'cohere/rerank-v3.5', query: 'q' });
    expect((await noDocs.json()).error).toContain('documents');
    expect(mocks.handleRerankCore).not.toHaveBeenCalled();
  });

  it('401 when requireApiKey is on and the key does not validate', async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.resolveClientApiKey.mockResolvedValue({ apiKey: 'bad', valid: false });
    mocks.isInternalModelTestAuthorized.mockResolvedValue(false);
    const res = await post({ model: 'cohere/rerank-v3.5', query: 'q', documents: ['d'] });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid API key');
    expect(mocks.recordApiKeyDevice).not.toHaveBeenCalled();
  });

  it("403 when the key's model allowlist excludes the model (quota protection #1154)", async () => {
    mocks.resolveClientApiKey.mockResolvedValue({ apiKey: 'sk-ok', valid: true });
    mocks.isModelAllowed.mockResolvedValue(false);
    const res = await post({ model: 'cohere/rerank-v3.5', query: 'q', documents: ['d'] });
    expect(res.status).toBe(403);
    expect(mocks.handleRerankCore).not.toHaveBeenCalled();
  });

  it('400 on an unresolvable model name', async () => {
    const res = await post({ model: 'not-a-model', query: 'q', documents: ['d'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid model format');
  });
});

describe('dispatch, fallback and lease hygiene', () => {
  it('happy path: core called with provider/model split, usage persisted, lease released', async () => {
    const res = await post({ model: 'cohere/rerank-v3.5', query: 'q', documents: ['a', 'b'] });
    expect(res.status).toBe(200);
    expect(mocks.handleRerankCore.mock.calls[0][0].modelInfo).toEqual({
      provider: 'cohere',
      model: 'rerank-v3.5',
    });
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'cohere',
        model: 'rerank-v3.5',
        connectionId: 'conn-1',
        endpoint: '/v1/rerank',
        status: 'success',
        tokens: { total_tokens: 12 },
      })
    );
    expect(mocks.clearAccountError).not.toHaveBeenCalled(); // core owns onRequestSuccess
    expect(mocks.releaseAccountLease).toHaveBeenCalledWith({ id: 'lease-1' });
  });

  it('no usage in the core result → nothing persisted (no phantom rows)', async () => {
    mocks.handleRerankCore.mockResolvedValue(okCore(null));
    await post({ model: 'cohere/rerank-v3.5', query: 'q', documents: ['d'] });
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it('rotates to the next account when markAccountUnavailable says fallback, excluding the failed one', async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        connectionId: 'c1',
        connectionName: 'A',
        apiKey: 'k1',
        accountLease: { id: 'l1' },
      })
      .mockResolvedValueOnce({
        connectionId: 'c2',
        connectionName: 'B',
        apiKey: 'k2',
        accountLease: { id: 'l2' },
      });
    mocks.handleRerankCore
      .mockResolvedValueOnce(failCore(429, 'rate limited'))
      .mockResolvedValueOnce(okCore());
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });

    const res = await post({ model: 'cohere/rerank-v3.5', query: 'q', documents: ['d'] });
    expect(res.status).toBe(200);
    const excludeArg = mocks.getProviderCredentials.mock.calls[1][1];
    expect([...excludeArg]).toEqual(['c1']);
    // Both leases released — the rotation must not leak the failed account's slot.
    expect(mocks.releaseAccountLease.mock.calls.map((c) => c[0]?.id)).toEqual(['l1', 'l2']);
  });

  it('when accounts run out, the LAST upstream error and status are reported, not a generic 500', async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        connectionId: 'c1',
        connectionName: 'A',
        apiKey: 'k1',
        accountLease: null,
      })
      .mockResolvedValueOnce(null);
    mocks.handleRerankCore.mockResolvedValueOnce(failCore(402, 'payment required'));
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });

    const res = await post({ model: 'cohere/rerank-v3.5', query: 'q', documents: ['d'] });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('payment required');
  });

  it('allRateLimited returns the unavailable envelope with retry info and no core call', async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      lastError: 'quota hit',
      clientErrorStatus: 429,
      retryAfter: 60,
      retryAfterHuman: '1m',
      accountLease: null,
    });
    const res = await post({ model: 'cohere/rerank-v3.5', query: 'q', documents: ['d'] });
    expect(res.status).toBe(429);
    expect((await res.json()).retry_after).toBe(60);
    expect(mocks.handleRerankCore).not.toHaveBeenCalled();
  });

  it('no credentials at all is a 400 naming the provider', async () => {
    mocks.getProviderCredentials.mockResolvedValue(null);
    const res = await post({ model: 'cohere/rerank-v3.5', query: 'q', documents: ['d'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('cohere');
  });

  it("a non-fallback failure returns the core's own response with its status", async () => {
    mocks.handleRerankCore.mockResolvedValue(failCore(422, 'documents too long'));
    const res = await post({ model: 'cohere/rerank-v3.5', query: 'q', documents: ['d'] });
    expect(res.status).toBe(422);
    expect(mocks.releaseAccountLease).toHaveBeenCalled();
  });

  it('lease released even when the core throws', async () => {
    mocks.handleRerankCore.mockRejectedValue(new Error('kaboom'));
    await expect(
      post({ model: 'cohere/rerank-v3.5', query: 'q', documents: ['d'] })
    ).rejects.toThrow('kaboom');
    expect(mocks.releaseAccountLease).toHaveBeenCalledWith({ id: 'lease-1' });
  });

  it('a bare combo name expands through handleComboChat and answers from the first working member', async () => {
    mocks.getComboModels.mockResolvedValue(['cohere/rerank-v3.5', 'jina-ai/jina-reranker-v2']);
    mocks.handleRerankCore.mockResolvedValueOnce(failCore(401)).mockResolvedValueOnce(okCore());
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });

    const res = await post({ model: 'rerank-pool', query: 'q', documents: ['d'] });
    expect(res.status).toBe(200);
    expect(mocks.handleRerankCore.mock.calls.map((c) => c[0].modelInfo.provider)).toEqual([
      'cohere',
      'jina-ai',
    ]);
  });

  it("a bare provider name uses the connection's defaultModel", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: 'cohere', model: 'rerank-v3.5' });
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: 'c1',
      connectionName: 'A',
      apiKey: 'k',
      defaultModel: 'rerank-english-v3.0',
      accountLease: null,
    });
    await post({ model: 'cohere', query: 'q', documents: ['d'] });
    expect(mocks.handleRerankCore.mock.calls[0][0].modelInfo.model).toBe('rerank-english-v3.0');
  });
});
