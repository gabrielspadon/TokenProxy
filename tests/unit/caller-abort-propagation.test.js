import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
const dispatchMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({ getComboModels: vi.fn(), getModelInfo: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: authMocks.clearAccountError,
  extractApiKey: () => null,
  getProviderCredentials: authMocks.getProviderCredentials,
  isValidApiKey: vi.fn(async () => true),
  markAccountUnavailable: authMocks.markAccountUnavailable,
}));
vi.mock("open-sse/handlers/chatCore.js", () => dispatchMocks);
// Spread the real module: the chat handler imports more from it than these
// three, and a mock that returns only some fails the whole file with
// "No <name> export" rather than one assertion.
vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  detectRequiredCapabilities: vi.fn(() => []),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
}));
// Spread the real module: a partial mock fails the WHOLE file the moment the
// module gains an export this object does not name (#577 added isModelDisabled).
vi.mock("@/sse/services/model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...modelMocks,
}));
vi.mock("@/lib/localDb", () => settingsMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(() => "***"),
  warn: vi.fn(),
}));
vi.mock("open-sse/utils/ollamaTransform.js", () => ({ transformToOllama: (response) => response }));

let handleChat;
let routes;

function credentials(connectionId = "account-a") {
  return {
    connectionId,
    connectionName: connectionId,
    apiKey: "provider-key",
    providerSpecificData: {},
  };
}

function request(path = "/v1/chat/completions", signal) {
  // The shape guard runs per endpoint before dispatch, so a Responses path
  // carries input[] — a chat-shaped body there is refused as malformed and the
  // abort path under test is never reached.
  const body = path.includes("/v1/responses")
    ? { model: "codex/gpt-5.6-sol", input: "hello" }
    : { model: "codex/gpt-5.6-sol", messages: [{ role: "user", content: "hello" }] };
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(body),
  });
}

function clientAborted() {
  return {
    success: false,
    clientAborted: true,
    status: 499,
    error: "Request aborted",
    response: Response.json({ error: { message: "Request aborted" } }, { status: 499 }),
  };
}

function requestReplayFailure() {
  return {
    success: false,
    status: 507,
    failureMetadata: { safeToReplay: true },
    error: "[507]: exceeded request buffer limit while retrying upstream",
    response: Response.json({ error: { message: "buffer" } }, { status: 507 }),
  };
}

function bodyDeadlineFailure() {
  return {
    success: false,
    status: 504,
    error: "Upstream response body timed out",
    response: Response.json({ error: { message: "Upstream response body timed out" } }, { status: 504 }),
  };
}

function modelFailure() {
  return {
    success: false,
    status: 404,
    error: "models/gpt-5.6-sol is not found",
    failureMetadata: { clientErrorStatus: 404, unknownModelVerified: true },
    response: Response.json({ error: { message: "models/gpt-5.6-sol is not found" } }, { status: 404 }),
  };
}

beforeAll(async () => {
  ({ handleChat } = await import("../../src/sse/handlers/chat.js"));
  routes = {
    apiChat: await import("../../src/app/api/v1/api/chat/route.js"),
    chatCompletions: await import("../../src/app/api/v1/chat/completions/route.js"),
    messages: await import("../../src/app/api/v1/messages/route.js"),
    responses: await import("../../src/app/api/v1/responses/route.js"),
    compact: await import("../../src/app/api/v1/responses/compact/route.js"),
  };
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  settingsMocks.getSettings.mockResolvedValue({
    requireApiKey: false,
    providerThinking: {},
    cavemanEnabled: false,
    ponytailEnabled: false,
    ccFilterNaming: false,
    connectTimeoutMs: 15000,
    providerStrategies: { codex: { connectTimeoutMs: 8000 } },
  });
  modelMocks.getComboModels.mockResolvedValue(null);
  modelMocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5.6-sol" });
  authMocks.getProviderCredentials.mockResolvedValue(credentials());
  authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, cooldownMs: 0 });
});

