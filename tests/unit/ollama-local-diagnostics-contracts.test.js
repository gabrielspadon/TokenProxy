/**
 * Contract tests for open-sse/executors/ollama-local.js: URL building
 * (runtimeTransport honoured, host resolution), retry disabled for local,
 * and the pre-flight/success/failure diagnostic paths including the
 * large-body breakdown. Upstream execute is mocked — no network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { debugMock } = vi.hoisted(() => ({ debugMock: vi.fn() }));

vi.mock('../../open-sse/utils/debugLog.js', () => ({
  dbg: (...args) => debugMock(...args),
  isDebugEnabled: true,
}));

const { BaseExecutor } = await import('../../open-sse/executors/base.js');
const { OllamaLocalExecutor } = await import('../../open-sse/executors/ollama-local.js');
const { OLLAMA_LOCAL_DEFAULT_HOST } = await import('../../open-sse/config/providers.js');

const baseRequest = {
  model: 'llama3',
  body: { messages: [{ role: 'user', content: 'hi' }] },
  stream: true,
  credentials: {},
};

beforeEach(() => {
  debugMock.mockReset();
  vi.restoreAllMocks();
});

const dbgText = () => debugMock.mock.calls.map((c) => c.join(' ')).join('\n');

describe('buildUrl', () => {
  it('defaults to <host>/api/chat with the default host', () => {
    const executor = new OllamaLocalExecutor();
    expect(executor.buildUrl('m', true, 0, {})).toBe(`${OLLAMA_LOCAL_DEFAULT_HOST}/api/chat`);
  });

  it("uses the connection's baseUrl, trailing slash stripped", () => {
    const executor = new OllamaLocalExecutor();
    const creds = { providerSpecificData: { baseUrl: 'http://box:9999/' } };
    expect(executor.buildUrl('m', true, 0, creds)).toBe('http://box:9999/api/chat');
  });

  it('honours a resolved runtimeTransport exactly (#2475)', () => {
    const executor = new OllamaLocalExecutor();
    const withSuffix = {
      runtimeTransport: { baseUrl: 'http://box:9999', urlSuffix: '/v1/messages' },
    };
    const bare = { runtimeTransport: { baseUrl: 'http://box:9999/v1/messages' } };
    expect(executor.buildUrl('m', true, 0, withSuffix)).toBe('http://box:9999/v1/messages');
    expect(executor.buildUrl('m', true, 0, bare)).toBe('http://box:9999/v1/messages');
  });
});

describe('config', () => {
  it('disables gateway-error retry for the local host', () => {
    const { retry } = new OllamaLocalExecutor().config;
    for (const status of [502, 503, 504]) {
      expect(retry[status]).toEqual({ attempts: 0, delayMs: 0 });
    }
  });
});

describe('execute diagnostics', () => {
  it('emits pre-flight summary and success line, delegating to the base executor', async () => {
    const result = { url: 'http://localhost:11434/api/chat' };
    const spy = vi.spyOn(BaseExecutor.prototype, 'execute').mockResolvedValueOnce(result);
    const executor = new OllamaLocalExecutor();

    await expect(executor.execute({ ...baseRequest })).resolves.toBe(result);
    expect(spy).toHaveBeenCalledTimes(1);
    const out = dbgText();
    expect(out).toContain('model=llama3');
    expect(out).toContain('messages:');
    expect(out).toContain('✓ connected');
    expect(out).toContain(result.url);
  });

  it('summarises roles, tool calls, images and content size', async () => {
    vi.spyOn(BaseExecutor.prototype, 'execute').mockResolvedValueOnce({ url: 'u' });
    const body = {
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'x' } },
            { type: 'tool_result', content: 'r' },
          ],
        },
        { role: 'assistant', content: 'a', tool_calls: [{ id: 't1' }, { id: 't2' }] },
        { role: 'tool', content: 'out' },
        { content: 'role-less' },
      ],
    };
    await new OllamaLocalExecutor().execute({ ...baseRequest, body });
    const out = dbgText();
    expect(out).toContain('5 msgs');
    expect(out).toContain('sys=1');
    expect(out).toContain('usr=1');
    expect(out).toContain('asst=1');
    expect(out).toContain('tool=1');
    expect(out).toContain('other=1');
    expect(out).toContain('tool_calls=2');
    expect(out).toContain('images=1');
    expect(out).toMatch(/content/);
  });

  it('handles an empty messages array', async () => {
    vi.spyOn(BaseExecutor.prototype, 'execute').mockResolvedValueOnce({ url: 'u' });
    await new OllamaLocalExecutor().execute({ ...baseRequest, body: { messages: [] } });
    expect(dbgText()).toContain('no messages');
  });

  it('breaks a large body down with top offenders and hints', async () => {
    vi.spyOn(BaseExecutor.prototype, 'execute').mockResolvedValueOnce({ url: 'u' });
    const big = 'x'.repeat(120 * 1024);
    const body = {
      messages: [
        { role: 'user', content: big },
        { role: 'assistant', content: big },
        { role: 'user', content: 'small' },
      ],
      tools: [{ name: 't' }],
      max_tokens: 512,
    };
    await new OllamaLocalExecutor().execute({ ...baseRequest, body });
    const out = dbgText();
    expect(out).toContain('Large body');
    expect(out).toContain('total_messages : 3');
    expect(out).toContain('top offenders');
    expect(out).toContain('tools          : 1 defined');
    expect(out).toContain('max_tokens     : 512');
    // Bytes render as KB/MB for large payloads.
    expect(out).toMatch(/\d+(\.\d+)?(KB|MB)/);
  });

  it('reports a non-timeout failure without the timeout diagnosis', async () => {
    const failure = new Error('connection refused');
    vi.spyOn(BaseExecutor.prototype, 'execute').mockRejectedValueOnce(failure);
    await expect(new OllamaLocalExecutor().execute({ ...baseRequest })).rejects.toBe(failure);
    const out = dbgText();
    expect(out).toContain('connection refused');
    expect(out).not.toContain('diagnosis');
  });
});
