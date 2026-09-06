// proxyFetch transport branches the existing suites leave dark: the relay
// path, the MITM DNS-bypass request (built on mocked dns/net/https, zero real
// sockets), abort classification on the proxy failure handler, the socks
// connect hook, and route-resolution edge cases. All network is mocked:
// globalThis.fetch is stubbed BEFORE the module loads so its captured
// originalFetch is the stub, and restored afterEach so other suites are not
// poisoned (see the hazard note in oauth-providers-index-dispatch.test.js).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dnsMode: 'resolve',
  dnsIp: '203.0.113.7',
  netMode: 'ok',
  httpsMode: 'ok',
  httpsBody: '{"a":1}',
  httpsStatus: 200,
  lastReqOptions: null,
  proxyAgentError: null,
  agentInstances: [],
  socksConnect: null,
}));

// tests/ carries its own nested undici that shadows the root copy when resolved
// from here, while proxyFetch.js's dynamic import walks up to the ROOT copy.
// Resolve through the SUT's own location so the mock lands on the module id it
// actually loads (same trick as proxy-fetch-dispatcher-eviction.test.js).
const resolveFromSut = vi.hoisted(() => {
  const { createRequire } = process.getBuiltinModule('node:module');
  const req = createRequire(new URL('../../open-sse/utils/proxyFetch.js', import.meta.url));
  return (id) => req.resolve(id);
});

vi.mock(resolveFromSut('undici'), () => ({
  Agent: class Agent {
    constructor(opts) {
      this.opts = opts;
      this.isAgent = true;
      state.agentInstances.push(this);
    }
    close() {}
  },
  ProxyAgent: class ProxyAgent {
    constructor(opts) {
      if (state.proxyAgentError) throw state.proxyAgentError;
      this.uri = opts.uri;
      this.isProxyAgent = true;
    }
    close() {}
  },
}));

vi.mock(resolveFromSut('socks-proxy-agent'), () => ({
  SocksProxyAgent: class SocksProxyAgent {
    constructor(url) {
      this.url = url;
    }
    connect(...args) {
      return state.socksConnect(...args);
    }
  },
}));

vi.mock('dns', () => ({
  Resolver: class Resolver {
    setServers() {}
    resolve4(host, cb) {
      if (state.dnsMode === 'resolve') setImmediate(() => cb(null, [state.dnsIp]));
      else if (state.dnsMode === 'fail') setImmediate(() => cb(new Error('ENOTFOUND')));
      // 'hang': never answer — the caller's signal is what ends it
    }
  },
}));

vi.mock('net', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    connect(port, ip, cb) {
      this.port = port;
      this.ip = ip;
      if (state.netMode === 'connect-error')
        setImmediate(() => this.emit('error', new Error('ECONNREFUSED')));
      else if (state.netMode !== 'hang') setImmediate(cb);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { default: { Socket }, Socket };
});

vi.mock('https', async () => {
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');
  const request = (opts, cb) => {
    state.lastReqOptions = opts;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      if (state.httpsMode === 'req-error') {
        setImmediate(() => req.emit('error', new Error('tls reset')));
        return;
      }
      const res = Readable.from([Buffer.from(state.httpsBody)]);
      res.statusCode = state.httpsStatus;
      res.statusMessage = 'OK';
      res.headers = { 'x-up': 'yes' };
      setImmediate(() => cb(res));
    };
    return req;
  };
  return { default: { request }, request };
});

// Capture originalFetch: the module snapshots globalThis.fetch at import.
const realFetch = globalThis.fetch;
const fetchSpy = vi.fn(async () => new Response('upstream-ok', { status: 200 }));
globalThis.fetch = fetchSpy;
const mod = await import('open-sse/utils/proxyFetch.js');
globalThis.fetch = realFetch;

const {
  proxyAwareFetch,
  resolveEffectiveProxyRoute,
  createProxyDispatcher,
  redactProxyUrlForLog,
  installGlobalProxyFetch,
} = mod;
const patchedFetch = mod.default;

// A host on the module's MITM bypass list; stable module constant.
const MITM_HOST = 'cloudcode-pa.googleapis.com';
let warnSpy;

