// Targets zenmux-free.js survivors not covered by the deep-equality file:
// addRound/updateRound exact body shape, fullText system-message composition,
// ctoken-missing guard, addRound non-ok swallow, updateRound skip-on-empty-text,
// buildSSEStream message_delta finish_reason + error-chunk fallback,
// validateCookies session-expired branch, and the default-502 catch mapping.
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

it('throws "ctoken not found in cookies" and never calls fetch when cookies lack ctoken', async () => {
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: { apiKey: 'sess=1' },
  });
  expect(fetchMock).not.toHaveBeenCalled();
  const err = JSON.parse(await out.response.text());
  expect(out.response.status).toBe(502);
  expect(err.error.message).toBe('ctoken not found in cookies');
});

it('a system message is prefixed onto the user question joined by a blank line', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
  const ex = new ZenmuxFreeExecutor();
  await ex.execute({
    model: 'm',
    body: {
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
      ],
    },
    stream: false,
    credentials: authCreds,
  });
  const [, chatInit] = fetchMock.mock.calls[1];
  const sent = JSON.parse(chatInit.body);
  expect(sent.messages[0].content[0].text).toBe('be nice\n\nhi');
});

it('the addRound request body carries the exact literal field set', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'round-1' }), { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
  const ex = new ZenmuxFreeExecutor();
  await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  const [, addRoundInit] = fetchMock.mock.calls[0];
  const sent = JSON.parse(addRoundInit.body);
  expect(sent.answer).toBe('​');
  expect(sent.question).toBe('hi');
  const extra = JSON.parse(sent.extra);
  expect(extra.status).toBe('sending');
});

it('addRound returning non-ok leaves roundId null, so updateRound never fires', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('nope', { status: 500 }))
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
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('updateRound is skipped (no third fetch) when the collected text is empty', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'round-1' }), { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
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

it('updateRound fires a third request with the exact success/finishReason fields when text is non-empty', async () => {
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
  expect(fetchMock).toHaveBeenCalledTimes(3);
  const [, updateInit] = fetchMock.mock.calls[2];
  const sent = JSON.parse(updateInit.body);
  expect(sent.status).toBe('success');
  expect(sent.finishReason).toBe('success');
  expect(sent.chatRoundId).toBe('round-1');
});

it('a message_delta chunk in stream mode carries stop_reason through as finish_reason', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(
      okStream(
        'data: ' +
          JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }) +
          '\n'
      )
    );
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: true,
    credentials: authCreds,
  });
  const text = await readAll(out.response.body);
  const frames = text.split('\n\n').filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'));
  const last = JSON.parse(frames[frames.length - 1].slice(6));
  expect(last.choices[0].finish_reason).toBe('max_tokens');
});

it('a message_delta chunk with no stop_reason defaults finish_reason to "stop"', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(
      okStream('data: ' + JSON.stringify({ type: 'message_delta', delta: {} }) + '\n')
    );
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: true,
    credentials: authCreds,
  });
  const text = await readAll(out.response.body);
  const frames = text.split('\n\n').filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'));
  const last = JSON.parse(frames[frames.length - 1].slice(6));
  expect(last.choices[0].finish_reason).toBe('stop');
});

it('buildSSEStream emits an [Error: ...] content chunk plus [DONE] when the upstream body throws mid-read', async () => {
  const throwing = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta"'));
    },
    pull() {
      throw new Error('upstream died');
    },
  });
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(new Response(throwing, { status: 200 }));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: true,
    credentials: authCreds,
  });
  const text = await readAll(out.response.body);
  expect(text).toContain('[Error: upstream died]');
  expect(text).toContain('[DONE]');
});

it('a thrown error with no statusCode maps to 502 with upstream_error type', async () => {
  fetchMock.mockRejectedValueOnce(new Error('network down'));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  expect(out.response.status).toBe(502);
  const err = JSON.parse(await out.response.text());
  expect(err.error.type).toBe('upstream_error');
  expect(err.error.code).toBe('HTTP_502');
});

describe('validateCookies session-expired branch', () => {
  it('an ok response with success:false returns "session expired", not a thrown error', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 200 }));
    const r = await validateCookies(AUTH_COOKIES);
    expect(r).toEqual({ valid: false, error: 'session expired' });
    globalFetch.mockRestore();
  });

  it('a thrown network error is caught and returned as the error field', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('dns fail'));
    const r = await validateCookies(AUTH_COOKIES);
    expect(r).toEqual({ valid: false, error: 'dns fail' });
    globalFetch.mockRestore();
  });
});
