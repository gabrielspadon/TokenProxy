import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveRequestDetail: vi.fn(),
  saveRequestUsage: vi.fn(),
  appendRequestLog: vi.fn(),
  trackPendingRequest: vi.fn(),
}));

vi.mock('@/lib/usageDb.js', () => ({
  saveRequestDetail: mocks.saveRequestDetail,
  saveRequestUsage: mocks.saveRequestUsage,
  appendRequestLog: mocks.appendRequestLog,
  trackPendingRequest: mocks.trackPendingRequest,
}));

const { buildOnStreamComplete } =
  await import('../../open-sse/handlers/chatCore/streamingHandler.js');
const { createPassthroughStreamWithLogger } = await import('../../open-sse/utils/stream.js');

const ctx = {
  provider: 'testprov',
  model: 'test-model',
  connectionId: 'conn-12345678',
  apiKey: 'client-key',
  requestStartTime: Date.now() - 1000,
  body: { messages: [{ role: 'user', content: 'hi' }] },
  stream: true,
  finalBody: null,
  translatedBody: null,
  clientRawRequest: { endpoint: '/v1/chat/completions' },
  pxpipe: undefined,
  reqTag: 'T1',
  log: null,
};

const encoder = new TextEncoder();
const completionProof = { terminalEvidence: { state: 'succeeded', reason: 'stream-complete', source: 'provider-stream' } };

describe('interrupted streaming request detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveRequestDetail.mockResolvedValue(undefined);
    mocks.saveRequestUsage.mockResolvedValue(undefined);
  });

  it('abandons only once even if both disconnect and error fire', () => {
    const { onStreamAbandoned } = buildOnStreamComplete({ ...ctx });
    onStreamAbandoned('stall_timeout');
    onStreamAbandoned('client_disconnected');

    expect(mocks.saveRequestDetail).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestDetail.mock.calls[0][0].providerResponse).toContain('stall_timeout');
  });

  it('does not double-finalize when a late completion races after abandon', () => {
    const { onStreamComplete, onStreamAbandoned } = buildOnStreamComplete({ ...ctx });
    onStreamAbandoned('client_disconnected');
    onStreamComplete(
      { content: 'late eof' },
      { prompt_tokens: 9, completion_tokens: 9 },
      Date.now()
    );

    expect(mocks.saveRequestDetail).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestDetail.mock.calls[0][0].status).toBe('cancelled');
  });

  it('does not overwrite after normal completion', () => {
    const { onStreamComplete, onStreamAbandoned } = buildOnStreamComplete({ ...ctx });
    onStreamComplete({ content: 'done' }, { prompt_tokens: 5, completion_tokens: 7 }, Date.now(), completionProof);
    onStreamAbandoned('client_disconnected');

    expect(mocks.saveRequestDetail).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestDetail.mock.calls[0][0].status).toBe('success');
  });

  it('recovers partial provider usage from streamState when abandon fires after chunks', () => {
    const { onStreamAbandoned, streamState } = buildOnStreamComplete({ ...ctx });
    streamState.usage = { prompt_tokens: 100, completion_tokens: 42 };
    streamState.content = 'partial response so far';
    onStreamAbandoned('client_disconnected');

    const detail = mocks.saveRequestDetail.mock.calls[0][0];
    expect(detail.tokens.prompt_tokens).toBe(100);
    expect(detail.tokens.completion_tokens).toBe(42);
    expect(detail.status).toBe('cancelled');
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
  });

  it('populates streamState from live SSE chunks (passthrough)', async () => {
    const streamState = { usage: null, content: '', thinking: '', ttftAt: null };
    const ts = createPassthroughStreamWithLogger(
      'testprov',
      null,
      'test-model',
      'conn-x',
      { messages: [{ role: 'user', content: 'hi' }] },
      null,
      'key',
      streamState
    );
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const chunk = {
      choices: [{ delta: { content: 'hello world' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    };
    // Start the read first: Node TransformStream does not run transform()
    // until the readable side has demand.
    const readPromise = reader.read();
    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    await readPromise;

    expect(streamState.content).toBe('hello world');
    expect(streamState.usage).toBeTruthy();
    expect(streamState.ttftAt).toBeTruthy();

    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
  });

  it('keeps normal completion behavior intact (success row + usage save)', () => {
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ ...ctx });
    onStreamComplete({ content: 'ok' }, { prompt_tokens: 3, completion_tokens: 4 }, null, completionProof);

    const detail = mocks.saveRequestDetail.mock.calls[0][0];
    expect(detail.id).toBe(streamDetailId);
    expect(detail.status).toBe('success');
    expect(detail.response.content).toBe('ok');
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
  });

  it('writes a cancelled row with the same streamDetailId when abandoned', () => {
    const { onStreamAbandoned, streamDetailId } = buildOnStreamComplete({ ...ctx });
    onStreamAbandoned('client_disconnected');

    expect(mocks.saveRequestDetail).toHaveBeenCalledTimes(1);
    const detail = mocks.saveRequestDetail.mock.calls[0][0];
    expect(detail.id).toBe(streamDetailId);
    expect(detail.status).toBe('cancelled');
    expect(detail.response.content).toContain('interrupted');
    expect(detail.tokens).toBeNull();
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });
});
