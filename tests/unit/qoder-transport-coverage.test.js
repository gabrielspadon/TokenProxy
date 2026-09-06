// Qoder executor transport coverage: guard-path 401s (missing userId /
// accessToken, PAT exchange failure), model-config refresh retry chain,
// content normalization (images, claude blocks, mixed text), SSE envelope
// unwrapping (error status, inner [DONE], billing peek), and pass-through of
// upstream failures. Zero real network: proxyAwareFetch and qoderModels are
// mocked (pattern: qoder-connect-timeout.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getQoderModelConfig: vi.fn(),
  resolveQoderModels: vi.fn(),
  isQoderPat: vi.fn(() => false),
  resolveQoderCredentials: vi.fn(),
}));

vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => mocks.fetch(...args),
}));
vi.mock('../../open-sse/services/qoderModels.js', () => ({
  getQoderModelConfig: (...args) => mocks.getQoderModelConfig(...args),
  resolveQoderModels: (...args) => mocks.resolveQoderModels(...args),
  isQoderPat: (...args) => mocks.isQoderPat(...args),
  resolveQoderCredentials: (...args) => mocks.resolveQoderCredentials(...args),
}));

const { QoderExecutor, __test__ } = await import('../../open-sse/executors/qoder.js');
const { QODER_CHAT_BASE_ALT, QODER_CHAT_URL_ENCODED } =
  await import('../../open-sse/shared/qoder/constants.js');

const creds = {
  accessToken: 'dt-test',
  providerSpecificData: { userId: 'user-1', machineId: 'machine-1' },
};
const baseBody = { messages: [{ role: 'user', content: 'hi' }] };

function sseUpstream(lines, { keepOpen = false } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      if (!keepOpen) controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}
const envelope = (body, statusCodeValue = 200) =>
  `data: ${JSON.stringify({ statusCodeValue, body })}\n\n`;

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.getQoderModelConfig.mockReset();
  mocks.resolveQoderModels.mockReset();
  mocks.isQoderPat.mockReset().mockReturnValue(false);
  mocks.resolveQoderCredentials.mockReset();
  mocks.getQoderModelConfig.mockResolvedValue({
    key: 'auto',
    source: 'system',
    display_name: 'Resolved-X',
  });
});

describe('buildUrl', () => {
  it('routes jt- tokens to the alternate base and others to the encoded URL', () => {
    const executor = new QoderExecutor();
    expect(executor.buildUrl({ accessToken: 'jt-abc' })).toContain(QODER_CHAT_BASE_ALT);
    expect(executor.buildUrl({ accessToken: 'dt-abc' })).toBe(QODER_CHAT_URL_ENCODED);
    expect(executor.buildUrl({ apiKey: 'jt-key' })).toContain(QODER_CHAT_BASE_ALT);
  });
});

