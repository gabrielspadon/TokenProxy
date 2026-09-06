import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ noAuth: true, refresh: vi.fn() }));
vi.mock('../../../open-sse/executors/index.js', () => ({ getExecutor: () => ({ noAuth: mocks.noAuth, refreshCredentials: mocks.refresh }) }));
vi.mock('../../../open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: (...args) => fetch(...args) }));
const { handleEmbeddingsCore } = await import('../../../open-sse/handlers/embeddingsCore.js');
const { handleImageGenerationCore } = await import('../../../open-sse/handlers/imageGenerationCore.js');
const { handleSttCore } = await import('../../../open-sse/handlers/sttCore.js');
const { handleRerankCore } = await import('../../../open-sse/handlers/rerankCore.js');
const { handleVideoProxyCore } = await import('../../../open-sse/handlers/videoCore.js');
const { handleJsonProxyCore } = await import('../../../open-sse/handlers/jsonProxyCore.js');

const cases = [
  ['embedding', () => handleEmbeddingsCore({ body: { input: 'fixture' }, modelInfo: { provider: 'openai', model: 'text-embedding-3-small' }, credentials: { apiKey: 'fixture' } })],
  ['image', () => handleImageGenerationCore({ body: { prompt: 'fixture' }, modelInfo: { provider: 'openai', model: 'gpt-image-1' }, credentials: { apiKey: 'fixture' } })],
  ['rerank', () => handleRerankCore({ body: { query: 'fixture', documents: ['fixture'] }, modelInfo: { provider: 'cohere', model: 'rerank-v3.5' }, credentials: { apiKey: 'fixture' } })],
  ['video', () => handleVideoProxyCore({ provider: 'xai', action: 'generations', rawBody: '{}', credentials: { apiKey: 'fixture' } })],
  ['ocr', () => handleJsonProxyCore({ provider: 'mistral', model: 'mistral-ocr-latest', kind: 'ocr', body: {}, credentials: { apiKey: 'fixture' } })],
  ['transcription', () => {
    const formData = new FormData(); formData.set('file', new File(['fixture'], 'fixture.wav'));
    return handleSttCore({ provider: 'openai', model: 'whisper-1', formData, credentials: { apiKey: 'fixture' }, sttConfig: { format: 'openai', authHeader: 'bearer', baseUrl: 'https://provider.invalid/transcriptions' } });
  }],
];
beforeEach(() => { mocks.noAuth = true; mocks.refresh.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe.each(cases)('independent %s core replay evidence', (_name, invoke) => {
  it.each([401, 429])('marks HTTP %i rejection as replayable', async (status) => {
    const fetch = vi.fn(async () => Response.json({ error: { message: 'fixture rejected' } }, { status }));
    vi.stubGlobal('fetch', fetch);
    const result = await invoke();
    expect(result.failureMetadata?.safeToReplay).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([408,409,500,502,503,504])('does not certify ambiguous HTTP%i', async status => {
    const fetch = vi.fn(async () => Response.json({error:{message:'outcome unknown'}},{status}));
    vi.stubGlobal('fetch',fetch);
    expect((await invoke()).failureMetadata?.safeToReplay).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [503,{'x-tokenproxy-replay-safe':'true'},true],
    [401,{'x-tokenproxy-replay-safe':'false'},false],
    [429,{'x-tokenproxy-replay-safe':'true','x-should-retry':'false'},false],
    [503,{'x-tokenproxy-replay-safe':'true','x-should-retry':'false'},false],
  ])('preserves HTTP%i permission %j',async(status,headers,safe)=>{
    const fetch=vi.fn(async()=>Response.json({error:{message:'fixture'}},{status,headers}));
    vi.stubGlobal('fetch',fetch);
    expect((await invoke()).failureMetadata?.safeToReplay).toBe(safe);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not certify an uncertain transport exception as replayable', async () => {
    const fetch = vi.fn(async () => { throw new Error('connection lost after write'); });
    vi.stubGlobal('fetch', fetch);
    const result = await invoke();
    expect(result.success).toBe(false);
    expect(result.failureMetadata?.safeToReplay).not.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe.each(cases.slice(0, 3))('%s credential refresh boundary', (_name, invoke) => {
  it.each(['x-tokenproxy-replay-safe','x-should-retry'])('does not refresh or resend when %s denies replay',async header=>{
    mocks.noAuth=false;
    mocks.refresh.mockResolvedValue({accessToken:'refreshed-fixture'});
    const fetch=vi.fn(async()=>Response.json({error:{message:'rejected'}},{status:401,headers:{[header]:'false'}}));
    vi.stubGlobal('fetch',fetch);
    expect((await invoke()).failureMetadata?.safeToReplay).toBe(false);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('starts cancellation before the second dispatch without awaiting a stuck cancellation',async()=>{
    mocks.noAuth=false; mocks.refresh.mockResolvedValue({accessToken:'refreshed-fixture'});
    let cancelled=false;
    const upstream=new Response(new ReadableStream({cancel(){cancelled=true; return new Promise(()=>{});}}),{status:401});
    const fetch=vi.fn().mockResolvedValueOnce(upstream).mockImplementationOnce(async()=>{
      expect(cancelled).toBe(true); throw new Error('second attempt outcome unknown');
    });
    vi.stubGlobal('fetch',fetch);
    expect((await invoke()).failureMetadata?.safeToReplay).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not return the old replayable 401 after the refreshed POST fails uncertainly', async () => {
    mocks.noAuth = false;
    mocks.refresh.mockResolvedValue({ accessToken: 'refreshed-fixture' });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: 'expired token' } }, { status: 401 })).mockRejectedValueOnce(new Error('second request possibly accepted'));
    vi.stubGlobal('fetch', fetch);
    const result = await invoke();
    expect(result.status).toBe(502);
    expect(result.failureMetadata?.safeToReplay).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
