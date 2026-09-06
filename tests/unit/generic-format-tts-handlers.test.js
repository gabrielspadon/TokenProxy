// Config-driven TTS format handlers in genericFormats.js. Every handler is
// reached through the SUT's own FORMAT_HANDLERS export; all fetch mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FORMAT_HANDLERS } from '../../open-sse/handlers/ttsProviders/genericFormats.js';

const AUDIO = new Uint8Array(256).fill(7);
const AUDIO_B64 = Buffer.from(AUDIO).toString('base64');

function binaryRes(ctype = 'audio/mpeg') {
  return new Response(AUDIO, { status: 200, headers: { 'content-type': ctype } });
}

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ARGS = {
  baseUrl: 'https://upstream.example/tts',
  apiKey: 'key-1',
  text: 'hello',
  modelId: 'model-1',
  voiceId: 'voice-1',
};

function lastCall() {
  const [url, opts] = globalThis.fetch.mock.calls.at(-1);
  return { url: String(url), opts, body: opts.body ? JSON.parse(opts.body) : null };
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('hyperbolic', () => {
  it('posts { text } with Bearer auth and returns the audio field', async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonRes({ audio: AUDIO_B64 }));
    const out = await FORMAT_HANDLERS.hyperbolic(ARGS);
    expect(out).toEqual({ base64: AUDIO_B64, format: 'mp3' });
    const { url, opts, body } = lastCall();
    expect(url).toBe(ARGS.baseUrl);
    expect(opts.headers.Authorization).toBe(`Bearer ${ARGS.apiKey}`);
    expect(body).toEqual({ text: ARGS.text });
  });

  it('throws the upstream error message on failure', async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonRes({ error: { message: 'quota gone' } }, 429));
    await expect(FORMAT_HANDLERS.hyperbolic(ARGS)).rejects.toThrow('quota gone');
  });
});

describe('deepgram', () => {
  it('sends the model as a query param with Token auth and decodes binary', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes());
    const out = await FORMAT_HANDLERS.deepgram(ARGS);
    expect(out).toEqual({ base64: AUDIO_B64, format: 'mp3' });
    const { url, opts } = lastCall();
    expect(new URL(url).searchParams.get('model')).toBe(ARGS.modelId);
    expect(opts.headers.Authorization).toBe(`Token ${ARGS.apiKey}`);
  });

  it('falls back to a default model when none is given', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes());
    await FORMAT_HANDLERS.deepgram({ ...ARGS, modelId: undefined });
    expect(new URL(lastCall().url).searchParams.get('model')).toBeTruthy();
  });
});

describe('nvidia-tts', () => {
  it('posts { input: { text }, voice, model } and decodes wav binary', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes('audio/wav'));
    const out = await FORMAT_HANDLERS['nvidia-tts'](ARGS);
    expect(out.format).toBe('wav');
    const { body } = lastCall();
    expect(body).toEqual({ input: { text: ARGS.text }, voice: ARGS.voiceId, model: ARGS.modelId });
  });

  it('defaults the voice when none is given', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes('audio/wav'));
    await FORMAT_HANDLERS['nvidia-tts']({ ...ARGS, voiceId: null });
    expect(lastCall().body.voice).toBeTruthy();
  });

  it('surfaces an upstream failure', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(FORMAT_HANDLERS['nvidia-tts'](ARGS)).rejects.toThrow('boom');
  });
});

describe('huggingface-tts', () => {
  it('appends the model to the URL and posts { inputs }', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes());
    await FORMAT_HANDLERS['huggingface-tts'](ARGS);
    const { url, body } = lastCall();
    expect(url).toBe(`${ARGS.baseUrl}/${ARGS.modelId}`);
    expect(body).toEqual({ inputs: ARGS.text });
  });

  it('rejects a missing or traversal model id without fetching', async () => {
    await expect(FORMAT_HANDLERS['huggingface-tts']({ ...ARGS, modelId: '' })).rejects.toThrow(
      /model id/i
    );
    await expect(
      FORMAT_HANDLERS['huggingface-tts']({ ...ARGS, modelId: '../etc' })
    ).rejects.toThrow(/model id/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('fish-audio', () => {
  it('sends the model in a header and the voice as reference_id', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes());
    await FORMAT_HANDLERS['fish-audio'](ARGS);
    const { opts, body } = lastCall();
    expect(opts.headers.model).toBe(ARGS.modelId);
    expect(body.reference_id).toBe(ARGS.voiceId);
    expect(body.text).toBe(ARGS.text);
  });

  it('omits reference_id and defaults the model when unset', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes());
    await FORMAT_HANDLERS['fish-audio']({ ...ARGS, modelId: null, voiceId: null });
    const { opts, body } = lastCall();
    expect(opts.headers.model).toBeTruthy();
    expect('reference_id' in body).toBe(false);
  });
});