beforeEach(() => {
  state.dnsMode = 'resolve';
  state.netMode = 'ok';
  state.httpsMode = 'ok';
  state.httpsBody = '{"a":1}';
  state.httpsStatus = 200;
  state.proxyAgentError = null;
  state.lastReqOptions = null;
  fetchSpy.mockClear();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  warnSpy.mockRestore();
});

describe('installGlobalProxyFetch', () => {
  it('swaps global fetch for the patched one, idempotently', () => {
    installGlobalProxyFetch();
    expect(globalThis.fetch).toBe(patchedFetch);
    installGlobalProxyFetch();
    expect(globalThis.fetch).toBe(patchedFetch);
  });
});

describe('redactProxyUrlForLog', () => {
  it('replaces a parseable URL with an empty hostname', () => {
    expect(redactProxyUrlForLog('unix:/tmp/proxy.sock')).toBe('[invalid proxy URL]');
  });
});

describe('route resolution edges', () => {
  it('treats an unparseable target as not matched by NO_PROXY and keeps the proxy', () => {
    const route = resolveEffectiveProxyRoute('::not-a-url::', {
      enabled: true,
      url: 'http://proxy.test:8080',
      noProxy: 'proxy.test',
    });
    expect(route.kind).toBe('proxy');
  });

  it('declares selected-proxy invalid when enablement is claimed without a url', () => {
    const route = resolveEffectiveProxyRoute('https://api.test/x', {
      resolutionKind: 'selected-proxy',
    });
    expect(route).toMatchObject({ kind: 'required-unavailable', reason: 'selected-proxy-invalid' });
  });

  it('declares invalid a proxy value that survives normalization but never parses', () => {
    const route = resolveEffectiveProxyRoute('https://api.test/x', {
      enabled: true,
      url: 'no scheme and spaces',
    });
    expect(route).toMatchObject({ kind: 'required-unavailable', reason: 'selected-proxy-invalid' });
  });

  it('falls back to direct for a garbage URL with no env proxy (unparseable protocol)', async () => {
    const res = await proxyAwareFetch('::garbage::', {}, null);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Direct path rides the happy-eyeballs Agent, never a ProxyAgent.
    expect(fetchSpy.mock.calls[0][1].dispatcher.isAgent).toBe(true);
  });
});

describe('relay route', () => {
  it('rewrites the request onto the relay URL with target/path headers', async () => {
    const res = await proxyAwareFetch(
      'https://api.test:8443/v1/chat?x=1',
      { headers: { a: 'b' } },
      { vercelRelayUrl: 'https://relay.test/fn' }
    );
    expect(res.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://relay.test/fn');
    expect(init.headers).toMatchObject({
      a: 'b',
      'x-relay-target': 'https://api.test:8443',
      'x-relay-path': '/v1/chat?x=1',
    });
  });
});

describe('proxy failure classification', () => {
  const proxyOpts = (url, extra = {}) => ({ enabled: true, url, ...extra });

  it('rethrows an abort-shaped proxy failure instead of retrying direct', async () => {
    for (const [i, err] of [
      Object.assign(new Error('x'), { name: 'TimeoutError' }),
      Object.assign(new Error('x'), { code: 'ABORT_ERR' }),
      new Error('This operation was aborted'),
    ].entries()) {
      state.proxyAgentError = err;
      await expect(
        proxyAwareFetch('https://plain.test/x', {}, proxyOpts(`http://p${i}.abort.test:1`))
      ).rejects.toBe(err);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails hard under strictProxy on a non-abort failure', async () => {
    state.proxyAgentError = new Error('ECONNREFUSED');
    await expect(
      proxyAwareFetch(
        'https://plain.test/x',
        {},
        proxyOpts('http://p.strict.test:1', { strictProxy: true })
      )
    ).rejects.toThrow(/strictProxy=true/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to direct on a non-abort failure without strictProxy', async () => {
    state.proxyAgentError = new Error('ECONNREFUSED');
    const res = await proxyAwareFetch('https://plain.test/x', {}, proxyOpts('http://p.lax.test:1'));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].dispatcher.isAgent).toBe(true);
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('falling back to direct');
  });
});

describe('MITM bypass host with a proxy', () => {
  it('uses the proxy dispatcher directly (proxy resolves DNS externally)', async () => {
    const res = await proxyAwareFetch(
      `https://${MITM_HOST}/v1`,
      {},
      { enabled: true, url: 'http://p.mitm-ok.test:1' }
    );
    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0][1].dispatcher.isProxyAgent).toBe(true);
  });

  it('fails hard under strictProxy when the proxy path fails', async () => {
    state.proxyAgentError = new Error('down');
    await expect(
      proxyAwareFetch(
        `https://${MITM_HOST}/v1`,
        {},
        { enabled: true, url: 'http://p.mitm-strict.test:1', strictProxy: true }
      )
    ).rejects.toThrow(/strictProxy=true/);
  });
});

