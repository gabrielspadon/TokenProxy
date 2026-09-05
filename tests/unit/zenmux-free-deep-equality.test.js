// Deep-equality and status-branch coverage for zenmux-free.js, targeting the
// many ObjectLiteral/StringLiteral survivors in request headers/bodies and
// response envelopes that field-by-field assertions in the other suites don't
// pin. All network mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { ZenmuxFreeExecutor, validateCookies } =
  await import('../../open-sse/executors/zenmux-free.js');

const AUTH_COOKIES = 'sess=1; ctoken=tok-123; other=x';
const authCreds = { apiKey: AUTH_COOKIES };

function sseBody(raw) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(raw));
      c.close();
    },
  });
}
function okStream(raw) {
  return new Response(sseBody(raw), { status: 200 });
}
async function readAll(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => fetchMock.mockReset());

it('chat request headers carry the exact literal set, nothing more or less', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
  const ex = new ZenmuxFreeExecutor();
  await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  const [, chatInit] = fetchMock.mock.calls[1];
  expect(chatInit.headers).toEqual({
    Cookie: AUTH_COOKIES,
    Origin: 'https://zenmux.ai',
    'User-Agent': chatInit.headers['User-Agent'],
    Referer: 'https://zenmux.ai/platform/chat',
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'chat-request-id': chatInit.headers['chat-request-id'],
    'x-zenmux-accept-processing': 'true, true',
    'x-zenmux-apikey-source': 'subscription',
    Accept: 'text/event-stream',
  });
  expect(chatInit.method).toBe('POST');
});

it('the opening SSE chunk in stream mode sets role assistant with a null finish_reason', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'my-model',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: true,
    credentials: authCreds,
  });
  const text = await readAll(out.response.body);
  const firstChunk = JSON.parse(text.split('\n\n')[0].slice(6));
  expect(firstChunk.object).toBe('chat.completion.chunk');
  expect(firstChunk.model).toBe('my-model');
  expect(firstChunk.choices).toEqual([
    { index: 0, delta: { role: 'assistant' }, finish_reason: null },
  ]);
});

it('non-stream response envelope matches the exact shape, id prefixed chatcmpl-zmf-', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(
      okStream(
        'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } }) + '\n'
      )
    );
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'my-model',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  const json = JSON.parse(await out.response.text());
  expect(json.id.startsWith('chatcmpl-zmf-')).toBe(true);
  expect(json.object).toBe('chat.completion');
  expect(json.model).toBe('my-model');
  expect(json.choices).toEqual([
    { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
  ]);
});

describe('upstream error status mapping', () => {
  it('401 maps to statusCode 401 with the cookies-expired message', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('denied', { status: 401 }));
    const ex = new ZenmuxFreeExecutor();
    const out = await ex.execute({
      model: 'm',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: authCreds,
    });
    const err = JSON.parse(await out.response.text());
    expect(out.response.status).toBe(401);
    expect(err.error.message).toBe('ZenMux: cookies expired');
  });

  it('402 maps to statusCode 402 with the quota-exhausted message', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('quota', { status: 402 }));
    const ex = new ZenmuxFreeExecutor();
    const out = await ex.execute({
      model: 'm',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: authCreds,
    });
    const err = JSON.parse(await out.response.text());
    expect(out.response.status).toBe(402);
    expect(err.error.message).toBe('ZenMux: quota exhausted');
  });

  it('a generic 500 maps to statusCode 500 with an HTTP-500 message', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const ex = new ZenmuxFreeExecutor();
    const out = await ex.execute({
      model: 'm',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: authCreds,
    });
    const err = JSON.parse(await out.response.text());
    expect(out.response.status).toBe(500);
    expect(err.error.message).toBe('ZenMux: HTTP 500');
  });
});

it('_collectText buffers a data: line split across two read chunks (holds the trailing partial in buf)', async () => {
  const full =
    'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'split-ok' } }) + '\n';
  const half = Math.floor(full.length / 2);
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(full.slice(0, half)));
      c.enqueue(new TextEncoder().encode(full.slice(half)));
      c.close();
    },
  });
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(new Response(stream, { status: 200 }));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  const json = JSON.parse(await out.response.text());
  expect(json.choices[0].message.content).toBe('split-ok');
});

it('a line that is not data-prefixed is skipped entirely, not parsed', async () => {
  const raw =
    ': comment line\n' +
    'data: ' +
    JSON.stringify({ type: 'content_block_delta', delta: { text: 'ok' } }) +
    '\n';
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(raw));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  const json = JSON.parse(await out.response.text());
  expect(json.choices[0].message.content).toBe('ok');
});

describe('validateCookies non-ok HTTP response', () => {
  it('a non-ok status short-circuits with the exact HTTP-<status> message, not parsing a body', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('x', { status: 500 }));
    const r = await validateCookies(AUTH_COOKIES);
    expect(r).toEqual({ valid: false, error: 'HTTP 500' });
    globalFetch.mockRestore();
  });

  it('no ctoken in the cookie string short-circuits before any fetch, with the "no ctoken" error', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const r = await validateCookies('sess=1');
    expect(r).toEqual({ valid: false, error: 'no ctoken' });
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('valid credentials return the displayName and email from data', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, data: { displayName: 'Gabriel', email: 'g@x' } }),
        {
          status: 200,
        }
      )
    );
    const r = await validateCookies(AUTH_COOKIES);
    expect(r).toEqual({ valid: true, user: 'Gabriel', email: 'g@x' });
    globalFetch.mockRestore();
  });
});
