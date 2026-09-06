// Windsurf executor transport coverage: execute() fetch plumbing (mocked),
// gRPC-web frame draining (content/done/error/trailer, split frames), decoder
// skip branches for non-length-delimited wire types, message flattening, and
// the null transformRequest/refreshCredentials contracts. Zero real network:
// proxyAwareFetch is mocked (pattern: default-executor-transport.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const {
  WindsurfExecutor,
  resolveWsModelId,
  buildGetChatMessageRequest,
  grpcWebFrame,
  decodeCompletionChunk,
} = await import('../../open-sse/executors/windsurf.js');

beforeEach(() => fetchMock.mockReset());

// ─── protobuf helpers (mirror of the module's minimal encoder) ───────────────
function varint(value) {
  const bytes = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}
function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function lenField(fieldNum, payload) {
  return concat([varint((fieldNum << 3) | 2), varint(payload.length), payload]);
}
function strField(fieldNum, s) {
  return lenField(fieldNum, new TextEncoder().encode(s));
}
function varintField(fieldNum, value) {
  return concat([varint(fieldNum << 3), varint(value)]);
}
const contentChunk = (text) => lenField(1, strField(1, text));
const errorChunk = (msg) => lenField(4, strField(1, msg));
const doneChunk = (prompt, completion) =>
  lenField(3, lenField(1, concat([varintField(1, prompt), varintField(2, completion)])));
const trailerFrame = (text) => {
  const payload = new TextEncoder().encode(text);
  const frame = grpcWebFrame(payload);
  frame[0] = 0x80;
  return frame;
};
function upstreamOf(...byteChunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of byteChunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}
async function sseEvents(response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((l) => {
      const data = l.replace(/^data: /, '');
      return data === '[DONE]' ? '[DONE]' : JSON.parse(data);
    });
}

describe('WindsurfExecutor.execute (mocked transport)', () => {
  const ex = new WindsurfExecutor();

  it('streams content + done frames into OpenAI SSE with usage', async () => {
    fetchMock.mockResolvedValue(
      upstreamOf(
        grpcWebFrame(contentChunk('hel')),
        grpcWebFrame(contentChunk('lo')),
        grpcWebFrame(doneChunk(7, 3))
      )
    );
    const model = 'any-model';
    const { response, url, transformedBody } = await ex.execute({
      model,
      body: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url' }] },
        ],
      },
      credentials: { accessToken: 'k' },
    });
    expect(url).toBe(ex.buildUrl());
    expect(transformedBody).toBeInstanceOf(Uint8Array);
    const events = await sseEvents(response);
    expect(events[0].choices[0].delta.role).toBe('assistant');
    const text = events
      .filter((e) => e !== '[DONE]' && e.choices?.[0]?.delta?.content)
      .map((e) => e.choices[0].delta.content)
      .join('');
    expect(text).toBe('hello');
    const finish = events.find((e) => e !== '[DONE]' && e.choices?.[0]?.finish_reason === 'stop');
    expect(finish.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    expect(events.at(-1)).toBe('[DONE]');
    // sent body is the framed proto of the request
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body[0]).toBe(0x00);
    expect(init.headers['Content-Type']).toBe('application/grpc-web+proto');
    expect(init.headers.Authorization).toBe('Bearer k');
  });

  it('reassembles a frame split across reads and empty message list gets one user turn', async () => {
    const frame = grpcWebFrame(contentChunk('split'));
    fetchMock.mockResolvedValue(upstreamOf(frame.slice(0, 3), frame.slice(3)));
    const { response, transformedBody } = await ex.execute({
      model: 'm',
      body: {},
      credentials: { apiKey: 'k2' },
    });
    const events = await sseEvents(response);
    expect(events.some((e) => e !== '[DONE]' && e.choices?.[0]?.delta?.content === 'split')).toBe(
      true
    );
    // openAIMessagesToWs produced the fallback empty user message: proto contains role "user"
    const bodyStr = new TextDecoder().decode(transformedBody);
    expect(bodyStr).toContain('user');
  });

  it('surfaces an ErrorChunk as an SSE error event then [DONE]', async () => {
    fetchMock.mockResolvedValue(upstreamOf(grpcWebFrame(errorChunk('boom'))));
    const { response } = await ex.execute({
      model: 'm',
      body: { messages: [{ role: 'user', content: 'x' }] },
      credentials: {},
    });
    const events = await sseEvents(response);
    expect(events[0].error.message).toBe('boom');
    expect(events.at(-1)).toBe('[DONE]');
  });

  it('surfaces a non-zero gRPC trailer status, decoding grpc-message', async () => {
    fetchMock.mockResolvedValue(
      upstreamOf(trailerFrame('grpc-status: 8\r\ngrpc-message: quota%20exceeded'))
    );
    const { response } = await ex.execute({
      model: 'm',
      body: { messages: [{ role: 'user', content: 'x' }] },
      credentials: {},
    });
    const events = await sseEvents(response);
    expect(events[0].error.message).toBe('quota exceeded');
  });

  it('a zero-status trailer and unknown frame flags are not errors', async () => {
    const weird = grpcWebFrame(contentChunk('x'));
    weird[0] = 0x42; // unknown flag → skipped
    fetchMock.mockResolvedValue(upstreamOf(weird, trailerFrame('grpc-status: 0')));
    const { response } = await ex.execute({
      model: 'm',
      body: { messages: [{ role: 'user', content: 'x' }] },
      credentials: {},
    });
    const events = await sseEvents(response);
    expect(events.some((e) => e !== '[DONE]' && e.error)).toBe(false);
    expect(events.some((e) => e !== '[DONE]' && e.choices?.[0]?.finish_reason === 'stop')).toBe(
      true
    );
  });

  it('returns the upstream untouched on non-ok status', async () => {
    const upstream = new Response('nope', { status: 401 });
    fetchMock.mockResolvedValue(upstream);
    const { response } = await ex.execute({ model: 'm', body: {}, credentials: {} });
    expect(response).toBe(upstream);
  });

  it('a body-less upstream still emits a stop chunk without usage', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: null });
    const { response } = await ex.execute({ model: 'm', body: {}, credentials: {} });
    const events = await sseEvents(response);
    const finish = events.find((e) => e !== '[DONE]' && e.choices?.[0]?.finish_reason === 'stop');
    expect(finish.usage).toBeUndefined();
  });

  it('a reader that throws mid-stream emits a windsurf_error event', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({ read: () => Promise.reject(new Error('torn')), releaseLock() {} }),
      },
    });
    const { response } = await ex.execute({ model: 'm', body: {}, credentials: {} });
    const events = await sseEvents(response);
    expect(events[0].error.message).toMatch(/torn/);
    expect(events[0].error.type).toBe('windsurf_error');
  });

  it('transformRequest is null and refreshCredentials resolves null (out-of-band)', async () => {
    expect(ex.transformRequest()).toBeNull();
    await expect(ex.refreshCredentials()).resolves.toBeNull();
  });
});

