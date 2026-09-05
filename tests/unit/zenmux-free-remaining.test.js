// Kills remaining zenmux-free.js survivors: reqId/subId dash-stripping,
// usage estimate exact divide-by-4 math, _collectText/buildSSEStream buffer
// trailing-line handling on a done read with no newline, buildSSEStream's
// message_delta requiring a truthy d.delta, updateRound's exact extra JSON
// field, and validateCookies' header shape. All network mocked.
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

it('chatRequestId sent to the anthropic endpoint has no dashes (uuid stripped)', async () => {
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
  // exact 32-char lowercase hex, not just "no dash": kills a mutant that
  // replaces the "" replacement arg with a non-empty, non-dash string.
  expect(chatInit.headers['chat-request-id']).toMatch(/^[0-9a-f]{32}$/);
});

it('addRound POST body is sent with method POST to the frontend base', async () => {
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
  const [, addRoundInit] = fetchMock.mock.calls[0];
  expect(addRoundInit.method).toBe('POST');
});

it('r1 not ok leaves roundId null, so step 3 updateRound never fires', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 500 }))
    .mockResolvedValueOnce(
      okStream(
        'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } }) + '\n'
      )
    );
  const ex = new ZenmuxFreeExecutor();
  await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('claudeBody sent to the chat endpoint has exact user/text message shape', async () => {
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
  const sent = JSON.parse(chatInit.body);
  expect(sent.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
});

it('non-stream usage totals prompt+completion tokens computed as ceil(length/4)', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(
      okStream(
        'data: ' +
          JSON.stringify({ type: 'content_block_delta', delta: { text: '12345678' } }) +
          '\n'
      )
    );
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'abcd' }] }, // question length 4 -> prompt_tokens 1
    stream: false,
    credentials: authCreds,
  });
  const json = JSON.parse(await out.response.text());
  expect(json.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
});

it('_collectText picks up the thinking field when delta.text is absent', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(
      okStream(
        'data: ' +
          JSON.stringify({ type: 'content_block_delta', delta: { thinking: 'ponder' } }) +
          '\n'
      )
    );
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  const json = JSON.parse(await out.response.text());
  expect(json.choices[0].message.content).toBe('ponder');
});

it('a final read with no trailing newline still yields the last data line (buf held from lines.pop())', async () => {
  const raw = 'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'tail' } });
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(raw)); // no trailing \n
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  const json = JSON.parse(await out.response.text());
  expect(json.choices[0].message.content).toBe('tail');
});

it('buildSSEStream: a message_delta event with a falsy delta emits no finish chunk', async () => {
  const raw = 'data: ' + JSON.stringify({ type: 'message_delta', delta: null }) + '\n';
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(raw));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: true,
    credentials: authCreds,
  });
  const text = await readAll(out.response.body);
  const frames = text.split('\n\n').filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'));
  const finishFrames = frames.filter(
    (f) => JSON.parse(f.slice(6)).choices[0].finish_reason !== null
  );
  expect(finishFrames).toHaveLength(0);
});

it('updateRound body carries the pinned modelInfo.slug field exactly', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'round-1' }), { status: 200 }))
    .mockResolvedValueOnce(
      okStream(
        'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } }) + '\n'
      )
    )
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  const ex = new ZenmuxFreeExecutor();
  await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const [, updateInit] = fetchMock.mock.calls[2];
  const sent = JSON.parse(updateInit.body);
  const extra = JSON.parse(sent.extra);
  expect(extra.modelInfo).toEqual({ slug: 'deepseek/deepseek-v4-pro' });
});

it('cid embeds a 12-char randomUUID slice and created is whole seconds, not ms', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
  const before = Math.floor(Date.now() / 1000);
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  const after = Math.floor(Date.now() / 1000);
  const json = JSON.parse(await out.response.text());
  expect(json.id).toMatch(/^chatcmpl-zmf-[0-9a-f-]{12}$/);
  expect(json.created).toBeGreaterThanOrEqual(before);
  expect(json.created).toBeLessThanOrEqual(after);
});

describe('validateCookies request shape', () => {
  it('sends only Cookie and User-Agent headers, no Origin', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { displayName: 'G', email: 'g@x' } }), {
        status: 200,
      })
    );
    await validateCookies(AUTH_COOKIES);
    const [, init] = globalFetch.mock.calls[0];
    expect(init.headers).toEqual({
      Cookie: AUTH_COOKIES,
      'User-Agent': init.headers['User-Agent'],
    });
    globalFetch.mockRestore();
  });

  it('success:true but data missing reports session expired, not valid', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const r = await validateCookies(AUTH_COOKIES);
    expect(r).toEqual({ valid: false, error: 'session expired' });
    globalFetch.mockRestore();
  });

  it('non-ok HTTP status reports the exact status code, not "session expired"', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    const r = await validateCookies(AUTH_COOKIES);
    expect(r).toEqual({ valid: false, error: 'HTTP 503' });
    globalFetch.mockRestore();
  });

  it('a network throw is caught and reported as the thrown error message', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('boom'));
    const r = await validateCookies(AUTH_COOKIES);
    expect(r).toEqual({ valid: false, error: 'boom' });
    globalFetch.mockRestore();
  });

  it('no ctoken in cookies short-circuits before any fetch call', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const r = await validateCookies('sess=1; other=x');
    expect(r).toEqual({ valid: false, error: 'no ctoken' });
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });
});

it('roundId is read from the addRound response body and reused by updateRound', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'round-77' }), { status: 200 }))
    .mockResolvedValueOnce(
      okStream(
        'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } }) + '\n'
      )
    )
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  const ex = new ZenmuxFreeExecutor();
  await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const [, updateInit] = fetchMock.mock.calls[2];
  const sent = JSON.parse(updateInit.body);
  expect(sent.chatRoundId).toBe('round-77');
});
