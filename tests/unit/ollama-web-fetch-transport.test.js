import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";

const OLLAMA_CONFIG = Object.freeze({
  formats: ["markdown"],
  maxCharacters: 200000,
  timeoutMs: 30000,
  costPerQuery: null,
});

const TARGET = "https://example.com/article";
const API_KEY = "ollama_test_key";
const originalFetch = globalThis.fetch;
const PLUMBING_MOCKS = [
  "@/shared/constants/providers.js",
  "open-sse/handlers/fetch/index.js",
  "@/sse/services/auth.js",
  "@/lib/localDb",
  "@/sse/services/tokenRefresh.js",
  "@/sse/utils/logger.js",
  "@/shared/utils/ssrfGuard.js",
];

function successResponse(payload = { title: "Example", content: "Hello", links: [] }, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function baseParams(overrides = {}) {
  const transport = overrides.transport || vi.fn().mockResolvedValue(successResponse());
  return {
    params: {
      url: TARGET,
      provider: "ollama",
      providerConfig: OLLAMA_CONFIG,
      credentials: { apiKey: API_KEY },
      proxyOptions: null,
      transport,
      ...overrides,
    },
    transport,
  };
}

async function runCore(overrides = {}) {
  const fixture = baseParams(overrides);
  return { result: await handleFetchCore(fixture.params), transport: fixture.transport };
}

function targetWithByteLength(totalBytes) {
  const prefix = "https://example.com/";
  return prefix + "a".repeat(totalBytes - Buffer.byteLength(prefix));
}

function streamResponse(chunks, {
  status = 200,
  contentType = "application/json",
  contentLength,
  cancel = vi.fn(),
} = {}) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel,
  });
  const headers = new Headers({ "Content-Type": contentType });
  if (contentLength !== undefined) headers.set("Content-Length", String(contentLength));
  return { response: new Response(body, { status, headers }), cancel };
}

function hangingBodyResponse(cancel = vi.fn()) {
  return {
    response: new Response(new ReadableStream({ start() {}, cancel }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    cancel,
  };
}

function jsonBytesOfSize(totalBytes) {
  const prefix = '{"title":"","content":"';
  const suffix = '","links":[]}';
  const fill = totalBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (fill < 0) throw new RangeError("totalBytes is too small");
  return new TextEncoder().encode(prefix + "x".repeat(fill) + suffix);
}

function expectLocalFailure(result, transport, status, code) {
  expect(result).toMatchObject({ success: false, status, code });
  expect(transport).not.toHaveBeenCalled();
  expect(result.error).not.toContain(API_KEY);
  expect(result.error).not.toContain(TARGET);
}

function captureAssertion(assertion) {
  return assertion.then(() => null, (error) => error);
}

async function importFetchHandlerForPlumbing({ noAuth = false } = {}) {
  vi.resetModules();
  const mocks = {
    handleFetchCore: vi.fn().mockResolvedValue({
      success: true,
      data: { provider: "transport-fixture", content: { text: "ok" } },
    }),
    getProviderCredentials: vi.fn(),
    checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  };

  vi.doMock("@/shared/constants/providers.js", () => ({
    AI_PROVIDERS: {
      "transport-fixture": {
        id: "transport-fixture",
        noAuth,
        fetchConfig: { formats: ["markdown"], maxCharacters: 200000, timeoutMs: 30000 },
      },
    },
    resolveProviderId: (value) => value,
  }));
  vi.doMock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: mocks.handleFetchCore }));
  vi.doMock("@/sse/services/auth.js", () => ({
    getProviderCredentials: mocks.getProviderCredentials,
    markAccountUnavailable: vi.fn(),
    clearAccountError: vi.fn(),
    extractApiKey: vi.fn(() => null),
    isValidApiKey: vi.fn(),
  }));
  vi.doMock("@/lib/localDb", () => ({
    getSettings: vi.fn(async () => ({ requireApiKey: false })),
    getCombos: vi.fn(async () => []),
  }));
  vi.doMock("@/sse/services/tokenRefresh.js", () => ({
    checkAndRefreshToken: mocks.checkAndRefreshToken,
    updateProviderCredentials: vi.fn(),
  }));
  vi.doMock("@/sse/utils/logger.js", () => ({
    request: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    maskKey: vi.fn(),
  }));
  vi.doMock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));

  return { handleFetch: (await import("@/sse/handlers/fetch.js")).handleFetch, mocks };
}

