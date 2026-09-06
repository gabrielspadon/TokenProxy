import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ core: vi.fn(), mark: vi.fn(), credentials: vi.fn() }));
vi.mock('@/sse/services/auth.js', () => ({ getProviderCredentials: mocks.credentials, markAccountUnavailable: mocks.mark, clearAccountError: vi.fn(), isValidApiKey: vi.fn(async () => true), extractApiKey: () => null }));
vi.mock('@/sse/services/model.js', async (original) => ({ ...(await original()), getModelInfo: async str => ({ provider: str.split('/')[0], model: str.split('/').slice(1).join('/') }), getComboModels: async () => null }));
vi.mock('@/lib/localDb', () => ({ getSettings: async () => ({ requireApiKey: false }), getProviderConnectionById: async () => null, getCombos: async () => [] }));
vi.mock('@/sse/services/tokenRefresh.js', () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn() }));
vi.mock('open-sse/handlers/embeddingsCore.js', () => ({ handleEmbeddingsCore: mocks.core }));
vi.mock('open-sse/handlers/imageGenerationCore.js', () => ({ handleImageGenerationCore: mocks.core }));
vi.mock('open-sse/handlers/sttCore.js', () => ({ handleSttCore: mocks.core }));
vi.mock('open-sse/handlers/rerankCore.js', () => ({ handleRerankCore: mocks.core }));
vi.mock('open-sse/handlers/ttsCore.js', () => ({ handleTtsCore: mocks.core }));
vi.mock('open-sse/handlers/search/index.js', () => ({ handleSearchCore: mocks.core }));
vi.mock('open-sse/handlers/fetch/index.js', () => ({ handleFetchCore: mocks.core }));
vi.mock('open-sse/handlers/jsonProxyCore.js', async original => ({ ...(await original()), handleJsonProxyCore: mocks.core }));
vi.mock('open-sse/handlers/videoCore.js', async original => ({ ...(await original()), handleVideoProxyCore: mocks.core }));
vi.mock('@/lib/usageDb.js', () => ({ saveRequestUsage: async () => {} }));
vi.mock('@/sse/utils/logger.js', () => ({ debug() {}, info() {}, warn() {}, error() {}, maskKey() {}, request() {} }));
const { handleEmbeddings } = await import('../../../src/sse/handlers/embeddings.js');
const { handleImageGeneration } = await import('../../../src/sse/handlers/imageGeneration.js');
const { handleStt } = await import('../../../src/sse/handlers/stt.js');
const { handleRerank } = await import('../../../src/sse/handlers/rerank.js');
const { handleTts } = await import('../../../src/sse/handlers/tts.js');
const { handleSearch } = await import('../../../src/sse/handlers/search.js');
const { handleFetch } = await import('../../../src/sse/handlers/fetch.js');
const { handleJsonProxy } = await import('../../../src/sse/handlers/jsonProxy.js');
const { handleVideoCreate } = await import('../../../src/sse/handlers/videoGeneration.js');
const jsonRequest = (body) => new Request('http://localhost/v1/fixture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'openai/fixture-model', ...body }) });
const cases = [
  ['embedding', () => handleEmbeddings(jsonRequest({ input: 'fixture' }))],
  ['image', () => handleImageGeneration(jsonRequest({ prompt: 'fixture' }))],
  ['rerank', () => handleRerank(jsonRequest({ model:'cohere/fixture-model',query:'fixture',documents:['fixture'] }))],
  ['tts', () => handleTts(jsonRequest({ input:'fixture' }))],
  ['search', () => handleSearch(jsonRequest({ provider:'tavily',query:'fixture' }))],
  ['fetch', () => handleFetch(jsonRequest({ provider:'tavily',url:'https://example.com/fixture' }))],
  ['ocr', () => handleJsonProxy(jsonRequest({ model:'mistral/mistral-ocr-latest',document:{type:'document_url',document_url:'https://example.com/fixture'} }), 'ocr')],
  ['moderation', () => handleJsonProxy(jsonRequest({ model:'mistral/mistral-moderation-latest',input:'fixture' }), 'moderation')],
  ['video', () => handleVideoCreate(jsonRequest({ model:'xai/grok-imagine-video',prompt:'fixture' }), 'generations')],
  ['transcription', () => { const form = new FormData(); form.set('model', 'openai/fixture-model'); form.set('file', new File(['fixture'], 'fixture.wav')); return handleStt(new Request('http://localhost/v1/audio/transcriptions', { method: 'POST', body: form })); }],
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.core.mockReset();
  vi.stubGlobal('fetch', () => { throw new Error('Unexpected network'); });
  mocks.credentials.mockImplementation(async (_p, excluded) => ({ connectionId: excluded.has('a') ? 'b' : 'a', connectionName: 'fixture', apiKey: 'fixture', providerSpecificData: {} }));
  mocks.mark.mockResolvedValue({ shouldFallback: true, mustWait: false });
});
afterEach(() => vi.unstubAllGlobals());

describe.each(cases)('independent %s account replay boundary', (_name, invoke) => {
  it('preserves the pin and a usable retry delay during a transient wait', async () => {
    mocks.mark.mockResolvedValue({ shouldFallback: true, mustWait: true, cooldownMs: 1500 });
    mocks.core.mockResolvedValueOnce({ success: false, status: 503, error: 'overloaded', failureMetadata: { safeToReplay: true }, response: Response.json({ error: 'overloaded' }, { status: 503 }) });
    const response = await invoke();
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(response.headers.get('x-should-retry')).toBe('true');
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect(mocks.core).toHaveBeenCalledTimes(1);
  });
  it('stops after an uncertain or accepted failure', async () => {
    mocks.core.mockResolvedValueOnce({ success: false, status: 502, error: 'partial', failureMetadata: { safeToReplay: false }, response: Response.json({ error: 'partial' }, { status: 502 }) }).mockResolvedValue({ success: true, response: Response.json({ data: [], text: 'duplicate' }) });
    const response = await invoke();
    expect(response.status).toBe(502);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect(mocks.core).toHaveBeenCalledTimes(1);
    expect(mocks.mark).not.toHaveBeenCalled();
  });
  it('does not infer replay permission from an unclassified failure status',async()=>{
    mocks.core.mockResolvedValueOnce({success:false,status:503,error:'unknown outcome',response:Response.json({error:'unknown'},{status:503})})
      .mockResolvedValue({success:true,response:Response.json({data:[]})});
    const response=await invoke();
    expect(response.status).toBe(503);expect(response.headers.get('x-should-retry')).toBe('false');
    expect(mocks.core).toHaveBeenCalledTimes(1);expect(mocks.mark).not.toHaveBeenCalled();
  });
  it('can rotate only after a certified HTTP rejection', async () => {
    mocks.core.mockResolvedValueOnce({ success: false, status: 429, error: 'rejected', failureMetadata: { safeToReplay: true }, response: Response.json({ error: 'rejected' }, { status: 429 }) }).mockResolvedValue({ success: true, response: Response.json({ data: [], text: 'once' }) });
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(mocks.core).toHaveBeenCalledTimes(2);
  });
});
