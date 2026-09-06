// MAX_COMPRESS_BODY_BYTES gate: open-sse/rtk/headroom.js compressWithHeadroom
// skips compression when the WHOLE request body serializes past 256 KiB
// (`sizeSnapshot.bodyBytes > MAX_COMPRESS_BODY_BYTES`, 262144 bytes). Bodies
// are built by padding a tool result; jsonBytes == byte length of
// JSON.stringify, so padding chars are solved arithmetically.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { compressWithHeadroom as compressWithPolicy } from '../../open-sse/rtk/headroom.js';
// Legacy proxy-contract fixtures explicitly permit lossy text compression.
const compressWithHeadroom = (body, options) => compressWithPolicy(body, { ...options, allowLossy: true });

const PROXY = 'http://127.0.0.1:8787';
const LIMIT = 256 * 1024; // MAX_COMPRESS_BODY_BYTES

function bodyAtBytes(target) {
  const body = { model: 'm', messages: [{ role: 'user', content: '' }] };
  const base = new TextEncoder().encode(JSON.stringify(body)).length;
  const pad = target - base; // 'x' is 1 byte/char and never escapes
  if (pad < 1) throw new Error('target too small');
  body.messages[0].content = 'x'.repeat(pad);
  const check = new TextEncoder().encode(JSON.stringify(body)).length;
  if (check !== target) throw new Error(`padding off: ${check} != ${target}`);
  return body;
}

function okRes(messages) {
  return new Response(
    JSON.stringify({ messages, tokens_before: 100000, tokens_after: 5000, tokens_saved: 95000 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MAX_COMPRESS_BODY_BYTES size gate', () => {
  it('body at LIMIT-1 compresses', async () => {
    const body = bodyAtBytes(LIMIT - 1);
    const fetchMock = vi.fn(async () => okRes([{ role: 'user', content: 'ok' }]));
    global.fetch = fetchMock;
    const diagnostics = {};
    const result = await compressWithHeadroom(body, {
      enabled: true,
      url: PROXY,
      model: 'm',
      format: 'openai',
      diagnostics,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(body.messages[0].content).toBe('ok');
  });

  it('body exactly at LIMIT compresses (gate is strictly-greater)', async () => {
    const body = bodyAtBytes(LIMIT);
    const fetchMock = vi.fn(async () => okRes([{ role: 'user', content: 'ok' }]));
    global.fetch = fetchMock;
    const result = await compressWithHeadroom(body, {
      enabled: true,
      url: PROXY,
      model: 'm',
      format: 'openai',
      diagnostics: {},
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(body.messages[0].content).toBe('ok');
  });

  it('body at LIMIT+1 skips: no fetch, body untouched, diagnostic names the limit', async () => {
    const body = bodyAtBytes(LIMIT + 1);
    const original = JSON.parse(JSON.stringify(body));
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch must not be called');
    });
    global.fetch = fetchMock;
    const diagnostics = {};
    const result = await compressWithHeadroom(body, {
      enabled: true,
      url: PROXY,
      model: 'm',
      format: 'openai',
      diagnostics,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(body).toEqual(original);
    expect(JSON.stringify(diagnostics)).toContain('payload too large');
    expect(JSON.stringify(diagnostics)).toContain(String(LIMIT));
  });

  it('measurement includes the whole body, not just messages (non-claude formats still skip)', async () => {
    // A body whose messages are tiny but whose OTHER fields push it past the
    // limit must still skip — the gate reads captureSizeSnapshot(body). This
    // whole-body skip only applies to non-claude formats now; the claude
    // format slices instead (see the "claude" describe block below).
    const pad = LIMIT; // oversized system field alone
    const body = {
      model: 'm',
      system: 's'.repeat(pad),
      messages: [{ role: 'user', content: 'hi' }],
    };
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch must not be called');
    });
    global.fetch = fetchMock;
    const result = await compressWithHeadroom(body, {
      enabled: true,
      url: PROXY,
      model: 'm',
      format: 'openai',
      diagnostics: {},
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe('claude format: oversized body slices instead of skipping', () => {
  it('compresses only the oldest messages that fit under the cap, never the last two', async () => {
    // Many equally sized messages so the body comfortably exceeds the cap.
    const MSG_BYTES = 20 * 1024;
    const TOTAL_MESSAGES = 20;
    const messages = [];
    for (let i = 0; i < TOTAL_MESSAGES; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(MSG_BYTES) });
    }
    const body = { model: 'm', messages };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).length;
    expect(bodyBytes).toBeGreaterThan(LIMIT); // sanity: this body needs slicing

    const fetchMock = vi.fn(async (_url, opts) => {
      const payload = JSON.parse(opts.body);
      // Small compressed stand-in so the byte-gain guard commits the result.
      return okRes(payload.messages.map((m) => ({ role: m.role, content: 'c' })));
    });
    global.fetch = fetchMock;
    const diagnostics = {};
    const result = await compressWithHeadroom(body, {
      enabled: true,
      url: PROXY,
      model: 'm',
      format: 'claude',
      diagnostics,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    const sentMessages = JSON.parse(fetchMock.mock.calls[0][1].body).messages;
    // Strict prefix of the original messages, fewer than the total, and
    // never reaching into the last two.
    expect(sentMessages).toEqual(messages.slice(0, sentMessages.length));
    expect(sentMessages.length).toBeLessThan(messages.length);
    expect(sentMessages.length).toBeLessThanOrEqual(messages.length - 2);
    expect(diagnostics.sliced).toEqual({ messages: sentMessages.length, of: messages.length });
  });
});