describe('decoder edge branches', () => {
  it('skips varint/fixed64/fixed32 fields and stops on an unknown wire type', () => {
    // varint field, fixed64 field, fixed32 field, then wire type 3 (unsupported)
    const buf = concat([
      varintField(9, 5),
      concat([varint((10 << 3) | 1), new Uint8Array(8)]),
      concat([varint((11 << 3) | 5), new Uint8Array(4)]),
      varint((12 << 3) | 3),
    ]);
    expect(decodeCompletionChunk(buf)).toEqual({ kind: 'unknown' });
  });

  it('skips non-target fields inside a ContentChunk before finding text', () => {
    const inner = concat([
      varintField(7, 1),
      concat([varint((8 << 3) | 1), new Uint8Array(8)]),
      concat([varint((9 << 3) | 5), new Uint8Array(4)]),
      strField(2, 'not-me'),
      strField(1, 'found'),
    ]);
    expect(decodeCompletionChunk(lenField(1, inner))).toEqual({ kind: 'content', text: 'found' });
  });

  it('done chunk without usage decodes to zero tokens', () => {
    expect(decodeCompletionChunk(lenField(3, varintField(2, 4)))).toEqual({
      kind: 'done',
      promptTokens: 0,
      completionTokens: 0,
    });
  });

  it('done chunk skips foreign fields around and inside usage', () => {
    const usage = concat([
      lenField(3, new TextEncoder().encode('skip')), // len-delim inside usage → skipped
      varintField(1, 11),
      varintField(2, 22),
    ]);
    const done = concat([varintField(2, 9), lenField(1, usage)]);
    expect(decodeCompletionChunk(lenField(3, done))).toEqual({
      kind: 'done',
      promptTokens: 11,
      completionTokens: 22,
    });
  });

  it('error chunk without a message field falls back to a default message', () => {
    expect(decodeCompletionChunk(lenField(4, varintField(2, 1))).message).toMatch(/windsurf/i);
  });

  it('multi-byte varint lengths round-trip through the request builder', () => {
    const long = 'y'.repeat(300); // forces encodeVarint's continuation branch
    const proto = buildGetChatMessageRequest('k', resolveWsModelId('m'), [
      { role: 'user', content: long },
    ]);
    expect(new TextDecoder().decode(proto)).toContain(long);
  });
});
