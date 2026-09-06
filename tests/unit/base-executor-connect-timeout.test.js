import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));
// Base uses the abortable promise timer. Route that dependency through the
// test clock; Vitest's global fake timers do not replace this built-in export.
vi.mock('node:timers/promises', () => ({ setTimeout: (ms, value, { signal } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(value); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
}) }));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");

function response(status = 200, headers = {}) {
  return new Response(null, { status, headers });
}

function hangUntilAbort(_url, options) {
  return new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
});

afterEach(() => vi.useRealTimers());

describe("BaseExecutor response-header timeout", () => {
  it("uses provider override and bypasses ordinary 502 retry", async () => {
    const executor = new BaseExecutor("test", {
      baseUrl: "https://upstream.test/chat",
      timeoutMs: 120000,
      retry: { 502: { attempts: 3, delayMs: 3000 } },
    });
    fetchMock.mockImplementation(hangUntilAbort);
    const pending = executor.execute({
      model: "m",
      body: {},
      stream: false,
      credentials: { apiKey: "k" },
      connectTimeout: { providerOverride: 8000, globalTimeout: 15000 },
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "ConnectTimeoutError",
      code: "UPSTREAM_CONNECT_TIMEOUT",
      timeoutMs: 8000,
    });
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline on headers and on network rejection", async () => {
    const executor = new BaseExecutor("test", {
      baseUrl: "https://upstream.test/chat",
      retry: { 502: { attempts: 0, delayMs: 0 } },
    });
    fetchMock.mockResolvedValueOnce(response());
    await executor.execute({ model: "m", body: {}, stream: false, credentials: {}, connectTimeout: { globalTimeout: 15000 } });
    expect(vi.getTimerCount()).toBe(0);
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(executor.execute({ model: "m", body: {}, stream: false, credentials: {}, connectTimeout: { globalTimeout: 15000 } })).rejects.toThrow("ECONNRESET");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves caller cancellation", async () => {
    const caller = new AbortController();
    const executor = new BaseExecutor("test", { baseUrl: "https://upstream.test/chat" });
    fetchMock.mockImplementation(hangUntilAbort);
    const pending = executor.execute({ model: "m", body: {}, stream: false, credentials: {}, signal: caller.signal, connectTimeout: { globalTimeout: 15000 } });
    const reason = new DOMException("client left", "AbortError");
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores caller cancellation when transport wraps the rejection", async () => {
    const caller = new AbortController();
    const executor = new BaseExecutor("test", {
      baseUrl: "https://upstream.test/chat",
      retry: { 502: { attempts: 0, delayMs: 0 } },
    });
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(new Error("[ProxyFetch] strict proxy wrapped abort")),
        { once: true },
      );
    }));
    const pending = executor.execute({
      model: "m",
      body: {},
      stream: false,
      credentials: {},
      signal: caller.signal,
      connectTimeout: { globalTimeout: 15000 },
    });
    const reason = new DOMException("client left", "AbortError");
    caller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("creates a fresh full deadline after an explicitly replay-safe rejection", async () => {
    const signals = [];
    const executor = new BaseExecutor("test", {
      baseUrl: "https://upstream.test/chat",
      retry: { 502: { attempts: 1, delayMs: 3000 } },
    });
    fetchMock
      .mockImplementationOnce((_url, options) => {
        signals.push(options.signal);
        return Promise.resolve(response(502, { 'x-tokenproxy-replay-safe': 'true' }));
      })
      .mockImplementationOnce((url, options) => {
        signals.push(options.signal);
        return hangUntilAbort(url, options);
      });
    const pending = executor.execute({
      model: "m",
      body: {},
      stream: false,
      credentials: {},
      connectTimeout: { providerOverride: 8000, globalTimeout: 15000 },
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0].aborted).toBe(false);
    const assertion = expect(pending).rejects.toMatchObject({
      name: "ConnectTimeoutError",
      timeoutMs: 8000,
    });
    await vi.advanceTimersByTimeAsync(7999);
    expect(signals[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(signals[1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resend an ambiguous 502 even when a status retry is configured', async () => {
    const executor = new BaseExecutor('test', {
      baseUrl: 'https://upstream.test/chat', retry: { 502: { attempts: 3, delayMs: 3000 } },
    });
    fetchMock.mockResolvedValueOnce(response(502));
    const result = await executor.execute({ model: 'm', body: {}, stream: false, credentials: {}, connectTimeout: { globalTimeout: 15000 } });
    expect(result.response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
