import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('undici', () => ({
  ProxyAgent: class ProxyAgent { async close() {} },
  Agent: class Agent { async close() {} },
}));

afterEach(() => vi.unstubAllGlobals());

describe('an aborted request never falls back to direct (#2211)', () => {
  for (const host of ['example.com', 'cloudcode-pa.googleapis.com']) {
    for (const strictProxy of [false, true]) {
      it.each([
        new DOMException('This operation was aborted', 'AbortError'),
        new DOMException('The operation timed out', 'TimeoutError'),
        Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }),
        new Error('The operation was aborted'),
      ])(`preserves transport cancellation for ${host}, strict=${strictProxy}: %s`, async (reason) => {
        const fetch = vi.fn(async () => { throw reason; });
        vi.stubGlobal('fetch', fetch);
        vi.resetModules();
        const { proxyAwareFetch } = await import('../../open-sse/utils/proxyFetch.js');
        await expect(proxyAwareFetch(`https://${host}/fixture`, { method: 'GET' }, {
          connectionProxyEnabled: true,
          connectionProxyUrl: 'http://127.0.0.1:19999',
          connectionNoProxy: '',
          strictProxy,
        })).rejects.toBe(reason);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][1].dispatcher.constructor.name).toBe('ProxyAgent');
      });
    }
  }

  it('rejects before dispatch when the caller cancels during pool creation', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.resetModules();
    const { proxyAwareFetch } = await import('../../open-sse/utils/proxyFetch.js');
    const caller = new AbortController();
    const reason = new DOMException('client left', 'AbortError');
    const pending = proxyAwareFetch('https://example.com/fixture', { signal: caller.signal }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: 'http://127.0.0.1:19999',
      connectionNoProxy: '',
      strictProxy: true,
    });
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });
});
