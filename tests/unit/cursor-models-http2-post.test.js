// Coverage for the real http2PostProto path inside cursorModels.js: the
// default unary POST used when no options.http2Post override is injected.
// The HTTP/2 session is a local EventEmitter fake; zero network.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from '../../open-sse/services/cursorModels.js';

const credentials = {
  accessToken: 'cursor-token',
  providerSpecificData: { machineId: 'machine-id' },
};
const directOptions = { resolutionKind: 'intentional-direct', reason: 'connection-proxy-direct' };

// Minimal protobuf writer for agent.v1.GetUsableModelsResponse fixtures.
function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}
function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}
const text = (v) => new TextEncoder().encode(v);
function concat(...parts) {
  const size = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
const model = (id, fields = {}) =>
  field(
    1,
    concat(field(1, text(id)), ...Object.entries(fields).map(([n, v]) => field(Number(n), text(v))))
  );

// Fake HTTP/2 session whose request emits the given status + body.
function fakeSession({ status = 200, body = Buffer.alloc(0), mode = 'ok' } = {}) {
  const session = new EventEmitter();
  session.request = vi.fn((headers) => {
    const request = new EventEmitter();
    request.destroy = vi.fn();
    request.end = vi.fn(() => {
      queueMicrotask(() => {
        if (mode === 'error') {
          request.emit('error', new Error('stream reset'));
          return;
        }
        request.emit('response', { ':status': status });
        if (body.length) request.emit('data', body);
        request.emit('end');
      });
    });
    request._headers = headers;
    return request;
  });
  return session;
}

function connector(session) {
  return vi.fn(async () => ({
    session,
    effectiveRoute: { cacheIdentity: 'direct' },
    close: vi.fn(),
  }));
}

const logs = { warn: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  clearCursorModelCache();
  logs.warn.mockClear();
  logs.debug.mockClear();
});
afterEach(() => clearCursorModelCache());

describe('resolveCursorModels via the built-in http2 POST', () => {
  it('returns null and logs when the credential lacks token or machine id', async () => {
    expect(await resolveCursorModels({}, { log: logs })).toBeNull();
    expect(await resolveCursorModels({ accessToken: 't' }, { log: logs })).toBeNull();
    expect(logs.debug).toHaveBeenCalled();
  });

  it('posts over the fake session, parses models, and caches the result', async () => {
    const body = Buffer.from(concat(model('m-1', { 4: 'Model One' }), model('m-2', {})));
    const session = fakeSession({ status: 200, body });
    const connect = connector(session);

    const result = await resolveCursorModels(credentials, {
      proxyOptions: directOptions,
      connectHttp2: connect,
      log: logs,
    });
    expect(result.models).toEqual([
      { id: 'm-1', name: 'Model One' },
      { id: 'm-2', name: 'm-2' }, // name falls back to the id
    ]);
    // The unary call sends protobuf pseudo-headers.
    const sent = session.request.mock.calls[0][0];
    expect(sent[':method']).toBe('POST');
    expect(sent['content-type']).toBe('application/proto');

    // Second call is served from cache: no new connection.
    const again = await resolveCursorModels(credentials, {
      proxyOptions: directOptions,
      connectHttp2: connect,
    });
    expect(again.models).toHaveLength(2);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh bypasses the cache and reconnects', async () => {
    const body = Buffer.from(concat(model('m-1', {})));
    const session = fakeSession({ status: 200, body });
    const connect = connector(session);
    const opts = { proxyOptions: directOptions, connectHttp2: connect };
    await resolveCursorModels(credentials, opts);
    await resolveCursorModels(credentials, { ...opts, forceRefresh: true });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('returns null and warns on a non-200 status', async () => {
    const session = fakeSession({ status: 503 });
    const result = await resolveCursorModels(credentials, {
      proxyOptions: directOptions,
      connectHttp2: connector(session),
      log: logs,
    });
    expect(result).toBeNull();
    expect(logs.warn).toHaveBeenCalledWith('CURSOR_MODELS', expect.stringContaining('503'));
  });

  it('returns null when the stream errors', async () => {
    const session = fakeSession({ mode: 'error' });
    const result = await resolveCursorModels(credentials, {
      proxyOptions: directOptions,
      connectHttp2: connector(session),
      log: logs,
    });
    expect(result).toBeNull();
    expect(logs.warn).toHaveBeenCalledWith(
      'CURSOR_MODELS',
      expect.stringContaining('stream reset')
    );
  });

  it('rejects immediately on a pre-aborted signal', async () => {
    const session = fakeSession({ status: 200 });
    const controller = new AbortController();
    controller.abort(new Error('caller gone'));
    const result = await resolveCursorModels(credentials, {
      proxyOptions: directOptions,
      connectHttp2: connector(session),
      signal: controller.signal,
      log: logs,
    });
    expect(result).toBeNull();
    expect(logs.warn).toHaveBeenCalledWith('CURSOR_MODELS', expect.stringContaining('caller gone'));
  });

  it('aborts a request in flight when the signal fires', async () => {
    const session = new EventEmitter();
    let request;
    session.request = vi.fn(() => {
      request = new EventEmitter();
      request.destroy = vi.fn();
      request.end = vi.fn(); // never answers
      return request;
    });
    const controller = new AbortController();
    const promise = resolveCursorModels(credentials, {
      proxyOptions: directOptions,
      connectHttp2: connector(session),
      signal: controller.signal,
      log: logs,
    });
    // Let the request start, then abort.
    await new Promise((r) => setImmediate(r));
    controller.abort(new Error('hung up'));
    expect(await promise).toBeNull();
    expect(request.destroy).toHaveBeenCalled();
  });

  it('returns null when session.request itself throws', async () => {
    const session = new EventEmitter();
    session.request = vi.fn(() => {
      throw new Error('GOAWAY');
    });
    const result = await resolveCursorModels(credentials, {
      proxyOptions: directOptions,
      connectHttp2: connector(session),
      log: logs,
    });
    expect(result).toBeNull();
  });

  it('returns null when the connector yields no effective route', async () => {
    const connect = vi.fn(async () => ({ session: {}, effectiveRoute: null, close: vi.fn() }));
    const result = await resolveCursorModels(credentials, {
      proxyOptions: directOptions,
      connectHttp2: connect,
      log: logs,
    });
    expect(result).toBeNull();
  });

  it('returns null on an empty catalog payload', async () => {
    const session = fakeSession({ status: 200, body: Buffer.alloc(0) });
    const result = await resolveCursorModels(credentials, {
      proxyOptions: directOptions,
      connectHttp2: connector(session),
    });
    expect(result).toBeNull();
  });
});

describe('parseCursorUsableModels display-name fallbacks', () => {
  it('prefers field 4, then 5, then 3, then the id; skips duplicates and blanks', () => {
    const payload = concat(
      model('a', { 4: 'Display', 5: 'Short', 3: 'DispId' }),
      model('b', { 5: 'Short B' }),
      model('c', { 3: 'DispId C' }),
      model('a', { 4: 'Duplicate' }),
      model('', { 4: 'no id' })
    );
    expect(parseCursorUsableModels(payload)).toEqual([
      { id: 'a', name: 'Display' },
      { id: 'b', name: 'Short B' },
      { id: 'c', name: 'DispId C' },
    ]);
  });
});
