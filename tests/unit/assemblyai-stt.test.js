import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSttCore } from '../../open-sse/handlers/sttCore.js';

const originalFetch = global.fetch;

function makeAudioFile() {
  return new File([new Uint8Array([1, 2, 3])], 'speech.wav', { type: 'audio/wav' });
}

function makeFormData(language) {
  const formData = new FormData();
  formData.set('file', makeAudioFile());
  if (language) formData.set('language', language);
  return formData;
}

function makeSttConfig() {
  return {
    baseUrl: 'https://api.assemblyai.com/v2/transcript',
    authType: 'apikey',
    authHeader: 'authorization',
    format: 'assemblyai',
  };
}

describe('AssemblyAI STT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // sttCore.js polls AssemblyAI with a real 2s `setTimeout` between attempts;
    // fake timers let the single completed-on-first-poll case here resolve
    // without actually sleeping.
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('uses raw Authorization header for AssemblyAI upload/submit/poll', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ upload_url: 'https://cdn.example/audio.wav' }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'transcript-id' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'completed', text: 'hello world' }),
      });

    const resultPromise = handleSttCore({
      provider: 'assemblyai',
      model: 'universal-2',
      formData: makeFormData('en'),
      credentials: { apiKey: 'test-api-key' },
      sttConfig: makeSttConfig(),
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({ text: 'hello world' });
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.assemblyai.com/v2/upload',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'test-api-key' }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.assemblyai.com/v2/transcript',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'test-api-key' }),
      })
    );
  });

  it('maps an explicit language field to AssemblyAI language_code', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ upload_url: 'https://cdn.example/audio.wav' }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'transcript-id' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'completed', text: 'hello world' }),
      });

    const p = handleSttCore({
      provider: 'assemblyai',
      model: 'universal-2',
      formData: makeFormData('en'),
      credentials: { apiKey: 'test-api-key' },
      sttConfig: makeSttConfig(),
    });
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    const submitBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(submitBody).toEqual({
      audio_url: 'https://cdn.example/audio.wav',
      speech_models: ['universal-2'],
      language_code: 'en',
    });
  });

  it('uses language detection when no language is provided', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ upload_url: 'https://cdn.example/audio.wav' }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'transcript-id' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'completed', text: 'hello world' }),
      });

    const p2 = handleSttCore({
      provider: 'assemblyai',
      model: 'universal-2',
      formData: makeFormData(),
      credentials: { apiKey: 'test-api-key' },
      sttConfig: makeSttConfig(),
    });
    await vi.advanceTimersByTimeAsync(2000);
    await p2;

    const submitBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(submitBody).toEqual({
      audio_url: 'https://cdn.example/audio.wav',
      speech_models: ['universal-2'],
      language_detection: true,
    });
  });
});
