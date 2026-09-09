import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createLocalTokenizer, encodingForModel, TOKENIZER_LIMITS } from '../../open-sse/utils/localTokenizer.js';
const require = createRequire(import.meta.url);
const reference = JSON.parse(fs.readFileSync(new URL('../fixtures/tokenizer/tiktoken-0.14.0.json', import.meta.url), 'utf8'));
const instances = [];
const make = options => { const value = createLocalTokenizer(options); instances.push(value); return value; };
afterEach(() => { for (const value of instances.splice(0)) value.close(); });
class StalledWorker extends EventEmitter {
  ref() {} unref() {} postMessage() {} terminate() { return Promise.resolve(); }
}
describe('verified bounded local tokenizer', () => {
  for (const encoding of ['cl100k_base', 'o200k_base']) {
    it(`${encoding} matches independent official tiktoken token IDs and worker counts`, async () => {
      const api = require(`gpt-tokenizer/cjs/encoding/${encoding}`); api.setMergeCacheSize(0);
      const rows = reference.records.filter(row => row.encoding === encoding);
      for (const row of rows) expect(api.encode(row.text, { disallowedSpecial: new Set() })).toEqual(row.ids);
      const value = await make().count(rows.map(row => row.text), { encoding });
      expect(value.counts).toEqual(rows.map(row => row.ids.length));
      expect(value).toMatchObject({ encoding, scope: 'text_only', estimated: false });
    });
  }
  it('does not infer routed aliases, unknown models or unsupported encodings', async () => {
    expect(encodingForModel('openai/gpt-4o')).toBeNull();
    expect(encodingForModel('gpt-4o-fake')).toBeNull();
    await expect(make().count(['hello'], { model: 'claude-sonnet-4' })).rejects.toMatchObject({ code: 'unsupported_model' });
  });
  it('bounds input by UTF-8 bytes before dispatch', async () => {
    await expect(make().count(['🌊'.repeat(32769)], { model: 'gpt-4o' })).rejects.toMatchObject({ code: 'input_too_large' });
  });
  it('bounds queue bytes including the active request and cancels all admissions', async () => {
    const tokenizer = make({ workerFactory: () => new StalledWorker() });
    const controller = new AbortController();
    const results = Array.from({ length: 4 }, () => tokenizer.count(['a'.repeat(131072)], { model: 'gpt-4o', signal: controller.signal }).catch(error => error.code));
    await expect(tokenizer.count(['x'], { model: 'gpt-4o' })).rejects.toMatchObject({ code: 'overloaded' });
    expect(tokenizer.status()).toMatchObject({ requests: 4, bytes: TOKENIZER_LIMITS.queuedBytes });
    controller.abort();
    expect(await Promise.all(results)).toEqual(Array(4).fill('aborted'));
    expect(tokenizer.status()).toMatchObject({ requests: 0, bytes: 0 });
  });
  it('bounds empty jobs by count and drains shutdown idempotently', async () => {
    const tokenizer = make({ workerFactory: () => new StalledWorker() });
    const results = Array.from({ length: 16 }, () => tokenizer.count([], { model: 'gpt-4o' }).catch(error => error.code));
    await expect(tokenizer.count([], { model: 'gpt-4o' })).rejects.toMatchObject({ code: 'overloaded' });
    tokenizer.close(); tokenizer.close();
    expect(await Promise.all(results)).toEqual(Array(16).fill('tokenizer_closed'));
    expect(tokenizer.status().bytes).toBe(0);
  });
  it('expires stalled work, rejects pre-abort and recovers from worker failure', async () => {
    let worker;
    const tokenizer = make({ workerFactory: () => { worker = new StalledWorker(); return worker; } });
    await expect(tokenizer.count(['x'], { model: 'gpt-4o', signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'aborted' });
    await expect(tokenizer.count(['x'], { model: 'gpt-4o', timeoutMs: 2 })).rejects.toMatchObject({ code: 'timeout' });
    const result = tokenizer.count(['x'], { model: 'gpt-4o' });
    await new Promise(resolve => setImmediate(resolve));
    worker.emit('error', new Error('controlled failure'));
    await expect(result).rejects.toMatchObject({ code: 'tokenizer_failed' });
    expect(tokenizer.status().bytes).toBe(0);
  });
  it('keeps main event loop responsive during a cold actual worker count', async () => {
    let timerRan = false;
    const timer = new Promise(resolve => setTimeout(() => { timerRan = true; resolve(); }, 0));
    const result = await make().count(['Unicode 🌊 code '.repeat(6000)], { model: 'gpt-4o' });
    expect(result.tokens).toBeGreaterThan(0); expect(timerRan).toBe(true); await timer;
  });
});
