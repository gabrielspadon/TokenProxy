// #2476: "Headroom (maybe also RTK) not working with TokenProxy on Windows".
// Reporter's own words: headroom works when Codex is wrapped with it
// directly, but tokenproxy's own integration against the default
// "http://localhost:8787" never shows any compression happening. On Windows,
// Node commonly resolves the bare "localhost" hostname to the IPv6 loopback
// (::1) before the IPv4 one, while headroom-ai's `proxy` binds only 127.0.0.1
// — every call then fails with ECONNREFUSED and compressWithHeadroom's
// fail-open swallows it silently, matching "the numbers did not change".
//
// Dispatcher identity is checked by shape, not `instanceof Agent`: this repo
// and `tests/` are separate npm packages with their own `undici` installs,
// so an `Agent` imported here would be a different class than the one
// `open-sse/rtk/headroom.js` constructs against its own copy.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { compressWithHeadroom as compressWithPolicy, resetHeadroomCircuitBreaker } from '../../open-sse/rtk/headroom.js';
// Legacy proxy-contract fixtures explicitly permit lossy text compression.
const compressWithHeadroom = (body, options) => compressWithPolicy(body, { ...options, allowLossy: true });
import { probeProxyRunning } from '../../src/lib/headroom/detect.js';

afterEach(() => {
  vi.restoreAllMocks();
  resetHeadroomCircuitBreaker();
});

describe('headroom compress call forces IPv4 for the default localhost endpoint', () => {
  it("passes a connection dispatcher when the endpoint host is the literal 'localhost'", async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [{ role: 'user', content: 'short' }],
          tokens_before: 100,
          tokens_after: 10,
          tokens_saved: 90,
        }),
        { status: 200 }
      )
    );

    await compressWithHeadroom(
      { messages: [{ role: 'user', content: 'long enough to compress' }] },
      {
        enabled: true,
        url: 'http://localhost:8787',
        model: 'm',
        format: 'openai',
        diagnostics: {},
      }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, opts] = fetchSpy.mock.calls[0];
    // URL string itself is unchanged — only the connection dispatcher is scoped.
    expect(calledUrl).toBe('http://localhost:8787/v1/compress');
    expect(opts.dispatcher).toBeTruthy();
    expect(typeof opts.dispatcher).toBe('object');
  });

  it('leaves a non-localhost endpoint (an explicit IP or remote host) alone', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [{ role: 'user', content: 'short' }],
          tokens_before: 100,
          tokens_after: 10,
          tokens_saved: 90,
        }),
        { status: 200 }
      )
    );

    await compressWithHeadroom(
      { messages: [{ role: 'user', content: 'long enough to compress' }] },
      {
        enabled: true,
        url: 'http://127.0.0.1:8787',
        model: 'm',
        format: 'openai',
        diagnostics: {},
      }
    );

    expect(fetchSpy.mock.calls[0][1].dispatcher).toBeUndefined();
  });
});

describe('headroom health probe forces IPv4 for the default localhost endpoint', () => {
  it('passes a connection dispatcher to the /health fetch for localhost', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    await probeProxyRunning('http://localhost:8787');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].dispatcher).toBeTruthy();
  });

  it('does not attach a dispatcher for a remote headroom URL', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    await probeProxyRunning('http://headroom.example:8787');

    expect(fetchSpy.mock.calls[0][1].dispatcher).toBeUndefined();
  });
});
