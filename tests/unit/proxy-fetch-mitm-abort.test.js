import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResponseHeaderTimeout } from "../../open-sse/utils/responseHeaderTimeout.js";

const seams = vi.hoisted(() => {
  class Emitter {
    constructor() {
      this.listeners = new Map();
    }

    on(event, listener) {
      const listeners = this.listeners.get(event) || [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event, listener) {
      const wrapped = (...args) => {
        this.removeListener(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    removeListener(event, listener) {
      const listeners = this.listeners.get(event) || [];
      this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
      return this;
    }

    emit(event, ...args) {
      for (const listener of [...(this.listeners.get(event) || [])]) listener(...args);
    }
  }

  const state = {
    dnsResolve: null,
    dnsCalls: [],
    socketConnect: null,
    sockets: [],
    requests: [],
  };

  class FakeSocket extends Emitter {
    constructor() {
      super();
      this.destroyReasons = [];
      state.sockets.push(this);
    }

    connect(port, ip, callback) {
      state.socketConnect(this, port, ip, callback);
      return this;
    }

    destroy(reason) {
      this.destroyReasons.push(reason);
      this.emit("error", reason);
      return this;
    }
  }

  class FakeRequest extends Emitter {
    constructor(options, onResponse) {
      super();
      this.options = options;
      this.onResponse = onResponse;
      this.destroyReasons = [];
      this.writes = [];
      state.requests.push(this);
    }

    write(chunk) {
      this.writes.push(chunk);
    }

    end() {}

    destroy(reason) {
      this.destroyReasons.push(reason);
      this.emit("error", reason);
      return this;
    }
  }

  return { state, FakeSocket, FakeRequest };
});

vi.mock("dns", () => ({
  Resolver: class {
    setServers() {}
    resolve4(hostname, callback) {
      seams.state.dnsCalls.push(hostname);
      seams.state.dnsResolve(hostname, callback);
    }
  },
}));

vi.mock("net", () => ({
  Socket: seams.FakeSocket,
  default: { Socket: seams.FakeSocket },
}));

vi.mock("https", () => ({
  request: (options, onResponse) => new seams.FakeRequest(options, onResponse),
  default: { request: (options, onResponse) => new seams.FakeRequest(options, onResponse) },
}));

const priorFetch = globalThis.fetch;
const nativeFetch = vi.fn();
globalThis.fetch = nativeFetch;
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const priorNoProxyPresent = Object.prototype.hasOwnProperty.call(process.env, "NO_PROXY");
const priorNoProxy = process.env.NO_PROXY;

function settle(promise) {
  return promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  nativeFetch.mockReset();
  nativeFetch.mockRejectedValue(new Error("unexpected direct fallback"));
  seams.state.dnsCalls.length = 0;
  seams.state.sockets.length = 0;
  seams.state.requests.length = 0;
  seams.state.dnsResolve = (_hostname, callback) => callback(null, ["203.0.113.10"]);
  seams.state.socketConnect = (_socket, _port, _ip, callback) => callback();
  process.env.NO_PROXY = "*";
});

afterEach(() => {
  vi.useRealTimers();
  if (priorNoProxyPresent) process.env.NO_PROXY = priorNoProxy;
  else delete process.env.NO_PROXY;
});

afterAll(() => {
  globalThis.fetch = priorFetch;
});

describe("proxyAwareFetch MITM bypass aborts", () => {
  it.each(['metadata', 'transport'])('composes the %s owner with the other transport lifetime', async owner => {
    const metadata = new AbortController();
    const transport = new AbortController();
    const pending = settle(proxyAwareFetch(
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
      { method: 'POST', body: '{}', signal: transport.signal },
      { signal: metadata.signal },
    ));
    await vi.dynamicImportSettled();
    expect(seams.state.requests).toHaveLength(1);
    const reason = new DOMException('fixture owner ended', 'AbortError');
    (owner === 'metadata' ? metadata : transport).abort(reason);
    expect((await pending).error).toBe(reason);
    expect(seams.state.requests[0].destroyReasons).toEqual([reason]);
    expect(seams.state.sockets[0].destroyReasons).toEqual([reason]);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("settles at the response-header deadline while DNS is pending and removes its listener", async () => {
    seams.state.dnsResolve = (_hostname, callback) => {
      setTimeout(() => callback(new Error("late DNS failure")), 2000);
    };
    const deadline = createResponseHeaderTimeout({ timeoutMs: 1000 });
    const removeListener = vi.spyOn(deadline.signal, "removeEventListener");
    const pending = settle(proxyAwareFetch(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",
      { method: "POST", signal: deadline.signal },
    ));

    await vi.advanceTimersByTimeAsync(1000);
    const atDeadline = await Promise.race([pending, Promise.resolve({ pending: true })]);
    const reason = deadline.signal.reason;
    await vi.advanceTimersByTimeAsync(1000);
    const final = await pending;
    deadline.clear();

    expect(atDeadline.error).toBe(reason);
    expect(final.error).toBe(reason);
    expect(seams.state.dnsCalls).toEqual(["daily-cloudcode-pa.googleapis.com"]);
    expect(seams.state.sockets).toHaveLength(0);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys the manual HTTPS request and socket with the deadline reason", async () => {
    seams.state.socketConnect = (_socket, _port, _ip, callback) => callback();
    const deadline = createResponseHeaderTimeout({ timeoutMs: 1000 });
    const removeListener = vi.spyOn(deadline.signal, "removeEventListener");
    const pending = settle(proxyAwareFetch(
      "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
      { method: "POST", body: "{}", signal: deadline.signal },
    ));
    await vi.dynamicImportSettled();
    expect(seams.state.requests).toHaveLength(1);
    const request = seams.state.requests[0];
    const socket = seams.state.sockets[0];
    setTimeout(() => request.emit("error", new Error("late request failure")), 2000);

    await vi.advanceTimersByTimeAsync(1000);
    const atDeadline = await Promise.race([pending, Promise.resolve({ pending: true })]);
    const reason = deadline.signal.reason;
    await vi.advanceTimersByTimeAsync(1000);
    const final = await pending;
    deadline.clear();

    expect(atDeadline.error).toBe(reason);
    expect(final.error).toBe(reason);
    expect(request.destroyReasons).toEqual([reason]);
    expect(socket.destroyReasons).toEqual([reason]);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a pre-aborted caller before DNS, socket, HTTPS, or fallback work", async () => {
    seams.state.dnsResolve = (_hostname, callback) => callback(new Error("DNS must not start"));
    const caller = new AbortController();
    const reason = new DOMException("client left", "AbortError");
    caller.abort(reason);

    const result = await settle(proxyAwareFetch(
      "https://api.individual.githubcopilot.com/chat/completions",
      { method: "POST", signal: caller.signal },
    ));

    expect(result.error).toBe(reason);
    expect(seams.state.dnsCalls).toHaveLength(0);
    expect(seams.state.sockets).toHaveLength(0);
    expect(seams.state.requests).toHaveLength(0);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
