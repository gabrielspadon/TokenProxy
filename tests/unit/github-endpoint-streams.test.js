// GithubExecutor stream + refresh coverage complementary to
// github-executor-transport / github-responses-routing / github-prefill-sanitize:
// the /v1/messages Claude shim and /responses transform streams (SSE line
// translation, tail-buffer flush, [DONE] forwarding, non-OK and bodyless
// pass-through, deadline classification on fetch failure), the chat-completions
// content-part sanitizer's serialization branches, the copilot/GitHub token
// refresh chain, and needsRefresh expiry parsing (seconds vs ISO). All network
// through the mocked proxyAwareFetch; endpoint expectations come from the
// executor's own config object, not literals.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { GithubExecutor } = await import('../../open-sse/executors/github.js');
const { OAUTH_ENDPOINTS } = await import('../../open-sse/config/appConstants.js');
const { SSE_DONE } = await import('../../open-sse/utils/sseConstants.js');

const sse = (events) =>
  new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });

const ok = (events) => new Response(sse(events), { status: 200 });

beforeEach(() => fetchMock.mockReset());

describe('GithubExecutor.sanitizeMessagesForChatCompletions — content part branches', () => {
  const ex = new GithubExecutor();

  it('returns the body untouched when there are no messages', () => {
    const body = { model: 'm' };
    expect(ex.sanitizeMessagesForChatCompletions(body)).toBe(body);
  });

  it('keeps text/image_url parts, serializes tool parts to text, drops empty ones', () => {
    const out = ex.sanitizeMessagesForChatCompletions({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'keep' },
            { type: 'image_url', image_url: { url: 'u' } },
            { type: 'tool_result', content: 'tool says' },
            { type: 'thinking', thinking: { deep: true } },
            { type: 'text', text: '' },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
    });
    const parts = out.messages[0].content;
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text', 'text']);
    expect(parts[2].text).toBe('tool says');
    // Non-string payloads are JSON-serialized, never dropped silently.
    expect(parts[3].text).toContain('thinking');
  });

  it('nulls content when every part is stripped, and leaves null-content tool_call messages alone', () => {
    const toolCallMsg = { role: 'assistant', content: null, tool_calls: [{ id: 't' }] };
    const out = ex.sanitizeMessagesForChatCompletions({
      messages: [
        { role: 'user', content: [{ type: 'text', text: '' }] },
        toolCallMsg,
        { role: 'user', content: 'end' },
      ],
    });
    expect(out.messages[0].content).toBeNull();
    expect(out.messages[1]).toBe(toolCallMsg);
  });
});

describe('GithubExecutor — /v1/messages Claude shim', () => {
  const ex = new GithubExecutor();
  const creds = { copilotToken: 'cop' };
  const claudeModel = 'claude-test-model';

  const claudeEvents = [
    'data: {"type":"message_start","message":{"id":"m1","model":"x","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hola"}}\n',
    'data: {"type":"content_block_stop","index":0}\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n',
    // no trailing newline on the last event: exercises the flush() tail buffer
    'data: {"type":"message_stop"}',
  ];

  it('routes a claude-named model to messagesUrl and translates the Claude SSE to OpenAI chunks', async () => {
    fetchMock.mockResolvedValueOnce(ok(claudeEvents));
    const out = await ex.execute({
      model: claudeModel,
      body: { messages: [{ role: 'user', content: 'q' }] },
      stream: true,
      credentials: creds,
    });
    expect(out.url).toBe(ex.config.messagesUrl);
    expect(fetchMock.mock.calls[0][0]).toBe(ex.config.messagesUrl);
    // Internal tool-name bookkeeping must not reach the wire (strict schema 400s).
    expect(out.transformedBody._toolNameMap).toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)._toolNameMap).toBeUndefined();
    const text = await out.response.text();
    expect(text).toContain('hola');
    // Every emitted frame is OpenAI-shaped, not Claude-shaped.
    for (const line of text
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))) {
      expect(JSON.parse(line.slice(6)).object).toBe('chat.completion.chunk');
    }
  });

  it('forwards upstream [DONE] when the client asked to stream', async () => {
    fetchMock.mockResolvedValueOnce(ok(['data: {"type":"message_stop"}\n', 'data: [DONE]\n']));
    const out = await ex.execute({
      model: claudeModel,
      body: { messages: [{ role: 'user', content: 'q' }] },
      stream: true,
      credentials: creds,
    });
    expect((await out.response.text()).includes(SSE_DONE.trim())).toBe(true);
  });

  it('passes a non-OK response through untouched', async () => {
    const refusal = new Response('denied', { status: 403 });
    fetchMock.mockResolvedValueOnce(refusal);
    const out = await ex.execute({
      model: claudeModel,
      body: { messages: [{ role: 'user', content: 'q' }] },
      stream: true,
      credentials: creds,
    });
    expect(out.response).toBe(refusal);
    expect(out.url).toBe(ex.config.messagesUrl);
  });

  it('an OK response with no body yields an empty same-status Response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: null, headers: new Headers() });
    const out = await ex.execute({
      model: claudeModel,
      body: { messages: [{ role: 'user', content: 'q' }] },
      stream: true,
      credentials: creds,
    });
    expect(out.response.status).toBe(200);
    expect(await out.response.text()).toBe('');
  });

  it('a fetch failure is classified by the deadline and rethrown', async () => {
    fetchMock.mockRejectedValueOnce(new Error('conn reset'));
    await expect(
      ex.execute({
        model: claudeModel,
        body: { messages: [{ role: 'user', content: 'q' }] },
        stream: true,
        credentials: creds,
      })
    ).rejects.toThrow('conn reset');
  });
});

