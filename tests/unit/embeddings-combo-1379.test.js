// Issue #1379 — /v1/embeddings ignored combos: a combo name reached
// getProviderCredentials as a provider and 400'd. It now expands the same way
// the TTS handler does, running members through the shared combo handler.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleEmbeddingsCore: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  markAccountUnavailable: vi.fn(),
  saveRequestUsage: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async (provider) => ({
    apiKey: `${provider}-secret`,
    connectionId: `conn-${provider}`,
    connectionName: `${provider} A`,
  }),
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: () => "client-key",
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("../../open-sse/handlers/embeddingsCore.js", () => ({
  handleEmbeddingsCore: mocks.handleEmbeddingsCore,
}));
vi.mock("../../open-sse/utils/error.js", () => ({
  errorResponse: (status, message) => Response.json({ error: message }, { status }),
  unavailableResponse: (status, message) => Response.json({ error: message }, { status }),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

import { handleEmbeddings } from "../../src/sse/handlers/embeddings.js";

const post = (model) => handleEmbeddings(new Request("http://localhost/v1/embeddings", {
  method: "POST",
  body: JSON.stringify({ model, input: "hello" }),
}));

// Combo members are "provider/model"; a bare combo name has no provider, which
// is exactly what getModelInfo answers for one.
const parse = (m) => (m.includes("/")
  ? { provider: m.split("/")[0], model: m.split("/").slice(1).join("/") }
  : { provider: null, model: m });

const okFor = (provider) => ({
  success: true,
  usage: null,
  response: Response.json({ object: "list", data: [{ embedding: [1], index: 0 }], model: provider }),
});

describe("embeddings combo support (#1379)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelInfo.mockImplementation(async (m) => parse(m));
    mocks.getComboModels.mockResolvedValue(null);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    mocks.saveRequestUsage.mockResolvedValue(undefined);
  });

  it("still runs a plain provider/model request without consulting combos", async () => {
    mocks.handleEmbeddingsCore.mockResolvedValue(okFor("openai"));
    const res = await post("openai/text-embedding-3-small");

    expect(res.status).toBe(200);
    expect(mocks.getComboModels).not.toHaveBeenCalled();
    expect(mocks.handleEmbeddingsCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleEmbeddingsCore.mock.calls[0][0].modelInfo)
      .toEqual({ provider: "openai", model: "text-embedding-3-small" });
  });

  it("expands a combo name and answers from the first member that works", async () => {
    mocks.getComboModels.mockResolvedValue(["openai/text-embedding-3-small", "voyage/voyage-3"]);
    mocks.handleEmbeddingsCore.mockImplementation(async ({ modelInfo }) => okFor(modelInfo.provider));

    const res = await post("emb-pool");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: "openai" });
    expect(mocks.handleEmbeddingsCore).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next member when the first provider fails", async () => {
    mocks.getComboModels.mockResolvedValue(["openai/text-embedding-3-small", "voyage/voyage-3"]);
    mocks.handleEmbeddingsCore.mockImplementation(async ({ modelInfo }) => (
      modelInfo.provider === "openai"
        // 401: falls back without the transient 502/503/504 cooldown sleep.
        ? { success: false, failureMetadata: { safeToReplay: true }, status: 401, error: "upstream rejected the key", response: Response.json({ error: "upstream rejected the key" }, { status: 401 }) }
        : okFor(modelInfo.provider)
    ));

    const res = await post("emb-pool");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: "voyage" });
    expect(mocks.handleEmbeddingsCore.mock.calls.map((c) => c[0].modelInfo.provider))
      .toEqual(["openai", "voyage"]);
  });

  it("reports a failure once every member has failed", async () => {
    mocks.getComboModels.mockResolvedValue(["openai/text-embedding-3-small", "voyage/voyage-3"]);
    mocks.handleEmbeddingsCore.mockResolvedValue({
      success: false, failureMetadata: { safeToReplay: true }, status: 401, error: "upstream rejected the key",
      response: Response.json({ error: "upstream rejected the key" }, { status: 401 }),
    });

    const res = await post("emb-pool");

    expect(res.ok).toBe(false);
    expect(mocks.handleEmbeddingsCore).toHaveBeenCalledTimes(2);
  });

  it("still 400s on a name that is neither a model nor a combo", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    const res = await post("not-a-thing");
    expect(res.status).toBe(400);
    expect(mocks.handleEmbeddingsCore).not.toHaveBeenCalled();
  });

  it("gives each member its own copy of the request body", async () => {
    mocks.getComboModels.mockResolvedValue(["openai/text-embedding-3-small", "voyage/voyage-3"]);
    const seen = [];
    mocks.handleEmbeddingsCore.mockImplementation(async ({ body, modelInfo }) => {
      seen.push(body.input); // value as the member received it, before its own mutation
      body.input = `mutated-by-${modelInfo.provider}`;
      return modelInfo.provider === "openai"
        ? { success: false, failureMetadata: { safeToReplay: true }, status: 401, error: "x", response: Response.json({ error: "x" }, { status: 401 }) }
        : okFor(modelInfo.provider);
    });

    await post("emb-pool");

    expect(seen).toEqual(["hello", "hello"]);
  });
});
