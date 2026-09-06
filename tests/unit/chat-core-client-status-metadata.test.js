import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  logTargetRequest: vi.fn(),
}));

const outerHandlerMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  getSettings: vi.fn(),
  getCombos: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  resolveProviderId: vi.fn((provider) => provider),
  getJsonProxyConfig: vi.fn(() => ({})),
  getVideoConfig: vi.fn(() => ({})),
  assertPublicUrl: vi.fn(),
  markAccountUnavailable: vi.fn(),
  handleEmbeddingsCore: vi.fn(),
  handleFetchCore: vi.fn(),
  handleImageGenerationCore: vi.fn(),
  handleJsonProxyCore: vi.fn(),
  handleSearchCore: vi.fn(),
  handleSttCore: vi.fn(),
  handleTtsCore: vi.fn(),
  handleVideoProxyCore: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ execute: mocks.execute, noAuth: false })),
}));
vi.mock("../../open-sse/translator/index.js", () => ({
  translateRequest: vi.fn((_source, _target, model, body) => ({ ...body, model })),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: mocks.logTargetRequest,
    logError: vi.fn(),
  })),
}));
vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: vi.fn(), proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/translator/formats/claude.js", () => ({ normalizeClaudePassthrough: vi.fn(), anchorClaudeCache: vi.fn() }));
vi.mock("../../open-sse/utils/toolDeduper.js", () => ({ dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })) }));
vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({ compressMessages: vi.fn(() => null), formatRtkLog: vi.fn(() => "") }));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));
vi.mock("../../open-sse/providers/capabilities.js", () => ({ getCapabilitiesForModel: vi.fn(() => ({})) }));
vi.mock("../../open-sse/translator/concerns/modality.js", () => ({ stripUnsupportedModalities: vi.fn(() => false) }));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
vi.mock("../../open-sse/translator/concerns/adaptiveStripper.js", () => ({
  stripRejectedFields: vi.fn(() => null),
  addRejectedFields: vi.fn(),
  getRejectedFields: vi.fn(() => new Set()),
  extractRejectedFieldNamesFromError: vi.fn(() => []),
}));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn(() => ({})),
}));
vi.mock("../../open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({ handleNonStreamingResponse: vi.fn() }));
vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({ handleForcedSSEToJson: vi.fn() }));
vi.mock("../../open-sse/handlers/chatCore/streamingHandler.js", () => ({
  buildOnStreamComplete: vi.fn(),
  handleStreamingResponse: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: outerHandlerMocks.getProviderCredentials,
  markAccountUnavailable: outerHandlerMocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: outerHandlerMocks.getSettings,
  getCombos: outerHandlerMocks.getCombos,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: outerHandlerMocks.getModelInfo,
  getComboModels: outerHandlerMocks.getComboModels,
}));
vi.mock("@/shared/constants/providers.js", () => ({
  AI_PROVIDERS: {
    demo: {
      id: "demo",
      fetchConfig: {},
      searchConfig: {},
      serviceKinds: ["stt", "tts"],
      sttConfig: { authType: "apiKey" },
      ttsConfig: { authType: "apiKey" },
    },
    xai: { id: "xai" },
  },
  resolveProviderId: outerHandlerMocks.resolveProviderId,
}));
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    demo: {
      id: "demo",
      fetchConfig: {},
      searchConfig: {},
      serviceKinds: ["stt", "tts"],
      sttConfig: { authType: "apiKey" },
      ttsConfig: { authType: "apiKey" },
    },
    xai: { id: "xai" },
  },
  resolveProviderId: outerHandlerMocks.resolveProviderId,
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("../../open-sse/services/combo.js", () => ({
  getComboModelsFromData: vi.fn(() => null),
  handleComboChat: vi.fn(),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: outerHandlerMocks.assertPublicUrl }));