describe('GithubExecutor — /responses endpoint stream transform', () => {
  const creds = { copilotToken: 'cop' };
  const codexModel = 'gpt-codex-test';

  const freshEx = () => {
    const ex = new GithubExecutor();
    ex.knownCodexModels.add(codexModel);
    return ex;
  };

  it('converts Responses API deltas to OpenAI chunks and forwards [DONE]', async () => {
    const ex = freshEx();
    fetchMock.mockResolvedValueOnce(
      ok([
        'data: {"type":"response.output_text.delta","delta":"hey"}\n',
        'garbage line that is not SSE\n',
        'data: [DONE]\n',
        // tail without newline: flush path, a done frame there must NOT re-emit
        'data: [DONE]',
      ])
    );
    const out = await ex.execute({
      model: codexModel,
      body: { messages: [{ role: 'user', content: 'q' }] },
      stream: true,
      credentials: creds,
    });
    expect(out.url).toBe(ex.config.responsesUrl);
    const text = await out.response.text();
    expect(text).toContain('hey');
    expect(text).toContain(SSE_DONE.trim());
    for (const line of text
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))) {
      expect(JSON.parse(line.slice(6)).object).toBe('chat.completion.chunk');
    }
  });

  it('flushes an unterminated trailing data line as a converted chunk', async () => {
    const ex = freshEx();
    fetchMock.mockResolvedValueOnce(
      ok(['data: {"type":"response.output_text.delta","delta":"tail"}'])
    );
    const out = await ex.execute({
      model: codexModel,
      body: { messages: [{ role: 'user', content: 'q' }] },
      stream: true,
      credentials: creds,
    });
    expect(await out.response.text()).toContain('tail');
  });

  it('passes a non-OK response through and handles a bodyless OK', async () => {
    const ex = freshEx();
    const refusal = new Response('no', { status: 402 });
    fetchMock.mockResolvedValueOnce(refusal);
    const bad = await ex.execute({
      model: codexModel,
      body: { messages: [{ role: 'user', content: 'q' }] },
      stream: true,
      credentials: creds,
    });
    expect(bad.response).toBe(refusal);

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: null, headers: new Headers() });
    const empty = await ex.execute({
      model: codexModel,
      body: { messages: [{ role: 'user', content: 'q' }] },
      stream: true,
      credentials: creds,
    });
    expect(await empty.response.text()).toBe('');
  });

  it('a fetch failure on /responses is classified and rethrown', async () => {
    const ex = freshEx();
    fetchMock.mockRejectedValueOnce(new Error('dead upstream'));
    await expect(
      ex.execute({
        model: codexModel,
        body: { messages: [{ role: 'user', content: 'q' }] },
        stream: true,
        credentials: creds,
      })
    ).rejects.toThrow('dead upstream');
  });
});

