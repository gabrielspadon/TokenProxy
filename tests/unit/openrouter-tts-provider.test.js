// OpenRouter TTS provider: chat-completions SSE audio modality. All fetch
// traffic mocked; expectations derived from PROVIDER_MEDIA's own ttsConfig.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_MEDIA } from '../../open-sse/providers/index.js';
import provider from '../../open-sse/handlers/ttsProviders/openrouter.js';

const CFG = PROVIDER_MEDIA['openrouter'].ttsConfig;
const CREDS = { apiKey: 'sk-test' };

const enc = new TextEncoder();

function sseChunk(audioData) {
  return `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: audioData } } }] })}`;
}

// Fake streaming Response: each element of `reads` arrives as one reader.read().
function sseRes(reads, { ok = true, status = 200, json } = {}) {
  let i = 0;
  return {
    ok,
    status,
    json: async () => {
      if (json === undefined) throw new Error('no json');
      return json;
    },
    body: {
      getReader: () => ({
        read: async () =>
          i < reads.length ? { done: false, value: enc.encode(reads[i++]) } : { done: true },
      }),
    },
  };
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('openrouter synthesize', () => {
  it('throws without an API key', async () => {
    await expect(provider.synthesize('hi', null, {})).rejects.toThrow(/API key/);
    await expect(provider.synthesize('hi', null, null)).rejects.toThrow(/API key/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('posts to the configured baseUrl with auth and extra headers, wav output', async () => {
    globalThis.fetch.mockResolvedValueOnce(sseRes([sseChunk('QUJD') + '\n', 'data: [DONE]\n']));
    const out = await provider.synthesize('hello', null, CREDS);
    expect(out).toEqual({ base64: 'QUJD', format: 'wav' });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe(CFG.baseUrl);
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe(`Bearer ${CREDS.apiKey}`);
    for (const [k, v] of Object.entries(CFG.headers || {})) expect(opts.headers[k]).toBe(v);

    const body = JSON.parse(opts.body);
    expect(body.model).toBe(CFG.defaultModel);
    expect(body.audio.voice).toBe('alloy');
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('splits vendor/model/voice into model and voice', async () => {
    globalThis.fetch.mockResolvedValueOnce(sseRes([sseChunk('QUJD') + '\n']));
    await provider.synthesize('hi', 'vendor/some-tts/nova', CREDS);
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('vendor/some-tts');
    expect(body.audio.voice).toBe('nova');
  });

  it('treats a single-slash model as a voice on the default model', async () => {
    globalThis.fetch.mockResolvedValueOnce(sseRes([sseChunk('QUJD') + '\n']));
    await provider.synthesize('hi', 'just/voice', CREDS);
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.model).toBe(CFG.defaultModel);
    expect(body.audio.voice).toBe('just/voice');
  });

  it('treats a slashless model as the voice', async () => {
    globalThis.fetch.mockResolvedValueOnce(sseRes([sseChunk('QUJD') + '\n']));
    await provider.synthesize('hi', 'shimmer', CREDS);
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.model).toBe(CFG.defaultModel);
    expect(body.audio.voice).toBe('shimmer');
  });

  it('accumulates audio across reads split mid-line and skips junk lines', async () => {
    const line1 = sseChunk('QUJD') + '\n';
    const reads = [
      line1.slice(0, 10),
      line1.slice(10) + 'data: not-json\n' + ': comment\n',
      sseChunk('REVG') + '\ndata: [DONE]\n',
    ];
    globalThis.fetch.mockResolvedValueOnce(sseRes(reads));
    const out = await provider.synthesize('hi', null, CREDS);
    expect(out.base64).toBe('QUJDREVG');
  });

  it('throws the upstream error message on a non-ok JSON response', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      sseRes([], { ok: false, status: 402, json: { error: { message: 'insufficient credits' } } })
    );
    await expect(provider.synthesize('hi', null, CREDS)).rejects.toThrow('insufficient credits');
  });

  it('falls back to the status code when the error body is not JSON', async () => {
    globalThis.fetch.mockResolvedValueOnce(sseRes([], { ok: false, status: 500 }));
    await expect(provider.synthesize('hi', null, CREDS)).rejects.toThrow(/500/);
  });

  it('throws when the stream carries no audio', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      sseRes([`data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n`, 'data: [DONE]\n'])
    );
    await expect(provider.synthesize('hi', null, CREDS)).rejects.toThrow(/no audio/);
  });
});
