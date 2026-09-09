import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { afterEach, describe, expect, it } from 'vitest';
import { POST } from '../../src/app/api/v1/messages/count_tokens/route.js';
import { createLocalTokenizer, TOKENIZER_LIMITS } from '../../open-sse/utils/localTokenizer.js';

const request = (body, options = {}) => new Request('http://localhost/v1/messages/count_tokens', { method: 'POST', body: JSON.stringify(body), ...options });
const trickle = (text, chunk = 1) => new Request('http://localhost/v1/messages/count_tokens', { method: 'POST', duplex: 'half', body: new ReadableStream({
  start(controller) { const bytes = Buffer.from(text); for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.subarray(i, i + chunk)); controller.close(); } }) });

describe('count endpoint body chunk overhead', () => {
  it('accepts a body trickled one byte at a time without holding one Buffer per chunk', async () => {
    const body = JSON.stringify({ model: 'gpt-4o', messages: [{ content: 'hello world '.repeat(4000) }] });
    const whole = await (await POST(request(JSON.parse(body)))).json();
    // The staging invariant is observable at the final concat: a 48 KiB body
    // that arrived as ~48k one-byte chunks is assembled from at most
    // ceil(size / 64 KiB) staged blocks, never one Buffer per chunk.
    const concat = Buffer.concat;
    const lists = [];
    Buffer.concat = (list, length) => { lists.push(list.length); return concat.call(Buffer, list, length); };
    let response;
    try { response = await POST(trickle(body, 1)); } finally { Buffer.concat = concat; }
    expect(response.status).toBe(200);
    const parsed = await response.json();
    expect(parsed.input_tokens).toBe(whole.input_tokens);
    expect(Math.max(...lists)).toBeLessThanOrEqual(Math.ceil(Buffer.byteLength(body) / 65536));
  });
  it('still refuses a trickled body past 4 MiB and one past the tokenizer text bound', async () => {
    const big = JSON.stringify({ model: 'gpt-4o', messages: [{ content: 'a'.repeat(4 * 1024 * 1024) }] });
    expect((await POST(trickle(big, 65536))).status).toBe(413);
    const text = JSON.stringify({ model: 'gpt-4o', messages: [{ content: 'a'.repeat(TOKENIZER_LIMITS.inputBytes + 1) }] });
    expect((await POST(trickle(text, 7919))).status).toBe(413);
  });
  it('reassembles chunk boundaries that split multi-byte characters', async () => {
    const body = JSON.stringify({ model: 'gpt-4o', messages: [{ content: '日本語🧭'.repeat(3000) }] });
    const whole = await (await POST(request(JSON.parse(body)))).json();
    const split = await (await POST(trickle(body, 3))).json();
    expect(split.input_tokens).toBe(whole.input_tokens);
  });
});

describe('tokenizer worker cancellation and replacement under load', () => {
  const instances = [];
  const make = () => { const value = createLocalTokenizer(); instances.push(value); return value; };
  afterEach(() => { for (const value of instances.splice(0)) value.close(); });
  it('aborting active work replaces the worker and later queued and new requests still complete', async () => {
    const tokenizer = make();
    // Four in flight at ~96 KiB each stays under the 512 KiB queued-byte bound.
    const heavy = 'Unicode 🌊 code '.repeat(5000);
    for (let round = 0; round < 3; round++) {
      const controller = new AbortController();
      const cancelled = tokenizer.count([heavy], { model: 'gpt-4o', signal: controller.signal }).catch(error => error.code);
      const survivors = Array.from({ length: 3 }, () => tokenizer.count([heavy], { model: 'gpt-4o' }));
      await new Promise(resolve => setImmediate(resolve));
      controller.abort();
      expect(await cancelled).toBe('aborted');
      const results = await Promise.all(survivors);
      expect(new Set(results.map(result => result.tokens)).size).toBe(1);
      expect(results[0].tokens).toBeGreaterThan(0);
    }
    expect(tokenizer.status()).toMatchObject({ requests: 0, bytes: 0 });
  });
  it('keeps resident memory bounded across repeated maximum-size counts', async () => {
    const tokenizer = make();
    // Realistic mixed text at the exact byte bound; a single repeated character
    // exercises BPE merge pathology rather than memory.
    const unit = 'The quick brown fox 🦊 jumps over 13 lazy dogs; naïve café résumé. ';
    const text = unit.repeat(Math.floor(TOKENIZER_LIMITS.inputBytes / Buffer.byteLength(unit)));
    await tokenizer.count([text], { model: 'gpt-4o' });
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 12; i++) await tokenizer.count([text], { model: 'gpt-4o' });
    expect(process.memoryUsage().rss - before).toBeLessThan(160 * 1024 * 1024);
    expect(tokenizer.status().peakBytes).toBeLessThanOrEqual(TOKENIZER_LIMITS.queuedBytes);
  });
  it('a worker that exceeds its heap limit fails the job without taking the process down', async () => {
    const tokenizer = createLocalTokenizer({ workerFactory: options => new (require('node:worker_threads').Worker)('setInterval(()=>{globalThis.keep=(globalThis.keep||[]).concat([Buffer.alloc(8*1024*1024)])},0)', { eval: true, ...options, resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 } }) });
    instances.push(tokenizer);
    await expect(tokenizer.count(['x'], { model: 'gpt-4o', timeoutMs: 8000 })).rejects.toMatchObject({ code: expect.stringMatching(/tokenizer_failed|timeout/) });
    expect(tokenizer.status().bytes).toBe(0);
  });
});