describe('GithubExecutor — token refresh chain', () => {
  const ex = new GithubExecutor();

  it('refreshCopilotToken maps token/expires_at, nulls on non-OK with a log, nulls on throw', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'ct', expires_at: 999 }), { status: 200 })
    );
    expect(await ex.refreshCopilotToken('gh', null)).toEqual({ token: 'ct', expiresAt: 999 });

    const log = { error: vi.fn() };
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    expect(await ex.refreshCopilotToken('gh', log)).toBeNull();
    expect(log.error).toHaveBeenCalledWith('TOKEN', expect.stringContaining('401'));

    fetchMock.mockRejectedValueOnce(new Error('net'));
    expect(await ex.refreshCopilotToken('gh', log)).toBeNull();
  });

  it('refreshGitHubToken posts the form grant to the registry token endpoint and keeps the old refresh token when omitted', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'at', expires_in: 60 }), { status: 200 })
    );
    const out = await ex.refreshGitHubToken('old-rt', null);
    expect(out).toEqual({ accessToken: 'at', refreshToken: 'old-rt', expiresIn: 60 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OAUTH_ENDPOINTS.github.token);
    const sent = Object.fromEntries(init.body);
    expect(sent.grant_type).toBe('refresh_token');
    expect(sent.refresh_token).toBe('old-rt');
    expect(sent.client_id).toBe(ex.config.clientId);
    // client_secret rides along only when the registry declares one.
    expect('client_secret' in sent).toBe(Boolean(ex.config.clientSecret));

    fetchMock.mockResolvedValueOnce(new Response('no', { status: 400 }));
    expect(await ex.refreshGitHubToken('old-rt', null)).toBeNull();

    fetchMock.mockRejectedValueOnce(new Error('net'));
    const log = { error: vi.fn() };
    expect(await ex.refreshGitHubToken('old-rt', log)).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it('refreshCredentials falls back GitHub→Copilot when the direct Copilot refresh fails', async () => {
    // 1st call: copilot refresh with stale access token → 401
    fetchMock.mockResolvedValueOnce(new Response('expired', { status: 401 }));
    // 2nd: github oauth refresh → new tokens
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'gh2', refresh_token: 'rt2', expires_in: 5 }), {
        status: 200,
      })
    );
    // 3rd: copilot refresh with the new token → success
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'cop2', expires_at: '2099-01-01T00:00:00Z' }), {
        status: 200,
      })
    );
    const out = await ex.refreshCredentials({ accessToken: 'gh1', refreshToken: 'rt1' }, null);
    expect(out).toMatchObject({
      accessToken: 'gh2',
      refreshToken: 'rt2',
      copilotToken: 'cop2',
      copilotTokenExpiresAt: '2099-01-01T00:00:00Z',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns the bare GitHub tokens when the post-refresh Copilot exchange also fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('expired', { status: 401 }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'gh2', expires_in: 5 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(new Response('still no', { status: 403 }));
    const out = await ex.refreshCredentials({ accessToken: 'gh1', refreshToken: 'rt1' }, null);
    expect(out.accessToken).toBe('gh2');
    expect(out.copilotToken).toBeUndefined();
  });

  it('returns null when everything fails, and short-circuits on a direct Copilot success', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 401 }));
    expect(await ex.refreshCredentials({ accessToken: 'a', refreshToken: 'r' }, null)).toBeNull();

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'cop', expires_at: 1 }), { status: 200 })
    );
    const out = await ex.refreshCredentials({ accessToken: 'a', refreshToken: 'r' }, null);
    expect(out).toMatchObject({ accessToken: 'a', refreshToken: 'r', copilotToken: 'cop' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GithubExecutor.needsRefresh — expiry parsing', () => {
  const ex = new GithubExecutor();

  it('true without a copilotToken; true inside the 5-minute lead for seconds and ISO forms', () => {
    expect(ex.needsRefresh({})).toBe(true);
    const soonSec = Math.floor(Date.now() / 1000) + 60; // < 1e12 → seconds branch
    expect(ex.needsRefresh({ copilotToken: 'c', copilotTokenExpiresAt: soonSec })).toBe(true);
    const soonIso = new Date(Date.now() + 60_000).toISOString();
    expect(ex.needsRefresh({ copilotToken: 'c', copilotTokenExpiresAt: soonIso })).toBe(true);
  });

  it('falls through to the base check when the copilot token is comfortably fresh', () => {
    const farIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(ex.needsRefresh({ copilotToken: 'c', copilotTokenExpiresAt: farIso })).toBe(false);
  });
});
