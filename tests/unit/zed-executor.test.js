// ZedExecutor: provider normalization, /completions payload envelope, NDJSON
// stream translation, non-2xx pass-through, and parseError shapes.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const zedLlmFetchMock = vi.fn();
const resolveZedModelsMock = vi.fn();
vi.mock('../../open-sse/shared/zedAuth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    zedLlmFetch: (...args) => zedLlmFetchMock(...args),
    resolveZedModels: (...args) => resolveZedModelsMock(...args),
  };
});
// Belt and braces: nothing in this file may hit the network.
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: vi.fn(async () => {
    throw new Error('unexpected network call');
  }),
}));

const ZedExecutor = (await import('../../open-sse/executors/zed.js')).default;

function ndjsonResponse(lines, status = 200) {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(lines.join('\n') + '\n'));
      c.close();
    },
  });
  return new Response(body, { status });
}

async function readSseChunks(response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .filter((l) => l !== '[DONE]')
    .map((l) => JSON.parse(l));
}

function catalog(entries) {
  return { rawById: new Map(Object.entries(entries)) };
}

beforeEach(() => {
  zedLlmFetchMock.mockReset();
  resolveZedModelsMock.mockReset();
});

describe('ZedExecutor.resolveModel — provider selection', () => {
  it('uses the catalog provider when present', async () => {
    resolveZedModelsMock.mockResolvedValue(catalog({ 'some-model': { provider: 'google' } }));
    const ex = new ZedExecutor();
    const { provider } = await ex.resolveModel('some-model', {}, null, null);
    expect(provider).toBe('Google');
  });

  it('re-resolves with forceRefresh when the model is missing, then infers from the name', async () => {
    resolveZedModelsMock.mockResolvedValue(catalog({}));
    const ex = new ZedExecutor();
    const { provider } = await ex.resolveModel('claude-sonnet-4.6', {}, null, null);
    expect(resolveZedModelsMock).toHaveBeenCalledTimes(2);
    expect(resolveZedModelsMock.mock.calls[1][1]).toMatchObject({ forceRefresh: true });
    expect(provider).toBe('Anthropic');
  });

  it('catalog failure degrades to name inference (grok→XAi, gemini→Google, else OpenAi)', async () => {
    resolveZedModelsMock.mockRejectedValue(new Error('catalog down'));
    const ex = new ZedExecutor();
    expect((await ex.resolveModel('grok-4', {}, null, null)).provider).toBe('XAi');
    expect((await ex.resolveModel('gemini-3-pro', {}, null, null)).provider).toBe('Google');
    expect((await ex.resolveModel('gpt-5.5', {}, null, null)).provider).toBe('OpenAi');
  });
});

describe('ZedExecutor.execute — payload envelope', () => {
  it('wraps the provider request in the Zed thread envelope and posts to /completions', async () => {
    resolveZedModelsMock.mockResolvedValue(catalog({ 'grok-4': { provider: 'xai' } }));
    zedLlmFetchMock.mockResolvedValue(ndjsonResponse(['[DONE]']));
    const ex = new ZedExecutor();
    const out = await ex.execute({
      model: 'grok-4',
      body: { messages: [{ role: 'user', content: 'hi' }], thread_id: 't-1', prompt_id: 'p-1' },
      stream: true,
      credentials: { accessToken: 'zt' },
    });

    const [creds, path, opts] = zedLlmFetchMock.mock.calls[0];
    expect(path).toBe('/completions');
    expect(creds).toMatchObject({ accessToken: 'zt' });
    const payload = JSON.parse(opts.fetchOptions.body);
    expect(payload).toMatchObject({
      thread_id: 't-1',
      prompt_id: 'p-1',
      provider: 'XAi',
      model: 'grok-4',
    });
    // xAI is OpenAI-shaped: request forwarded with stream forced on.
    expect(payload.provider_request).toMatchObject({ model: 'grok-4', stream: true });
    // Status-capable client headers announced.
    expect(opts.fetchOptions.headers['x-zed-client-supports-status-messages']).toBe('true');
    expect(out.transformedBody).toEqual(payload);
    // Auth header never surfaced verbatim in the receipt.
    expect(out.headers.Authorization).toBe('Bearer <zed-llm-token>');
  });

  it('falls back to credentials._clientSessionId for thread_id', async () => {
    resolveZedModelsMock.mockResolvedValue(catalog({}));
    zedLlmFetchMock.mockResolvedValue(ndjsonResponse(['[DONE]']));
    const ex = new ZedExecutor();
    await ex.execute({
      model: 'gpt-5.5',
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: 'zt', _clientSessionId: 'sess-9' },
    });
    const payload = JSON.parse(zedLlmFetchMock.mock.calls[0][2].fetchOptions.body);
    expect(payload.thread_id).toBe('sess-9');
  });
});

