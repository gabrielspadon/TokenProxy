import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
const tokenMocks = vi.hoisted(() => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
}));
const modelMocks = vi.hoisted(() => ({
  getModelInfo: vi.fn(async (modelStr) => {
    const [provider, ...parts] = String(modelStr).split("/");
    return { provider, model: parts.join("/") || null };
  }),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => tokenMocks);
// Spread the real module: a partial mock fails the WHOLE file the moment the
// module gains an export this object does not name (#577 added isModelDisabled).
vi.mock("@/sse/services/model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...modelMocks,
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), maskKey: vi.fn(),
}));
// The handler deliberately uses the proxy-aware transport. Delegate that
// transport to the test's fetch spy so these are app behavior tests, not an
// accidental live Mistral call.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => global.fetch(...args.slice(0, 2)),
}));

import { handleModerations } from "@/sse/handlers/moderations.js";
import { handleOcr } from "@/sse/handlers/ocr.js";

const originalFetch = global.fetch;
const account = (overrides = {}) => ({
  connectionId: "conn-1",
  connectionName: "Mistral primary",
  apiKey: "test-secret-token",
  ...overrides,
});
const jsonResponse = (body, status = 200, contentType = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": contentType } });
const requestFor = (path, body, signal) => new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal,
});

beforeEach(() => {
  global.fetch = vi.fn();
  authMocks.getProviderCredentials.mockReset();
  authMocks.markAccountUnavailable.mockReset().mockResolvedValue({ shouldFallback: false });
  authMocks.clearAccountError.mockReset().mockResolvedValue(undefined);
  tokenMocks.checkAndRefreshToken.mockReset().mockImplementation(async (_provider, credentials) => credentials);
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("Mistral OCR and moderation handlers", () => {
  it("forwards OCR through the registered config and strips the internal provider prefix", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce(jsonResponse({ model: "mistral-ocr-latest", pages: [] }, 200, "application/vnd.mistral+json"));

    const response = await handleOcr(requestFor("/v1/ocr", {
      model: "mistral/mistral-ocr-latest",
      document: { type: "document_url", document_url: "https://example.test/document.pdf" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.mistral+json");
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.mistral.ai/v1/ocr");
    expect(init.headers.Authorization).toBe("Bearer test-secret-token");
    expect(JSON.parse(init.body)).toMatchObject({ model: "mistral-ocr-latest" });
  });

  it("rejects OCR providers without a registered OCR endpoint before selecting credentials", async () => {
    const response = await handleOcr(requestFor("/v1/ocr", {
      model: "openai/gpt-4o",
      document: { type: "document_url", document_url: "https://example.test/document.pdf" },
    }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("does not support OCR");
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects OCR requests without a document before selecting credentials", async () => {
    const response = await handleOcr(requestFor("/v1/ocr", {
      model: "mistral/mistral-ocr-latest",
    }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing required field: document");
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("rejects malformed OCR and moderation payload fields before selecting credentials", async () => {
    const ocrResponse = await handleOcr(requestFor("/v1/ocr", {
      model: "mistral/mistral-ocr-latest",
      document: "https://example.test/document.pdf",
    }));
    const moderationResponse = await handleModerations(requestFor("/v1/moderations", {
      model: "mistral/mistral-moderation-latest",
      input: { text: "not a supported input shape" },
    }));

    expect(ocrResponse.status).toBe(400);
    expect(await ocrResponse.text()).toContain("document must be an object");
    expect(moderationResponse.status).toBe(400);
    expect(await moderationResponse.text()).toContain("input must be a string or array of strings");
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("forwards batch moderation input and strips the internal provider prefix", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce(jsonResponse({ results: [{ flagged: false }] }));

    const response = await handleModerations(requestFor("/v1/moderations", {
      model: "mistral/mistral-moderation-latest",
      input: ["safe", "also safe"],
    }));

    expect(response.status).toBe(200);
    const [, init] = global.fetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      model: "mistral-moderation-latest",
      input: ["safe", "also safe"],
    });
  });

  it("returns a body-phase client cancellation without marking or rotating its account", async () => {
    const controller = new AbortController();
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => {
        controller.abort();
        throw new DOMException("client disconnected", "AbortError");
      },
    });

    const response = await handleOcr(requestFor("/v1/ocr", {
      model: "mistral/mistral-ocr-latest",
      document: { type: "document_url", document_url: "https://example.test/document.pdf" },
    }, controller.signal));

    expect(response.status).toBe(499);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("redacts the serving credential when an upstream moderation error echoes it", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce(new Response("upstream rejected Bearer test-secret-token", { status: 401 }));

    const response = await handleModerations(requestFor("/v1/moderations", {
      model: "mistral/mistral-moderation-latest",
      input: "test",
    }));

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain("test-secret-token");
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "conn-1", 401, expect.not.stringContaining("test-secret-token"), "mistral", "mistral-moderation-latest",
      undefined, { safeToReplay: true }
    );
  });

  it("retries moderation with the next account when the failure is eligible for fallback", async () => {
    authMocks.getProviderCredentials
      .mockResolvedValueOnce(account({ connectionId: "conn-1", apiKey: "first-secret" }))
      .mockResolvedValueOnce(account({ connectionId: "conn-2", apiKey: "second-secret" }));
    authMocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ error: { message: "rate limited" } }, 429))
      .mockResolvedValueOnce(jsonResponse({ results: [{ flagged: false }] }));

    const response = await handleModerations(requestFor("/v1/moderations", {
      model: "mistral/mistral-moderation-latest",
      input: "test",
    }));

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(authMocks.getProviderCredentials.mock.calls[1][1]).toEqual(new Set(["conn-1"]));
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer second-secret");
  });
});
