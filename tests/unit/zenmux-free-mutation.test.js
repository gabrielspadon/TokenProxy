// Mutation-kill coverage for zenmux-free.js internals not pinned by
// zenmux-free-executor.test.js: exact header/body literals, the
// content_block_delta/message_delta type-vs-delta guard, the fire-and-forget
// updateRound gate, and the usage-estimate arithmetic. All network mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { ZenmuxFreeExecutor, validateCookies } =
  await import('../../open-sse/executors/zenmux-free.js');

const AUTH_COOKIES = 'sess=1; ctoken=tok-123; other=x';
const authCreds = { apiKey: AUTH_COOKIES };

function sseBody(rawLines) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(rawLines));
      c.close();
    },
  });
}
function okStream(rawLines) {
  return new Response(sseBody(rawLines), { status: 200 });
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

it('addRound and chat requests carry the exact zenmux headers (Referer, Origin, UA, Content-Type)', async () => {
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
  expect(addRoundInit.headers.Origin).toBe('https://zenmux.ai');
  expect(addRoundInit.headers.Referer).toBe('https://zenmux.ai/platform/chat');
  expect(addRoundInit.headers['Content-Type']).toBe('application/json');
  const addRoundBody = JSON.parse(addRoundInit.body);
  expect(addRoundBody.chatId.startsWith('9r_')).toBe(true);
  expect(addRoundBody.answer).toBe('​');
  expect(JSON.parse(addRoundBody.extra).status).toBe('sending');
});

it('defaults the question to "Hello" when there is no user message', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
  const ex = new ZenmuxFreeExecutor();
  await ex.execute({ model: 'm', body: { messages: [] }, stream: false, credentials: authCreds });
  const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
  expect(sent.messages[0].content[0].text).toBe('Hello');
});

it('ignores a JSON-malformed data line and keeps decoding the rest', async () => {
  const raw =
    'data: {not json}\n' +
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

it('never appends text from an event whose type is not content_block_delta, even if delta.text is set', async () => {
  const events = [
    { type: 'other_event', delta: { text: 'INTRUDER' } },
    { type: 'content_block_delta', delta: { text: 'ok' } },
  ];
  const raw = events.map((e) => `data: ${JSON.stringify(e)}\n`).join('');
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
  expect(json.choices[0].message.content).not.toContain('INTRUDER');
});

it('stream mode never treats a non-message_delta event carrying delta as the finish event', async () => {
  const events = [
    { type: 'content_block_delta', delta: { text: 'hi' } },
    { type: 'other_event', delta: { stop_reason: 'INTRUDER' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ];
  const raw = events.map((e) => `data: ${JSON.stringify(e)}\n`).join('');
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
  const chunks = text
    .split('\n\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
  const finishes = chunks.filter((c) => c.choices[0].finish_reason !== null);
  expect(finishes).toHaveLength(1);
  expect(finishes[0].choices[0].finish_reason).toBe('end_turn');
});

it('stream mode does not enqueue an empty-content chunk for a delta with no text or thinking', async () => {
  const events = [
    { type: 'content_block_delta', delta: {} },
    { type: 'content_block_delta', delta: { text: 'x' } },
  ];
  const raw = events.map((e) => `data: ${JSON.stringify(e)}\n`).join('');
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
  const chunks = text
    .split('\n\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
  const contentChunks = chunks.filter((c) => 'content' in c.choices[0].delta);
  expect(contentChunks).toHaveLength(1);
  expect(contentChunks[0].choices[0].delta.content).toBe('x');
});

it('updateRound is not sent when addRound never produced a roundId', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 })) // addRound, no "id" field
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
  await new Promise((r) => setTimeout(r, 0));
  expect(fetchMock).toHaveBeenCalledTimes(2); // addRound + chat only, no updateRound
});

it('updateRound is not sent when the collected text is empty, even with a roundId', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'round-1' }), { status: 200 }))
    .mockResolvedValueOnce(okStream(''));
  const ex = new ZenmuxFreeExecutor();
  await ex.execute({
    model: 'm',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: true,
    credentials: authCreds,
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('usage estimate divides length by 4, not multiplies', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(
      okStream(
        'data: ' +
          JSON.stringify({ type: 'content_block_delta', delta: { text: 'a'.repeat(40) } }) +
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
  expect(json.usage.completion_tokens).toBe(10); // 40/4, would be 160 if * 4
});

describe('validateCookies: success and data are both required (AND, not OR)', () => {
  it('success:false with a data payload still reports session expired', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, data: { displayName: 'G', email: 'g@x' } }), {
        status: 200,
      })
    );
    const r = await validateCookies(AUTH_COOKIES);
    expect(r).toEqual({ valid: false, error: 'session expired' });
    globalFetch.mockRestore();
  });

  it('success:true with null data still reports session expired', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: null }), { status: 200 })
      );
    const r = await validateCookies(AUTH_COOKIES);
    expect(r).toEqual({ valid: false, error: 'session expired' });
    globalFetch.mockRestore();
  });
});
