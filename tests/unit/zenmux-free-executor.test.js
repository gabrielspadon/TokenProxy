// ZenmuxFreeExecutor: cookie auth, three-step frontend flow, SSE re-encoding,
// and the fail-closed error envelope. All network scripted through proxyFetch.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { ZenmuxFreeExecutor, validateCookies } =
  await import('../../open-sse/executors/zenmux-free.js');

const COOKIES = 'sess=1; ctoken=tok-123; other=x';

function sseBody(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n`).join('');
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

function okStream(events) {
  return new Response(sseBody(events), { status: 200 });
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

const CLAUDE_EVENTS = [
  { type: 'content_block_delta', delta: { text: 'Hel' } },
  { type: 'content_block_delta', delta: { text: 'lo' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
];

beforeEach(() => fetchMock.mockReset());

describe('ZenmuxFreeExecutor.execute — request construction', () => {
  it('sends the cookie and ctoken to zenmux.ai only, with the pinned upstream model', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'round-1' }), { status: 200 })) // addRound
      .mockResolvedValueOnce(okStream(CLAUDE_EVENTS)); // anthropic

    const ex = new ZenmuxFreeExecutor();
    const out = await ex.execute({
      model: 'zenmux-model',
      body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, temperature: 0.5 },
      stream: false,
      credentials: { apiKey: COOKIES },
    });

    // Every call this executor made stays on zenmux.ai — the cookie must not
    // reach any other host.
    for (const [url, init] of fetchMock.mock.calls) {
      expect(new URL(url).hostname).toBe('zenmux.ai');
      expect(init.headers.Cookie).toBe(COOKIES);
    }
    const [addRoundUrl] = fetchMock.mock.calls[0];
    expect(new URL(addRoundUrl).searchParams.get('ctoken')).toBe('tok-123');

    const [chatUrl, chatInit] = fetchMock.mock.calls[1];
    expect(chatUrl).toContain('/api/anthropic/v1/messages');
    expect(new URL(chatUrl).searchParams.get('ctoken')).toBe('tok-123');
    const sent = JSON.parse(chatInit.body);
    expect(sent.model).toBe('deepseek/deepseek-v4-pro:streamlake');
    expect(sent.max_tokens).toBe(32);
    expect(sent.temperature).toBe(0.5);
    expect(sent.stream).toBe(true);
    expect(chatInit.headers['anthropic-version']).toBe('2023-06-01');

    expect(out.response.status).toBe(200);
  });

  it('system message is prepended to the question', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 500 })) // addRound fails, tolerated
      .mockResolvedValueOnce(okStream(CLAUDE_EVENTS));

    const ex = new ZenmuxFreeExecutor();
    await ex.execute({
      model: 'm',
      body: {
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hi' },
        ],
      },
      stream: false,
      credentials: { apiKey: COOKIES },
    });
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(sent.messages[0].content[0].text).toBe('be terse\n\nhi');
  });

  it('fails closed without a ctoken: 502 error envelope, no network call', async () => {
    const ex = new ZenmuxFreeExecutor();
    const out = await ex.execute({
      model: 'm',
      body: { messages: [] },
      stream: false,
      credentials: { apiKey: 'no-token-here' },
    });
    expect(out.response.status).toBe(502);
    const err = JSON.parse(await out.response.text());
    expect(err.error.message).toContain('ctoken not found');
    expect(err.error.type).toBe('upstream_error');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ZenmuxFreeExecutor.execute — upstream error mapping', () => {
  async function statusOf(upstreamStatus) {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // addRound (no id → no updateRound)
      .mockResolvedValueOnce(new Response('denied', { status: upstreamStatus }));
    const ex = new ZenmuxFreeExecutor();
    const out = await ex.execute({
      model: 'm',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: { apiKey: COOKIES },
    });
    return { status: out.response.status, body: JSON.parse(await out.response.text()) };
  }

  it('401/403 → 401 cookies-expired envelope (triggers credential invalidation, not retry-forever)', async () => {
    const a = await statusOf(401);
    expect(a.status).toBe(401);
    expect(a.body.error.message).toContain('cookies expired');
    const b = await statusOf(403);
    expect(b.status).toBe(401);
  });

  it('402 → quota exhausted with status preserved', async () => {
    const r = await statusOf(402);
    expect(r.status).toBe(402);
    expect(r.body.error.message).toContain('quota exhausted');
  });

  it('other non-2xx → same status propagated, never a silent 200', async () => {
    const r = await statusOf(503);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('HTTP_503');
  });
});

describe('ZenmuxFreeExecutor.execute — stream vs non-stream branches', () => {
  it('stream:true re-encodes Claude deltas as OpenAI chunks ending in [DONE]', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(okStream(CLAUDE_EVENTS));
    const ex = new ZenmuxFreeExecutor();
    const out = await ex.execute({
      model: 'client-model',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: true,
      credentials: { apiKey: COOKIES },
    });
    expect(out.response.headers.get('content-type')).toContain('text/event-stream');
    const text = await readAll(out.response.body);
    const chunks = text
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(6)));
    const content = chunks.map((c) => c.choices[0].delta.content || '').join('');
    expect(content).toBe('Hello');
    // Client-facing model name is the requested one, not the pinned upstream id.
    expect(chunks.every((c) => c.model === 'client-model')).toBe(true);
    expect(chunks.at(-1).choices[0].finish_reason).toBe('end_turn');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('stream:false collects text into a chat.completion JSON with a usage block', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(okStream(CLAUDE_EVENTS));
    const ex = new ZenmuxFreeExecutor();
    const out = await ex.execute({
      model: 'client-model',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: { apiKey: COOKIES },
    });
    const json = JSON.parse(await out.response.text());
    expect(json.object).toBe('chat.completion');
    expect(json.model).toBe('client-model');
    expect(json.choices[0].message.content).toBe('Hello');
    const c = Math.ceil('Hello'.length / 4);
    expect(json.usage.completion_tokens).toBe(c);
    expect(json.usage.prompt_tokens).toBeGreaterThan(0);
    expect(json.usage.total_tokens).toBe(json.usage.prompt_tokens + c);
  });
});

describe('validateCookies', () => {
  it('no ctoken → invalid without a network call', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const r = await validateCookies('nope=1');
    expect(r).toEqual({ valid: false, error: 'no ctoken' });
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('HTTP error and expired session both report invalid; success carries user identity', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { displayName: 'G', email: 'g@x' } }), {
          status: 200,
        })
      );
    expect(await validateCookies(COOKIES)).toEqual({ valid: false, error: 'HTTP 401' });
    expect(await validateCookies(COOKIES)).toEqual({ valid: false, error: 'session expired' });
    expect(await validateCookies(COOKIES)).toEqual({ valid: true, user: 'G', email: 'g@x' });
    globalFetch.mockRestore();
  });
});
