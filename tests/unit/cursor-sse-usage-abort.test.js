/**
 * CursorExecutor: SSE stream assembly across multiple frames, usage-accounting
 * internal consistency (billing-relevant), gzip frame decompression at the
 * executor level, upstream non-200 on the legacy ChatService path, and an
 * abort mid-stream propagating out of execute() rather than being swallowed.
 *
 * Idiom: constructor-injected transport stub (cursor-empty-body.test.js),
 * cursorResponseFrame builder (cursor-composer-thinking.test.js), parseSSE
 * (cursor-agent-exec-request.test.js). ZERO real network/process: transport
 * methods are replaced directly on the executor instance.
 */
import { describe, it, expect, vi } from 'vitest';
import zlib from 'node:zlib';

import { CursorExecutor } from '../../open-sse/executors/cursor.js';
import { encodeField, wrapConnectRPCFrame } from '../../open-sse/utils/cursorProtobuf.js';

const LEN = 2;

const credentials = {
  accessToken: 'cursor-token',
  providerSpecificData: { machineId: 'a'.repeat(64) },
};

// isAgentTextRequest() routes any pure-text message list to the newer
// AgentService transport; a message carrying tool_calls forces the legacy
// ChatService path, which is what makeHttp2Request/makeFetchRequest below
// actually stub (see cursor-empty-body.test.js for the same shape).
const requestBody = {
  messages: [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
    },
  ],
};

function cursorResponseFrame({ text = '', thinking = '' }, compress = false) {
  const responseFields = [];
  if (text) responseFields.push(encodeField(1, LEN, text));
  if (thinking) responseFields.push(encodeField(25, LEN, encodeField(1, LEN, thinking)));
  const response = Buffer.concat(responseFields.map((f) => Buffer.from(f)));
  const envelope = encodeField(2, LEN, response);
  return Buffer.from(wrapConnectRPCFrame(envelope, compress));
}

function parseSSE(text) {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => chunk.slice('data: '.length))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data));
}

describe('transformProtobufToSSE — multi-frame assembly', () => {
  it('assembles content across multiple frames into ordered deltas ending in [DONE]', async () => {
    const executor = new CursorExecutor();
    const buffer = Buffer.concat([
      cursorResponseFrame({ text: 'Hello, ' }),
      cursorResponseFrame({ text: 'world!' }),
    ]);
    executor.makeHttp2Request = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, body: buffer });

    const { response } = await executor.execute({
      model: 'gpt-5.2',
      body: requestBody,
      stream: true,
      credentials,
    });
    const text = await response.text();
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);

    const events = parseSSE(text);
    const content = events.map((e) => e.choices?.[0]?.delta?.content || '').join('');
    expect(content).toBe('Hello, world!');
    // First delta carries the role, subsequent ones don't repeat it.
    expect(events[0].choices[0].delta.role).toBe('assistant');
  });

  it('final chunk carries usage that is internally consistent (prompt+completion=total)', async () => {
    const executor = new CursorExecutor();
    const buffer = cursorResponseFrame({ text: 'a fairly short reply' });
    executor.makeHttp2Request = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, body: buffer });

    const { response } = await executor.execute({
      model: 'gpt-5.2',
      body: requestBody,
      stream: true,
      credentials,
    });
    const events = parseSSE(await response.text());
    const last = events[events.length - 1];
    expect(last.usage.prompt_tokens).toBeGreaterThan(0);
    expect(last.usage.completion_tokens).toBeGreaterThan(0);
    expect(last.usage.total_tokens).toBe(last.usage.prompt_tokens + last.usage.completion_tokens);
    expect(last.choices[0].finish_reason).toBe('stop');
  });
});

describe('transformProtobufToJSON — usage accounting matches the non-streaming path', () => {
  it('prompt_tokens/completion_tokens/total_tokens agree, and completion scales with reply length', async () => {
    const executor = new CursorExecutor();
    const shortBody = cursorResponseFrame({ text: 'hi' });
    const longBody = cursorResponseFrame({ text: 'a'.repeat(400) });

    executor.makeHttp2Request = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, body: shortBody });
    const shortResult = await executor.execute({
      model: 'gpt-5.2',
      body: requestBody,
      stream: false,
      credentials,
    });
    const shortJson = await shortResult.response.json();

    executor.makeHttp2Request = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, body: longBody });
    const longResult = await executor.execute({
      model: 'gpt-5.2',
      body: requestBody,
      stream: false,
      credentials,
    });
    const longJson = await longResult.response.json();

    for (const json of [shortJson, longJson]) {
      const u = json.usage;
      expect(u.total_tokens).toBe(u.prompt_tokens + u.completion_tokens);
    }
    // A longer reply must never bill fewer completion tokens than a shorter one.
    expect(longJson.usage.completion_tokens).toBeGreaterThan(shortJson.usage.completion_tokens);
    expect(shortJson.choices[0].message.content).toBe('hi');
  });
});

