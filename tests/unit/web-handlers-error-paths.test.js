// Error/edge-path coverage for the web search + web fetch SSE handlers.
// All collaborators mocked; providers replaced by a synthetic registry so no
// assertion depends on a real provider's catalog. Zero network.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  isValidApiKey: vi.fn(),
  getSettings: vi.fn(),
  getCombos: vi.fn(),
  handleSearchCore: vi.fn(),
  handleFetchCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  resolveClientApiKey: vi.fn(),
  assertPublicUrl: vi.fn(),
  recordApiKeyDevice: vi.fn(),
  refuseDisallowedModel: vi.fn(),
  handleComboChat: vi.fn(),
  getComboModelsFromData: vi.fn(),
}));

vi.mock('@/sse/services/auth.js', () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  isValidApiKey: mocks.isValidApiKey,
}));
vi.mock('@/lib/localDb', () => ({
  getSettings: mocks.getSettings,
  getCombos: mocks.getCombos,
}));
vi.mock('open-sse/handlers/search/index.js', () => ({ handleSearchCore: mocks.handleSearchCore }));
vi.mock('open-sse/handlers/fetch/index.js', () => ({ handleFetchCore: mocks.handleFetchCore }));
vi.mock('@/sse/services/tokenRefresh.js', () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));
vi.mock('@/lib/auth/clientApiKey', () => ({ resolveClientApiKey: mocks.resolveClientApiKey }));
vi.mock('@/shared/utils/ssrfGuard.js', () => ({ assertPublicUrl: mocks.assertPublicUrl }));
vi.mock('@/sse/services/apiKeyDevices.js', () => ({
  recordApiKeyDevice: mocks.recordApiKeyDevice,
}));
vi.mock('@/sse/services/modelAccess.js', () => ({
  refuseDisallowedModel: mocks.refuseDisallowedModel,
}));
vi.mock('open-sse/services/combo.js', () => ({
  handleComboChat: mocks.handleComboChat,
  getComboModelsFromData: mocks.getComboModelsFromData,
}));
vi.mock('@/sse/utils/logger.js', () => ({
  request: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => 'masked'),
}));
// Synthetic provider registry: every branch of the handlers is reachable
// without naming a real provider.
vi.mock('@/shared/constants/providers.js', () => {
  const AI_PROVIDERS = {
    'prov-search': {
      id: 'prov-search',
      searchConfig: { id: 'prov-search' },
      fetchConfig: { id: 'prov-search' },
    },
    'prov-noauth': { id: 'prov-noauth', noAuth: true, searchConfig: {}, fetchConfig: {} },
    'prov-fb': { id: 'prov-fb', searchConfig: {}, credentialFallback: 'prov-chat' },
    'prov-chat': { id: 'prov-chat', searchConfig: {} },
    'prov-none': { id: 'prov-none' },
  };
  return {
    AI_PROVIDERS,
    resolveProviderId: (x) => (x === 'alias-search' ? 'prov-search' : x),
  };
});

import { handleSearch } from '@/sse/handlers/search.js';
import { handleFetch } from '@/sse/handlers/fetch.js';

const CREDS = {
  connectionId: 'conn-1',
  connectionName: 'Conn One',
  accessToken: 'tok',
  providerSpecificData: {
    connectionProxyEnabled: true,
    connectionProxyUrl: 'http://p:1',
    strictProxy: true,
  },
};

function post(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const searchReq = (body) => post('http://localhost/v1/web/search', body);
const fetchReq = (body) => post('http://localhost/v1/web/fetch', body);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveClientApiKey.mockResolvedValue({ apiKey: null, valid: false });
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getCombos.mockResolvedValue([]);
  mocks.getComboModelsFromData.mockReturnValue(null);
  mocks.refuseDisallowedModel.mockResolvedValue(null);
  mocks.assertPublicUrl.mockImplementation(() => {});
  mocks.checkAndRefreshToken.mockImplementation(async (_p, c) => c);
  mocks.getProviderCredentials.mockResolvedValue(CREDS);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
  mocks.handleSearchCore.mockResolvedValue({ success: true, response: new Response('{}') });
  mocks.handleFetchCore.mockResolvedValue({ success: true, data: { ok: true } });
});

