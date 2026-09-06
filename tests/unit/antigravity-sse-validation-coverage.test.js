import { describe, expect, it, vi } from 'vitest';
import {
  classifyAntigravityJsonValidation,
  readBoundedAntigravityJson,
  classifyAntigravitySseOutcome,
  classifyAntigravitySseValidation,
  createAntigravitySseValidationGate,
  createSseTextStream,
} from 'open-sse/handlers/chatCore/antigravitySseValidation.js';
import {
  ANTIGRAVITY_SAFE_ERROR_MESSAGE,
  ANTIGRAVITY_VERIFICATION_REQUIRED_MESSAGE,
} from 'open-sse/services/antigravityValidation.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// A payload classifyAntigravityValidation({source:"chat"}) recognises as
// VALIDATION_REQUIRED, built from the service's own contract.
const VALIDATION_URL = 'https://accounts.google.com/verify?u=1';
const VALIDATION_PAYLOAD = {
  error: {
    code: 403,
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        domain: 'cloudcode-pa.googleapis.com',
        reason: 'VALIDATION_REQUIRED',
        metadata: { validation_link: VALIDATION_URL },
      },
    ],
  },
};
const ERROR_PAYLOAD = { error: { message: 'upstream broke' } };
const SAFE_PAYLOAD = { choices: [{ delta: { content: 'hi' } }] };

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

function readerFrom(chunks) {
  let i = 0;
  return {
    read: async () =>
      i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
    cancel: vi.fn(async () => {}),
    releaseLock: vi.fn(),
  };
}

async function drain(stream) {
  const reader = stream.getReader();
  const parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { text: parts.join(''), error: null };
      parts.push(decoder.decode(value));
    }
  } catch (error) {
    return { text: parts.join(''), error };
  }
}

describe('classifyAntigravityJsonValidation', () => {
  it('classifies a validation payload and returns null for safe or invalid JSON', () => {
    const v = classifyAntigravityJsonValidation(JSON.stringify(VALIDATION_PAYLOAD));
    expect(v?.kind).toBe('antigravity_validation_required');
    expect(v.url).toBe(VALIDATION_URL);
    expect(classifyAntigravityJsonValidation(JSON.stringify(SAFE_PAYLOAD), 200)).toBeNull();
    expect(classifyAntigravityJsonValidation('{not json', 403)).toBeNull();
    expect(classifyAntigravityJsonValidation(undefined)).toBeNull();
  });

  it('falls back to the transport status when the payload carries none', () => {
    const payload = { error: { details: VALIDATION_PAYLOAD.error.details } };
    expect(classifyAntigravityJsonValidation(JSON.stringify(payload), 403)).toBeTruthy();
    expect(classifyAntigravityJsonValidation(JSON.stringify(payload), 200)).toBeNull();
  });
});

describe('readBoundedAntigravityJson', () => {
  it('concatenates chunks to EOF and decodes them', async () => {
    const chunks = [encoder.encode('{"a":'), encoder.encode('1}')];
    const out = await readBoundedAntigravityJson({
      reader: readerFrom(chunks.slice(1)),
      initialChunk: chunks[0],
    });
    expect(out).toEqual({ exceeded: false, text: '{"a":1}' });
  });

  it('skips empty chunks and reports an oversized body as exceeded', async () => {
    const small = await readBoundedAntigravityJson({
      reader: readerFrom([new Uint8Array(0), encoder.encode('x')]),
      initialChunk: encoder.encode('y'),
    });
    expect(small.text).toBe('yx');

    const big = new Uint8Array(64 * 1024 + 1);
    const first = await readBoundedAntigravityJson({ reader: readerFrom([]), initialChunk: big });
    expect(first).toEqual({ exceeded: true, text: null });

    const later = await readBoundedAntigravityJson({
      reader: readerFrom([big]),
      initialChunk: encoder.encode('x'),
    });
    expect(later).toEqual({ exceeded: true, text: null });
  });
});

describe('classifyAntigravitySseOutcome / classifyAntigravitySseValidation', () => {
  it('finds a validation event across complete frames, CRLF included', () => {
    const text = sse(SAFE_PAYLOAD) + `data: ${JSON.stringify(VALIDATION_PAYLOAD)}\r\n\r\n`;
    const outcome = classifyAntigravitySseOutcome(text);
    expect(outcome.kind).toBe('validation');
    expect(classifyAntigravitySseValidation(text).url).toBe(VALIDATION_URL);
  });

  it('classifies a generic error frame and returns null for safe traffic', () => {
    expect(classifyAntigravitySseOutcome(sse(ERROR_PAYLOAD)).kind).toBe('error');
    expect(classifyAntigravitySseOutcome(sse(SAFE_PAYLOAD))).toBeNull();
    expect(classifyAntigravitySseValidation(sse(ERROR_PAYLOAD))).toBeNull();
  });

  it('inspects a trailing partial frame only when includeTrailing is on', () => {
    const trailing = `data: ${JSON.stringify(ERROR_PAYLOAD)}`;
    expect(classifyAntigravitySseOutcome(trailing).kind).toBe('error');
    expect(classifyAntigravitySseOutcome(trailing, { includeTrailing: false })).toBeNull();
    expect(classifyAntigravitySseOutcome('   ')).toBeNull();
    expect(classifyAntigravitySseOutcome(null)).toBeNull();
  });

  it('ignores frames without data lines and non-JSON data', () => {
    expect(classifyAntigravitySseOutcome(': comment\n\n')).toBeNull();
    expect(classifyAntigravitySseOutcome('data: {broken\n\n')).toBeNull();
  });
});

