// Abort, late-arrival and default-primitive paths of connectHttp2.
// Every transport is a local EventEmitter fake; node:net, node:tls,
// node:http2 and socks-proxy-agent are module-mocked, so zero network.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const moduleMocks = vi.hoisted(() => ({
  netConnect: vi.fn(),
  tlsConnect: vi.fn(),
  http2Connect: vi.fn(),
  SocksProxyAgent: vi.fn(),
}));

vi.mock('node:net', () => ({ default: { connect: moduleMocks.netConnect } }));
vi.mock('node:tls', () => ({ default: { connect: moduleMocks.tlsConnect } }));
vi.mock('node:http2', () => ({ default: { connect: moduleMocks.http2Connect } }));
vi.mock('socks-proxy-agent', () => ({ SocksProxyAgent: moduleMocks.SocksProxyAgent }));

const { connectHttp2 } = await import('../../open-sse/utils/http2Connect.js');

const TARGET = 'https://upstream.example.test/service';
const DIRECT = { kind: 'direct', strictProxy: false, cacheIdentity: 'direct' };

function socket() {
  const value = new EventEmitter();
  value.write = vi.fn(() => true);
  value.unshift = vi.fn();
  value.destroy = vi.fn((error) => value.emit('close', error));
  return value;
}

function session({ autoConnect = true } = {}) {
  const value = new EventEmitter();
  value.close = vi.fn();
  value.destroy = vi.fn((error) => value.emit('close', error));
  if (autoConnect) queueMicrotask(() => value.emit('connect'));
  return value;
}

function fakePrimitives({
  autoTlsConnect = true,
  connectResponse = ['HTTP/1.1 200 OK\r\n\r\n'],
} = {}) {
  const netSocket = socket();
  const tlsSockets = [];
  const sessions = [];
  const socksSocket = socket();
  const socksConnect = vi.fn(async () => socksSocket);
  netSocket.write.mockImplementation(() => {
    for (const chunk of connectResponse)
      queueMicrotask(() => netSocket.emit('data', Buffer.from(chunk)));
    return true;
  });
  const primitives = {
    netConnect: vi.fn(() => {
      queueMicrotask(() => netSocket.emit('connect'));
      return netSocket;
    }),
    tlsConnect: vi.fn(() => {
      const value = socket();
      tlsSockets.push(value);
      if (autoTlsConnect) queueMicrotask(() => value.emit('secureConnect'));
      return value;
    }),
    http2Connect: vi.fn((_origin, options = {}) => {
      const value = session();
      value.connection = options.createConnection?.();
      sessions.push(value);
      return value;
    }),
    createSocksAgent: vi.fn(() => ({ connect: socksConnect })),
  };
  return { primitives, netSocket, tlsSockets, sessions, socksSocket, socksConnect };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('default node primitives', () => {
  it('routes a direct connect through http2.connect', async () => {
    moduleMocks.http2Connect.mockImplementation(() => session());
    const lease = await connectHttp2(TARGET, { route: DIRECT });
    expect(moduleMocks.http2Connect).toHaveBeenCalledWith(new URL(TARGET).origin, {});
    lease.close();
  });

  it('routes an http proxy through net.connect then tls.connect', async () => {
    const netSocket = socket();
    netSocket.write.mockImplementation(() => {
      queueMicrotask(() => netSocket.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n')));
      return true;
    });
    moduleMocks.netConnect.mockImplementation(() => {
      queueMicrotask(() => netSocket.emit('connect'));
      return netSocket;
    });
    moduleMocks.tlsConnect.mockImplementation(() => {
      const value = socket();
      queueMicrotask(() => value.emit('secureConnect'));
      return value;
    });
    moduleMocks.http2Connect.mockImplementation(() => session());

    const lease = await connectHttp2(TARGET, {
      route: {
        kind: 'proxy',
        proxyUrl: 'http://proxy.test:8080',
        strictProxy: true,
        cacheIdentity: 'proxy:x',
      },
    });
    expect(moduleMocks.netConnect).toHaveBeenCalledWith({ host: 'proxy.test', port: 8080 });
    expect(moduleMocks.tlsConnect).toHaveBeenCalledTimes(1);
    lease.close();
  });

  it('routes a socks proxy through SocksProxyAgent', async () => {
    const socksSocket = socket();
    moduleMocks.SocksProxyAgent.mockImplementation(function () {
      this.connect = vi.fn(async () => socksSocket);
    });
    moduleMocks.tlsConnect.mockImplementation(() => {
      const value = socket();
      queueMicrotask(() => value.emit('secureConnect'));
      return value;
    });
    moduleMocks.http2Connect.mockImplementation(() => session());

    const lease = await connectHttp2(TARGET, {
      route: {
        kind: 'proxy',
        proxyUrl: 'socks5://proxy.test:1080',
        strictProxy: true,
        cacheIdentity: 'proxy:x',
      },
    });
    expect(moduleMocks.SocksProxyAgent).toHaveBeenCalledWith('socks5://proxy.test:1080');
    lease.close();
  });
});

describe('route validation', () => {
  it('rejects an unrecognised route kind', async () => {
    await expect(connectHttp2(TARGET, { route: { kind: 'carrier-pigeon' } })).rejects.toMatchObject(
      { code: 'unsupported_proxy_route' }
    );
  });

  it('rejects a proxy route whose URL does not parse', async () => {
    await expect(
      connectHttp2(TARGET, {
        route: { kind: 'proxy', proxyUrl: 'not a url', strictProxy: true },
      })
    ).rejects.toMatchObject({ code: 'unsupported_proxy_protocol' });
  });

  it('rejects a proxy route on a non-tunnel protocol', async () => {
    await expect(
      connectHttp2(TARGET, {
        route: { kind: 'proxy', proxyUrl: 'ftp://proxy.test:21', strictProxy: true },
      })
    ).rejects.toMatchObject({ code: 'unsupported_proxy_protocol' });
  });
});

describe('abort handling on the socks path (waitWithAbort)', () => {
  it('resolves normally when the agent answers before any abort', async () => {
    const fake = fakePrimitives();
    const controller = new AbortController();
    const lease = await connectHttp2(TARGET, {
      route: { kind: 'proxy', proxyUrl: 'socks5://proxy.test:1080', strictProxy: true },
      signal: controller.signal,
      primitives: fake.primitives,
    });
    expect(fake.socksConnect).toHaveBeenCalledTimes(1);
    lease.close();
  });

  it('rejects with the abort reason and destroys a late-arriving socks socket', async () => {
    const fake = fakePrimitives();
    let releaseSocket;
    const lateSocket = socket();
    // Only a close() teardown: exercises the destroy-less resource branch.
    delete lateSocket.destroy;
    lateSocket.close = vi.fn();
    fake.socksConnect.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSocket = () => resolve(lateSocket);
        })
    );
    const controller = new AbortController();
    const reason = new Error('caller gave up');

    const pending = connectHttp2(TARGET, {
      route: { kind: 'proxy', proxyUrl: 'socks5://proxy.test:1080', strictProxy: true },
      signal: controller.signal,
      primitives: fake.primitives,
    });
    await new Promise((r) => setImmediate(r));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    releaseSocket();
    await new Promise((r) => setImmediate(r));
    expect(lateSocket.close).toHaveBeenCalledTimes(1);
  });

  it('propagates an agent connect failure with the signal still pending', async () => {
    const fake = fakePrimitives();
    const failure = new Error('socks handshake refused');
    fake.socksConnect.mockRejectedValue(failure);
    const controller = new AbortController();

    await expect(
      connectHttp2(TARGET, {
        route: { kind: 'proxy', proxyUrl: 'socks5://proxy.test:1080', strictProxy: true },
        signal: controller.signal,
        primitives: fake.primitives,
      })
    ).rejects.toBe(failure);
  });
});

