// Kills StringLiteral/ObjectLiteral/ArithmeticOperator/ConditionalExpression
// survivors in zenmux-free.js not covered by the executor or mutation suites:
// exact URL/UA constants, extractCtoken/zmGet (dead per current callers but
// exported indirectly via handleExecute's cookie flow), buildSSEStream error
// path, and validateCookies' catch branch. All network mocked.
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

it('chat request targets the exact anthropic messages path on zenmux.ai', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  expect(fetchMock.mock.calls[1][0]).toBe(
    'https://zenmux.ai/api/anthropic/v1/messages?ctoken=tok-123'
  );
  expect(out.url).toBe('https://zenmux.ai/api/anthropic/v1/messages');
});

it('addRound targets the frontend/chat/addRound path exactly', async () => {
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
  expect(fetchMock.mock.calls[0][0]).toBe(
    'https://zenmux.ai/api/frontend/chat/addRound?ctoken=tok-123'
  );
});

it('User-Agent header is a real Chrome UA string, not empty', async () => {
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
  expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toContain('Mozilla/5.0');
  expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toContain('Chrome/');
});

it('a falsy apiKey (no credentials) fails closed with ctoken-not-found, never an empty-string cookie header', async () => {
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [] },
    stream: false,
    credentials: {},
  });
  expect(out.response.status).toBe(502);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('a missing body.messages defaults to an empty list rather than throwing', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({ model: 'm', body: {}, stream: false, credentials: authCreds });
  expect(out.response.status).toBe(200);
});

it('claudeBody carries the pinned deepseek model id and default max_tokens 4096', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'client-facing',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  expect(out.transformedBody.model).toBe('deepseek/deepseek-v4-pro:streamlake');
  expect(out.transformedBody.max_tokens).toBe(4096);
});

it('does not send a temperature field when the request omits one', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  expect(out.transformedBody).not.toHaveProperty('temperature');
});

it('_collectText resolves to empty string when the response has no body at all', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    credentials: authCreds,
  });
  const json = JSON.parse(await out.response.text());
  expect(json.choices[0].message.content).toBe('');
});

it('buildSSEStream error path emits an [Error: ...] chunk and still terminates with [DONE]', async () => {
  const throwingBody = new ReadableStream({
    start(c) {
      c.error(new Error('boom'));
    },
  });
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(new Response(throwingBody, { status: 200 }));
  const ex = new ZenmuxFreeExecutor();
  const out = await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: true,
    credentials: authCreds,
  });
  const text = await readAll(out.response.body);
  expect(text).toContain('[Error: boom]');
  expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
});

describe('validateCookies error handling', () => {
  it('a thrown network error surfaces as valid:false with the error message', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network down'));
    const r = await validateCookies(AUTH_COOKIES);
    expect(r).toEqual({ valid: false, error: 'network down' });
    globalFetch.mockRestore();
  });
});

describe('ZenmuxFreeExecutor.execute error envelope defaults', () => {
  it('an error with no statusCode defaults to 502, not 200 or undefined', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom-no-status'));
    const ex = new ZenmuxFreeExecutor();
    const out = await ex.execute({
      model: 'm',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: authCreds,
    });
    expect(out.response.status).toBe(502);
    const err = JSON.parse(await out.response.text());
    expect(err.error.code).toBe('HTTP_502');
  });

  it('passes the original request body through as transformedBody on error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const ex = new ZenmuxFreeExecutor();
    const reqBody = { messages: [{ role: 'user', content: 'hi' }] };
    const out = await ex.execute({
      model: 'm',
      body: reqBody,
      stream: false,
      credentials: authCreds,
    });
    expect(out.transformedBody).toBe(reqBody);
  });
});