describe("caller abort propagation", () => {
  it.each([
    ["/api/v1/api/chat", "apiChat"],
    ["/api/v1/chat/completions", "chatCompletions"],
    ["/api/v1/messages", "messages"],
    ["/api/v1/responses", "responses"],
    ["/api/v1/responses/compact", "compact"],
  ])("preserves the original signal through %s and short-circuits typed abort", async (path, routeName) => {
    const caller = new AbortController();
    const incoming = request(path, caller.signal);
    dispatchMocks.handleChatCore.mockResolvedValue(clientAborted());

    const response = await routes[routeName].POST(incoming);

    expect(response.status).toBe(499);
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
    const forwardedSignal = dispatchMocks.handleChatCore.mock.calls[0][0].callerSignal;
    if (routeName === "compact") {
      expect(forwardedSignal).not.toBe(incoming.signal);
      caller.abort(new DOMException("compact caller left", "AbortError"));
      expect(forwardedSignal).toMatchObject({ aborted: true });
      expect(forwardedSignal.reason).toBe(caller.signal.reason);
    } else {
      expect(forwardedSignal).toBe(incoming.signal);
    }
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("preserves caller identity through the request-buffer replay candidate and does not mutate an aborted account", async () => {
    const incoming = request();
    dispatchMocks.handleChatCore
      .mockResolvedValueOnce(requestReplayFailure())
      .mockResolvedValueOnce(clientAborted());

    const response = await handleChat(incoming);

    expect(response.status).toBe(499);
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(dispatchMocks.handleChatCore.mock.calls.map(([options]) => options.callerSignal))
      .toEqual([incoming.signal, incoming.signal]);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    // The options object also carries this request's client session evidence
    // (clientHeaders/clientBody), which is what selection hashes into the
    // durable pin. Match on the ROUTING directives this test is about, then
    // assert the other two are absent, so the exactness that mattered here --
    // no stray pin or lock bypass leaking in -- survives the wider shape.
    expect(authMocks.getProviderCredentials).toHaveBeenNthCalledWith(
      2,
      "codex",
      expect.any(Set),
      "gpt-5.6-sol",
      expect.objectContaining({ preferredConnectionId: "account-a" }),
    );
    const replayOptions = authMocks.getProviderCredentials.mock.calls[1][3];
    expect(replayOptions.strictPreferredConnection).toBeUndefined();
    expect(replayOptions.ignoreModelLockConnId).toBeUndefined();
  });

  it("takes one ordinary account-failure transition for a body deadline", async () => {
    dispatchMocks.handleChatCore.mockResolvedValue(bodyDeadlineFailure());

    const response = await handleChat(request());

    expect(response.status).toBe(504);
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledTimes(1);
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "account-a",
      504,
      "Upstream response body timed out",
      "codex",
      "gpt-5.6-sol",
      undefined,
      null,
      { rid: expect.stringMatching(/^[0-9a-f]{8}$/) },
    );
  });

  it("forwards only safe model failure metadata into account state", async () => {
    dispatchMocks.handleChatCore.mockResolvedValue(modelFailure());

    const response = await handleChat(request());

    expect(response.status).toBe(404);
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "account-a",
      404,
      "models/gpt-5.6-sol is not found",
      "codex",
      "gpt-5.6-sol",
      undefined,
      { clientErrorStatus: 404, unknownModelVerified: true },
      { rid: expect.stringMatching(/^[0-9a-f]{8}$/) },
    );
  });

  it("projects the selected model client status without changing raw credential state", async () => {
    authMocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      retryAfter: new Date(Date.now() + 60_000).toISOString(),
      retryAfterHuman: "reset after 1m",
      lastError: "selected model unavailable",
      lastErrorCode: 502,
      clientErrorStatus: 404,
    });

    const response = await handleChat(request());

    expect(response.status).toBe(404);
    expect(dispatchMocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("keeps a selected all-locked chat account separate from a preceding failed account", async () => {
    authMocks.getProviderCredentials.mockImplementation(async (_provider, excluded) => {
      if (!excluded?.size) return credentials("account-a");
      return {
        allRateLimited: true,
        retryAfter: new Date(Date.now() + 120_000).toISOString(),
        retryAfterHuman: "reset after 2m",
        lastError: "B selected lock reason",
        lastErrorCode: 502,
        clientErrorStatus: null,
      };
    });
    authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 1 });
    dispatchMocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 429,
      failureMetadata: { safeToReplay: true },
      error: "A failure must not leak",
      response: Response.json({ error: { message: "A failure must not leak" } }, { status: 429 }),
    });

    const response = await handleChat(request());

    expect(response.status).toBe(502);
    expect(response.headers.get("retry-after")).toMatch(/^(119|120)$/);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("B selected lock reason") },
    });
  });

  it("uses a generic unavailable response for a legacy lock without metadata", async () => {
    authMocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      retryAfter: new Date(Date.now() + 60_000).toISOString(),
      retryAfterHuman: "reset after 1m",
      lastError: null,
      lastErrorCode: null,
      clientErrorStatus: null,
    });

    const response = await handleChat(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("Unavailable") },
    });
  });

});
