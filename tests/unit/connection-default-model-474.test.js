import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
const coreMocks = vi.hoisted(() => ({
  handleChatCore: vi.fn(),
  handleEmbeddingsCore: vi.fn(),
}));
const modelMocks = vi.hoisted(() => ({
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
}));
const settingsMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getProxyPools: vi.fn(),
  getSettings: vi.fn(),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn(),
  updateProviderConnection: vi.fn(),
  updateProviderStrategyProxyPoolSnapshotIfBound: vi.fn(),
  validateApiKey: vi.fn(),
}));
const usageMocks = vi.hoisted(() => ({ saveRequestUsage: vi.fn() }));
const proxyMocks = vi.hoisted(() => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  toConnectionProxyOptions: vi.fn((config) => ({
    connectionProxyEnabled: config.connectionProxyEnabled,
    connectionProxyUrl: config.connectionProxyUrl,
    connectionNoProxy: config.connectionNoProxy,
    resolutionKind: config.resolutionKind,
    strictProxy: config.strictProxy,
    vercelRelayUrl: config.vercelRelayUrl,
  })),
}));
const quotaMocks = vi.hoisted(() => ({ evaluateQuota: vi.fn() }));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => authMocks);
// Spread the real module: a partial mock fails the WHOLE file the moment the
// module gains an export this object does not name (#577 added isModelDisabled).
vi.mock("@/sse/services/model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...modelMocks,
}));
vi.mock("@/lib/localDb", () => settingsMocks);
vi.mock("@/lib/network/connectionProxy", () => proxyMocks);
vi.mock("@/sse/services/quotaGuard.js", () => quotaMocks);
vi.mock("@/lib/usageDb.js", () => usageMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(() => "***"),
  request: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: coreMocks.handleChatCore }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: coreMocks.handleEmbeddingsCore }));
// Spread the real module: the chat handler imports more from it than these
// three, and a mock that returns only some fails the whole file with
// "No <name> export" rather than one assertion.
vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  detectRequiredCapabilities: vi.fn(() => []),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((handler) => handler),
  getActiveAdapterStrategy: vi.fn(),
}));

let handleChat;
let handleEmbeddings;

function selectedCredentials(overrides = {}) {
  return {
    connectionId: "connection-a",
    connectionName: "MiniMax A",
    apiKey: "provider-secret",
    providerSpecificData: {},
    defaultModel: "MiniMax-M2.7",
    ...overrides,
  };
}

function chatRequest(model) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
  });
}

function embeddingsRequest(model) {
  return new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "hello" }),
  });
}

function success() {
  return { success: true, response: Response.json({ data: [] }) };
}

beforeAll(async () => {
  ({ handleChat } = await import("@/sse/handlers/chat.js"));
  ({ handleEmbeddings } = await import("@/sse/handlers/embeddings.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  settingsMocks.getSettings.mockResolvedValue({
    fallbackStrategy: "fill-first",
    requireApiKey: false,
    providerThinking: {},
    providerStrategies: {},
    cavemanEnabled: false,
    ponytailEnabled: false,
    ccFilterNaming: false,
  });
  settingsMocks.getProviderConnections.mockResolvedValue([]);
  settingsMocks.getProxyPools.mockResolvedValue([]);
  settingsMocks.updateProviderConnection.mockResolvedValue(undefined);
  proxyMocks.resolveConnectionProxyConfig.mockResolvedValue({
    kind: "usable",
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    resolutionKind: "unselected",
    strictProxy: false,
    vercelRelayUrl: "",
  });
  quotaMocks.evaluateQuota.mockResolvedValue({ paused: false });
  modelMocks.getComboModels.mockResolvedValue(null);
  modelMocks.getModelInfo.mockResolvedValue({ provider: "minimax", model: "auto" });
  settingsMocks.getProviderConnections.mockResolvedValue([{
    id: 'connection-a', provider: 'minimax', isActive: true, defaultModel: 'MiniMax-M2.7',
  }]);
  authMocks.getProviderCredentials.mockResolvedValue(selectedCredentials());
  authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
  coreMocks.handleChatCore.mockResolvedValue(success());
  coreMocks.handleEmbeddingsCore.mockResolvedValue(success());
});