describe('execute guard paths', () => {
  it('returns 401 when userId is missing', async () => {
    const { response } = await new QoderExecutor().execute({
      model: 'auto',
      body: baseBody,
      stream: true,
      credentials: { accessToken: 'dt-x', providerSpecificData: {} },
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toContain('userId');
  });

  it('returns 401 when accessToken is missing', async () => {
    const { response } = await new QoderExecutor().execute({
      model: 'auto',
      body: baseBody,
      stream: true,
      credentials: { providerSpecificData: { userId: 'u' } },
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toContain('accessToken');
  });

  it('returns 401 when PAT exchange fails', async () => {
    mocks.isQoderPat.mockReturnValue(true);
    mocks.resolveQoderCredentials.mockRejectedValue(new Error('exchange denied'));
    const { response } = await new QoderExecutor().execute({
      model: 'auto',
      body: baseBody,
      stream: true,
      credentials: { accessToken: 'pt-x', providerSpecificData: { userId: 'u' } },
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toContain('exchange denied');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 when model config resolution fails entirely', async () => {
    mocks.getQoderModelConfig.mockResolvedValue(null);
    mocks.resolveQoderModels.mockResolvedValue({ rawConfigs: new Map() });
    const { response } = await new QoderExecutor().execute({
      model: 'qoder/unknown-model',
      body: baseBody,
      stream: true,
      credentials: creds,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('unknown-model');
    expect(mocks.resolveQoderModels).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ forceRefresh: true })
    );
  });

  it('recovers via forced refresh when the cache is cold', async () => {
    mocks.getQoderModelConfig.mockResolvedValue(null);
    mocks.resolveQoderModels.mockResolvedValue({
      rawConfigs: new Map([
        ['late', { source: 'system', is_reasoning: true, max_output_tokens: 100 }],
      ]),
    });
    mocks.fetch.mockResolvedValue(sseUpstream(['data: [DONE]\n\n']));
    const { response, transformedBody } = await new QoderExecutor().execute({
      model: 'qoder/late',
      body: baseBody,
      stream: true,
      credentials: creds,
    });
    expect(response.status).toBe(200);
    expect(transformedBody.model_config.key).toBe('late');
    expect(transformedBody.parameters.max_tokens).toBe(100);
  });

  it('passes a non-ok upstream response through unchanged', async () => {
    const upstream = new Response('denied', { status: 403 });
    mocks.fetch.mockResolvedValue(upstream);
    const { response } = await new QoderExecutor().execute({
      model: 'auto',
      body: baseBody,
      stream: true,
      credentials: creds,
    });
    expect(response).toBe(upstream);
  });
});

describe('buildQoderRequestBody normalization', () => {
  const build = (body) =>
    __test__.buildQoderRequestBody({
      model: 'qoder/auto',
      body,
      credentials: creds,
    });

  it('hoists system text, flattens text arrays, caps max_tokens by request', async () => {
    const { payload } = await build({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'system', content: [{ type: 'text', text: 'and kind' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
      max_tokens: 5,
      max_completion_tokens: 3,
    });
    expect(payload.system).toBe('be brief\n\nand kind');
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].content).toBe('a\nb');
    expect(payload.parameters.max_tokens).toBe(3);
    expect(payload.chat_context.text).toBe('a\nb');
  });

  it('preserves openai image blocks and converts claude image sources', async () => {
    const { payload } = await build({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'https://img.example/x.png' } },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'image', source: { type: 'url', url: 'https://img.example/y.png' } },
            { type: 'text', text: 'after' },
          ],
        },
      ],
      tools: [{ type: 'function', function: { name: 't' } }],
    });
    const content = payload.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: 'look' });
    const urls = content.filter((b) => b.type === 'image_url').map((b) => b.image_url.url);
    expect(urls[0]).toBe('https://img.example/x.png');
    expect(urls[1]).toMatch(/^data:image\/png;base64,/);
    expect(urls[2]).toBe('https://img.example/y.png');
    expect(content.at(-1)).toEqual({ type: 'text', text: 'after' });
  });

  it('derives stable, distinct record ids from content, tools and budget', async () => {
    const a = await build({ messages: [{ role: 'user', content: 'same' }] });
    const b = await build({ messages: [{ role: 'user', content: 'same' }] });
    const c = await build({ messages: [{ role: 'user', content: 'different' }] });
    expect(a.payload.chat_record_id).toBe(b.payload.chat_record_id);
    expect(a.payload.chat_record_id).not.toBe(c.payload.chat_record_id);
    expect(a.payload.session_id).toBe(b.payload.session_id);
  });

  it('handles non-string non-array content and skips null messages', async () => {
    const { payload } = await build({
      messages: [null, { role: 'user', content: 42 }, { role: 'user', content: null }],
    });
    expect(payload.messages[0].content).toBe('42');
    expect(payload.messages[1].content).toBe('');
  });
});

describe('normalizeMessages edges', () => {
  it('returns empty shape for a non-array input', () => {
    expect(__test__.normalizeMessages(undefined)).toEqual({ messages: [], systemText: '' });
  });
});

describe('isBillingBlock', () => {
  it('classifies quota / throttle / pricingUrl signatures and rejects the rest', () => {
    expect(__test__.isBillingBlock('{"code":"112","msg":"quota"}')).toBe(true);
    expect(__test__.isBillingBlock('{"code":"10605"}')).toBe(true);
    expect(__test__.isBillingBlock('{"pricingUrl":"https://x"}')).toBe(true);
    expect(__test__.isBillingBlock('{"code":"500"}')).toBe(false);
    expect(__test__.isBillingBlock(null)).toBe(false);
    expect(__test__.isBillingBlock(42)).toBe(false);
  });
});

