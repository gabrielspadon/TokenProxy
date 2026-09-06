// GrokWebExecutor contract: OpenAI-messages → single Grok prompt (role-prefixed
// history, bare last user turn), NDJSON upstream parsing (garbage lines skipped,
// trailing unterminated line flushed), SSE and JSON response synthesis with
// fingerprint carry-over, error classification (400 invalid_request, upstream
// HTTP_<status> pass-through, 502 on connect failure / empty body / stream error),
// sso cookie normalization, and abort propagation. All network stubbed via
// vi.stubGlobal('fetch', ...) — expectations derive from PROVIDERS['grok-web']
// and the SSE constants, not hardcoded endpoints.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { GrokWebExecutor } = await import('../../open-sse/executors/grok-web.js');
const { PROVIDERS } = await import('../../open-sse/config/providers.js');
const { SSE_DONE, SSE_HEADERS_NO_BUFFER } = await import('../../open-sse/utils/sseConstants.js');

const BASE_URL = PROVIDERS['grok-web'].baseUrl;

const bodyStream = (chunks) =>
  new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });

const upstream = (chunks) => ({ ok: true, status: 200, body: bodyStream(chunks) });

const run = (ex, over = {}) =>
  ex.execute({
    model: 'any-unmapped-model',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: { apiKey: 'tok' },
    signal: undefined,
    log: null,
    ...over,
  });