vi.mock("../../open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: outerHandlerMocks.handleEmbeddingsCore }));
vi.mock("../../open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: outerHandlerMocks.handleFetchCore }));
vi.mock("../../open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: outerHandlerMocks.handleImageGenerationCore }));
vi.mock("../../open-sse/handlers/jsonProxyCore.js", () => ({
  getJsonProxyConfig: outerHandlerMocks.getJsonProxyConfig,
  handleJsonProxyCore: outerHandlerMocks.handleJsonProxyCore,
}));
vi.mock("../../open-sse/handlers/search/index.js", () => ({ handleSearchCore: outerHandlerMocks.handleSearchCore }));
vi.mock("../../open-sse/handlers/sttCore.js", () => ({ handleSttCore: outerHandlerMocks.handleSttCore }));
vi.mock("../../open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: outerHandlerMocks.handleTtsCore }));
vi.mock("../../open-sse/handlers/videoCore.js", () => ({
  getVideoConfig: outerHandlerMocks.getVideoConfig,
  handleVideoProxyCore: outerHandlerMocks.handleVideoProxyCore,
  sanitizeSecrets: vi.fn((value) => value),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
const { handleFetch } = await import("../../src/sse/handlers/fetch.js");
const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");
const { handleJsonProxy } = await import("../../src/sse/handlers/jsonProxy.js");
const { handleSearch } = await import("../../src/sse/handlers/search.js");
const { handleStt } = await import("../../src/sse/handlers/stt.js");
const { handleTts } = await import("../../src/sse/handlers/tts.js");
const { handleVideoCreate } = await import("../../src/sse/handlers/videoGeneration.js");

function failedResponse(status, payload) {
  return {
    response: new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
    url: "https://upstream.test/chat",
    headers: {},
    transformedBody: {},
  };
}

function options() {
  const body = { model: "gemini/gemini-missing", messages: [{ role: "user", content: "hello" }], stream: false };
  return {
    body,
    modelInfo: { provider: "gemini", model: "gemini-missing" },
    credentials: { apiKey: "test", providerSpecificData: {} },
    clientRawRequest: { endpoint: "/v1/chat/completions", body },
    connectionId: "connection-1",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), errorLine: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  outerHandlerMocks.getProviderCredentials.mockResolvedValue({
    allRateLimited: true,
    retryAfter: new Date(Date.now() + 60_000).toISOString(),
    retryAfterHuman: "reset after 1m",
    lastError: "the selected model is unavailable",
    lastErrorCode: 502,
    clientErrorStatus: 404,
  });
  outerHandlerMocks.getSettings.mockResolvedValue({});
  outerHandlerMocks.getCombos.mockResolvedValue([]);
  outerHandlerMocks.getModelInfo.mockImplementation(async (modelName) => {
    const [provider, model] = modelName.split("/");
    return { provider, model };
  });
  outerHandlerMocks.getComboModels.mockResolvedValue(null);
  outerHandlerMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, cooldownMs: 0 });
});

describe("chat core model failure metadata", () => {
  it("retains a verified payload only long enough to attach safe model metadata", async () => {
    mocks.execute.mockResolvedValueOnce(failedResponse(404, {
      error: {
        code: 404,
        status: "NOT_FOUND",
        message: "models/gemini-missing is not found for API version v1beta",
      },
    }));

    const result = await handleChatCore(options());

    expect(result).toMatchObject({
      success: false,
      status: 404,
      failureMetadata: { clientErrorStatus: 404, unknownModelVerified: true },
    });
    await expect(result.response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("gemini-missing") },
    });
  });

  it("keeps a generic structured ModelError at its raw status", async () => {
    mocks.execute.mockResolvedValueOnce(failedResponse(502, {
      error: { message: "ModelError: request rejected" },
    }));

    await expect(handleChatCore(options())).resolves.toMatchObject({
      status: 502,
      failureMetadata: { clientErrorStatus: 502, unknownModelVerified: false },
    });
  });

  it("projects selected metadata through every credentialed all-rate-limited handler", async () => {
    const json = (body, path) => new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const form = new FormData();
    form.set("model", "demo/stt-model");
    form.set("file", new Blob(["audio"]), "audio.wav");
    const multipart = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });

    const responses = await Promise.all([
      handleEmbeddings(json({ model: "demo/embedding", input: "hello" }, "/v1/embeddings")),
      handleFetch(json({ provider: "demo", url: "https://example.com" }, "/v1/web/fetch")),
      handleImageGeneration(json({ model: "demo/image", prompt: "hello" }, "/v1/images/generations")),
      handleJsonProxy(json({ model: "demo/moderation", input: "hello" }, "/v1/moderations"), "moderation"),
      handleSearch(json({ provider: "demo", query: "hello" }, "/v1/web/search")),
      handleStt(multipart),
      handleTts(json({ model: "demo/voice", input: "hello" }, "/v1/audio/speech")),
      handleVideoCreate(json({ model: "xai/video", prompt: "hello" }, "/v1/videos/generations"), "generations"),
    ]);

    expect(responses).toHaveLength(8);
    for (const response of responses) expect(response.status).toBe(404);
    expect(outerHandlerMocks.getProviderCredentials).toHaveBeenCalledTimes(8);
  });

  it("keeps a selected all-locked account's reason and raw status separate from a failed account", async () => {
    const selectedRetryAfter = new Date(Date.now() + 120_000).toISOString();
    const selectedLock = {
      allRateLimited: true,
      retryAfter: selectedRetryAfter,
      retryAfterHuman: "reset after 2m",
      lastError: "B selected lock reason",
      lastErrorCode: 502,
      clientErrorStatus: null,
    };
    const failedOnA = {
      success: false,
      status: 429,
      failureMetadata: { safeToReplay: true },
      error: "A failure must not leak",
      response: Response.json({ error: { message: "A failure must not leak" } }, { status: 429 }),
    };
    outerHandlerMocks.getProviderCredentials.mockImplementation(async (_provider, excluded) =>
      excluded?.size ? selectedLock : { connectionId: "account-a", providerSpecificData: {} }
    );
    outerHandlerMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 1 });
    outerHandlerMocks.handleEmbeddingsCore.mockResolvedValue(failedOnA);
    outerHandlerMocks.handleFetchCore.mockResolvedValue(failedOnA);
    outerHandlerMocks.handleImageGenerationCore.mockResolvedValue(failedOnA);
    outerHandlerMocks.handleJsonProxyCore.mockResolvedValue(failedOnA);
    outerHandlerMocks.handleSearchCore.mockResolvedValue(failedOnA);
    outerHandlerMocks.handleSttCore.mockResolvedValue(failedOnA);
    outerHandlerMocks.handleTtsCore.mockResolvedValue(failedOnA);
    outerHandlerMocks.handleVideoProxyCore.mockResolvedValue(failedOnA);
    const json = (body, path) => new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const form = new FormData();
    form.set("model", "demo/stt-model");
    form.set("file", new Blob(["audio"]), "audio.wav");

    const responses = await Promise.all([
      handleEmbeddings(json({ model: "demo/embedding", input: "hello" }, "/v1/embeddings")),
      handleFetch(json({ provider: "demo", url: "https://example.com" }, "/v1/web/fetch")),
      handleImageGeneration(json({ model: "demo/image", prompt: "hello" }, "/v1/images/generations")),
      handleJsonProxy(json({ model: "demo/moderation", input: "hello" }, "/v1/moderations"), "moderation"),
      handleSearch(json({ provider: "demo", query: "hello" }, "/v1/web/search")),
      handleStt(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form })),
      handleTts(json({ model: "demo/voice", input: "hello" }, "/v1/audio/speech")),
      handleVideoCreate(json({ model: "xai/video", prompt: "hello" }, "/v1/videos/generations"), "generations"),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(502);
      expect(response.headers.get("retry-after")).toMatch(/^(119|120)$/);
      const payload = await response.json();
      expect(payload.error.message).toContain("B selected lock reason");
      expect(payload.error.message).toContain("reset after 2m");
      expect(payload.error.message).not.toContain("A failure must not leak");
    }
  });
});
