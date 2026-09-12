// Cursor executor transport coverage: protobuf frame decode paths in
// transformProtobufToJSON/SSE (JSON error frames, tool-call accumulation,
// finalization without isLast), decompression fallback chain, AgentService
// non-200 and failure classification. Zero real network: proxyAwareFetch is
// mocked and AgentService sessions are stubbed (pattern:
// windsurf-transport-coverage.test.js / cursor-agent-exec-request.test.js).
import { describe, it, expect, vi } from 'vitest';
import zlib from 'zlib';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: (...args) => fetchMock(...args) };
});

const { CursorExecutor, buildAgentRunFrame, isAgentCapableRequest } =
  await import('../../open-sse/executors/cursor.js');
const { encodeField, wrapConnectRPCFrame, decodeMessage } =
  await import('../../open-sse/utils/cursorProtobuf.js');

const LEN = 2;
const VARINT = 0;

const creds = {
  accessToken: 'tok',
  providerSpecificData: { machineId: 'a'.repeat(64) },
};

// ── response frame builders (derived from the module's own encoder) ─────────
function textFrame(text) {
  return Buffer.from(wrapConnectRPCFrame(encodeField(2, LEN, encodeField(1, LEN, text))));
}
function rawFrame(flags, payload) {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}
function toolCallFrame({ id, name, args, isLast }) {
  const parts = Buffer.concat([
    Buffer.from(encodeField(3, LEN, id)),
    Buffer.from(encodeField(9, LEN, name)),
    Buffer.from(encodeField(10, LEN, args)),
    Buffer.from(encodeField(11, VARINT, isLast ? 1 : 0)),
  ]);
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, parts)));
}
function parseSSE(text) {
  return text
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => c.slice(6))
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d));
}

const ex = () => new CursorExecutor();

describe('buildHeaders', () => {
  it('requires a machineId', () => {
    expect(() => ex().buildHeaders({ accessToken: 't', providerSpecificData: {} })).toThrow(
      /Machine ID/
    );
  });
});

describe('isAgentCapableRequest / buildAgentRunFrame edges', () => {
  it('rejects null content and empty message lists', () => {
    expect(isAgentCapableRequest({ messages: [] })).toBe(false);
    expect(isAgentCapableRequest({ messages: [{ role: 'user', content: null }] })).toBe(false);
  });

  it('encodes array content, drops empty history entries, and frames correctly', () => {
    const frame = buildAgentRunFrame(
      [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'assistant', content: '' }, // empty history entry -> dropped
        { role: 'user', content: [{ type: 'text', text: 'q1' }, { type: 'other' }] },
        { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      ],
      'some-model'
    );
    expect(frame[0]).toBe(0);
    const payloadLen = Buffer.from(frame).readUInt32BE(1);
    expect(frame.length).toBe(5 + payloadLen);
    // frame decodes as a protobuf message with the run_request field
    const msg = decodeMessage(frame.slice(5));
    expect(msg.has(1)).toBe(true);
  });
});

