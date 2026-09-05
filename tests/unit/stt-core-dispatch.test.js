// handleSttCore: trust-boundary validation, per-format provider dispatch,
// auth-header selection, and error propagation with the upstream status kept.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleSttCore } from 'open-sse/handlers/sttCore.js';

const realFetch = globalThis.fetch;
let calls;

function stub(responder) {
  calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init, calls.length);
  });
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function formDataWith(entries = [], { withFile = true } = {}) {
  const fd = new FormData();
  if (withFile) fd.append('file', new File([new Uint8Array([1, 2, 3])], 'a.mp3', { type: '' }));
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

const run = (over = {}) =>
  handleSttCore({
    provider: 'prov',
    model: 'model-1',
    formData: formDataWith(over.entries),
    credentials: { apiKey: 'sk-1', ...(over.credentials || {}) },
    sttConfig: over.sttConfig,
    ...over,
  });

describe('trust boundary', () => {
  it('400 when the file field is missing, before any fetch', async () => {
    stub(() => json({}));
    const r = await handleSttCore({
      provider: 'p',
      model: 'm',
      formData: new FormData(),
      credentials: { apiKey: 'k' },
      sttConfig: { baseUrl: 'https://x', format: 'whisper' },
    });
    expect(r).toMatchObject({ success: false, status: 400 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('400 when the provider has no sttConfig', async () => {
    stub(() => json({}));
    const r = await run({ sttConfig: undefined });
    expect(r).toMatchObject({ success: false, status: 400 });
    expect(r.error).toContain('does not support STT');
  });

  it('401 when auth is required and no credential is present; authType none needs no token', async () => {
    stub(() => json({ text: 'hi' }));
    const noCreds = await handleSttCore({
      provider: 'p',
      model: 'm',
      formData: formDataWith(),
      credentials: {},
      sttConfig: { baseUrl: 'https://x', authType: 'bearer' },
    });
    expect(noCreds).toMatchObject({ success: false, status: 401 });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const open = await handleSttCore({
      provider: 'p',
      model: 'm',
      formData: formDataWith(),
      credentials: {},
      sttConfig: { baseUrl: 'https://x', authType: 'none' },
    });
    expect(open.success).toBe(true);
    expect(calls[0].init.headers?.Authorization).toBeUndefined();
  });
});

describe('provider dispatch and request shape', () => {
  it('openai-compatible default: multipart with model and only the whitelisted optional fields', async () => {
    stub(
      () =>
        new Response('{"text":"t"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const r = await run({
      sttConfig: { baseUrl: 'https://api.example/v1/audio/transcriptions', authType: 'bearer' },
      entries: [
        ['language', 'en'],
        ['temperature', '0'],
        ['evil_extra', 'x'],
      ],
    });
    expect(r.success).toBe(true);
    const body = calls[0].init.body;
    expect(body.get('model')).toBe('model-1');
    expect(body.get('language')).toBe('en');
    expect(body.get('temperature')).toBe('0');
    expect(body.get('evil_extra')).toBeNull();
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk-1');
  });

  it('deepgram: raw binary body, model in query, language falls back to detect_language', async () => {
    stub(() => json({ results: { channels: [{ alternatives: [{ transcript: 'dg text' }] }] } }));
    const r = await run({
      sttConfig: {
        baseUrl: 'https://api.deepgram.com/v1/listen',
        format: 'deepgram',
        authHeader: 'token',
      },
    });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('model')).toBe('model-1');
    expect(u.searchParams.get('detect_language')).toBe('true');
    expect(calls[0].init.headers.Authorization).toBe('Token sk-1');
    // mp3 extension mapped even though file.type was empty
    expect(calls[0].init.headers['Content-Type']).toBe('audio/mpeg');
    const payload = JSON.parse(await r.response.text());
    expect(payload.text).toBe('dg text');
  });

  it('deepgram with explicit language sets language= and not detect_language', async () => {
    stub(() => json({ results: { channels: [{ alternatives: [{ transcript: 'x' }] }] } }));
    await run({
      sttConfig: { baseUrl: 'https://api.deepgram.com/v1/listen', format: 'deepgram' },
      entries: [['language', 'pt']],
    });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('language')).toBe('pt');
    expect(u.searchParams.get('detect_language')).toBeNull();
  });

  it('huggingface: rejects a path-traversal model id before any fetch', async () => {
    stub(() => json({ text: 'x' }));
    const r = await run({
      model: '../secrets',
      sttConfig: {
        baseUrl: 'https://api-inference.huggingface.co/models/',
        format: 'huggingface-asr',
      },
    });
    expect(r).toMatchObject({ success: false, status: 400 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('gemini: inline_data with base64 audio and language appended to the prompt', async () => {
    stub(() => json({ candidates: [{ content: { parts: [{ text: 'gm ' }, { text: 'text' }] } }] }));
    const r = await run({
      sttConfig: { baseUrl: 'https://glang.googleapis.com/v1beta/models', format: 'gemini-stt' },
      entries: [['language', 'en']],
    });
    expect(calls[0].url).toBe(
      'https://glang.googleapis.com/v1beta/models/model-1:generateContent?key=sk-1'
    );
    const body = JSON.parse(calls[0].init.body);
    const parts = body.contents[0].parts;
    expect(parts[0].text).toContain('Language: en.');
    expect(parts[1].inline_data).toMatchObject({ mime_type: 'audio/mpeg' });
    expect(JSON.parse(await r.response.text()).text).toBe('gm text');
  });

  it('per-connection baseUrl override redirects the request and strips the trailing slash', async () => {
    stub(
      () =>
        new Response('{"text":"t"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    await run({
      sttConfig: { baseUrl: 'https://cloud.example/v1', authType: 'bearer' },
      credentials: {
        apiKey: 'sk-1',
        providerSpecificData: { baseUrl: 'https://self.hosted/stt/' },
      },
    });
    expect(calls[0].url).toBe('https://self.hosted/stt');
  });
});

describe('error propagation', () => {
  it('upstream 429 with a JSON error body keeps the status and extracts the message', async () => {
    stub(() => json({ error: { message: 'quota exceeded' } }, 429));
    const r = await run({ sttConfig: { baseUrl: 'https://x', authType: 'bearer' } });
    expect(r).toMatchObject({ success: false, status: 429, error: 'quota exceeded' });
  });

  it('upstream 500 with a plain-text body keeps the text', async () => {
    stub(() => new Response('upstream broke', { status: 500 }));
    const r = await run({ sttConfig: { baseUrl: 'https://x', authType: 'bearer' } });
    expect(r).toMatchObject({ success: false, status: 500, error: 'upstream broke' });
  });

  it('a thrown fetch becomes a 502, never an unhandled rejection', async () => {
    calls = [];
    globalThis.fetch = vi.fn(async () => {
      throw new Error('dns fail');
    });
    const r = await run({ sttConfig: { baseUrl: 'https://x', authType: 'bearer' } });
    expect(r).toMatchObject({ success: false, status: 502, error: 'dns fail' });
  });

  it('assemblyai: upload → submit → poll completes with the transcript; poll error propagates', async () => {
    vi.useFakeTimers();
    try {
      let pollN = 0;
      stub((url, init) => {
        if (url.includes('/upload')) return json({ upload_url: 'https://cdn.aai/x' });
        if (init.method === 'POST') return json({ id: 'tr-1' });
        pollN += 1;
        return json(pollN < 2 ? { status: 'processing' } : { status: 'completed', text: 'aai text' });
      });
      const pending = run({
        sttConfig: { baseUrl: 'https://api.assemblyai.com/v2/transcript', format: 'assemblyai' },
        entries: [['language', 'en']],
      });
      await vi.advanceTimersByTimeAsync(5000);
      const r = await pending;
      expect(r.success).toBe(true);
      expect(JSON.parse(await r.response.text()).text).toBe('aai text');
      // submit body carried the language, not detection
      const submit = calls.find((c) => c.url.endsWith('/transcript') && c.init.method === 'POST');
      expect(JSON.parse(submit.init.body)).toMatchObject({ language_code: 'en' });

      stub((url, init) => {
        if (url.includes('/upload')) return json({ upload_url: 'u' });
        if (init.method === 'POST') return json({ id: 'tr-2' });
        return json({ status: 'error', error: 'transcode failed' });
      });
      const failing = run({
        sttConfig: { baseUrl: 'https://api.assemblyai.com/v2/transcript', format: 'assemblyai' },
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await failing).toMatchObject({ success: false, status: 500, error: 'transcode failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('assemblyai: an upload failure propagates the upload status without submitting', async () => {
    stub((url) => {
      if (url.includes('/upload')) return json({ error: 'bad audio' }, 422);
      throw new Error('must not reach submit');
    });
    const r = await run({
      sttConfig: { baseUrl: 'https://api.assemblyai.com/v2/transcript', format: 'assemblyai' },
    });
    expect(r).toMatchObject({ success: false, status: 422 });
    expect(calls).toHaveLength(1);
  });
});
