import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ noAuth: true, refresh: vi.fn() }));
vi.mock('../../../open-sse/executors/index.js', () => ({ getExecutor: () => ({ noAuth: mocks.noAuth, refreshCredentials: mocks.refresh }) }));
const { handleEmbeddingsCore } = await import('../../../open-sse/handlers/embeddingsCore.js');
const { handleImageGenerationCore } = await import('../../../open-sse/handlers/imageGenerationCore.js');
const { handleSttCore } = await import('../../../open-sse/handlers/sttCore.js');

const cases = [
  ['embedding', () => handleEmbeddingsCore({ body: { input: 'fixture' }, modelInfo: { provider: 'openai', model: 'text-embedding-3-small' }, credentials: { apiKey: 'fixture' } })],
  ['image', () => handleImageGenerationCore({ body: { prompt: 'fixture' }, modelInfo: { provider: 'openai', model: 'gpt-image-1' }, credentials: { apiKey: 'fixture' } })],
  ['transcription', () => {
    const formData = new FormData(); formData.set('file', new File(['fixture'], 'fixture.wav'));
    return handleSttCore({ provider: 'openai', model: 'whisper-1', formData, credentials: { apiKey: 'fixture' }, sttConfig: { format: 'openai', authHeader: 'bearer', baseUrl: 'https://provider.invalid/transcriptions' } });
  }],
];
beforeEach(() => { mocks.noAuth = true; mocks.refresh.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe.each(cases)('independent %s core replay evidence', (_name, invoke) => {
  it.each([401, 429, 503])('marks explicit HTTP %i rejection as replayable', async (status) => {
    const fetch = vi.fn(async () => Response.json({ error: { message: 'fixture rejected' } }, { status }));
    vi.stubGlobal('fetch', fetch);
    const result = await invoke();
    expect(result.failureMetadata?.safeToReplay).toBe(true);
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

describe.each(cases.slice(0, 2))('%s credential refresh boundary', (_name, invoke) => {
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