describe("connection default model routing (PR #474)", () => {
  it("exposes the selected connection default model to the request handlers", async () => {
    settingsMocks.getProviderConnections.mockResolvedValueOnce([{
      id: "connection-a",
      authType: "apikey",
      apiKey: "provider-secret",
      defaultModel: "  MiniMax-M2.7  ",
      displayName: "MiniMax A",
      isActive: true,
      priority: 1,
      providerSpecificData: {},
    }]);
    const { getProviderCredentials } = await vi.importActual("@/sse/services/auth.js");

    const credentials = await getProviderCredentials("minimax", new Set(), "auto");

    expect(credentials.defaultModel).toBe("MiniMax-M2.7");
  });

  it("sends the selected connection default for a bare chat alias", async () => {
    const response = await handleChat(chatRequest("auto"));

    expect(response.status).toBe(200);
    const [options] = coreMocks.handleChatCore.mock.calls[0];
    expect(options.body.model).toBe("minimax/MiniMax-M2.7");
    expect(options.modelInfo).toEqual({ provider: "minimax", model: "MiniMax-M2.7" });
    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "minimax", expect.any(Set), "MiniMax-M2.7", expect.any(Object),
    );
  });

  it("sends the selected connection default for a bare embeddings alias", async () => {
    const response = await handleEmbeddings(embeddingsRequest("auto"));

    expect(response.status).toBe(200);
    const [options] = coreMocks.handleEmbeddingsCore.mock.calls[0];
    expect(options.body.model).toBe("minimax/MiniMax-M2.7");
    expect(options.modelInfo).toEqual({ provider: "minimax", model: "MiniMax-M2.7" });
    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith("minimax", expect.any(Set), "MiniMax-M2.7");
  });

  it.each([
    ["chat", () => handleChat(chatRequest("minimax/auto")), () => coreMocks.handleChatCore],
    ["embeddings", () => handleEmbeddings(embeddingsRequest("minimax/auto")), () => coreMocks.handleEmbeddingsCore],
  ])("does not override an explicit %s model", async (_name, send, core) => {
    const response = await send();

    expect(response.status).toBe(200);
    const [options] = core().mock.calls[0];
    expect(options.body.model).toBe("minimax/auto");
    expect(options.modelInfo).toEqual({ provider: "minimax", model: "auto" });
  });

  it.each([
    ["chat", () => handleChat(chatRequest("auto")), () => coreMocks.handleChatCore],
    ["embeddings", () => handleEmbeddings(embeddingsRequest("auto")), () => coreMocks.handleEmbeddingsCore],
  ])("does not call an upstream core without eligible %s credentials", async (_name, send, core) => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(null);

    const response = await send();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(core()).not.toHaveBeenCalled();
  });

  it.each([
    ["chat", () => handleChat(chatRequest("auto")), () => coreMocks.handleChatCore],
    ["embeddings", () => handleEmbeddings(embeddingsRequest("auto")), () => coreMocks.handleEmbeddingsCore],
  ])("does not call an upstream core for all-rate-limited %s credentials", async (_name, send, core) => {
    authMocks.getProviderCredentials.mockResolvedValueOnce({
      allRateLimited: true,
      lastError: "quota exhausted",
      lastErrorCode: 429,
      retryAfter: null,
      retryAfterHuman: "later",
    });

    const response = await send();

    expect(response.status).toBe(429);
    expect(core()).not.toHaveBeenCalled();
  });

  it("locks the physical model that failed after resolving a bare default", async () => {
    coreMocks.handleChatCore.mockResolvedValueOnce({
      success: false,
      status: 400,
      error: "unknown model",
      response: Response.json({ error: "unknown model" }, { status: 400 }),
    });

    const response = await handleChat(chatRequest("auto"));

    expect(response.status).toBe(400);
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "connection-a", 400, "unknown model", "minimax", "MiniMax-M2.7", undefined, null,
      { rid: expect.stringMatching(/^[0-9a-f]{8}$/) },
    );
  });
});