describe('ZedExecutor.execute — stream translation', () => {
  it('translates xAI (OpenAI-shaped) event lines into an SSE stream ending in [DONE]', async () => {
    resolveZedModelsMock.mockResolvedValue(catalog({ 'grok-4': { provider: 'xai' } }));
    const chunk = (content) => ({
      event: {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'grok-4',
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      },
    });
    zedLlmFetchMock.mockResolvedValue(
      ndjsonResponse([
        JSON.stringify(chunk('Hel')),
        JSON.stringify(chunk('lo')),
        JSON.stringify({ status: 'stream_ended' }),
      ])
    );
    const ex = new ZedExecutor();
    const out = await ex.execute({
      model: 'grok-4',
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: 'zt' },
    });
    expect(out.response.headers.get('content-type')).toBe('text/event-stream');
    const raw = await out.response.clone().text();
    const chunks = await readSseChunks(out.response);
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('');
    expect(content).toBe('Hello');
    expect(raw).toContain('data: [DONE]');
  });

  it('a failed status frame becomes a visible error chunk, then the stream finishes', async () => {
    resolveZedModelsMock.mockResolvedValue(catalog({ 'grok-4': { provider: 'xai' } }));
    zedLlmFetchMock.mockResolvedValue(
      ndjsonResponse([JSON.stringify({ status: { failed: { message: 'over quota' } } })])
    );
    const ex = new ZedExecutor();
    const out = await ex.execute({
      model: 'grok-4',
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: 'zt' },
    });
    const chunks = await readSseChunks(out.response);
    const errChunk = chunks.find((c) => c.choices?.[0]?.delta?.content?.includes('[Zed error]'));
    expect(errChunk).toBeDefined();
    expect(errChunk.choices[0].delta.content).toContain('over quota');
    expect(errChunk.choices[0].finish_reason).toBe('stop');
  });

  it('a non-2xx upstream response is returned as-is: status and body reach the caller', async () => {
    resolveZedModelsMock.mockResolvedValue(catalog({}));
    zedLlmFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'trial_blocked', message: 'no' }), { status: 403 })
    );
    const ex = new ZedExecutor();
    const out = await ex.execute({
      model: 'gpt-5.5',
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: 'zt' },
    });
    expect(out.response.status).toBe(403);
    expect(await out.response.text()).toContain('trial_blocked');
  });
});

describe('ZedExecutor.parseError', () => {
  const ex = new ZedExecutor();

  it('trial_blocked gets the explanatory message with the upstream text embedded', () => {
    const out = ex.parseError(
      { status: 403, statusText: 'Forbidden' },
      JSON.stringify({ code: 'trial_blocked', message: 'billing off' })
    );
    expect(out.status).toBe(403);
    expect(out.message).toContain('trial access is blocked');
    expect(out.message).toContain('billing off');
  });

  it('other codes are prefixed Zed <code>, plain bodies pass through, status preserved', () => {
    expect(
      ex.parseError(
        { status: 429, statusText: '' },
        JSON.stringify({ code: 'rate_limited', message: 'slow down' })
      ).message
    ).toBe('Zed rate_limited: slow down');
    expect(ex.parseError({ status: 500, statusText: 'ISE' }, 'plain text error')).toMatchObject({
      status: 500,
      message: 'plain text error',
    });
  });
});

describe('ZedExecutor credential lifecycle', () => {
  it('never claims a refresh path (long-lived token, must fail closed instead of looping refresh)', async () => {
    const ex = new ZedExecutor();
    expect(ex.needsRefresh({})).toBe(false);
    expect(await ex.refreshCredentials()).toBeNull();
  });
});