describe('executor-level gzip frame decoding (readCursorFrame/decompressPayload)', () => {
  it('decodes a gzip-flagged frame transparently in the SSE path', async () => {
    const executor = new CursorExecutor();
    const buffer = cursorResponseFrame({ text: 'gzip content' }, true);
    executor.makeHttp2Request = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, body: buffer });

    const { response } = await executor.execute({
      model: 'gpt-5.2',
      body: requestBody,
      stream: true,
      credentials,
    });
    const events = parseSSE(await response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || '').join('');
    expect(content).toBe('gzip content');
  });

  it('falls back through inflate when a TRAILER-flagged frame is raw zlib deflate, not gzip', async () => {
    const executor = new CursorExecutor();
    const responseFields = Buffer.from(encodeField(1, LEN, 'deflated content'));
    const envelope = Buffer.from(encodeField(2, LEN, responseFields));
    const deflated = zlib.deflateSync(envelope);
    const frame = Buffer.alloc(5 + deflated.length);
    frame[0] = 0x02; // TRAILER flag, not GZIP
    frame.writeUInt32BE(deflated.length, 1);
    deflated.copy(frame, 5);

    executor.makeHttp2Request = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, body: frame });
    const { response } = await executor.execute({
      model: 'gpt-5.2',
      body: requestBody,
      stream: false,
      credentials,
    });
    const json = await response.json();
    expect(json.choices[0].message.content).toBe('deflated content');
  });
});

describe('execute — upstream non-200 on the legacy ChatService path', () => {
  it('wraps a non-200 transport status into an invalid_request_error JSON body without transforming', async () => {
    const executor = new CursorExecutor();
    executor.makeHttp2Request = vi
      .fn()
      .mockResolvedValue({ status: 429, headers: {}, body: Buffer.from('rate limited upstream') });
    executor.transformProtobufToSSE = vi.fn();
    executor.transformProtobufToJSON = vi.fn();

    const { response } = await executor.execute({
      model: 'gpt-5.2',
      body: requestBody,
      stream: true,
      credentials,
    });
    expect(response.status).toBe(429);
    const json = await response.json();
    expect(json.error.type).toBe('invalid_request_error');
    expect(json.error.message).toContain('rate limited upstream');
    expect(executor.transformProtobufToSSE).not.toHaveBeenCalled();
  });
});

describe('execute — error/abort mid-stream', () => {
  it('an AbortError thrown by the transport propagates out of execute rather than becoming a 500', async () => {
    const executor = new CursorExecutor();
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    executor.makeHttp2Request = vi.fn().mockRejectedValue(abortError);

    await expect(
      executor.execute({ model: 'gpt-5.2', body: requestBody, stream: true, credentials })
    ).rejects.toThrow('The operation was aborted');
  });

  it('a non-abort transport error is converted into a 500 connection_error JSON body, not thrown', async () => {
    const executor = new CursorExecutor();
    executor.makeHttp2Request = vi.fn().mockRejectedValue(new Error('socket hang up'));

    const { response } = await executor.execute({
      model: 'gpt-5.2',
      body: requestBody,
      stream: true,
      credentials,
    });
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error.type).toBe('connection_error');
    expect(json.error.message).toBe('socket hang up');
  });

  it('a JSON error frame with resource_exhausted and no prior content returns a 429 rather than a truncated stream', async () => {
    const executor = new CursorExecutor();
    // Byte-sniffed by the executor before protobuf decode: a raw JSON body
    // starting with '{"error"' short-circuits into createErrorResponse().
    const errorPayload = Buffer.from(
      JSON.stringify({ error: { code: 'resource_exhausted', message: 'quota exceeded' } })
    );
    const frame = Buffer.alloc(5 + errorPayload.length);
    frame.writeUInt32BE(errorPayload.length, 1);
    errorPayload.copy(frame, 5);
    executor.makeHttp2Request = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, body: frame });

    const { response } = await executor.execute({
      model: 'gpt-5.2',
      body: requestBody,
      stream: true,
      credentials,
    });
    expect(response.status).toBe(429);
    const json = await response.json();
    expect(json.error.type).toBe('rate_limit_error');
    expect(json.error.message).toBe('quota exceeded');
  });

  it('an error frame arriving after real content is preserved rather than discarding the partial reply', async () => {
    const executor = new CursorExecutor();
    const errorPayload = Buffer.from(JSON.stringify({ error: 'downstream reset' }));
    const errorFrame = Buffer.alloc(5 + errorPayload.length);
    errorFrame.writeUInt32BE(errorPayload.length, 1);
    errorPayload.copy(errorFrame, 5);
    const buffer = Buffer.concat([cursorResponseFrame({ text: 'partial reply' }), errorFrame]);
    executor.makeHttp2Request = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, body: buffer });

    const { response } = await executor.execute({
      model: 'gpt-5.2',
      body: requestBody,
      stream: true,
      credentials,
    });
    expect(response.status).toBe(200);
    const events = parseSSE(await response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || '').join('');
    expect(content).toBe('partial reply');
  });
});
