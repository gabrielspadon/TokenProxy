import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  refreshCredentials: vi.fn(),
  refreshWithRetry: vi.fn(),
  parseUpstreamError: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: mocks.execute,
    refreshCredentials: mocks.refreshCredentials,
    noAuth: false,
  })),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: (...args) => mocks.refreshWithRetry(...args),
}));

vi.mock("../../open-sse/translator/index.js", () => ({
  translateRequest: vi.fn((source, _target, model, body) => {
    if (source === "claude") {
      return {
        model,
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        stream: body.stream,
      };
    }
    return { ...body, model };
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
  anchorClaudeCache: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/translator/concerns/adaptiveStripper.js", () => ({
  stripRejectedFields: vi.fn((body) => {
    if (!Object.hasOwn(body, "verbosity")) return null;
    const stripped = { ...body };
    delete stripped.verbosity;
    return stripped;
  }),
  addRejectedFields: vi.fn(),
  getRejectedFields: vi.fn(() => new Set()),
  extractRejectedFieldNamesFromError: vi.fn((message) =>
    message.includes("verbosity") ? ["verbosity"] : []),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createCallerAbortResult: vi.fn(() => ({
    success: false,
    clientAborted: true,
    status: 499,
    error: "Request aborted",
    response: Response.json({ error: { message: "Request aborted" } }, { status: 499 }),
  })),
  createErrorResult: vi.fn((status, message, _resetAt, failureMetadata) => ({
    success: false,
    status,
    error: message,
    failureMetadata,
    response: Response.json({ error: { message } }, { status }),
  })),
  formatProviderError: vi.fn((error) => error.message),
  isCallerAbortError: vi.fn(() => false),
  parseUpstreamError: (...args) => mocks.parseUpstreamError(...args),
}));

vi.mock("../../open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
  handleNonStreamingResponse: vi.fn(async ({ providerResponse }) => ({
    success: true,
    response: providerResponse,
  })),
}));

vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: vi.fn(async () => null),
}));

vi.mock("../../open-sse/handlers/chatCore/streamingHandler.js", () => ({
  buildOnStreamComplete: vi.fn(() => ({
    onStreamComplete: vi.fn(),
    onStreamAbandoned: vi.fn(),
    streamDetailId: null,
    streamState: {},
  })),
  handleStreamingResponse: vi.fn(() => ({ success: true, response: new Response() })),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { ConnectTimeoutError } = await import("../../open-sse/utils/responseHeaderTimeout.js");
const { applyCodexFastMode } = await import("../../open-sse/config/codexFastMode.js");

const { createFallbackDeadline } = await import("../../open-sse/utils/fallbackDeadline.js");
const { requestSignal, withRequestLifetime } = await import("../../open-sse/utils/requestLifetime.js");
afterEach(() => vi.useRealTimers());

const connectTimeout = { providerOverride: 8000, globalTimeout: 15000 };

function response(status) {
  return {
    response: new Response(null, { status }),
    url: "https://upstream.test/chat",
    headers: {},
    transformedBody: {},
  };
}

function options(overrides = {}) {
  const body = {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    ...overrides.body,
  };
  return {
    body,
    modelInfo: { provider: "deepseek", model: "deepseek-chat" },
    credentials: { apiKey: "test", providerSpecificData: {} },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: "application/json" },
    },
    connectionId: "connection-1",
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: mocks.warn,
      error: vi.fn(),
    },
    connectTimeout,
    ...overrides,
    body,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockReset();
  mocks.refreshCredentials.mockReset();
  mocks.refreshWithRetry.mockReset();
  mocks.refreshCredentials.mockResolvedValue({ accessToken: "fresh-token" });
  mocks.refreshWithRetry.mockImplementation(async (refresh) => refresh());
  mocks.parseUpstreamError.mockImplementation(async (upstream) => ({
    statusCode: upstream.status,
    message: upstream.status === 400 ? "Unsupported parameter: verbosity" : "upstream rejected request",
  }));
});

