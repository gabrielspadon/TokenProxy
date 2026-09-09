import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup }));
import { prefetchRemoteImages } from '../../open-sse/translator/concerns/prefetch.js';
import { fetchImageAsBase64 } from '../../open-sse/translator/concerns/image.js';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const bodyOf = urls => ({ messages: [{ role: 'user', content: urls.map(url => ({ type: 'image_url', image_url: { url } })) }] });
const tick = () => new Promise(resolve => setImmediate(resolve));
beforeEach(() => { lookup.mockReset(); lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); });
afterEach(() => vi.unstubAllGlobals());

describe('bounded remote-image preparation', () => {
  it('coalesces repeated URLs, bounds concurrent work and commits in source order', async () => {
    const pending = new Map(), calls = []; let active = 0, peak = 0;
    vi.stubGlobal('fetch', async (url, { signal }) => {
      calls.push(url); active++; peak = Math.max(peak, active);
      await new Promise((resolve, reject) => { pending.set(url, resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      active--;
      return new Response(Uint8Array.from([...png, url.endsWith('a') ? 1 : url.endsWith('b') ? 2 : 3]));
    });
    const body = bodyOf(['https://images.test/a', 'https://images.test/b', 'https://images.test/a', 'https://images.test/c']);
    const original = structuredClone(body);
    const result = prefetchRemoteImages(body, 'openai', 'gemini', { concurrency: 2 });
    await tick(); expect(calls).toHaveLength(2); expect(body).toEqual(original);
    pending.get('https://images.test/b')(); await tick(); expect(calls).toHaveLength(3);
    pending.get('https://images.test/c')(); pending.get('https://images.test/a')();
    expect(await result).toBe(4); expect(peak).toBe(2); expect(calls).toHaveLength(3);
    expect(body.messages[0].content.map(block => Buffer.from(block.image_url.url.split(',')[1], 'base64').at(-1))).toEqual([1, 2, 1, 3]);
  });

  it('refuses aggregate expansion from repeated images without partially mutating the request', async () => {
    vi.stubGlobal('fetch', async () => new Response(png));
    const body = bodyOf(['https://images.test/a', 'https://images.test/a']), before = structuredClone(body);
    await expect(prefetchRemoteImages(body, 'openai', 'gemini', { maxTotalBytes: 12 })).rejects.toMatchObject({ code: 'media_aggregate_limit' });
    expect(body).toEqual(before);
  });

  it('cancels readers and queued images together and does not commit completed siblings', async () => {
    const caller = new AbortController(), started = [], cancelled = [];
    vi.stubGlobal('fetch', async url => {
      started.push(url);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(png); }, cancel() { cancelled.push(url); } }));
    });
    const body = bodyOf(['https://images.test/a', 'https://images.test/b', 'https://images.test/c']), before = structuredClone(body);
    const promise = prefetchRemoteImages(body, 'openai', 'gemini', { concurrency: 2, signal: caller.signal });
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await tick(); caller.abort(); await rejected;
    expect(started).toHaveLength(2); expect(cancelled).toHaveLength(2); expect(body).toEqual(before);
  });

  it('keeps timeout protection when caller cancellation is supplied', async () => {
    vi.stubGlobal('fetch', async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
    const caller = new AbortController();
    await expect(fetchImageAsBase64('https://images.test/a', { signal: caller.signal, timeoutMs: 10 })).resolves.toBeNull();
    expect(caller.signal.aborted).toBe(false);
  }, 500);

  it('abandons DNS lookup promptly and never starts fetch after late DNS success', async () => {
    let finish; lookup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const caller = new AbortController();
    const promise = fetchImageAsBase64('https://images.test/a', { signal: caller.signal });
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await tick(); caller.abort(); await rejected;
    finish([{ address: '93.184.216.34', family: 4 }]); await tick();
    expect(fetch).not.toHaveBeenCalled();
  });
});
