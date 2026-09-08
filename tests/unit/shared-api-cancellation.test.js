import { afterEach, expect, it, vi } from 'vitest';
import { call } from '../../src/shared/api.js';
afterEach(() => vi.unstubAllGlobals());
it('propagates caller cancellation and distinguishes it from network failure', async () => {
  const controller = new AbortController();
  const fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('private', 'AbortError')), { once: true })));
  vi.stubGlobal('fetch', fetch);
  const pending = call('/fixture', { method: 'POST', body: { retained: true }, signal: controller.signal });
  controller.abort();
  expect(await pending).toEqual({ ok: false, status: 0, body: { error: 'Request cancelled', code: 'cancelled' } });
  expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  vi.stubGlobal('fetch', async () => { throw new Error('connection failed'); });
  expect((await call('/fixture')).body.code).toBe('network');
});