describe("chat connect timeout propagation", () => {
  it("carries caller cancellation into the initial executor attempt", async () => {
    const caller = new AbortController();
    const reason = new DOMException("client left", "AbortError");
    let started;
    const executorStarted = new Promise((resolve) => {
      started = resolve;
    });
    mocks.execute.mockImplementationOnce(({ signal }) => {
      started(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const pending = handleChatCore(options({ callerSignal: caller.signal }));
    const executorSignal = await executorStarted;
    caller.abort(reason);

    await expect(pending).resolves.toMatchObject({ success: false, status: 499, clientAborted: true });
    expect(executorSignal).not.toBe(caller.signal);
    expect(executorSignal).toMatchObject({ aborted: true, reason });
  });

  it("carries caller cancellation into the credential-refresh executor attempt", async () => {
    const caller = new AbortController();
    const reason = new DOMException("client left", "AbortError");
    let started;
    const retryStarted = new Promise((resolve) => {
      started = resolve;
    });
    mocks.execute
      .mockResolvedValueOnce(response(401))
      .mockImplementationOnce(({ signal }) => {
        started(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });

    const pending = handleChatCore(options({ callerSignal: caller.signal }));
    const executorSignal = await retryStarted;
    caller.abort(reason);

    await expect(pending).resolves.toMatchObject({ success: false, status: 499, clientAborted: true });
    expect(executorSignal).toMatchObject({ aborted: true, reason });
  });

  it("carries caller cancellation into the field-strip executor attempt", async () => {
    const caller = new AbortController();
    const reason = new DOMException("client left", "AbortError");
    let started;
    const retryStarted = new Promise((resolve) => {
      started = resolve;
    });
    mocks.execute
      .mockResolvedValueOnce(response(400))
      .mockImplementationOnce(({ signal }) => {
        started(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });

    const pending = handleChatCore(options({
      callerSignal: caller.signal,
      body: { verbosity: "high" },
    }));
    const executorSignal = await retryStarted;
    caller.abort(reason);

    await expect(pending).resolves.toMatchObject({ success: false, status: 499, clientAborted: true });
    expect(executorSignal).toMatchObject({ aborted: true, reason });
  });

  it("passes the same context to initial and credential-refresh attempts", async () => {
    mocks.execute.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200));

    const result = await handleChatCore(options());

    expect(result.success).toBe(true);
    expect(mocks.execute.mock.calls.map(([request]) => request.connectTimeout)).toEqual([
      connectTimeout,
      connectTimeout,
    ]);
  });

  it("passes the same context to initial and field-strip attempts", async () => {
    mocks.execute.mockResolvedValueOnce(response(400)).mockResolvedValueOnce(response(200));

    const result = await handleChatCore(options({ body: { verbosity: "high" } }));

    expect(result.success).toBe(true);
    expect(mocks.execute.mock.calls.map(([request]) => request.connectTimeout)).toEqual([
      connectTimeout,
      connectTimeout,
    ]);
  });

  it("maps an initial typed timeout to 502", async () => {
    mocks.execute.mockRejectedValueOnce(new ConnectTimeoutError(8000));
    await expect(handleChatCore(options())).resolves.toMatchObject({ success: false, status: 502 });
  });

  it.each([400, 401, 403, 429, 503])("preserves non-replayable provenance on an executor's synthetic HTTP %s", async (status) => {
    const result = response(status);
    result.response.headers.set("x-tokenproxy-replay-safe", "false");
    mocks.execute.mockResolvedValueOnce(result);
    await expect(handleChatCore(options({ body: { verbosity: "high" } }))).resolves.toMatchObject({
      success: false,
      failureMetadata: { safeToReplay: false },
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.refreshWithRetry).not.toHaveBeenCalled();
  });

  it.each([false, true])('carries wire-proven quota rejection separately from same-account retry advice (generation evidence %s)', async generationEvidence => {
    const upstream = response(429);
    upstream.response.headers.set('x-should-retry', 'false');
    mocks.execute.mockResolvedValueOnce(upstream);
    mocks.parseUpstreamError.mockResolvedValueOnce({ statusCode: 429, message: 'Usage credits required',
      errorPayload: { error: { message: 'Usage credits required' }, ...(generationEvidence ? { usage: { total_tokens: 1 } } : {}) } });
    const result = await handleChatCore(options());
    expect(result.failureMetadata).toMatchObject({ safeToReplay: false, safeAcrossAccounts: !generationEvidence });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('does not authorize cross-account replay when a canonical 429 reports accepted generation', async () => {
    mocks.execute.mockResolvedValueOnce(response(429));
    const message = 'quota exhausted after generation accepted';
    mocks.parseUpstreamError.mockResolvedValue({ statusCode: 429, message,
      errorPayload: { error: { type: 'rate_limit_error', message } } });
    const result = await handleChatCore(options());
    expect(result.failureMetadata).toMatchObject({ safeToReplay: false, safeAcrossAccounts: false });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("forbids another replay after an accepted field-strip retry returns a synthetic failure", async () => {
    const rejected = response(503);
    rejected.response.headers.set("x-tokenproxy-replay-safe", "false");
    mocks.execute.mockResolvedValueOnce(response(400)).mockResolvedValueOnce(rejected);
    await expect(handleChatCore(options({ body: { verbosity: "high" } }))).resolves.toMatchObject({
      success: false, status: 503, failureMetadata: { safeToReplay: false },
    });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it("maps an initial caller abort to 499", async () => {
    mocks.execute.mockRejectedValueOnce(new DOMException("client left", "AbortError"));
    await expect(handleChatCore(options())).resolves.toMatchObject({ success: false, status: 499 });
  });

  it.each([
    [new ConnectTimeoutError(8000), 502],
    [new DOMException("client left", "AbortError"), 499],
  ])("maps credential-refresh retry transport error to %s", async (failure, expectedStatus) => {
    mocks.execute.mockResolvedValueOnce(response(401)).mockRejectedValueOnce(failure);
    await expect(handleChatCore(options())).resolves.toMatchObject({ success: false, status: expectedStatus });
  });

  it("maps an unrelated credential-refresh retry error to 502", async () => {
    mocks.execute.mockResolvedValueOnce(response(401)).mockRejectedValueOnce(new Error("socket closed"));
    await expect(handleChatCore(options())).resolves.toMatchObject({ success: false, status: 502 });
  });

  it.each([
    [new ConnectTimeoutError(8000), 502],
    [new DOMException("client left", "AbortError"), 499],
  ])("maps field-strip retry transport error to %s", async (failure, expectedStatus) => {
    mocks.execute.mockResolvedValueOnce(response(400)).mockRejectedValueOnce(failure);
    await expect(handleChatCore(options({ body: { verbosity: "high" } }))).resolves.toMatchObject({
      success: false,
      status: expectedStatus,
    });
  });

  it("forbids replay after a field-strip retry loses its transport outcome", async () => {
    mocks.execute.mockResolvedValueOnce(response(400)).mockRejectedValueOnce(new Error("socket closed"));
    await expect(handleChatCore(options({ body: { verbosity: "high" } }))).resolves.toMatchObject({
      success: false,
      status: 502,
      failureMetadata: { safeToReplay: false },
    });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });
  it('keeps the deadline armed after intermediate rejected headers', async () => {
    vi.useFakeTimers();
    const fallbackDeadline = createFallbackDeadline({ timeoutMs: 1000 });
    mocks.execute.mockImplementationOnce(async ({ afterDispatch }) => {
      await afterDispatch(new Response(null, { status: 503 }));
      return new Promise(() => {});
    });
    const pending = handleChatCore(options({ connectTimeout: { ...connectTimeout, fallbackDeadline } }));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ status: 504, failureMetadata: { safeToReplay: false } });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it.each(['deadline', 'caller'])('persists an issued one-use refresh after its %s expires without dispatching', async (termination) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fallbackDeadline = createFallbackDeadline({ timeoutMs: 1000 });
    let completeRedemption;
    mocks.execute.mockResolvedValueOnce(response(401));
    mocks.refreshCredentials.mockImplementationOnce(() => {
      expect(requestSignal()).toBeUndefined();
      return new Promise(resolve => { completeRedemption = resolve; });
    });
    const stored = { accessToken: 'durable-access', refreshToken: 'durable-rotation' };
    const persist = vi.fn(async () => stored);
    const pending = withRequestLifetime(caller.signal, () => handleChatCore(options({
      callerSignal: caller.signal, connectTimeout: { ...connectTimeout, fallbackDeadline }, onCredentialsRefreshed: persist,
    })));
    await vi.advanceTimersByTimeAsync(0);
    expect(completeRedemption).toBeTypeOf('function');
    if (termination === 'caller') caller.abort();
    else await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ status: termination === 'caller' ? 499 : 504 });
    completeRedemption({ accessToken: 'rotated-access', refreshToken: 'one-use-rotation' });
    await vi.advanceTimersByTimeAsync(0);
    expect(persist).toHaveBeenCalledExactlyOnceWith({ accessToken: 'rotated-access', refreshToken: 'one-use-rotation' });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it.each([null, false, 'throw'])('refuses retry dispatch when credential persistence returns %s', async acknowledgement => {
    mocks.execute.mockResolvedValueOnce(response(401));
    const persist = vi.fn(async () => {
      if (acknowledgement === 'throw') throw new Error('SECRET_CANARY');
      return acknowledgement;
    });
    await expect(handleChatCore(options({ onCredentialsRefreshed: persist }))).resolves.toMatchObject({
      status: 502, failureMetadata: { safeToReplay: false },
    });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('SECRET_CANARY');
  });

  it('dispatches only the authoritative persisted refresh result', async () => {
    mocks.execute.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200));
    const persist = vi.fn(async () => ({ accessToken: 'persisted-winner', refreshToken: 'persisted-rotation' }));
    await expect(handleChatCore(options({ onCredentialsRefreshed: persist }))).resolves.toMatchObject({ success: true });
    expect(mocks.execute.mock.calls[1][0].credentials).toMatchObject({ accessToken: 'persisted-winner', refreshToken: 'persisted-rotation' });
  });


});

describe("Codex Sol Fast policy", () => {
  it("is provider-scoped and leaves the input body untouched", () => {
    const body = Object.freeze({ model: "gpt-5.6-sol", input: [] });

    expect(applyCodexFastMode(body, {
      provider: "openai",
      model: "gpt-5.6-sol(max)",
      enabled: true,
    })).toBe(body);
    expect(applyCodexFastMode(body, {
      provider: "codex",
      model: "codex/gpt-5.6-sol(max)",
      enabled: true,
    })).toEqual({ ...body, service_tier: "priority" });
    expect(body).not.toHaveProperty("service_tier");
  });

  it.each([
    "gpt-5.6-sol(max)",
    "gpt-5.6-sol-review(ultra)",
  ])("applies priority after Claude translation for %s", async (model) => {
    mocks.execute.mockResolvedValueOnce(response(200));

    await handleChatCore(options({
      body: {
        model,
        system: "Be concise",
        messages: [{ role: "user", content: "hello" }],
      },
      modelInfo: { provider: "codex", model },
      sourceFormatOverride: "claude",
      codexFastMode: true,
    }));

    expect(mocks.execute.mock.calls[0][0].body).toMatchObject({
      model: expect.stringMatching(/^gpt-5\.6-sol/),
      service_tier: "priority",
    });
  });

  it.each([
    [false, "gpt-5.6-sol(max)"],
    [true, "gpt-5.6-codex(max)"],
    [true, "gpt-5.6-solstice(max)"],
  ])("does not apply outside the enabled Sol scope", async (enabled, model) => {
    mocks.execute.mockResolvedValueOnce(response(200));

    await handleChatCore(options({
      modelInfo: { provider: "codex", model },
      codexFastMode: enabled,
    }));

    expect(mocks.execute.mock.calls[0][0].body).not.toHaveProperty("service_tier");
  });

  it.each([
    ["default", true, "gpt-5.6-sol"],
    ["priority", true, "gpt-5.6-sol"],
    ["unsupported", true, "gpt-5.6-sol"],
    ["priority", false, "gpt-5.6-sol"],
    ["priority", true, "gpt-5.6-terra"],
    ["default", false, "gpt-5.6-luna"],
  ])(
    'preserves explicit service tier "%s" with Fast=%s for %s',
    async (serviceTier, codexFastMode, model) => {
    mocks.execute.mockResolvedValueOnce(response(200));

    await handleChatCore(options({
      body: { service_tier: serviceTier },
      modelInfo: { provider: "codex", model },
      sourceFormatOverride: "claude",
      codexFastMode,
    }));

      expect(mocks.execute.mock.calls[0][0].body.service_tier).toBe(serviceTier);
    },
  );
});