describe('transformProtobufToJSON', () => {
  it('decodes text frames across the gzip / deflate / raw-deflate fallback chain', async () => {
    const buffer = Buffer.concat([
      rawFrame(0x01, zlib.gzipSync(Buffer.from(encodeField(2, LEN, encodeField(1, LEN, 'abc'))))),
      rawFrame(
        0x02,
        zlib.deflateSync(Buffer.from(encodeField(2, LEN, encodeField(1, LEN, 'def'))))
      ),
      rawFrame(
        0x03,
        zlib.deflateRawSync(Buffer.from(encodeField(2, LEN, encodeField(1, LEN, 'ghi'))))
      ),
    ]);
    const response = ex().transformProtobufToJSON(buffer, 'm', { messages: [] });
    const json = await response.json();
    expect(json.choices[0].message.content).toBe('abcdefghi');
  });

  it('returns the undecompressed payload when every decompressor fails', async () => {
    const buffer = rawFrame(0x01, Buffer.from('not compressed at all'));
    const response = ex().transformProtobufToJSON(buffer, 'm', { messages: [] });
    const json = await response.json();
    expect(json.choices[0].message.content).toBeNull();
  });

  it('rejects an incomplete trailing frame without returning partial content', async () => {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(100, 1); // claims 100 bytes, none follow
    const buffer = Buffer.concat([textFrame('ok'), header]);
    const response = ex().transformProtobufToJSON(buffer, 'm', { messages: [] });
    expect(response.status).toBe(502);
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect((await response.json()).error.code).toBe('invalid_cursor_protobuf');
  });

  it('rejects a zero-frame body and one byte over the configured response bound', async () => {
    const executor = new CursorExecutor({ responseMaxBytes: 16 });
    const empty = executor.transformProtobufToJSON(Buffer.alloc(0), 'm', { messages: [] });
    const oversized = executor.transformProtobufToJSON(Buffer.alloc(17), 'm', { messages: [] });

    expect(empty.status).toBe(502);
    expect((await empty.json()).error.code).toBe('missing_response_body');
    expect(oversized.status).toBe(502);
    expect(oversized.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect((await oversized.json()).error.code).toBe('cursor_response_too_large');
  });

  it('accepts a complete frame exactly at the configured response bound', async () => {
    const frame = textFrame('ok');
    const executor = new CursorExecutor({ responseMaxBytes: frame.length });
    const response = executor.transformProtobufToJSON(frame, 'm', { messages: [] });

    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe('ok');
  });

  it('maps a JSON error frame to a structured error response', async () => {
    const err = JSON.stringify({
      error: {
        code: 'resource_exhausted',
        details: [{ debug: { details: { title: 'quota gone' }, error: 'usage_limit' } }],
      },
    });
    const response = ex().transformProtobufToJSON(rawFrame(0x00, Buffer.from(err)), 'm', {
      messages: [],
    });
    expect(response.status).toBe(429);
    const json = await response.json();
    expect(json.error.type).toBe('rate_limit_error');
    expect(json.error.message).toBe('quota gone');
    expect(json.error.code).toBe('usage_limit');
  });

  it('keeps decoded content when a JSON error frame arrives after content', async () => {
    const err = Buffer.from('{"error":{"message":"late failure"}}');
    const buffer = Buffer.concat([textFrame('partial'), rawFrame(0x00, err)]);
    const response = ex().transformProtobufToJSON(buffer, 'm', { messages: [] });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe('partial');
  });

  it('accumulates streamed tool-call arguments and finalizes on isLast', async () => {
    const buffer = Buffer.concat([
      toolCallFrame({ id: 'call-1', name: 'Write', args: '{"pa', isLast: false }),
      toolCallFrame({ id: 'call-1', name: 'Write', args: 'th":1}', isLast: true }),
    ]);
    const json = await ex().transformProtobufToJSON(buffer, 'm', { messages: [] }).json();
    const call = json.choices[0].message.tool_calls[0];
    expect(call.id).toBe('call-1');
    expect(call.function.arguments).toBe('{"path":1}');
    expect(json.choices[0].finish_reason).toBe('tool_calls');
  });

  it('finalizes a tool call the stream never marked last', async () => {
    const buffer = toolCallFrame({ id: 'call-2', name: 'Read', args: '{}', isLast: false });
    const json = await ex().transformProtobufToJSON(buffer, 'm', { messages: [] }).json();
    expect(json.choices[0].message.tool_calls).toHaveLength(1);
    expect(json.choices[0].message.tool_calls[0].function.name).toBe('Read');
  });
});

describe('transformProtobufToSSE', () => {
  it('rejects truncated protobuf rather than emitting a successful SSE terminator', async () => {
    const frame = textFrame('complete');
    const response = ex().transformProtobufToSSE(frame.subarray(0, frame.length - 1), 'm', {
      messages: [],
    });

    expect(response.status).toBe(502);
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect((await response.json()).error.code).toBe('invalid_cursor_protobuf');
  });

  it('maps a JSON error frame to a structured error response', async () => {
    const err = Buffer.from('{"error":{"message":"nope"}}');
    const response = ex().transformProtobufToSSE(rawFrame(0x00, err), 'm', { messages: [] });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('nope');
  });

  it('keeps streamed content when a JSON error frame arrives after content', async () => {
    const err = Buffer.from('{"error":{"message":"late"}}');
    const buffer = Buffer.concat([textFrame('kept'), rawFrame(0x00, err)]);
    const response = ex().transformProtobufToSSE(buffer, 'm', { messages: [] });
    expect(response.status).toBe(200);
    const content = parseSSE(await response.text())
      .map((e) => e.choices?.[0]?.delta?.content || '')
      .join('');
    expect(content).toBe('kept');
  });

  it('streams tool-call deltas: initial name chunk, argument deltas, tool_calls finish', async () => {
    const buffer = Buffer.concat([
      toolCallFrame({ id: 'c1', name: 'Write', args: '{"a"', isLast: false }),
      toolCallFrame({ id: 'c1', name: 'Write', args: ':1}', isLast: true }),
    ]);
    const events = parseSSE(
      await ex().transformProtobufToSSE(buffer, 'm', { messages: [] }).text()
    );
    const toolDeltas = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []);
    expect(toolDeltas.length).toBe(2);
    expect(toolDeltas.map((t) => t.function.arguments).join('')).toBe('{"a":1}');
    expect(events.at(-1).choices[0].finish_reason).toBe('tool_calls');
  });

  it('emits a finalizing chunk for a tool call the stream never marked last', async () => {
    // Two frames, same id, neither isLast: second frame emits an argument
    // delta (marking the id emitted); finalize loop must not duplicate it.
    const buffer = Buffer.concat([
      toolCallFrame({ id: 'c2', name: 'Run', args: '{', isLast: false }),
      toolCallFrame({ id: 'c2', name: 'Run', args: '}', isLast: false }),
    ]);
    const events = parseSSE(
      await ex().transformProtobufToSSE(buffer, 'm', { messages: [] }).text()
    );
    const toolDeltas = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []);
    expect(toolDeltas.map((t) => t.function.arguments).join('')).toBe('{}');
    expect(events.at(-1).choices[0].finish_reason).toBe('tool_calls');
  });
});

