/**
 * Unit tests for perplexity-web executor
 *
 * Covers:
 *  - Message parsing (system/user/assistant/developer, multi-part content)
 *  - Query building for first turn vs follow-up (session continuity)
 *  - Tools injection into instructions
 *  - Request body shape (dual query_str top-level + params.query_str is required by upstream)
 *  - Auth header construction (apiKey → Cookie, accessToken → Bearer)
 *  - Model mapping (normal + thinking)
 *  - Error handling (401, 429)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseOpenAIMessages,
  buildQuery,
  buildPplxRequestBody,
  formatToolsHint,
  PerplexityWebExecutor,
} from '../../open-sse/executors/perplexity-web.js';

const originalFetch = global.fetch;

function mockPplxStream(events) {
  const chunks = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new Blob([chunks]).stream(), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('parseOpenAIMessages', () => {
  it('extracts system + history + current msg', () => {
    const parsed = parseOpenAIMessages([
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ]);
    expect(parsed.systemMsg.trim()).toBe('Be helpful');
    expect(parsed.history).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
    ]);
    expect(parsed.currentMsg).toBe('Q2');
  });

  it('treats developer role as system', () => {
    const parsed = parseOpenAIMessages([
      { role: 'developer', content: 'Be concise' },
      { role: 'user', content: 'hi' },
    ]);
    expect(parsed.systemMsg.trim()).toBe('Be concise');
    expect(parsed.currentMsg).toBe('hi');
  });

  it('handles multi-part content (array of text blocks)', () => {
    const parsed = parseOpenAIMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'part1' },
          { type: 'text', text: 'part2' },
        ],
      },
    ]);
    expect(parsed.currentMsg).toBe('part1 part2');
  });

  it('skips empty content messages', () => {
    const parsed = parseOpenAIMessages([
      { role: 'user', content: '   ' },
      { role: 'user', content: 'real' },
    ]);
    expect(parsed.currentMsg).toBe('real');
  });
});

describe('buildQuery', () => {
  it('first turn: returns JSON with instructions + query', () => {
    const parsed = { systemMsg: 'Be helpful\n', history: [], currentMsg: 'Hello' };
    const q = buildQuery(parsed, null);
    const obj = JSON.parse(q);
    expect(obj.query).toBe('Hello');
    expect(obj.instructions).toContain('Be helpful');
    expect(obj.instructions.some((s) => s.includes('web search'))).toBe(true);
  });

  it('follow-up (with backendUuid): returns plain currentMsg, no JSON', () => {
    const parsed = {
      systemMsg: 'Be helpful',
      history: [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
      ],
      currentMsg: 'Follow up',
    };
    const q = buildQuery(parsed, 'uuid-abc-123');
    expect(q).toBe('Follow up');
  });

  it('includes history when present on first turn', () => {
    const parsed = {
      systemMsg: '',
      history: [{ role: 'user', content: 'earlier' }],
      currentMsg: 'now',
    };
    const obj = JSON.parse(buildQuery(parsed, null));
    expect(obj.history).toEqual([{ role: 'user', content: 'earlier' }]);
    expect(obj.query).toBe('now');
  });

  it('injects tools into instructions on first turn', () => {
    const parsed = { systemMsg: '', history: [], currentMsg: 'hi' };
    const tools = [
      { function: { name: 'Shell', description: 'Run bash' } },
      { function: { name: 'Read', description: 'Read file' } },
    ];
    const obj = JSON.parse(buildQuery(parsed, null, tools));
    const hint = obj.instructions.find((s) => s.includes('Available tools'));
    expect(hint).toBeDefined();
    expect(hint).toContain('- Shell: Run bash');
    expect(hint).toContain('- Read: Read file');
  });

  it('ignores tools on follow-up turn (uses session)', () => {
    const parsed = { systemMsg: '', history: [{ role: 'user', content: 'x' }], currentMsg: 'y' };
    const tools = [{ function: { name: 'Shell', description: 'd' } }];
    const q = buildQuery(parsed, 'uuid', tools);
    expect(q).toBe('y');
  });

  it('truncates query if JSON exceeds 96000 chars', () => {
    const big = 'x'.repeat(100000);
    const parsed = { systemMsg: big, history: [], currentMsg: 'hi' };
    const q = buildQuery(parsed, null);
    expect(q.length).toBeLessThanOrEqual(96000);
  });
});

describe('formatToolsHint', () => {
  it('returns empty string for no tools', () => {
    expect(formatToolsHint()).toBe('');
    expect(formatToolsHint([])).toBe('');
  });

  it('handles OpenAI tool schema (function wrapper)', () => {
    const out = formatToolsHint([{ function: { name: 'Foo', description: 'does foo' } }]);
    expect(out).toContain('- Foo: does foo');
  });

  it('handles flat tool schema', () => {
    const out = formatToolsHint([{ name: 'Bar', description: 'does bar' }]);
    expect(out).toContain('- Bar: does bar');
  });

  it('truncates long descriptions to first line, max 200 chars', () => {
    const longDesc = 'line1\nline2\nline3';
    const out = formatToolsHint([{ function: { name: 'X', description: longDesc } }]);
    expect(out).toContain('- X: line1');
    expect(out).not.toContain('line2');
  });
});

describe('buildPplxRequestBody', () => {
  it('sets query_str at both top-level AND params (required by upstream API)', () => {
    const body = buildPplxRequestBody('hello world', 'concise', 'pplx_pro', null);
    expect(body.query_str).toBe('hello world');
    expect(body.params.query_str).toBe('hello world');
  });

  it('includes required params', () => {
    const body = buildPplxRequestBody('q', 'copilot', 'claude46sonnet', 'uuid-xyz');
    expect(body.params.search_focus).toBe('internet');
    expect(body.params.mode).toBe('copilot');
    expect(body.params.model_preference).toBe('claude46sonnet');
    expect(body.params.sources).toEqual(['web']);
    expect(body.params.use_schematized_api).toBe(true);
    expect(body.params.is_incognito).toBe(true);
    expect(body.params.last_backend_uuid).toBe('uuid-xyz');
    expect(body.params.version).toBe('2.18');
  });
});

describe('PerplexityWebExecutor.execute', () => {
  let capturedUrl;
  let capturedOpts;
  let capturedBody;

  beforeEach(() => {
    capturedUrl = null;
    capturedOpts = null;
    capturedBody = null;
    global.fetch = vi.fn(async (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      capturedBody = JSON.parse(opts.body);
      return mockPplxStream([
        {
          blocks: [
            {
              intended_usage: 'markdown',
              markdown_block: { chunks: ['answer'], progress: 'DONE' },
            },
          ],
          status: 'COMPLETED',
          backend_uuid: 'resp-uuid-1',
        },
      ]);
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps pplx-auto → mode=concise, pref=pplx_pro', async () => {
    const exec = new PerplexityWebExecutor();
    await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }], stream: false },
      stream: false,
      credentials: { apiKey: 'cookie-abc' },
    });
    expect(capturedBody.params.mode).toBe('concise');
    expect(capturedBody.params.model_preference).toBe('pplx_pro');
  });

  it('applies THINKING_MAP when reasoning_effort is set', async () => {
    const exec = new PerplexityWebExecutor();
    await exec.execute({
      model: 'pplx-opus',
      body: {
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        reasoning_effort: 'high',
      },
      stream: false,
      credentials: { apiKey: 'cookie-abc' },
    });
    expect(capturedBody.params.mode).toBe('copilot');
    expect(capturedBody.params.model_preference).toBe('claude46opusthinking');
  });

  it('sends Cookie header when credentials.apiKey provided', async () => {
    const exec = new PerplexityWebExecutor();
    await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }], stream: false },
      stream: false,
      credentials: { apiKey: 'my-session-token' },
    });
    expect(capturedOpts.headers.Cookie).toBe('__Secure-next-auth.session-token=my-session-token');
    expect(capturedOpts.headers.Authorization).toBeUndefined();
  });

  it('sends Bearer header when credentials.accessToken provided', async () => {
    const exec = new PerplexityWebExecutor();
    await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }], stream: false },
      stream: false,
      credentials: { accessToken: 'tok-1' },
    });
    expect(capturedOpts.headers.Authorization).toBe('Bearer tok-1');
  });

  it('injects body.tools into query_str instructions', async () => {
    const exec = new PerplexityWebExecutor();
    await exec.execute({
      model: 'pplx-auto',
      body: {
        messages: [{ role: 'user', content: 'what tools do you have?' }],
        tools: [{ function: { name: 'Shell', description: 'Execute commands' } }],
        stream: false,
      },
      stream: false,
      credentials: { apiKey: 'c' },
    });
    const queryObj = JSON.parse(capturedBody.query_str);
    const toolsHint = queryObj.instructions.find((s) => s.includes('Available tools'));
    expect(toolsHint).toContain('- Shell: Execute commands');
  });

  it('returns 400 on missing messages', async () => {
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: {},
      stream: false,
      credentials: { apiKey: 'c' },
    });
    expect(response.status).toBe(400);
  });

  it('surfaces upstream 401 with friendly auth message', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'bad' }), { status: 401 })
    );
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: { apiKey: 'bad-cookie' },
    });
    expect(response.status).toBe(401);
    const j = await response.json();
    expect(j.error.message).toMatch(/auth failed|expired/i);
  });

  it('surfaces 429 with rate-limit message', async () => {
    global.fetch = vi.fn(async () => new Response('', { status: 429 }));
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: { apiKey: 'c' },
    });
    expect(response.status).toBe(429);
    const j = await response.json();
    expect(j.error.message).toMatch(/rate limited/i);
  });
});

// ── Added contracts: streaming path, thinking events, session continuity ─────

function rawPplxStream(text) {
  return new Response(new Blob([text]).stream(), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function readAllSse(response) {
  const reader = response.body.getReader();
  let acc = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
  }
  return acc;
}

describe('buildQuery — degenerate first turn', () => {
  it('empty history and empty current message still produce a query field', () => {
    const obj = JSON.parse(buildQuery({ systemMsg: '', history: [], currentMsg: '' }, null));
    expect(obj.query).toBe('');
  });
});

describe('PerplexityWebExecutor.execute — streaming', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('emits role chunk, content deltas, reasoning for search steps, finish and [DONE]', async () => {
    global.fetch = vi.fn(async () =>
      mockPplxStream([
        {
          backend_uuid: 'bk-1',
          blocks: [
            {
              intended_usage: 'pro_search_steps',
              plan_block: {
                steps: [
                  {
                    step_type: 'SEARCH_WEB',
                    search_web_content: { queries: [{ query: 'q1' }, { query: 'q1' }] },
                  },
                  {
                    step_type: 'READ_RESULTS',
                    read_results_content: { urls: ['https://a.example', 'https://a.example'] },
                  },
                ],
              },
            },
            { intended_usage: 'plan', plan_block: { goals: [{ description: 'goal-1' }] } },
          ],
        },
        {
          blocks: [
            {
              intended_usage: 'markdown',
              markdown_block: { chunks: ['Hello '], progress: 'IN_PROGRESS' },
            },
          ],
        },
        {
          blocks: [
            {
              intended_usage: 'markdown',
              markdown_block: { chunks: ['Hello world'], progress: 'DONE' },
            },
          ],
          status: 'COMPLETED',
        },
      ])
    );
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }], stream: true },
      stream: true,
      credentials: { apiKey: 'c' },
    });
    const acc = await readAllSse(response);
    expect(acc).toContain('"role":"assistant"');
    // Each thinking source surfaces once, deduplicated.
    expect(acc.match(/Searching: q1/g)).toHaveLength(1);
    expect(acc.match(/Reading: https:\/\/a.example/g)).toHaveLength(1);
    expect(acc).toContain('goal-1');
    expect(acc).toContain('"content":"Hello "');
    expect(acc).toContain('"finish_reason":"stop"');
    expect(acc).toContain('[DONE]');
  });

  it('surfaces an upstream error event as an inline error chunk, still terminated', async () => {
    global.fetch = vi.fn(async () =>
      mockPplxStream([{ error_code: 42, error_message: 'quota gone' }])
    );
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }], stream: true },
      stream: true,
      credentials: { apiKey: 'c' },
    });
    const acc = await readAllSse(response);
    expect(acc).toContain('quota gone');
    expect(acc).toContain('"finish_reason":"stop"');
    expect(acc).toContain('[DONE]');
  });

  it('a body stream that throws mid-read yields a stream-error chunk and [DONE], never a hang', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('conn reset'));
            },
          }),
          { status: 200 }
        )
    );
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }], stream: true },
      stream: true,
      credentials: { apiKey: 'c' },
    });
    const acc = await readAllSse(response);
    expect(acc).toContain('Stream error');
    expect(acc).toContain('[DONE]');
  });
});

describe('PerplexityWebExecutor.execute — non-streaming details', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('collects thinking into reasoning_content and text-fallback events into content', async () => {
    global.fetch = vi.fn(async () =>
      mockPplxStream([
        {
          blocks: [{ intended_usage: 'plan', plan_block: { goals: [{ description: 'think-1' }] } }],
        },
        { blocks: [], text: 'plain answer' },
        { status: 'COMPLETED' },
      ])
    );
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: { apiKey: 'c' },
    });
    const j = await response.json();
    expect(j.choices[0].message.content).toBe('plain answer');
    expect(j.choices[0].message.reasoning_content).toBe('think-1');
    expect(j.usage.total_tokens).toBeGreaterThan(0);
  });

  it('an error event returns a 502 with the upstream message', async () => {
    global.fetch = vi.fn(async () => mockPplxStream([{ error_message: 'backend sad' }]));
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: { apiKey: 'c' },
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toBe('backend sad');
  });

  it('a null upstream body returns a 502 empty-body error', async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: { apiKey: 'c' },
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toMatch(/empty response body/i);
  });

  it('a network failure returns 502; an abort is rethrown to the caller', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: { apiKey: 'c' },
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toContain('socket hang up');

    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    global.fetch = vi.fn(async () => {
      throw abortErr;
    });
    await expect(
      exec.execute({
        model: 'pplx-auto',
        body: { messages: [{ role: 'user', content: 'hi' }] },
        stream: false,
        credentials: { apiKey: 'c' },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('an unmapped model rides through as a raw copilot preference', async () => {
    let captured;
    global.fetch = vi.fn(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return mockPplxStream([{ status: 'COMPLETED' }]);
    });
    const exec = new PerplexityWebExecutor();
    await exec.execute({
      model: 'some-custom-model',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: { apiKey: 'c' },
    });
    expect(captured.params.mode).toBe('copilot');
    expect(captured.params.model_preference).toBe('some-custom-model');
  });
});

describe('PerplexityWebExecutor — session continuity across turns', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  const answerStream = (uuid, answer) =>
    mockPplxStream([
      {
        backend_uuid: uuid,
        blocks: [
          { intended_usage: 'markdown', markdown_block: { chunks: [answer], progress: 'DONE' } },
        ],
        status: 'COMPLETED',
      },
    ]);

  async function turn(exec, messages, capture) {
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: { messages },
      stream: false,
      credentials: { apiKey: 'c' },
    });
    return { response, body: capture.body };
  }

  it('a follow-up matching a stored transcript reuses the backend uuid and sends a plain query', async () => {
    const capture = {};
    global.fetch = vi.fn(async (url, opts) => {
      capture.body = JSON.parse(opts.body);
      return answerStream('uuid-sess-1', 'First answer');
    });
    const exec = new PerplexityWebExecutor();
    await turn(exec, [{ role: 'user', content: 'Q-alpha' }], capture);
    expect(capture.body.params.last_backend_uuid).toBeNull();

    // Second turn replays the transcript and asks a follow-up.
    await turn(
      exec,
      [
        { role: 'user', content: 'Q-alpha' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Q-beta' },
      ],
      capture
    );
    expect(capture.body.params.last_backend_uuid).toBe('uuid-sess-1');
    expect(capture.body.query_str).toBe('Q-beta');
  });

  it('a follow-up with no new user message is rejected as an empty query', async () => {
    const capture = {};
    global.fetch = vi.fn(async (url, opts) => {
      capture.body = JSON.parse(opts.body);
      return answerStream('uuid-sess-2', 'Only answer');
    });
    const exec = new PerplexityWebExecutor();
    await turn(exec, [{ role: 'user', content: 'Q-gamma' }], capture);
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: {
        messages: [
          { role: 'user', content: 'Q-gamma' },
          { role: 'assistant', content: 'Only answer' },
        ],
      },
      stream: false,
      credentials: { apiKey: 'c' },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/empty query/i);
  });

  it('an expired session entry is dropped and the turn restarts as a first turn', async () => {
    const capture = {};
    global.fetch = vi.fn(async (url, opts) => {
      capture.body = JSON.parse(opts.body);
      return answerStream('uuid-sess-3', 'Aged answer');
    });
    const exec = new PerplexityWebExecutor();
    await turn(exec, [{ role: 'user', content: 'Q-delta' }], capture);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3600_000 + 1000);
    await turn(
      exec,
      [
        { role: 'user', content: 'Q-delta' },
        { role: 'assistant', content: 'Aged answer' },
        { role: 'user', content: 'Q-epsilon' },
      ],
      capture
    );
    expect(capture.body.params.last_backend_uuid).toBeNull();
    // First-turn shape: JSON envelope, not the bare follow-up string.
    expect(JSON.parse(capture.body.query_str).query).toBe('Q-epsilon');
  });
});

describe('PerplexityWebExecutor — SSE wire-format edge cases', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function run(streamText) {
    global.fetch = vi.fn(async () => rawPplxStream(streamText));
    const exec = new PerplexityWebExecutor();
    const { response } = await exec.execute({
      model: 'pplx-auto',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      stream: false,
      credentials: { apiKey: 'c' },
    });
    return response.json();
  }

  it('CRLF line endings and a [DONE] sentinel terminate cleanly', async () => {
    const j = await run('data: {"blocks":[],"text":"crlf answer"}\r\n\r\ndata: [DONE]\r\n\r\n');
    expect(j.choices[0].message.content).toBe('crlf answer');
  });

  it('event: end_of_stream terminates without needing [DONE]', async () => {
    const j = await run('data: {"blocks":[],"text":"eos answer"}\n\nevent: end_of_stream\n');
    expect(j.choices[0].message.content).toBe('eos answer');
  });

  it('a final data line without a trailing newline is still flushed', async () => {
    const j = await run('data: {"blocks":[],"text":"tail answer"}');
    expect(j.choices[0].message.content).toBe('tail answer');
  });
});