describe('annotateResolvedModel', () => {
  it('adds x_resolved_model once and leaves non-JSON and arrays alone', () => {
    const chunk = JSON.stringify({ id: 'x' });
    const once = __test__.annotateResolvedModel(chunk, 'M');
    expect(JSON.parse(once).x_resolved_model).toBe('M');
    expect(__test__.annotateResolvedModel(once, 'N')).toBe(once);
    expect(__test__.annotateResolvedModel('not json', 'M')).toBe('not json');
    expect(__test__.annotateResolvedModel('[1]', 'M')).toBe('[1]');
    expect(__test__.annotateResolvedModel(chunk, null)).toBe(chunk);
  });
});

describe('wrapQoderSSE', () => {
  it('returns the response untouched when not ok or bodyless', async () => {
    const bad = new Response('x', { status: 500 });
    expect(await __test__.wrapQoderSSE(bad, 'm')).toBe(bad);
  });

  it('returns 403 on a billing-block first frame', async () => {
    const upstream = sseUpstream([envelope('{"code":"112","pricingUrl":"x"}', 429)], {
      keepOpen: true,
    });
    const wrapped = await __test__.wrapQoderSSE(upstream, 'm');
    expect(wrapped.status).toBe(403);
    const json = await wrapped.json();
    expect(json.error.code).toBe(429);
  });

  it('unwraps envelopes, annotates resolved model, terminates on [DONE]', async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: 'hey' } }] });
    const upstream = sseUpstream([envelope(inner), 'data: [DONE]\n\n', envelope(inner)], {
      keepOpen: true,
    });
    const wrapped = await __test__.wrapQoderSSE(upstream, 'm', 'Resolved-X');
    const text = await wrapped.text();
    const events = text.split('\n\n').filter((l) => l.startsWith('data: '));
    expect(events).toHaveLength(2); // one chunk + [DONE]; post-DONE frame dropped
    expect(JSON.parse(events[0].slice(6)).x_resolved_model).toBe('Resolved-X');
    expect(events[1]).toContain('[DONE]');
  });

  it('converts a non-200 envelope after content into an error chunk + [DONE]', async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: 'ok' } }] });
    const upstream = sseUpstream([envelope(inner), envelope('boom detail', 500)], {
      keepOpen: true,
    });
    const wrapped = await __test__.wrapQoderSSE(upstream, 'm');
    const text = await wrapped.text();
    expect(text).toContain('qoder error 500');
    expect(text).toContain('boom detail');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('honors an inner [DONE] body and strips embedded newlines from chunks', async () => {
    const multiline = '{"choices":[{"delta":{"content":"a"}}]}';
    const wrapped = await __test__.wrapQoderSSE(
      sseUpstream(
        [
          `data: ${JSON.stringify({ statusCodeValue: 200, body: multiline.slice(0, 10) + '\n' + multiline.slice(10) })}\n\n`,
          envelope('[DONE]'),
        ],
        { keepOpen: true }
      ),
      'm'
    );
    const text = await wrapped.text();
    const dataLines = text.split('\n\n').filter((l) => l.startsWith('data: '));
    expect(dataLines[0]).toBe(`data: ${multiline}`);
    expect(dataLines.at(-1)).toContain('[DONE]');
  });

  it('emits [DONE] when the upstream closes without a terminal frame', async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: 'tail' } }] });
    // no trailing newline on last frame: exercises the partial-line flush
    const wrapped = await __test__.wrapQoderSSE(sseUpstream([envelope(inner).slice(0, -1)]), 'm');
    const text = await wrapped.text();
    expect(text).toContain('tail');
    expect(text).toContain('[DONE]');
  });

  it('skips unparseable and non-data lines without dying', async () => {
    // Upstream must close: peekFirstQoderFrame only ever re-inspects the first
    // buffered line, so a leading comment line stalls the peek on an open socket.
    const wrapped = await __test__.wrapQoderSSE(
      sseUpstream([': comment\n', 'data: not-json\n\n', 'data: [DONE]\n\n']),
      'm'
    );
    const text = await wrapped.text();
    expect(text.trim()).toBe('data: [DONE]');
  });
});

describe('needsRefresh / refreshCredentials', () => {
  it('never refreshes', async () => {
    const executor = new QoderExecutor();
    expect(executor.needsRefresh()).toBe(false);
    expect(await executor.refreshCredentials()).toBeNull();
  });
});