describe('abort and write failures during HTTP CONNECT', () => {
  it('rejects and destroys the proxy socket when aborted mid-CONNECT', async () => {
    const fake = fakePrimitives();
    fake.netSocket.write.mockImplementation(() => true); // proxy never answers
    const controller = new AbortController();
    const reason = new Error('deadline');

    const pending = connectHttp2(TARGET, {
      route: { kind: 'proxy', proxyUrl: 'http://proxy.test:8080', strictProxy: true },
      signal: controller.signal,
      primitives: fake.primitives,
    });
    await new Promise((r) => setImmediate(r));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fake.netSocket.destroy).toHaveBeenCalled();
  });

  it('rejects when writing the CONNECT request itself throws', async () => {
    const fake = fakePrimitives();
    const failure = new Error('EPIPE');
    fake.netSocket.write.mockImplementation(() => {
      throw failure;
    });

    await expect(
      connectHttp2(TARGET, {
        route: { kind: 'proxy', proxyUrl: 'http://proxy.test:8080', strictProxy: true },
        primitives: fake.primitives,
      })
    ).rejects.toBe(failure);
  });

  it('destroys the target TLS socket when its handshake errors', async () => {
    const fake = fakePrimitives({ autoTlsConnect: false });
    const failure = new Error('handshake failed');
    const pending = connectHttp2(TARGET, {
      route: { kind: 'proxy', proxyUrl: 'http://proxy.test:8080', strictProxy: true },
      primitives: fake.primitives,
    });
    await new Promise((r) => setImmediate(r));
    fake.tlsSockets[0].emit('error', failure);
    await expect(pending).rejects.toBe(failure);
    expect(fake.tlsSockets[0].destroy).toHaveBeenCalled();
  });
});