// ── AgentService stubs ──────────────────────────────────────────────────────
function stubSession(executor, { status = 200, frames = [], readError = null } = {}) {
  const queue = [...frames];
  executor.openAgentHttp2Stream = () => ({
    responseHeaders: Promise.resolve({ ':status': status }),
    write() {},
    end() {},
    close() {},
    async read() {
      if (readError && !queue.length) throw readError;
      if (!queue.length) return { value: undefined, done: true };
      return { value: queue.shift(), done: false };
    },
  });
}
const agentBody = { messages: [{ role: 'user', content: 'hi' }] };

describe('executeAgent transport failures', () => {
  it('returns an api_error response for a non-200 AgentService status', async () => {
    const executor = ex();
    stubSession(executor, { status: 429, frames: [Buffer.from('slow down')] });
    const { response } = await executor.executeAgent({
      model: 'm',
      body: agentBody,
      stream: true,
      credentials: creds,
    });
    expect(response.status).toBe(429);
    const json = await response.json();
    expect(json.error.message).toContain('429');
    expect(json.error.message).toContain('slow down');
  });

  it('still reports the status when reading the error body fails', async () => {
    const executor = ex();
    stubSession(executor, { status: 500, readError: new Error('socket reset') });
    const { response } = await executor.executeAgent({
      model: 'm',
      body: agentBody,
      stream: true,
      credentials: creds,
    });
    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toContain('500');
  });

  it('decodes gzip agent frames and frames split across reads', async () => {
    const executor = ex();
    const textUpdate = Buffer.from(
      encodeField(1, LEN, encodeField(1, LEN, encodeField(1, LEN, 'gz')))
    );
    const gzFrame = rawFrame(0x01, zlib.gzipSync(textUpdate));
    const plain = Buffer.from(
      wrapConnectRPCFrame(encodeField(1, LEN, encodeField(1, LEN, encodeField(1, LEN, '-tail'))))
    );
    const trailer = rawFrame(0x02, Buffer.from('grpc-status: 0'));
    stubSession(executor, { frames: [gzFrame, plain.slice(0, 3), plain.slice(3), trailer] });
    const controller = new AbortController();
    const { response } = await executor.executeAgent({
      model: 'm',
      body: agentBody,
      stream: false,
      credentials: creds,
      signal: controller.signal,
    });
    const json = await response.json();
    expect(json.choices[0].message.content).toBe('gz-tail');
  });

  it('wraps an AgentService connection failure via execute() as connection_error', async () => {
    const executor = ex();
    executor.openAgentHttp2Stream = async () => {
      throw new Error('dial refused');
    };
    const { response } = await executor.execute({
      model: 'm',
      body: agentBody,
      stream: true,
      credentials: creds,
    });
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error.type).toBe('connection_error');
    expect(json.error.message).toContain('dial refused');
  });

  it('wraps a responseHeaders rejection as a request failure', async () => {
    const executor = ex();
    executor.openAgentHttp2Stream = async () => ({
      responseHeaders: Promise.reject(new Error('reset before headers')),
      write() {},
      end() {},
      close() {},
      async read() {
        return { done: true };
      },
    });
    await expect(
      executor.executeAgent({ model: 'm', body: agentBody, stream: true, credentials: creds })
    ).rejects.toThrow(/reset before headers/);
  });
});

describe('openAgentHttp2Stream adapter contract', () => {
  it('rejects an adapter that does not return a SessionLease', async () => {
    const executor = new CursorExecutor({ connectHttp2: async () => ({}) });
    await expect(executor.openAgentHttp2Stream('https://agent.example/run', {})).rejects.toThrow(
      /SessionLease/
    );
  });

  it('fails with http2_connection_closed when the stream ends before headers', async () => {
    const { EventEmitter } = await import('node:events');
    const req = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      write() {},
      end() {},
    });
    const session = Object.assign(new EventEmitter(), { request: () => req });
    const executor = new CursorExecutor({
      connectHttp2: async () => ({ session, close() {} }),
    });
    const stream = await executor.openAgentHttp2Stream('https://agent.example/run', {});
    req.emit('end');
    req.emit('close');
    await expect(stream.responseHeaders).rejects.toMatchObject({ code: 'http2_connection_closed' });
    await expect(stream.read()).rejects.toMatchObject({ code: 'http2_connection_closed' });
  });
});

describe('refreshCredentials', () => {
  it('is a no-op returning null', async () => {
    expect(await ex().refreshCredentials()).toBeNull();
  });
});
