import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  proxyAwareFetch: vi.fn(),
  refreshCredentials: vi.fn(),
  refreshWithRetry: vi.fn(),
  noAuth: false,
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: mocks.execute,
    refreshCredentials: mocks.refreshCredentials,
    get noAuth() {
      return mocks.noAuth;
    },
  })),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", async (importOriginal) => ({
  ...await importOriginal(),
  refreshWithRetry: (...args) => mocks.refreshWithRetry(...args),
}));

vi.mock("../../open-sse/handlers/chatCore/upstreamRoute.js", () => ({
  resolveUpstreamRoute: vi.fn(() => ({
    targetFormat: "openai",
    transport: { id: "test-transport" },
  })),
}));

vi.mock("../../open-sse/translator/index.js", () => ({
  register: vi.fn(),
  needsTranslation: vi.fn(() => false),
  translateRequest: vi.fn((_source, _target, model, body) => ({ ...body, model })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
  handleNonStreamingResponse: vi.fn(async () => ({ success: true, response: new Response() })),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { VertexExecutor } = await import("../../open-sse/executors/vertex.js");

function coreOptions(credentials, requestId) {
  const body = {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  };
  return {
    body,
    modelInfo: { provider: "deepseek", model: "deepseek-chat" },
    credentials,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { "x-request-id": requestId },
    },
    connectionId: "shared-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
}

describe("PR #3170 credential metadata isolation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.noAuth = false;
    mocks.refreshWithRetry.mockImplementation(async (refresh) => refresh());
    mocks.refreshCredentials.mockResolvedValue({
      accessToken: "refreshed-token",
      refreshToken: "rotated-refresh-token",
    });
    mocks.execute.mockImplementation(async ({ credentials }) => {
      const requestId = credentials.rawHeaders["x-request-id"];
      credentials.session = `session-${requestId}`;
      credentials.accessToken = `token-${requestId}`;
      credentials.providerSpecificData.requestId = requestId;
      return {
        response: new Response("{}", { status: 200 }),
        url: "https://upstream.test/chat/completions",
        headers: {},
        transformedBody: {},
      };
    });
    mocks.proxyAwareFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("keeps frozen shared credentials isolated across independent chat requests", async () => {
    const shared = Object.freeze({
      apiKey: "shared-api-key",
      providerSpecificData: Object.freeze({ stable: true }),
    });

    await Promise.all([
      handleChatCore(coreOptions(shared, "request-a")),
      handleChatCore(coreOptions(shared, "request-b")),
    ]);

    const effectiveCredentials = mocks.execute.mock.calls.map(([request]) => request.credentials);
    expect(effectiveCredentials).toHaveLength(2);
    expect(effectiveCredentials).not.toContain(shared);
    expect(effectiveCredentials.map((item) => ({
      runtimeTransport: item.runtimeTransport.id,
      requestId: item.rawHeaders["x-request-id"],
      session: item.session,
      accessToken: item.accessToken,
      providerRequestId: item.providerSpecificData.requestId,
    }))).toEqual(expect.arrayContaining([
      {
        runtimeTransport: "test-transport",
        requestId: "request-a",
        session: "session-request-a",
        accessToken: "token-request-a",
        providerRequestId: "request-a",
      },
      {
        runtimeTransport: "test-transport",
        requestId: "request-b",
        session: "session-request-b",
        accessToken: "token-request-b",
        providerRequestId: "request-b",
      },
    ]));
    expect(effectiveCredentials[0].providerSpecificData).not.toBe(shared.providerSpecificData);
    expect(effectiveCredentials[1].providerSpecificData).not.toBe(shared.providerSpecificData);
    expect(shared).toEqual({ apiKey: "shared-api-key", providerSpecificData: { stable: true } });
    expect(shared).not.toHaveProperty("rawHeaders");
    expect(shared).not.toHaveProperty("runtimeTransport");
    expect(shared).not.toHaveProperty("session");
    expect(shared).not.toHaveProperty("accessToken");
  });

  it("keeps a refresh retry local while reporting rotated credentials", async () => {
    const shared = Object.freeze({
      apiKey: "shared-api-key",
      refreshToken: "original-refresh-token",
      providerSpecificData: Object.freeze({ stable: true }),
    });
    mocks.execute
      .mockResolvedValueOnce({
        response: new Response("{}", { status: 401 }),
        url: "https://upstream.test/chat/completions",
        headers: {},
        transformedBody: {},
      })
      .mockImplementationOnce(async ({ credentials }) => {
        expect(credentials).not.toBe(shared);
        expect(credentials.accessToken).toBe("refreshed-token");
        expect(credentials.refreshToken).toBe("rotated-refresh-token");
        return {
          response: new Response("{}", { status: 200 }),
          url: "https://upstream.test/chat/completions",
          headers: {},
          transformedBody: {},
        };
      });
    // The acknowledgement a real persist returns. chatCore treats a callback
    // that resolves to anything other than an object as "persistence was not
    // confirmed" and refuses the retry, so a callback returning undefined
    // describes a store that silently dropped the rotated token rather than
    // the successful rotation this test is about. Every production caller
    // (src/sse/handlers/chat.js, src/sse/services/tokenRefresh.js) returns the
    // stored row.
    const onCredentialsRefreshed = vi.fn(async (refreshed) => ({ ...refreshed }));

    const result = await handleChatCore({
      ...coreOptions(shared, "refresh-request"),
      onCredentialsRefreshed,
    });

    expect(result.success).toBe(true);
    expect(onCredentialsRefreshed).toHaveBeenCalledWith({
      accessToken: "refreshed-token",
      refreshToken: "rotated-refresh-token",
    });
    expect(shared).toEqual({
      apiKey: "shared-api-key",
      refreshToken: "original-refresh-token",
      providerSpecificData: { stable: true },
    });
    expect(shared).not.toHaveProperty("rawHeaders");
    expect(shared).not.toHaveProperty("accessToken");
  });

  it("does not cache a resolved Vertex project ID on frozen direct-executor credentials", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "projects/direct-isolation-project/locations/global was not found" },
    }), { status: 404 }));
    const shared = Object.freeze({
      apiKey: "vertex-direct-api-key",
      providerSpecificData: Object.freeze({ stable: true }),
    });

    const result = await new VertexExecutor("vertex-partner").execute({
      model: "meta/llama-4-scout",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: shared,
    });

    expect(result.url).toContain("/projects/direct-isolation-project/locations/global/");
    expect(shared).toEqual({
      apiKey: "vertex-direct-api-key",
      providerSpecificData: { stable: true },
    });
    expect(shared.providerSpecificData).not.toHaveProperty("projectId");
  });
});
