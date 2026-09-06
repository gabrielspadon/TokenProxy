// proxyAwareFetch MITM-bypass proxy branch: an abort from the proxy attempt is
// rethrown untouched (#2211), any other failure with strictProxy off logs and
// falls back to the direct bypass path. Also pins the waitWithSignal rejection
// path used by resolveRealIP when the caller hands a live (non-aborted) signal.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  state: { dnsResolve: null, dnsCalls: [] },
}));

vi.mock('dns', () => ({
  Resolver: class {
    constructor() {}
    setServers() {}
    resolve4(hostname, callback) {
      seams.state.dnsCalls.push(hostname);
      seams.state.dnsResolve(hostname, callback);
    }
  },
}));

const priorFetch = globalThis.fetch;
const nativeFetch = vi.fn();
globalThis.fetch = nativeFetch;
const { proxyAwareFetch } = await import('../../open-sse/utils/proxyFetch.js');

// DNS_CACHE is module state; shouldBypassMitmDns matches on `includes`, so each
// case gets its own sub-host of a known bypass target.
function bypassUrl(tag) {
  return `https://${tag}.proxy.individual.githubcopilot.com/chat/completions`;
}

const proxyOptions = { enabled: true, url: 'http://127.0.0.1:1', strictProxy: false };

beforeEach(() => {
  nativeFetch.mockReset();
  seams.state.dnsCalls.length = 0;
  seams.state.dnsResolve = (_hostname, callback) => callback(new Error('ENOTFOUND'));
});

afterAll(() => {
  globalThis.fetch = priorFetch;
});

describe('proxyAwareFetch MITM bypass via configured proxy', () => {
  it('rethrows an abort from the proxy attempt instead of falling back', async () => {
    const abortError = new DOMException('This operation was aborted', 'AbortError');
    nativeFetch.mockRejectedValueOnce(abortError);
    await expect(proxyAwareFetch(bypassUrl('abort'), {}, proxyOptions)).rejects.toBe(abortError);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to direct bypass on a non-abort proxy failure (even a falsy rejection)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    nativeFetch.mockRejectedValueOnce('').mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await proxyAwareFetch(bypassUrl('fallback'), {}, proxyOptions);
    expect(res.status).toBe(200);
    // proxy attempt, then (DNS failed) the post-bypass proxy retry
    expect(nativeFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to direct bypass'));
    warn.mockRestore();
  });

  it('rejects through waitWithSignal when DNS fails under a live signal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    nativeFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const controller = new AbortController();
    const res = await proxyAwareFetch(bypassUrl('signal'), { signal: controller.signal }, null);
    expect(res.status).toBe(200);
    expect(seams.state.dnsCalls.length).toBe(1);
    warn.mockRestore();
  });
});