describe('createAntigravitySseValidationGate', () => {
  it('passes safe events through and closes at upstream EOF', async () => {
    const reader = readerFrom([encoder.encode(sse(SAFE_PAYLOAD))]);
    const stream = createAntigravitySseValidationGate({
      reader,
      initialChunk: encoder.encode(sse(SAFE_PAYLOAD)),
    });
    const { text, error } = await drain(stream);
    expect(error).toBeNull();
    expect(text).toBe(sse(SAFE_PAYLOAD) + sse(SAFE_PAYLOAD));
  });

  it('terminates with the verification message on a validation event and calls the hook', async () => {
    const onValidationRequired = vi.fn();
    const reader = readerFrom([]);
    const stream = createAntigravitySseValidationGate({
      reader,
      initialChunk: encoder.encode(sse(VALIDATION_PAYLOAD)),
      onValidationRequired,
    });
    const { error } = await drain(stream);
    expect(error?.message).toBe(ANTIGRAVITY_VERIFICATION_REQUIRED_MESSAGE);
    expect(onValidationRequired).toHaveBeenCalledWith(
      expect.objectContaining({ url: VALIDATION_URL })
    );
    expect(reader.cancel).toHaveBeenCalled();
  });

  it('terminates with the safe message on a generic error event and calls the hook', async () => {
    const onUpstreamError = vi.fn();
    const stream = createAntigravitySseValidationGate({
      reader: readerFrom([]),
      initialChunk: encoder.encode(sse(ERROR_PAYLOAD)),
      onUpstreamError,
    });
    const { error } = await drain(stream);
    expect(error?.message).toBe(ANTIGRAVITY_SAFE_ERROR_MESSAGE);
    expect(onUpstreamError).toHaveBeenCalled();
  });

  it('fails safe on an oversized complete frame and on an oversized unbounded buffer', async () => {
    const bigFrame = `data: ${'x'.repeat(64 * 1024)}\n\n`;
    const framed = createAntigravitySseValidationGate({
      reader: readerFrom([]),
      initialChunk: encoder.encode(bigFrame),
    });
    expect((await drain(framed)).error?.message).toBe(ANTIGRAVITY_SAFE_ERROR_MESSAGE);

    const unbounded = createAntigravitySseValidationGate({
      reader: readerFrom([new Uint8Array(64 * 1024 + 1).fill(97)]),
      initialChunk: encoder.encode('data: start'),
    });
    expect((await drain(unbounded)).error?.message).toBe(ANTIGRAVITY_SAFE_ERROR_MESSAGE);
  });

  it('classifies trailing bytes at EOF: validation, error, and safe passthrough', async () => {
    const trailingValidation = createAntigravitySseValidationGate({
      reader: readerFrom([]),
      initialChunk: encoder.encode(`data: ${JSON.stringify(VALIDATION_PAYLOAD)}`),
    });
    expect((await drain(trailingValidation)).error?.message).toBe(
      ANTIGRAVITY_VERIFICATION_REQUIRED_MESSAGE
    );

    const trailingError = createAntigravitySseValidationGate({
      reader: readerFrom([]),
      initialChunk: encoder.encode(`data: ${JSON.stringify(ERROR_PAYLOAD)}`),
    });
    expect((await drain(trailingError)).error?.message).toBe(ANTIGRAVITY_SAFE_ERROR_MESSAGE);

    const trailingSafe = createAntigravitySseValidationGate({
      reader: readerFrom([]),
      initialChunk: encoder.encode('data: partial-safe'),
    });
    const out = await drain(trailingSafe);
    expect(out.error).toBeNull();
    expect(out.text).toBe('data: partial-safe');
  });

  it('fails safe when the upstream reader throws mid-stream', async () => {
    const reader = {
      read: async () => {
        throw new Error('upstream reset');
      },
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    const stream = createAntigravitySseValidationGate({
      reader,
      initialChunk: encoder.encode('data: waiting'),
    });
    expect((await drain(stream)).error?.message).toBe(ANTIGRAVITY_SAFE_ERROR_MESSAGE);
  });

  it('propagates cancel to the upstream reader', async () => {
    const reader = readerFrom([]);
    const stream = createAntigravitySseValidationGate({
      reader,
      initialChunk: encoder.encode(''),
    });
    await stream.cancel('bye');
    expect(reader.cancel).toHaveBeenCalledWith('bye');
  });
});

describe('createSseTextStream', () => {
  it('emits the text once and closes', async () => {
    const { text, error } = await drain(createSseTextStream('data: one\n\n'));
    expect(error).toBeNull();
    expect(text).toBe('data: one\n\n');
  });
});
