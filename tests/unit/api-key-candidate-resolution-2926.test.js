import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  isValidApiKey: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
const coreMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({ getComboModels: vi.fn(), getModelInfo: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
const deviceMocks = vi.hoisted(() => ({ recordApiKeyDevice: vi.fn() }));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: authMocks.clearAccountError,
  getProviderCredentials: authMocks.getProviderCredentials,
  isValidApiKey: authMocks.isValidApiKey,
  markAccountUnavailable: authMocks.markAccountUnavailable,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: coreMocks.handleChatCore }));
// Spread the real module: a partial mock fails the WHOLE file the moment the
// module gains an export this object does not name (#577 added isModelDisabled).
vi.mock("@/sse/services/model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...modelMocks,
}));
vi.mock("@/lib/localDb", () => settingsMocks);
vi.mock("@/sse/services/apiKeyDevices.js", () => deviceMocks);
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
// The chat handler imports more exports than this test exercises.
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

async function clientApiKeyModule() {
  try {
    return await import("@/lib/auth/clientApiKey.js");
  } catch {
    return {
      collectClientApiKeyCandidates: () => [],
      resolveClientApiKey: async () => ({ apiKey: null, valid: false }),
    };
  }
}

function request(path = "/v1/messages?key=query-key", headers = {}) {
  return new Request(`http://router.test${path}`, { headers });
}

function chatRequest(headers = {}) {
  return new Request("http://router.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "minimax/MiniMax-M2.7",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

function emptyJsonRequest(headers = {}) {
  return new Request("http://router.test/v1/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

beforeAll(async () => {
  ({ handleChat } = await import("@/sse/handlers/chat.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.isValidApiKey.mockImplementation(async (key) => key === "sk-valid");
  authMocks.getProviderCredentials.mockResolvedValue({
    connectionId: "connection-a",
    connectionName: "MiniMax A",
    apiKey: "provider-secret",
    providerSpecificData: {},
  });
  modelMocks.getComboModels.mockResolvedValue(null);
  modelMocks.getModelInfo.mockResolvedValue({ provider: "minimax", model: "MiniMax-M2.7" });
  settingsMocks.getSettings.mockResolvedValue({
    requireApiKey: true,
    providerThinking: {},
    providerStrategies: {},
    cavemanEnabled: false,
    ponytailEnabled: false,
    ccFilterNaming: false,
  });
  coreMocks.handleChatCore.mockResolvedValue({
    success: true,
    response: Response.json({ choices: [{ message: { content: "ok" } }] }),
  });
});

describe("gateway API-key candidate resolution (PR #2926)", () => {
  it("collects every supported credential once in protocol precedence order", async () => {
    const { collectClientApiKeyCandidates } = await clientApiKeyModule();

    expect(collectClientApiKeyCandidates(request(undefined, {
      Authorization: "Bearer bearer-key",
      "x-api-key": "header-key",
      "x-goog-api-key": "google-key",
    }))).toEqual(["bearer-key", "header-key", "google-key", "query-key"]);
  });

  it("selects the valid x-api-key after a stale Claude Bearer credential", async () => {
    const { resolveClientApiKey } = await clientApiKeyModule();
    const validate = vi.fn(async (key) => key === "sk-valid");

    await expect(resolveClientApiKey(request("/v1/messages", {
      Authorization: "Bearer stale-claude-session",
      "x-api-key": "sk-valid",
    }), validate)).resolves.toEqual({ apiKey: "sk-valid", valid: true });
    expect(validate).toHaveBeenNthCalledWith(1, "stale-claude-session");
    expect(validate).toHaveBeenNthCalledWith(2, "sk-valid");
  });

  it("keeps a valid Authorization credential when an extra header is invalid", async () => {
    const { resolveClientApiKey } = await clientApiKeyModule();
    const validate = vi.fn(async (key) => key === "bearer-key");

    await expect(resolveClientApiKey(request("/v1/chat/completions", {
      Authorization: "Bearer bearer-key",
      "x-api-key": "stale-extra-key",
    }), validate)).resolves.toEqual({ apiKey: "bearer-key", valid: true });
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("keeps Google-header and query credentials in the same resolver", async () => {
    const { resolveClientApiKey } = await clientApiKeyModule();
    const validateGoogle = vi.fn(async (key) => key === "google-key");
    const validateQuery = vi.fn(async (key) => key === "query-key");

    await expect(resolveClientApiKey(request("/v1beta/models?key=query-key", {
      "x-goog-api-key": "google-key",
    }), validateGoogle)).resolves.toEqual({ apiKey: "google-key", valid: true });
    await expect(resolveClientApiKey(request(), validateQuery)).resolves.toEqual({ apiKey: "query-key", valid: true });
  });

  it("attributes a Claude messages request to the valid x-api-key after a stale Bearer", async () => {
    const response = await handleChat(chatRequest({
      Authorization: "Bearer stale-claude-session",
      "x-api-key": "sk-valid",
    }));

    expect(response.status).toBe(200);
    expect(deviceMocks.recordApiKeyDevice).toHaveBeenCalledWith("sk-valid", expect.any(Request));
    expect(coreMocks.handleChatCore).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "sk-valid",
      sourceFormatOverride: "claude",
    }));
    const [{ clientRawRequest }] = coreMocks.handleChatCore.mock.calls[0];
    expect(clientRawRequest.headers).not.toHaveProperty("authorization");
    expect(clientRawRequest.headers).not.toHaveProperty("x-api-key");
    expect(clientRawRequest.headers).not.toHaveProperty("x-goog-api-key");
  });

  it("uses the selected x-api-key at every claimed modality gate", async () => {
    const dualCredentials = {
      Authorization: "Bearer stale-claude-session",
      "x-api-key": "sk-valid",
    };
    const formData = new FormData();
    const cases = [
      ["embeddings", () => import("@/sse/handlers/embeddings.js"), (module) => module.handleEmbeddings(emptyJsonRequest(dualCredentials))],
      ["fetch", () => import("@/sse/handlers/fetch.js"), (module) => module.handleFetch(emptyJsonRequest(dualCredentials))],
      ["image", () => import("@/sse/handlers/imageGeneration.js"), (module) => module.handleImageGeneration(emptyJsonRequest(dualCredentials))],
      ["search", () => import("@/sse/handlers/search.js"), (module) => module.handleSearch(emptyJsonRequest(dualCredentials))],
      ["STT", () => import("@/sse/handlers/stt.js"), (module) => module.handleStt(new Request("http://router.test/v1/audio/transcriptions", {
        method: "POST",
        headers: dualCredentials,
        body: formData,
      }))],
      ["TTS", () => import("@/sse/handlers/tts.js"), (module) => module.handleTts(emptyJsonRequest(dualCredentials))],
      ["video", () => import("@/sse/handlers/videoGeneration.js"), (module) => module.handleVideoGet(request("/v1/videos/", dualCredentials), null)],
      ["rerank", () => import("@/sse/handlers/rerank.js"), (module) => module.handleRerank(emptyJsonRequest(dualCredentials))],
      ["JSON proxy", () => import("@/sse/handlers/jsonProxy.js"), (module) => module.handleJsonProxy(emptyJsonRequest(dualCredentials), "ocr")],
    ];

    for (const [name, load, invoke] of cases) {
      const response = await invoke(await load());
      expect(response.status, name).toBe(400);
      await response.body?.cancel();
    }
    expect(deviceMocks.recordApiKeyDevice).toHaveBeenCalledTimes(cases.length);
    for (const [apiKey] of deviceMocks.recordApiKeyDevice.mock.calls) {
      expect(apiKey).toBe("sk-valid");
    }
  });
});
