import { trackResponseLifetime } from '../helpers/response-lifetime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  getProviderCredentials: vi.fn(),
  isValidApiKey: vi.fn(async () => true),
  markAccountUnavailable: vi.fn(),
}));
const coreMocks = vi.hoisted(() => ({
  getJsonProxyConfig: vi.fn(() => ({ baseUrl: "https://api.mistral.ai/v1/ocr" })),
  handleJsonProxyCore: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "mistral", model: "mistral-ocr-latest" })),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ requireApiKey: false })) }));
vi.mock("@/sse/utils/logger.js", () => ({ request: vi.fn() }));
vi.mock("open-sse/handlers/jsonProxyCore.js", () => coreMocks);

import { handleJsonProxy as rawhandleJsonProxy } from "@/sse/handlers/jsonProxy.js";
const handleJsonProxy = trackResponseLifetime(rawhandleJsonProxy);

const account = (id) => ({ connectionId: id, apiKey: `key-${id}` });
const requestFor = () => new Request("http://localhost/v1/ocr", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "mistral/mistral-ocr-latest",
    document: { type: "document_url", document_url: "https://example.test/a.pdf" },
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleJsonProxy cancellation and timeout behavior", () => {
  it("returns a body-phase client cancellation without marking or rotating the selected account", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account("conn-1"));
    coreMocks.handleJsonProxyCore.mockResolvedValueOnce({
      success: false,
      clientAborted: true,
      response: new Response(null, { status: 499 }),
    });

    const response = await handleJsonProxy(requestFor(), "ocr");

    expect(response.status).toBe(499);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("does not resend a possibly accepted request after a response-body timeout", async () => {
    authMocks.getProviderCredentials
      .mockResolvedValueOnce(account("conn-1"))
      .mockResolvedValueOnce(account("conn-2"));
    authMocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });
    coreMocks.handleJsonProxyCore
      .mockResolvedValueOnce({ success: false, status: 504, error: "upstream timed out", response: new Response("timeout", { status: 504 }) })
      .mockResolvedValueOnce({ success: true, response: new Response('{"pages":[]}', { status: 200 }) });

    const response = await handleJsonProxy(requestFor(), "ocr");

    expect(response.status).toBe(504);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(coreMocks.handleJsonProxyCore).toHaveBeenCalledTimes(1);
  });
});
