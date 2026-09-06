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

// An accepted stream is decoded exactly once. A second dispatch is forbidden,
// even if an intact replacement answer could be obtained.
async function runFrames(frames) {
  fetchMock.mockResolvedValueOnce(response(frames));
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

function expectCorruptFrame(sse) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(errorsIn(sse)).toMatchObject([{
    code: 'kiro_missing_terminal',
    details: { terminal_provenance: 'corrupt_eventstream_frame', transport_state: 'corrupt_frame', safe_to_replay: false },
  }]);
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
    expectCorruptFrame(await runFrames(bad()));
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
    expectCorruptFrame(await runFrames(bad()));
  });

  it('keeps a rejected header type private without a replacement generation', async () => {
    const sse = await runFrames([
      textFrame('assistantResponseEvent', { content: 'must stay private' }, [
        headerBytes('h-weird', 42, new Uint8Array(0)),
      ]),
    ]);
    expectCorruptFrame(sse);
    expect(textIn(sse)).toBe('');
    expect(sse).not.toContain('must stay private');
  });
});

describe('EventStream frame validation', () => {
  // The prelude-CRC, message-CRC, out-of-bounds-headers and duplicate-header
  // cases are already asserted in kiro-terminal-integrity.test.js, which owns
  // the accepted-response integrity contract. What is left here is the decoder's own
  // payload handling, which that file does not reach.

  it('rejects a payload that is not valid JSON', async () => {
    const bad = () => [
      frameFrom([stringHeader(':event-type', 'assistantResponseEvent')], '{not json'),
    ];
    expectCorruptFrame(await runFrames(bad()));
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