describe('inworld', () => {
  it('uses Basic auth and returns audioContent', async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonRes({ audioContent: AUDIO_B64 }));
    const out = await FORMAT_HANDLERS.inworld(ARGS);
    expect(out).toEqual({ base64: AUDIO_B64, format: 'mp3' });
    const { opts, body } = lastCall();
    expect(opts.headers.Authorization).toBe(`Basic ${ARGS.apiKey}`);
    expect(body.voiceId).toBe(ARGS.voiceId);
    expect(body.modelId).toBe(ARGS.modelId);
  });

  it('throws when the response has no audioContent', async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonRes({}));
    await expect(FORMAT_HANDLERS.inworld(ARGS)).rejects.toThrow(/no audio/);
  });

  it('defaults voice and model when unset', async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonRes({ audioContent: AUDIO_B64 }));
    await FORMAT_HANDLERS.inworld({ ...ARGS, voiceId: null, modelId: null });
    const { body } = lastCall();
    expect(body.voiceId).toBeTruthy();
    expect(body.modelId).toBeTruthy();
  });
});

describe('cartesia', () => {
  it('authenticates via X-API-Key and wraps the voice as { mode: "id" }', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes());
    await FORMAT_HANDLERS.cartesia(ARGS);
    const { opts, body } = lastCall();
    expect(opts.headers['X-API-Key']).toBe(ARGS.apiKey);
    expect(body.transcript).toBe(ARGS.text);
    expect(body.model_id).toBe(ARGS.modelId);
    expect(body.voice).toEqual({ mode: 'id', id: ARGS.voiceId });
  });

  it('omits the voice and defaults the model when unset', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes());
    await FORMAT_HANDLERS.cartesia({ ...ARGS, modelId: null, voiceId: null });
    const { body } = lastCall();
    expect('voice' in body).toBe(false);
    expect(body.model_id).toBeTruthy();
  });
});

describe('playht', () => {
  it('splits "userId:apiKey" into X-USER-ID and Bearer', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes());
    await FORMAT_HANDLERS.playht({ ...ARGS, apiKey: 'user-9:secret-9' });
    const { opts, body } = lastCall();
    expect(opts.headers['X-USER-ID']).toBe('user-9');
    expect(opts.headers.Authorization).toBe('Bearer secret-9');
    expect(body.text).toBe(ARGS.text);
    expect(body.voice_engine).toBe(ARGS.modelId);
  });

  it('falls back to the whole key when there is no colon, with defaults', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes());
    await FORMAT_HANDLERS.playht({ ...ARGS, apiKey: 'solo-key', modelId: null, voiceId: null });
    const { opts, body } = lastCall();
    expect(opts.headers.Authorization).toBe('Bearer solo-key');
    expect(body.voice).toBeTruthy();
    expect(body.voice_engine).toBeTruthy();
  });
});

describe('coqui and tortoise (local, noAuth)', () => {
  it('coqui posts { text, speaker_id } without auth', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes('audio/wav'));
    const out = await FORMAT_HANDLERS.coqui(ARGS);
    expect(out.format).toBe('wav');
    const { opts, body } = lastCall();
    expect(opts.headers.Authorization).toBeUndefined();
    expect(body).toEqual({ text: ARGS.text, speaker_id: ARGS.voiceId });
  });

  it('coqui omits speaker_id when no voice is given', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes('audio/wav'));
    await FORMAT_HANDLERS.coqui({ ...ARGS, voiceId: null });
    expect(lastCall().body).toEqual({ text: ARGS.text });
  });

  it('tortoise posts { text, voice } and defaults the voice', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes('audio/wav'));
    await FORMAT_HANDLERS.tortoise({ ...ARGS, voiceId: null });
    const { body } = lastCall();
    expect(body.text).toBe(ARGS.text);
    expect(body.voice).toBeTruthy();
  });

  it('tortoise surfaces upstream failure', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response('down', { status: 502 }));
    await expect(FORMAT_HANDLERS.tortoise(ARGS)).rejects.toThrow('down');
  });
});

describe('openai-compatible', () => {
  it('posts the OpenAI speech shape with Bearer auth', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes());
    await FORMAT_HANDLERS.openai(ARGS);
    const { opts, body } = lastCall();
    expect(opts.headers.Authorization).toBe(`Bearer ${ARGS.apiKey}`);
    expect(body.model).toBe(ARGS.modelId);
    expect(body.input).toBe(ARGS.text);
    expect(body.voice).toBe(ARGS.voiceId);
  });

  it('omits Authorization and defaults the voice when unset', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes());
    await FORMAT_HANDLERS.openai({ ...ARGS, apiKey: null, voiceId: null });
    const { opts, body } = lastCall();
    expect(opts.headers.Authorization).toBeUndefined();
    expect(body.voice).toBeTruthy();
  });
});

describe('binary decoding via responseToBase64', () => {
  it('honours the response content-type over the handler default', async () => {
    globalThis.fetch.mockResolvedValueOnce(binaryRes('audio/ogg'));
    const out = await FORMAT_HANDLERS.deepgram(ARGS);
    expect(out.format).toBe('ogg');
  });

  it('rejects a payload under 100 bytes as empty audio', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      new Response(new Uint8Array(10), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    );
    await expect(FORMAT_HANDLERS.deepgram(ARGS)).rejects.toThrow(/empty audio/);
  });
});