describe('shared request validation (search + fetch)', () => {
  it.each([
    ['search', handleSearch, searchReq],
    ['fetch', handleFetch, fetchReq],
  ])('%s: 400 on invalid JSON body', async (_n, handler, req) => {
    const res = await handler(req('{not json'));
    expect(res.status).toBe(400);
  });

  it.each([
    ['search', handleSearch, searchReq, { query: 'q' }],
    ['fetch', handleFetch, fetchReq, { url: 'https://example.com/' }],
  ])('%s: 400 on missing provider/model', async (_n, handler, req, body) => {
    const res = await handler(req(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toMatch(/provider/i);
  });

  it.each([
    ['search', handleSearch, searchReq],
    ['fetch', handleFetch, fetchReq],
  ])('%s: 401 when requireApiKey and no key presented', async (_n, handler, req) => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const res = await handler(
      req({ provider: 'prov-search', query: 'q', url: 'https://example.com/' })
    );
    expect(res.status).toBe(401);
  });

  it.each([
    ['search', handleSearch, searchReq],
    ['fetch', handleFetch, fetchReq],
  ])('%s: 401 when requireApiKey and key is invalid', async (_n, handler, req) => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.resolveClientApiKey.mockResolvedValue({ apiKey: 'bad', valid: false });
    const res = await handler(
      req({ provider: 'prov-search', query: 'q', url: 'https://example.com/' })
    );
    expect(res.status).toBe(401);
    expect(mocks.recordApiKeyDevice).not.toHaveBeenCalled();
  });

  it('records the device on a valid key and enforces the model allowlist', async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.resolveClientApiKey.mockResolvedValue({ apiKey: 'good', valid: true });
    const barred = new Response('no', { status: 403 });
    mocks.refuseDisallowedModel.mockResolvedValue(barred);
    const res = await handleSearch(searchReq({ provider: 'prov-search', query: 'q' }));
    expect(mocks.recordApiKeyDevice).toHaveBeenCalledWith('good', expect.anything());
    expect(res).toBe(barred);
  });

  it('fetch: allowlist refusal short-circuits too', async () => {
    mocks.resolveClientApiKey.mockResolvedValue({ apiKey: 'good', valid: true });
    const barred = new Response('no', { status: 403 });
    mocks.refuseDisallowedModel.mockResolvedValue(barred);
    const res = await handleFetch(
      fetchReq({ provider: 'prov-search', url: 'https://example.com/' })
    );
    expect(res).toBe(barred);
  });

  it.each([
    ['search', handleSearch, searchReq, { provider: 'prov-unknown', query: 'q' }],
    ['fetch', handleFetch, fetchReq, { provider: 'prov-unknown', url: 'https://example.com/' }],
  ])('%s: 400 on unknown provider', async (_n, handler, req, body) => {
    const res = await handler(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Unknown provider/);
  });

  it.each([
    ['search', handleSearch, searchReq, { provider: 'prov-none', query: 'q' }, /web search/],
    [
      'fetch',
      handleFetch,
      fetchReq,
      { provider: 'prov-none', url: 'https://example.com/' },
      /web fetch/,
    ],
  ])('%s: 400 when provider lacks the capability', async (_n, handler, req, body, msg) => {
    const res = await handler(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(msg);
  });
});