describe('MITM DNS-bypass request (no proxy)', () => {
  it('resolves the real IP and speaks HTTPS to it with the original hostname pinned', async () => {
    const res = await proxyAwareFetch(`https://${MITM_HOST}/v1/x?q=1`, {
      method: 'POST',
      headers: { h: '1' },
      body: '{"m":1}',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-up')).toBe('yes');
    // SNI and Host pinned to the requested hostname, not the resolved IP.
    expect(state.lastReqOptions.servername).toBe(MITM_HOST);
    expect(state.lastReqOptions.headers.Host).toBe(MITM_HOST);
    expect(state.lastReqOptions.path).toBe('/v1/x?q=1');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('falls through to direct fetch when the transport errors', async () => {
    state.dnsIp = '203.0.113.8'; // distinct host cache entry not needed; IP cache is per hostname
    state.httpsMode = 'req-error';
    const res = await proxyAwareFetch(`https://daily-${MITM_HOST}/v1`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('MITM bypass failed');
  });

  it('falls through to direct fetch when DNS resolution fails, and caches the failure', async () => {
    state.dnsMode = 'fail';
    const url = 'https://api.individual.githubcopilot.com/v1';
    const r1 = await proxyAwareFetch(url, {});
    state.dnsMode = 'hang'; // a second lookup would hang; the cached failure must skip it
    const r2 = await proxyAwareFetch(url, {});
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('an abort while the socket is pending rejects with the abort reason', async () => {
    state.netMode = 'hang';
    const controller = new AbortController();
    const pending = proxyAwareFetch('https://proxy.individual.githubcopilot.com/v1', {
      signal: controller.signal,
    });
    await new Promise((r) => setImmediate(r));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a socket connect error surfaces as the direct-fetch fallback', async () => {
    state.netMode = 'connect-error';
    const res = await proxyAwareFetch('https://q.us-east-1.amazonaws.com/v1', {});
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('an abort during DNS resolution propagates instead of being cached as failure', async () => {
    state.dnsMode = 'hang';
    const controller = new AbortController();
    const pending = proxyAwareFetch('https://codewhisperer.us-east-1.amazonaws.com/v1', {
      signal: controller.signal,
    });
    await new Promise((r) => setImmediate(r));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('createProxyDispatcher socks connect hook', () => {
  it('hands the socks socket to undici on success and the error on failure', async () => {
    state.agentInstances.length = 0;
    const dispatcher = await createProxyDispatcher('socks5://s.test:1080');
    const { connect } = state.agentInstances.at(-1).opts;
    expect(typeof connect).toBe('function');

    const socket = { fake: true };
    state.socksConnect = async () => socket;
    const ok = await new Promise((resolve) => {
      connect({ protocol: 'https:', hostname: 'up.test', port: '' }, (err, s) =>
        resolve({ err, s })
      );
    });
    expect(ok).toEqual({ err: null, s: socket });

    const boom = new Error('socks down');
    state.socksConnect = async () => {
      throw boom;
    };
    const bad = await new Promise((resolve) => {
      connect({ protocol: 'http:', hostname: 'up.test', port: 8080 }, (err, s) =>
        resolve({ err, s })
      );
    });
    expect(bad.err).toBe(boom);
    expect(dispatcher.isAgent).toBe(true);
  });
});
