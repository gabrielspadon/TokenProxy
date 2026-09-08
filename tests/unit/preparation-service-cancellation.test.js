import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressWithHeadroom, resetHeadroomCircuitBreaker } from '../../open-sse/rtk/headroom.js';
import { reorderByRelevance } from '../../open-sse/utils/embedReorder.js';
import { compressWithPxpipe } from '../../open-sse/rtk/pxpipe.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
afterEach(() => { vi.unstubAllGlobals(); resetHeadroomCircuitBreaker(); });
const messages = () => [
  { role: 'user', content: 'Earlier question'.repeat(100) }, { role: 'assistant', content: 'Earlier answer'.repeat(100) },
  { role: 'user', content: 'Second question'.repeat(100) }, { role: 'assistant', content: 'Second answer'.repeat(100) },
  { role: 'user', content: 'Current request' }, { role: 'assistant', content: 'Protected answer' },
];

describe('optional preparation cancellation', () => {
  for (const service of ['headroom', 'embedding']) it(`cancels ${service} without changing caller input or treating abort as provider failure`, async () => {
    let observedSignal;
    vi.stubGlobal('fetch', async (_url, { signal }) => { observedSignal = signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); });
    const caller = new AbortController(), input = { messages: messages() }, before = structuredClone(input);
    const task = service === 'headroom'
      ? compressWithHeadroom(input, { enabled: true, allowLossy: true, format: 'claude', url: 'http://localhost:8787', model: 'synthetic', signal: caller.signal })
      : reorderByRelevance(input.messages, { query: 'Earlier question context', keepRecentTurns: 2, embedUrl: 'http://localhost:11434/v1/embeddings', embedModel: 'fixture', cache: new Map(), signal: caller.signal });
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await tick(); caller.abort(); await rejected; expect(observedSignal.aborted).toBe(true); expect(input).toEqual(before);
  }, 500);

  it('passes a cancellation signal to a cooperative PXPIPE adapter and ignores late output', async () => {
    const caller = new AbortController(), body = { messages: messages() }, before = structuredClone(body);
    let observedSignal;
    const transform = ({ signal }) => { observedSignal = signal; return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })); };
    const task = compressWithPxpipe(body, { enabled: true, allowLossy: true, format: 'claude', minChars: 1, transform, signal: caller.signal });
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await tick(); caller.abort(); await rejected; expect(observedSignal.aborted).toBe(true); expect(body).toEqual(before);
  }, 500);
});