describe('search-specific validation and routing', () => {
  it('400 on missing/blank query', async () => {
    const res = await handleSearch(searchReq({ provider: 'prov-search', query: '   ' }));
    expect(res.status).toBe(400);
  });

  it('resolves an alias to its provider id before routing', async () => {
    const res = await handleSearch(searchReq({ model: 'alias-search', query: 'q' }));
    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      'prov-search',
      expect.any(Set),
      'websearch:prov-search'
    );
  });

  it('expands a combo through handleComboChat with the settings strategy', async () => {
    mocks.getComboModelsFromData.mockReturnValue(['prov-search']);
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      comboStrategies: { 'my-combo': { fallbackStrategy: 'round-robin' } },
      comboStickyRoundRobinLimit: 3,
    });
    mocks.handleComboChat.mockImplementation(({ handleSingleModel, models, body }) =>
      handleSingleModel(body, models[0])
    );
    const res = await handleSearch(searchReq({ provider: 'my-combo', query: 'q' }));
    expect(res.status).toBe(200);
    expect(mocks.handleComboChat).toHaveBeenCalledWith(
      expect.objectContaining({
        comboName: 'my-combo',
        comboStrategy: 'round-robin',
        comboStickyLimit: 3,
      })
    );
  });

  it('noAuth provider skips credential lookup entirely', async () => {
    const res = await handleSearch(searchReq({ provider: 'prov-noauth', query: 'q' }));
    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleSearchCore).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: null })
    );
  });

  it("falls back to the linked chat provider's credentials under the search lock key", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce(CREDS);
    const res = await handleSearch(searchReq({ provider: 'prov-fb', query: 'q' }));
    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenNthCalledWith(
      2,
      'prov-chat',
      expect.any(Set),
      'websearch:prov-fb'
    );
  });

  it('returns unavailableResponse when all accounts are rate limited', async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      lastError: 'quota',
      retryAfter: 60,
      retryAfterHuman: '1m',
    });
    const res = await handleSearch(searchReq({ provider: 'prov-search', query: 'q' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toMatch(/quota/);
  });

  it('honours clientErrorStatus on the all-rate-limited path', async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      lastError: 'gone',
      clientErrorStatus: 429,
      retryAfter: 5,
      retryAfterHuman: '5s',
    });
    const res = await handleSearch(searchReq({ provider: 'prov-search', query: 'q' }));
    expect(res.status).toBe(429);
  });

  it('400 when the provider has no credentials at all', async () => {
    mocks.getProviderCredentials.mockResolvedValue(null);
    const res = await handleSearch(searchReq({ provider: 'prov-search', query: 'q' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/No credentials/);
  });

  it('rotates on shouldFallback and reports the last error when exhausted', async () => {
    mocks.handleSearchCore.mockResolvedValue({ success: false, status: 429, error: 'rl' });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.getProviderCredentials.mockResolvedValueOnce(CREDS).mockResolvedValueOnce(null);
    const res = await handleSearch(searchReq({ provider: 'prov-search', query: 'q' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toBe('rl');
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      'conn-1',
      429,
      'rl',
      'prov-search',
      'websearch:prov-search'
    );
  });

  it("returns the core's failure response when fallback is refused", async () => {
    const failResp = new Response('boom', { status: 500 });
    mocks.handleSearchCore.mockResolvedValue({
      success: false,
      status: 500,
      error: 'boom',
      response: failResp,
    });
    const res = await handleSearch(searchReq({ provider: 'prov-search', query: 'q' }));
    expect(res).toBe(failResp);
  });

  it('refresh callback preserves providerSpecificData; success callback clears the error', async () => {
    mocks.handleSearchCore.mockImplementation(async (opts) => {
      await opts.onCredentialsRefreshed({ accessToken: 'new' });
      await opts.onRequestSuccess();
      return { success: true, response: new Response('{}') };
    });
    const res = await handleSearch(searchReq({ provider: 'prov-search', query: 'q' }));
    expect(res.status).toBe(200);
    expect(mocks.updateProviderCredentials).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({
        accessToken: 'new',
        existingProviderSpecificData: CREDS.providerSpecificData,
        testStatus: 'active',
      })
    );
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ connectionId: 'conn-1' })
    );
  });
});

