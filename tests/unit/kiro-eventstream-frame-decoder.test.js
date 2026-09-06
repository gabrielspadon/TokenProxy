// Covers the AWS EventStream frame decoder inside open-sse/executors/kiro.js:
// the header value-type table (bool/byte/short/int/long/bytes/string/timestamp/
// uuid), the per-frame bound and CRC validation, and the payload decode. These
// paths only run through the streaming executor, so frames are fed in as a
// mocked upstream body. Nothing here contacts a real endpoint: proxyFetch is
// mocked, which also keeps installGlobalProxyFetch from replacing the stub.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
  installGlobalProxyFetch: vi.fn(),
}));

const { KiroExecutor } = await import('../../open-sse/executors/kiro.js');

const encoder = new TextEncoder();
const credentials = { accessToken: 'test-token' };

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// One encoder per AWS EventStream header value type, keyed by the wire type
// byte. The decoder under test has a branch per type, and only type 7 (string)
// was previously exercised.
function headerBytes(name, type, valueBytes) {
  const nameBytes = encoder.encode(name);
  return concat([Uint8Array.of(nameBytes.length), nameBytes, Uint8Array.of(type), valueBytes]);
}

function u16(value) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value, false);
  return b;
}

function stringHeader(name, value) {
  const valueBytes = encoder.encode(value);
  return headerBytes(name, 7, concat([u16(valueBytes.length), valueBytes]));
}

function boolHeader(name, value) {
  // Types 0 and 1 carry the value in the type byte itself, no payload.
  return headerBytes(name, value ? 0 : 1, new Uint8Array(0));
}

function byteHeader(name, value) {
  const b = new Uint8Array(1);
  new DataView(b.buffer).setInt8(0, value);
  return headerBytes(name, 2, b);
}

function shortHeader(name, value) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, value, false);
  return headerBytes(name, 3, b);
}

function intHeader(name, value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, value, false);
  return headerBytes(name, 4, b);
}

function longHeader(name) {
  // Types 5 and 8 are 8 bytes the decoder skips rather than surfaces.
  return headerBytes(name, 5, new Uint8Array(8));
}

function timestampHeader(name) {
  return headerBytes(name, 8, new Uint8Array(8));
}

function bytesHeader(name, valueBytes) {
  return headerBytes(name, 6, concat([u16(valueBytes.length), valueBytes]));
}

function uuidHeader(name) {
  return headerBytes(name, 9, new Uint8Array(16));
}

function checksum(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(8, crc32(bytes.subarray(0, 8)), false);
  view.setUint32(bytes.byteLength - 4, crc32(bytes.subarray(0, bytes.byteLength - 4)), false);
  return bytes;
}

// payload === null builds a frame with a zero-length body, which is the
// "headers only" shape the decoder returns as { payload: null }.
function frameFrom(headerChunks, payload) {
  const headers = concat(headerChunks);
  const payloadBytes =
    payload === null
      ? new Uint8Array(0)
      : encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const totalLength = 12 + headers.byteLength + payloadBytes.byteLength + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headers.byteLength, false);
  frame.set(headers, 12);
  frame.set(payloadBytes, 12 + headers.byteLength);
  return checksum(frame);
}

function textFrame(eventType, payload, extraHeaders = []) {
  return frameFrom([stringHeader(':event-type', eventType), ...extraHeaders], payload);
}

function response(frames, status = 200) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const value of frames) controller.enqueue(value);
        controller.close();
      },
    }),
    { status, statusText: status === 200 ? 'OK' : 'Upstream Error' }
  );
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out + decoder.decode();
    out += decoder.decode(value, { stream: true });
  }
}

// A decode failure triggers the executor's ONE bounded integrity retry, which
// issues a second upstream call. Both are mocked: the first carries the frames
// under test, the second a clean stream, so the retry resolves instead of
// stalling against an unmocked upstream. The failed attempt's decoder message
// still reaches the client in the retry diagnostics.
async function runFrames(frames, { retryFrames = null } = {}) {
  fetchMock.mockResolvedValueOnce(response(frames));
  fetchMock.mockResolvedValueOnce(
    response(retryFrames || [textFrame('assistantResponseEvent', { content: 'retry-clean' })])
  );
  const result = await new KiroExecutor().execute({
    model: 'kr/claude-opus-4.8',
    body: {
      conversationState: {
        history: [],
        currentMessage: { userInputMessage: { content: 'hi', modelId: 'claude-opus-4.8' } },
      },
    },
    stream: true,
    credentials,
  });
  return readAll(result.response.body);
}