beforeEach(() => {
  vi.useRealTimers();
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  for (const specifier of PLUMBING_MOCKS) vi.doUnmock(specifier);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("Ollama web fetch request contract", () => {
  it("sends the official request and normalizes the successful response", async () => {
    const proxyOptions = Object.freeze({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:3128",
      connectionNoProxy: "localhost,127.0.0.1",
      vercelRelayUrl: "https://relay.test/egress",
      strictProxy: true,
    });
    const { result, transport } = await runCore({ proxyOptions });

    expect(transport).toHaveBeenCalledWith(
      "https://ollama.com/api/web_fetch",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ url: TARGET }),
        signal: expect.any(AbortSignal),
      }),
      proxyOptions,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      data: {
        provider: "ollama",
        url: TARGET,
        title: "Example",
        content: { format: "markdown", text: "Hello", length: 5 },
      },
    });
  });

  it("omits empty links and reports unknown cost", async () => {
    const { result } = await runCore();

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("links");
    expect(result.data.usage.fetch_cost_usd).toBeNull();
  });

  it.each([
    ["missing configuration", undefined],
    ["extra advertised format", { ...OLLAMA_CONFIG, formats: ["markdown", "text"] }],
    ["wrong maximum", { ...OLLAMA_CONFIG, maxCharacters: 100000 }],
    ["wrong timeout", { ...OLLAMA_CONFIG, timeoutMs: 15000 }],
  ])("rejects %s", async (_name, providerConfig) => {
    const { result, transport } = await runCore({ providerConfig });
    expectLocalFailure(result, transport, 500, "OLLAMA_INVALID_CONFIG");
  });

  it.each([
    ["missing credentials", undefined],
    ["empty API key", { apiKey: "" }],
    ["whitespace-only API key", { apiKey: "   " }],
    ["non-ASCII API key", { apiKey: "clé" }],
    ["embedded whitespace or control", { apiKey: "abc\tdef" }],
    ["legacy key and token fields", { key: "legacy-key", token: "legacy-token" }],
  ])("rejects %s", async (_name, credentials) => {
    const { result, transport } = await runCore({ credentials });
    expectLocalFailure(result, transport, 401, "OLLAMA_INVALID_API_KEY");
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["markdown", "markdown"],
  ])("accepts %s format", async (_name, format) => {
    const { result, transport } = await runCore({ format });
    expect(result.success).toBe(true);
    expect(result.data.content.format).toBe("markdown");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["text", "text"],
    ["html", "html"],
    ["case variant", "Markdown"],
    ["array", ["markdown"]],
    ["number", 1],
  ])("rejects %s format", async (_name, format) => {
    const { result, transport } = await runCore({ format });
    expectLocalFailure(result, transport, 400, "OLLAMA_INVALID_FORMAT");
  });

  it.each([
    ["omitted", undefined, 200000],
    ["null", null, 200000],
    ["minimum", 1, 1],
    ["maximum", 200000, 200000],
  ])("accepts %s maximum", async (_name, maxCharacters, expectedMaximum) => {
    const content = "abcdef";
    const transport = vi.fn().mockResolvedValue(successResponse({ title: "Example", content, links: [] }));
    const { result } = await runCore({ maxCharacters, transport });
    expect(result.success).toBe(true);
    expect(result.data.content.text).toBe(content.slice(0, expectedMaximum));
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["string", "5"],
    ["non-finite", Infinity],
    ["over cap", 200001],
  ])("rejects %s maximum", async (_name, maxCharacters) => {
    const { result, transport } = await runCore({ maxCharacters });
    expectLocalFailure(result, transport, 400, "OLLAMA_INVALID_MAX_CHARACTERS");
  });

  it.each([
    ["missing input", undefined],
    ["surrounding whitespace", ` ${TARGET}`],
    ["malformed input", "not a URL"],
    ["unsupported scheme", "ftp://example.com/file"],
    ["embedded credentials", "https://user:pass@example.com/article"],
    ["8192-byte URL", targetWithByteLength(8192)],
  ])("validates %s", async (name, url) => {
    const { result, transport } = await runCore({ url });
    if (name === "8192-byte URL") {
      expect(result.success).toBe(true);
      expect(transport).toHaveBeenCalledTimes(1);
      return;
    }
    expectLocalFailure(result, transport, 400, "OLLAMA_INVALID_URL");
  });

  it("rejects an 8193-byte URL", async () => {
    const { result, transport } = await runCore({ url: targetWithByteLength(8193) });
    expectLocalFailure(result, transport, 400, "OLLAMA_INVALID_URL");
  });

  it("forwards the exact five-field proxy object unchanged", async () => {
    const proxyOptions = Object.freeze({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:3128",
      connectionNoProxy: "localhost,127.0.0.1",
      vercelRelayUrl: "https://relay.test/egress",
      strictProxy: false,
    });
    const { result, transport } = await runCore({ proxyOptions });

    expect(result.success).toBe(true);
    expect(transport.mock.calls[0][2]).toBe(proxyOptions);
  });

  it("does not add a direct attempt after an injected strict transport rejects", async () => {
    const transport = vi.fn().mockRejectedValue(new Error("strict proxy unavailable"));
    const { result } = await runCore({
      transport,
      proxyOptions: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.test:3128",
        connectionNoProxy: "",
        vercelRelayUrl: "",
        strictProxy: true,
      },
    });

    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_TRANSPORT_ERROR" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("Ollama web fetch deadline and bounded body", () => {
  it("rejects a caller pre-abort without starting transport", async () => {
    const caller = new AbortController();
    const reason = new DOMException("client left", "AbortError");
    caller.abort(reason);

    const { result, transport } = await runCore({ signal: caller.signal });

    expect(result).toMatchObject({ success: false, status: 499, code: "OLLAMA_CLIENT_ABORTED" });
    expect(transport).not.toHaveBeenCalled();
    expect(caller.signal.reason).toBe(reason);
  });

  it("preserves caller abort and cancels a body read once", async () => {
    const caller = new AbortController();
    const reason = new DOMException("client left", "AbortError");
    const { response, cancel } = hangingBodyResponse();
    const transport = vi.fn().mockResolvedValue(response);
    const pending = runCore({ signal: caller.signal, transport });
    for (let attempt = 0; attempt < 10 && !response.body.locked; attempt += 1) {
      await Promise.resolve();
    }
    expect(response.body.locked).toBe(true);
    caller.abort(reason);

    const { result } = await pending;

    expect(result).toMatchObject({ success: false, status: 499, code: "OLLAMA_CLIENT_ABORTED" });
    expect(caller.signal.reason).toBe(reason);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(reason);
  });

  it("times out slow response headers at 30000 ms", async () => {
    vi.useFakeTimers();
    const transport = vi.fn((_url, init) => new Promise((resolve, reject) => {
      void resolve;
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    const pending = runCore({ transport });
    const observed = captureAssertion(expect(pending).resolves.toMatchObject({
      result: { success: false, status: 504, code: "OLLAMA_TIMEOUT" },
    }));

    await vi.advanceTimersByTimeAsync(30000);
    const assertionError = await observed;
    expect(vi.getTimerCount()).toBe(0);
    if (assertionError) throw assertionError;
  });

  it("times out a slow body at 30000 ms and cancels once", async () => {
    vi.useFakeTimers();
    const { response, cancel } = hangingBodyResponse();
    const transport = vi.fn().mockResolvedValue(response);
    const pending = runCore({ transport });
    const observed = captureAssertion(expect(pending).resolves.toMatchObject({
      result: { success: false, status: 504, code: "OLLAMA_TIMEOUT" },
    }));

    await vi.advanceTimersByTimeAsync(30000);
    const assertionError = await observed;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    if (assertionError) throw assertionError;
  });

  it("times out a reader that never resolves without awaiting cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise(() => {}));
    const reader = {
      read: vi.fn(() => new Promise(() => {})),
      cancel,
      releaseLock: vi.fn(),
    };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: { getReader: () => reader },
    };
    const pending = runCore({ transport: vi.fn().mockResolvedValue(response) });
    const observed = captureAssertion(expect(pending).resolves.toMatchObject({
      result: { success: false, status: 504, code: "OLLAMA_TIMEOUT" },
    }));

    await vi.advanceTimersByTimeAsync(30000);
    const assertionError = await observed;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    if (assertionError) throw assertionError;
  });

  it("settles caller abort when injected transport ignores its signal and owns a late rejection", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const reason = new DOMException("client left", "AbortError");
    const callerAdd = vi.spyOn(caller.signal, "addEventListener");
    const callerRemove = vi.spyOn(caller.signal, "removeEventListener");
    let rejectTransport;
    let transportSignal;
    let signalAdd;
    let signalRemove;
    const transport = vi.fn((_url, init) => {
      transportSignal = init.signal;
      signalAdd = vi.spyOn(init.signal, "addEventListener");
      signalRemove = vi.spyOn(init.signal, "removeEventListener");
      return new Promise((_resolve, reject) => {
        rejectTransport = reject;
      });
    });
    const pending = runCore({ signal: caller.signal, transport });
    await Promise.resolve();
    const guarded = Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve({ result: "did not settle" }), 1)),
    ]);
    caller.abort(reason);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await guarded;
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    rejectTransport(new Error("late transport rejection"));
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    process.off("unhandledRejection", onUnhandled);

    expect(outcome.result).toMatchObject({
      success: false,
      status: 499,
      code: "OLLAMA_CLIENT_ABORTED",
    });
    expect(transportSignal.aborted).toBe(true);
    expect(transportSignal.reason).toBe(reason);
    expect(callerAdd.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    expect(callerRemove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    expect(signalAdd.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    expect(signalRemove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it("cancels a late Response once with the caller abort reason and contains sync cleanup failure", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const reason = new DOMException("client left", "AbortError");
    let resolveTransport;
    const transport = vi.fn(() => new Promise((resolve) => {
      resolveTransport = resolve;
    }));
    const pending = runCore({ signal: caller.signal, transport });
    await Promise.resolve();

    caller.abort(reason);
    const { result } = await pending;
    const cancel = vi.fn(() => {
      throw new Error("synthetic synchronous cancel failure");
    });
    const response = successResponse();
    vi.spyOn(response.body, "getReader").mockReturnValue({ cancel });
    resolveTransport(response);
    await Promise.resolve();
    await Promise.resolve();

    expect(result).toMatchObject({ success: false, status: 499, code: "OLLAMA_CLIENT_ABORTED" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles timeout when injected transport ignores its signal and owns a late resolution", async () => {
    vi.useFakeTimers();
    let resolveTransport;
    let transportSignal;
    let signalAdd;
    let signalRemove;
    const transport = vi.fn((_url, init) => {
      transportSignal = init.signal;
      signalAdd = vi.spyOn(init.signal, "addEventListener");
      signalRemove = vi.spyOn(init.signal, "removeEventListener");
      return new Promise((resolve) => {
        resolveTransport = resolve;
      });
    });
    const pending = runCore({ transport });
    await vi.advanceTimersByTimeAsync(30000);
    const guarded = Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve({ result: "did not settle" }), 1)),
    ]);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await guarded;
    const timeoutReason = transportSignal.reason;
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    const cancel = vi.fn(() => Promise.reject(new Error("synthetic asynchronous cancel failure")));
    const response = successResponse();
    vi.spyOn(response.body, "getReader").mockReturnValue({ cancel });
    resolveTransport(response);
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    process.off("unhandledRejection", onUnhandled);

    expect(outcome.result).toMatchObject({
      success: false,
      status: 504,
      code: "OLLAMA_TIMEOUT",
    });
    expect(transportSignal.aborted).toBe(true);
    expect(timeoutReason?.code).toBe("OLLAMA_TIMEOUT");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(timeoutReason);
    expect(signalAdd.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    expect(signalRemove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it.each([
    ["wrong content type", "caller"],
    ["wrong content type", "timeout"],
    ["null body", "caller"],
    ["null body", "timeout"],
    ["body read settlement", "caller"],
    ["body read settlement", "timeout"],
  ])("classifies %s boundary %s abort", async (boundary, source) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const reason = new DOMException("client left", "AbortError");
    let triggered = false;
    const trigger = () => {
      if (triggered) return;
      triggered = true;
      if (source === "caller") caller.abort(reason);
      else vi.advanceTimersByTime(30000);
    };
    const headers = {
      get(name) {
        if (boundary === "wrong content type" && name.toLowerCase() === "content-type") {
          trigger();
          return "text/plain";
        }
        return name.toLowerCase() === "content-type" ? "application/json" : null;
      },
    };
    const reader = {
      read: vi.fn().mockResolvedValue({
        get done() {
          if (boundary === "body read settlement") trigger();
          return true;
        },
        value: undefined,
      }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const response = {
      ok: true,
      status: 200,
      headers,
      get body() {
        if (boundary === "null body") {
          trigger();
          return null;
        }
        if (boundary === "body read settlement") return { getReader: () => reader };
        return null;
      },
    };
    const { result } = await runCore({
      signal: caller.signal,
      transport: vi.fn().mockResolvedValue(response),
    });

    expect(triggered).toBe(true);
    expect(result).toMatchObject({
      success: false,
      status: source === "caller" ? 499 : 504,
      code: source === "caller" ? "OLLAMA_CLIENT_ABORTED" : "OLLAMA_TIMEOUT",
    });
    if (source === "caller") expect(caller.signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a successful body at exactly 4 MiB", async () => {
    const bytes = jsonBytesOfSize(4 * 1024 * 1024);
    const { response } = streamResponse([bytes], { contentLength: bytes.byteLength });
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(response) });
    expect(result.success).toBe(true);
  });

  it("rejects and cancels a successful body one byte over 4 MiB", async () => {
    const bytes = jsonBytesOfSize(4 * 1024 * 1024 + 1);
    const { response, cancel } = streamResponse([bytes, Uint8Array.of(120)]);
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(response) });

    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_RESPONSE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("accepts a bounded body without content length", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ title: "Example", content: "ok" }));
    const { response } = streamResponse([bytes]);
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(response) });

    expect(result).toMatchObject({ success: true, data: { content: { text: "ok" } } });
  });

  it("rejects an understated content length when streamed bytes exceed 4 MiB", async () => {
    const bytes = jsonBytesOfSize(4 * 1024 * 1024 + 1);
    const { response, cancel } = streamResponse([bytes, Uint8Array.of(120)], { contentLength: 1 });
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(response) });

    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_RESPONSE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("decodes multibyte UTF-8 content", async () => {
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({ title: "Café", content: "naïve 😀" })),
    });
    expect(result).toMatchObject({
      success: true,
      data: { title: "Café", content: { text: "naïve 😀", length: 8 } },
    });
  });

  it("rejects invalid UTF-8", async () => {
    const { response } = streamResponse([new Uint8Array([0xc3, 0x28])]);
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(response) });
    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_INVALID_ENCODING" });
  });

  it("rejects invalid JSON", async () => {
    const { response } = streamResponse([new TextEncoder().encode("not-json")]);
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(response) });
    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_INVALID_JSON" });
  });

  it("rejects a non-JSON content type and cancels the body", async () => {
    const { response, cancel } = streamResponse([new TextEncoder().encode("text")], {
      contentType: "text/plain",
    });
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(response) });

    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_INVALID_CONTENT_TYPE" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("classifies an empty object distinctly", async () => {
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(successResponse({})) });
    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_EMPTY_RESPONSE" });
  });

  it("rejects a response missing title", async () => {
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({ content: "Hello" })),
    });
    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_INVALID_RESPONSE" });
  });

  it("rejects a response missing content", async () => {
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({ title: "Example" })),
    });
    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_INVALID_RESPONSE" });
  });

  it("accepts empty title and content strings", async () => {
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({ title: "", content: "" })),
    });
    expect(result).toMatchObject({
      success: true,
      data: { title: null, content: { text: "", length: 0 } },
    });
  });
});