describe('fetch-specific validation and routing', () => {
  const okBody = { provider: 'prov-search', url: 'https://example.com/a' };

  it('400 on missing url', async () => {
    const res = await handleFetch(fetchReq({ provider: 'prov-search' }));
    expect(res.status).toBe(400);
  });

  it('400 on an unparseable url', async () => {
    const res = await handleFetch(fetchReq({ provider: 'prov-search', url: 'not a url' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Invalid URL/);
  });

  it('400 when the SSRF guard rejects the target', async () => {
    mocks.assertPublicUrl.mockImplementation(() => {
      throw new Error('Blocked internal target');
    });
    const res = await handleFetch(fetchReq(okBody));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Blocked/);
  });

  it('expands a combo through handleComboChat', async () => {
    mocks.getComboModelsFromData.mockReturnValue(['prov-search']);
    mocks.handleComboChat.mockImplementation(({ handleSingleModel, models, body }) =>
      handleSingleModel(body, models[0])
    );
    const res = await handleFetch(fetchReq({ ...okBody, provider: 'fetch-combo' }));
    expect(res.status).toBe(200);
    expect(mocks.handleComboChat).toHaveBeenCalledWith(
      expect.objectContaining({ comboName: 'fetch-combo' })
    );
  });

  it('noAuth provider: success wraps result.data as JSON', async () => {
    const res = await handleFetch(
      fetchReq({ provider: 'prov-noauth', url: 'https://example.com/' })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    // No credentials → all proxy options default off.
    expect(mocks.handleFetchCore).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyOptions: expect.objectContaining({
          connectionProxyEnabled: false,
          strictProxy: false,
        }),
      })
    );
  });

  it("noAuth provider: failure maps to errorResponse with the core's status", async () => {
    mocks.handleFetchCore.mockResolvedValue({ success: false, status: 451, error: 'nope' });
    const res = await handleFetch(
      fetchReq({ provider: 'prov-noauth', url: 'https://example.com/' })
    );
    expect(res.status).toBe(451);
  });

  it('returns unavailableResponse when all accounts are rate limited', async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      lastError: 'quota',
      lastErrorCode: '429',
      retryAfter: 9,
      retryAfterHuman: '9s',
    });
    const res = await handleFetch(fetchReq(okBody));
    expect(res.status).toBe(429);
  });

  it('400 when the provider has no credentials at all', async () => {
    mocks.getProviderCredentials.mockResolvedValue(null);
    const res = await handleFetch(fetchReq(okBody));
    expect(res.status).toBe(400);
  });

  it('rotates on shouldFallback and reports the last error when exhausted', async () => {
    mocks.handleFetchCore.mockResolvedValue({ success: false, status: 502, error: 'upstream' });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.getProviderCredentials.mockResolvedValueOnce(CREDS).mockResolvedValueOnce(null);
    const res = await handleFetch(fetchReq(okBody));
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toBe('upstream');
  });

  it('maps a non-fallback core failure to errorResponse', async () => {
    mocks.handleFetchCore.mockResolvedValue({ success: false, status: 500, error: 'boom' });
    const res = await handleFetch(fetchReq(okBody));
    expect(res.status).toBe(500);
  });

  it("passes the connection's proxy fields and the refresh callback preserves them", async () => {
    mocks.handleFetchCore.mockImplementation(async (opts) => {
      expect(opts.proxyOptions).toEqual(
        expect.objectContaining({
          connectionProxyEnabled: true,
          connectionProxyUrl: 'http://p:1',
          strictProxy: true,
        })
      );
      await opts.onCredentialsRefreshed({ accessToken: 'new' });
      return { success: true, data: { done: 1 } };
    });
    const res = await handleFetch(fetchReq(okBody));
    expect(res.status).toBe(200);
    expect(mocks.updateProviderCredentials).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({
        existingProviderSpecificData: CREDS.providerSpecificData,
        testStatus: 'active',
      })
    );
  });
});