// The executor answers a decode failure with an SSE error envelope rather than
// throwing, so a decoder assertion reads the emitted error message.
function errorsIn(sse) {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]')
    .map((line) => {
      try {
        return JSON.parse(line.slice(6)).error;
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.message);
}

// A decoder rejection only reaches the client once BOTH the initial attempt and
// the bounded retry fail; a recovered request deliberately releases only the
// retry's own output. The envelope carries the decoder's message on the outer
// error, so that is where a decode assertion reads.
function failureMessages(sse) {
  return errorsIn(sse).map((e) => e.message);
}

function textIn(sse) {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]')
    .flatMap((line) => {
      try {
        return JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || [];
      } catch {
        return [];
      }
    })
    .join('');
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('EventStream header value types', () => {
  it('decodes a frame carrying every header value type alongside the event type', async () => {
    // A real Kiro frame carries only string headers, but the decoder implements
    // the whole AWS table. Sending one of each proves no type byte desyncs the
    // header cursor: if any branch consumed the wrong width, :event-type would
    // no longer be found and the assistant text would not arrive.
    const sse = await runFrames([
      textFrame('assistantResponseEvent', { content: 'typed-headers-ok' }, [
        boolHeader('h-true', true),
        boolHeader('h-false', false),
        byteHeader('h-byte', -7),
        shortHeader('h-short', -300),
        intHeader('h-int', 70000),
        longHeader('h-long'),
        timestampHeader('h-ts'),
        bytesHeader('h-bytes', Uint8Array.of(1, 2, 3)),
        uuidHeader('h-uuid'),
      ]),
      textFrame('messageStopEvent', {}),
    ]);

    expect(errorsIn(sse)).toEqual([]);
    expect(textIn(sse)).toContain('typed-headers-ok');
  });

  it('rejects an unknown header value type', async () => {
    const bad = () => [
      textFrame('assistantResponseEvent', { content: 'x' }, [
        headerBytes('h-weird', 42, new Uint8Array(0)),
      ]),
    ];
    const messages = failureMessages(await runFrames(bad(), { retryFrames: bad() }));
    expect(messages.some((m) => /unknown type 42/i.test(m))).toBe(true);
  });

  it('rejects a header whose declared value runs past the header block', async () => {
    // Declare a 64-byte string value but supply none of it, so the value would
    // read past the header block and into the payload region.
    const bad = () => {
      const truncated = concat([
        Uint8Array.of(5),
        encoder.encode('trunc'),
        Uint8Array.of(7),
        u16(64),
      ]);
      return [frameFrom([truncated], { content: 'x' })];
    };
    const messages = failureMessages(await runFrames(bad(), { retryFrames: bad() }));
    expect(messages.some((m) => /exceeds its declared bounds/i.test(m))).toBe(true);
  });

  it('keeps a rejected header type private when the bounded retry succeeds', async () => {
    // The failed attempt's frames must never reach the client once the retry
    // produces a clean stream; only the retry's own text is released.
    const sse = await runFrames([
      textFrame('assistantResponseEvent', { content: 'must stay private' }, [
        headerBytes('h-weird', 42, new Uint8Array(0)),
      ]),
    ]);
    expect(errorsIn(sse)).toEqual([]);
    expect(textIn(sse)).toContain('retry-clean');
    expect(sse).not.toContain('must stay private');
  });
});

describe('EventStream frame validation', () => {
  // The prelude-CRC, message-CRC, out-of-bounds-headers and duplicate-header
  // cases are already asserted in kiro-terminal-integrity.test.js, which owns
  // the retry-and-recover contract. What is left here is the decoder's own
  // payload handling, which that file does not reach.

  it('rejects a payload that is not valid JSON', async () => {
    const bad = () => [
      frameFrom([stringHeader(':event-type', 'assistantResponseEvent')], '{not json'),
    ];
    const sse = await runFrames(bad(), { retryFrames: bad() });
    expect(failureMessages(sse).some((m) => /payload is not valid JSON/i.test(m))).toBe(true);
    // Both attempts are reported, and both name the frame decoder.
    const [error] = errorsIn(sse);
    expect(error.details.attempts.map((a) => a.terminal_provenance)).toEqual([
      'corrupt_eventstream_frame',
      'corrupt_eventstream_frame',
    ]);
  });
});

describe('EventStream empty payloads', () => {
  it('treats a zero-length and a whitespace-only payload as no payload', async () => {
    // Both return { payload: null }. A messageStopEvent still terminates the
    // stream cleanly, so the absence of an error envelope is the assertion.
    for (const payload of [null, '   \n\t ']) {
      const sse = await runFrames([
        frameFrom([stringHeader(':event-type', 'messageStopEvent')], payload),
      ]);
      expect(errorsIn(sse)).toEqual([]);
      expect(sse).toContain('[DONE]');
    }
  });
});