describe("Ollama web fetch normalized response", () => {
  it("omits links when the field is missing", async () => {
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({ title: "Example", content: "Hello" })),
    });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("links");
  });

  it("omits an empty links array", async () => {
    const { result } = await runCore();
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("links");
  });

  it("preserves 100 valid links in upstream order", async () => {
    const links = Array.from({ length: 100 }, (_value, index) => `https://example.com/${index}`);
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({ title: "Example", content: "Hello", links })),
    });
    expect(result).toMatchObject({ success: true, data: { links } });
  });

  it("rejects 101 links", async () => {
    const links = Array.from({ length: 101 }, (_value, index) => `https://example.com/${index}`);
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({ title: "Example", content: "Hello", links })),
    });
    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_INVALID_RESPONSE" });
  });

  it("accepts exactly 64 KiB of links", async () => {
    const links = Array.from({ length: 8 }, () => targetWithByteLength(8192));
    expect(links.reduce((total, link) => total + Buffer.byteLength(link), 0)).toBe(64 * 1024);
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({ title: "Example", content: "Hello", links })),
    });
    expect(result).toMatchObject({ success: true, data: { links } });
  });

  it("rejects one byte over aggregate and individual link limits", async () => {
    const aggregateOver = [
      ...Array.from({ length: 8 }, () => targetWithByteLength(8192)),
      "https://x.co/",
    ];
    const individualOver = [targetWithByteLength(8193)];

    for (const links of [aggregateOver, individualOver]) {
      const { result } = await runCore({
        transport: vi.fn().mockResolvedValue(successResponse({ title: "Example", content: "Hello", links })),
      });
      expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_INVALID_RESPONSE" });
    }
  });

  it("rejects a non-string link", async () => {
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({
        title: "Example",
        content: "Hello",
        links: [42],
      })),
    });
    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_INVALID_RESPONSE" });
  });

  it("rejects a non-HTTP link", async () => {
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({
        title: "Example",
        content: "Hello",
        links: ["ftp://example.com/file"],
      })),
    });
    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_INVALID_RESPONSE" });
  });

  it("rejects link userinfo", async () => {
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({
        title: "Example",
        content: "Hello",
        links: ["https://user:pass@example.com/private"],
      })),
    });
    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_INVALID_RESPONSE" });
  });

  it("rejects surrounding link whitespace", async () => {
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({
        title: "Example",
        content: "Hello",
        links: [" https://example.com/article"],
      })),
    });
    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_INVALID_RESPONSE" });
  });

  it("preserves link order without dereferencing any returned URL", async () => {
    const links = ["https://b.example/path", "http://a.example/", "https://c.example/final"];
    const transport = vi.fn().mockResolvedValue(successResponse({ title: "Example", content: "Hello", links }));
    const { result } = await runCore({ transport });

    expect(result).toMatchObject({ success: true, data: { links } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("truncates default content at 200000 UTF-16 code units", async () => {
    const content = "x".repeat(200001);
    const { result } = await runCore({
      transport: vi.fn().mockResolvedValue(successResponse({ title: "Example", content })),
    });
    expect(result).toMatchObject({
      success: true,
      data: { content: { text: "x".repeat(200000), length: 200000 } },
    });
  });

  it("preserves content exactly at the requested maximum", async () => {
    const { result } = await runCore({
      maxCharacters: 5,
      transport: vi.fn().mockResolvedValue(successResponse({ title: "Example", content: "abcde" })),
    });
    expect(result).toMatchObject({ success: true, data: { content: { text: "abcde", length: 5 } } });
  });

  it("truncates content over the requested maximum", async () => {
    const { result } = await runCore({
      maxCharacters: 5,
      transport: vi.fn().mockResolvedValue(successResponse({ title: "Example", content: "abcdef" })),
    });
    expect(result).toMatchObject({ success: true, data: { content: { text: "abcde", length: 5 } } });
  });

  it("drops an unmatched high surrogate at the truncation boundary", async () => {
    const { result } = await runCore({
      maxCharacters: 2,
      transport: vi.fn().mockResolvedValue(successResponse({ title: "Example", content: "A😀B" })),
    });
    expect(result).toMatchObject({ success: true, data: { content: { text: "A", length: 1 } } });
  });

  it("returns a bounded scalar JSON upstream error", async () => {
    const response = new Response(JSON.stringify({ error: "quota unavailable" }), {
      status: 429,
      headers: { "Content-Type": "application/problem+json; charset=utf-8" },
    });
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(response) });
    expect(result).toEqual({
      success: false,
      status: 429,
      code: "OLLAMA_UPSTREAM_ERROR",
      error: "quota unavailable",
      failureMetadata: { safeToReplay: true },
      resetsAtMs: null,
    });
  });

  it("uses a generic message for non-JSON upstream text", async () => {
    const response = new Response("private provider detail", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(response) });
    expect(result).toEqual({
      success: false,
      status: 503,
      code: "OLLAMA_UPSTREAM_ERROR",
      error: "Ollama web fetch failed (HTTP 503)",
      failureMetadata: { safeToReplay: false },
      resetsAtMs: null,
    });
  });

  it("cancels an oversized diagnostic body and uses a generic message", async () => {
    const bytes = new Uint8Array(16 * 1024 + 1).fill(120);
    const { response, cancel } = streamResponse([bytes, Uint8Array.of(120)], {
      status: 500,
      contentType: "application/json",
    });
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(response) });

    expect(result).toEqual({
      success: false,
      status: 500,
      code: "OLLAMA_UPSTREAM_ERROR",
      error: "Ollama web fetch failed (HTTP 500)",
      failureMetadata: { safeToReplay: false },
      resetsAtMs: null,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("redacts the API key and target URL from upstream diagnostics", async () => {
    const response = new Response(JSON.stringify({
      error: `Bearer ${API_KEY} could not fetch ${TARGET}`,
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
    const { result } = await runCore({ transport: vi.fn().mockResolvedValue(response) });

    expect(result).toMatchObject({ success: false, status: 403, code: "OLLAMA_UPSTREAM_ERROR" });
    expect(result.error).not.toContain(API_KEY);
    expect(result.error).not.toContain(TARGET);
    expect(result.error.length).toBeLessThanOrEqual(512);
  });

  it("redacts configured proxy URL userinfo from transport failures", async () => {
    const proxyUrl = "http://proxy-user:proxy-pass@proxy.test:3128";
    const transport = vi.fn().mockRejectedValue(new Error(
      `failed via ${proxyUrl} for proxy-user with proxy-pass while fetching ${TARGET}`,
    ));
    const { result } = await runCore({
      transport,
      proxyOptions: {
        connectionProxyEnabled: true,
        connectionProxyUrl: proxyUrl,
        connectionNoProxy: "",
        vercelRelayUrl: "",
        strictProxy: true,
      },
    });

    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_TRANSPORT_ERROR" });
    expect(result.error).not.toContain(proxyUrl);
    expect(result.error).not.toContain("proxy-user");
    expect(result.error).not.toContain("proxy-pass");
    expect(result.error).not.toContain(TARGET);
    expect(result.error.length).toBeLessThanOrEqual(512);
  });

  it("redacts canonical and decoded target variants from upstream JSON diagnostics", async () => {
    const rawUrl = "https://EXAMPLE.com:443/%61rticle";
    const canonicalUrl = new URL(rawUrl).href;
    const decodedUrl = decodeURI(canonicalUrl);
    const response = new Response(JSON.stringify({
      error: `failed ${canonicalUrl} after decoding ${decodedUrl} with Bearer ${API_KEY}`,
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
    const { result } = await runCore({
      url: rawUrl,
      transport: vi.fn().mockResolvedValue(response),
    });

    expect(result).toMatchObject({ success: false, status: 403, code: "OLLAMA_UPSTREAM_ERROR" });
    for (const secret of [rawUrl, canonicalUrl, decodedUrl, API_KEY]) {
      expect(result.error).not.toContain(secret);
    }
  });

  it("redacts canonical and decoded target variants from transport diagnostics", async () => {
    const rawUrl = "https://EXAMPLE.com:443/%61rticle";
    const canonicalUrl = new URL(rawUrl).href;
    const decodedUrl = decodeURI(canonicalUrl);
    const transport = vi.fn().mockRejectedValue(new Error(
      `transport failed for ${canonicalUrl} and decoded ${decodedUrl}`,
    ));
    const { result } = await runCore({ url: rawUrl, transport });

    expect(result).toMatchObject({ success: false, status: 502, code: "OLLAMA_TRANSPORT_ERROR" });
    for (const secret of [rawUrl, canonicalUrl, decodedUrl, API_KEY]) {
      expect(result.error).not.toContain(secret);
    }
  });
});

describe("Ollama default proxy transport", () => {
  it("passes exact proxy policy to the default transport and never falls back when strict", async () => {
    const proxyOptions = Object.freeze({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy-user:proxy-pass@127.0.0.1:19999",
      connectionNoProxy: "localhost,127.0.0.1",
      vercelRelayUrl: "",
      strictProxy: true,
    });
    const priorFetch = globalThis.fetch;
    let proxyAttempts = 0;
    let directAttempts = 0;
    const nativeFetch = vi.fn(async (_url, init = {}) => {
      if (init.dispatcher) {
        proxyAttempts += 1;
        throw new Error("synthetic proxy refusal");
      }
      directAttempts += 1;
      throw new Error("unexpected direct Ollama attempt");
    });

    try {
      globalThis.fetch = nativeFetch;
      vi.resetModules();
      const actualProxyModule = await vi.importActual("../../open-sse/utils/proxyFetch.js");
      const observedProxyAwareFetch = vi.fn((...args) => actualProxyModule.proxyAwareFetch(...args));
      vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
        ...actualProxyModule,
        proxyAwareFetch: observedProxyAwareFetch,
      }));
      const { handleFetchCore: freshCore } = await import("../../open-sse/handlers/fetch/index.js");

      const result = await freshCore({
        url: TARGET,
        provider: "ollama",
        providerConfig: OLLAMA_CONFIG,
        credentials: { apiKey: API_KEY },
        proxyOptions,
      });

      expect(result).toMatchObject({
        success: false,
        status: 502,
        code: "OLLAMA_TRANSPORT_ERROR",
      });
      expect(observedProxyAwareFetch).toHaveBeenCalledTimes(1);
      expect(observedProxyAwareFetch.mock.calls[0][0]).toBe("https://ollama.com/api/web_fetch");
      expect(observedProxyAwareFetch.mock.calls[0][2]).toBe(proxyOptions);
      expect(nativeFetch).toHaveBeenCalledTimes(1);
      expect(nativeFetch.mock.calls[0][1]).toEqual(expect.objectContaining({
        dispatcher: expect.anything(),
      }));
      expect(proxyAttempts).toBe(1);
      expect(directAttempts).toBe(0);
    } finally {
      vi.doUnmock("../../open-sse/utils/proxyFetch.js");
      vi.resetModules();
      globalThis.fetch = priorFetch;
    }
  });
});

describe("application signal and proxy plumbing", () => {
  it("passes the Request signal and resolved connection proxy policy", async () => {
    const providerSpecificData = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:3128",
      connectionNoProxy: "localhost,127.0.0.1",
      connectionProxyPoolId: "pool-a",
      vercelRelayUrl: "https://relay.test/egress",
      strictProxy: true,
    };
    const caller = new AbortController();
    const { handleFetch, mocks } = await importFetchHandlerForPlumbing();
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: API_KEY,
      connectionId: "connection-a",
      connectionName: "Ollama A",
      providerSpecificData,
    });
    const request = new Request("http://localhost/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "transport-fixture", url: TARGET }),
      signal: caller.signal,
    });

    const response = await handleFetch(request);

    expect(response.status).toBe(200);
    const coreArgs = mocks.handleFetchCore.mock.calls[0][0];
    expect(coreArgs.signal).toBe(request.signal);
    expect(coreArgs.signal).not.toBe(caller.signal);
    expect(coreArgs.proxyOptions).toEqual({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:3128",
      connectionNoProxy: "localhost,127.0.0.1",
      vercelRelayUrl: "https://relay.test/egress",
      strictProxy: true,
    });
    expect(coreArgs).not.toHaveProperty("transport");
    expect(coreArgs.proxyOptions).not.toHaveProperty("connectionProxyPoolId");
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith("transport-fixture", expect.any(Set));

    const reason = new DOMException("client left", "AbortError");
    caller.abort(reason);
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe(reason);
    expect(coreArgs.signal.reason).toBe(reason);
  });

  it("passes the Request signal and normalized direct policy for no-auth providers", async () => {
    const caller = new AbortController();
    const { handleFetch, mocks } = await importFetchHandlerForPlumbing({ noAuth: true });
    const request = new Request("http://localhost/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "transport-fixture", url: TARGET }),
      signal: caller.signal,
    });

    const response = await handleFetch(request);

    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    const coreArgs = mocks.handleFetchCore.mock.calls[0][0];
    expect(coreArgs.signal).toBe(request.signal);
    expect(coreArgs.signal).not.toBe(caller.signal);
    expect(coreArgs.proxyOptions).toEqual({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    });
    expect(coreArgs).not.toHaveProperty("transport");

    const reason = new DOMException("client left", "AbortError");
    caller.abort(reason);
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe(reason);
    expect(coreArgs.signal.reason).toBe(reason);
  });
});