const parseSSE = (text) =>
  text
    .split('\n\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));

beforeEach(() => fetchMock.mockReset());

describe('GrokWebExecutor.execute — request validation', () => {
  const ex = new GrokWebExecutor();

  it('400s on a missing or empty messages array without calling upstream', async () => {
    for (const body of [{}, { messages: [] }, { messages: 'no' }]) {
      const out = await run(ex, { body });
      expect(out.response.status).toBe(400);
      const err = await out.response.json();
      expect(err.error.type).toBe('invalid_request');
      expect(out.url).toBe(BASE_URL);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400s when every message reduces to empty text', async () => {
    const out = await run(ex, {
      body: {
        messages: [
          { role: 'user', content: '   ' },
          { role: 'user', content: [{ type: 'image_url', url: 'x' }] },
        ],
      },
    });
    expect(out.response.status).toBe(400);
    expect((await out.response.json()).error.type).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GrokWebExecutor — prompt assembly and outbound request shape', () => {
  const ex = new GrokWebExecutor();

  it('prefixes history with roles, maps developer→system, leaves the last user turn bare', async () => {
    fetchMock.mockResolvedValueOnce(upstream(['\n']));
    const out = await run(ex, {
      body: {
        messages: [
          { role: 'developer', content: 'sys rules' },
          { role: 'user', content: [{ type: 'text', text: 'q1' }, { type: 'image_url' }] },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'q2' },
        ],
      },
    });
    expect(out.transformedBody.message).toBe(
      'system: sys rules\n\nuser: q1\n\nassistant: a1\n\nq2'
    );
    expect(out.url).toBe(BASE_URL);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(BASE_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).message).toBe(out.transformedBody.message);
  });

  it("normalizes the sso cookie: with and without the pasted 'sso=' prefix", async () => {
    fetchMock.mockResolvedValue(upstream(['\n']));
    const a = await run(ex, { credentials: { apiKey: 'sso=abc123' } });
    const b = await run(ex, { credentials: { apiKey: 'abc123' } });
    expect(a.headers.Cookie).toBe('sso=abc123');
    expect(b.headers.Cookie).toBe('sso=abc123');
    const none = await run(ex, { credentials: {} });
    expect(none.headers.Cookie).toBeUndefined();
  });

  it('logs and falls back to a default mapping for an unmapped model', async () => {
    fetchMock.mockResolvedValueOnce(upstream(['\n']));
    const log = { info: vi.fn() };
    const out = await run(ex, { model: 'definitely-not-a-model', log });
    expect(log.info).toHaveBeenCalledWith(
      'GROK-WEB',
      expect.stringContaining('definitely-not-a-model')
    );
    expect(out.transformedBody.modelName).toBeTruthy();
    expect(out.transformedBody.modelMode).toBeTruthy();
  });
});

describe('GrokWebExecutor — upstream failure classification', () => {
  const ex = new GrokWebExecutor();

  it('a generic fetch failure becomes a 502 upstream_error, not a throw', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const log = { error: vi.fn() };
    const out = await run(ex, { log });
    expect(out.response.status).toBe(502);
    const err = await out.response.json();
    expect(err.error.type).toBe('upstream_error');
    expect(err.error.message).toContain('ECONNRESET');
    expect(log.error).toHaveBeenCalled();
  });

  it('an AbortError propagates as a throw for the retry layer', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abortErr);
    await expect(run(ex)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('non-OK statuses pass through with an HTTP_<status> code; 401/403/429 get guidance', async () => {
    for (const status of [401, 403, 429, 500]) {
      fetchMock.mockResolvedValueOnce({ ok: false, status, body: null });
      const out = await run(ex);
      expect(out.response.status).toBe(status);
      const err = await out.response.json();
      expect(err.error.code).toBe(`HTTP_${status}`);
      expect(err.error.type).toBe('upstream_error');
    }
  });

  it('an OK response with no body is a 502 upstream_error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: null });
    const out = await run(ex);
    expect(out.response.status).toBe(502);
    expect((await out.response.json()).error.type).toBe('upstream_error');
  });
});

describe('GrokWebExecutor — non-streaming synthesis', () => {
  const ex = new GrokWebExecutor();

  it('accumulates deltas, lets a final modelResponse override, carries the fingerprint, fills usage', async () => {
    fetchMock.mockResolvedValueOnce(
      upstream([
        'not-json\n',
        '{"result":{"response":{"llmInfo":{"modelHash":"fp-1"},"token":"Hel"}}}\n',
        '{"result":{"response":{"token":"lo","responseId":"r1"}}}\n',
        // trailing line without newline exercises the flush path
        '{"result":{"response":{"modelResponse":{"message":"Hello there"}}}}',
      ])
    );
    const out = await run(ex, { stream: false });
    expect(out.response.status).toBe(200);
    const json = await out.response.json();
    expect(json.object).toBe('chat.completion');
    expect(json.choices[0].message).toEqual({ role: 'assistant', content: 'Hello there' });
    expect(json.choices[0].finish_reason).toBe('stop');
    expect(json.system_fingerprint).toBe('fp-1');
    const expectedTok = Math.ceil('Hello there'.length / 4);
    expect(json.usage).toEqual({
      prompt_tokens: expectedTok,
      completion_tokens: expectedTok,
      total_tokens: expectedTok * 2,
    });
  });

  it('an upstream error event becomes a 502 GROK_ERROR', async () => {
    fetchMock.mockResolvedValueOnce(upstream(['{"error":{"message":"boom"}}\n']));
    const out = await run(ex, { stream: false });
    expect(out.response.status).toBe(502);
    const err = await out.response.json();
    expect(err.error.code).toBe('GROK_ERROR');
    expect(err.error.message).toBe('boom');
  });

  it('an error event with only a code falls back to a code-bearing message', async () => {
    fetchMock.mockResolvedValueOnce(upstream(['{"error":{"code":7}}\n']));
    const out = await run(ex, { stream: false });
    expect((await out.response.json()).error.message).toContain('7');
  });
});

describe('GrokWebExecutor — streaming synthesis', () => {
  const ex = new GrokWebExecutor();

  it('emits role chunk, token deltas with fingerprint, finish stop, then [DONE], under no-buffer SSE headers', async () => {
    fetchMock.mockResolvedValueOnce(
      upstream([
        '{"result":{"response":{"llmInfo":{"modelHash":"fp-s"},"token":"a"}}}\n',
        '{"result":{"response":{"token":"b"}}}\n',
      ])
    );
    const out = await run(ex, { stream: true });
    expect(out.response.status).toBe(200);
    for (const [k, v] of Object.entries(SSE_HEADERS_NO_BUFFER)) {
      expect(out.response.headers.get(k)).toBe(v);
    }
    const text = await out.response.text();
    expect(text.endsWith(SSE_DONE)).toBe(true);
    const chunks = parseSSE(text);
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    const contents = chunks.map((c) => c.choices[0].delta.content).filter((c) => c !== undefined);
    expect(contents).toEqual(['a', 'b']);
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
    expect(chunks.at(-1).system_fingerprint).toBe('fp-s');
  });

  it('surfaces an upstream error event inline and still terminates the stream', async () => {
    fetchMock.mockResolvedValueOnce(upstream(['{"error":{"message":"quota"}}\n']));
    const out = await run(ex, { stream: true });
    const text = await out.response.text();
    expect(text).toContain('[Error: quota]');
    expect(text.endsWith(SSE_DONE)).toBe(true);
  });

  it('a body stream that errors mid-read produces a [Stream error:] chunk and [DONE]', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error('brk'));
        },
      }),
    });
    const out = await run(ex, { stream: true });
    const text = await out.response.text();
    expect(text).toContain('[Stream error: brk]');
    expect(text.endsWith(SSE_DONE)).toBe(true);
  });

  it('a pre-aborted signal ends the stream cleanly with finish stop', async () => {
    const ac = new AbortController();
    ac.abort();
    fetchMock.mockResolvedValueOnce(upstream(['{"result":{"response":{"token":"never"}}}\n']));
    const out = await run(ex, { stream: true, signal: ac.signal });
    const text = await out.response.text();
    expect(text).not.toContain('never');
    expect(text.endsWith(SSE_DONE)).toBe(true);
    expect(parseSSE(text).at(-1).choices[0].finish_reason).toBe('stop');
  });
});
