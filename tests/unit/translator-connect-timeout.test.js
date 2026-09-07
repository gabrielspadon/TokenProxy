import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  execute: vi.fn(),
  refreshCredentials: vi.fn(),
}));

vi.mock("@/lib/localDb.js", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
}));

vi.mock("open-sse/index.js", () => ({
  getExecutor: () => ({
    execute: mocks.execute,
    refreshCredentials: mocks.refreshCredentials,
  }),
}));

import { POST } from "../../src/app/api/translator/send/route.js";
import { ConnectTimeoutError } from "../../open-sse/utils/responseHeaderTimeout.js";

const connection = {
  id: "connection-1",
  provider: "antigravity",
  isActive: true,
  accessToken: "old-token",
  refreshToken: "refresh-token",
  providerSpecificData: { projectId: "project-1" },
};

function request() {
  return new Request("http://localhost/api/translator/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "antigravity",
      model: "gemini-3.1-pro",
      body: { messages: [{ role: "user", content: "hi" }], stream: true },
    }),
  });
}

describe("translator connect timeout propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getProviderConnections.mockResolvedValue([connection]);
    mocks.getSettings.mockResolvedValue({
      connectTimeoutMs: 15000,
      providerStrategies: { antigravity: { connectTimeoutMs: 8000 } },
    });
    mocks.updateProviderConnection.mockResolvedValue(undefined);
    mocks.refreshCredentials.mockResolvedValue({ accessToken: "new-token" });
  });

  it("reads settings once and reuses one context and signal after refresh", async () => {
    mocks.execute
      .mockResolvedValueOnce({ response: new Response("unauthorized", { status: 401 }) })
      .mockResolvedValueOnce({ response: new Response("data: [DONE]\n\n", { status: 200 }) });
    const translatorRequest = request();

    const response = await POST(translatorRequest);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-tokenproxy-connection-id')).toBe('connection-1');
    expect(response.headers.get('x-tokenproxy-diagnostic-scope')).toBe('direct-executor');
    expect(response.headers.get('x-tokenproxy-credential-refreshed')).toBe('true');
    expect(mocks.getSettings).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls.map(([options]) => options.connectTimeout)).toEqual([
      { providerOverride: 8000, globalTimeout: 15000 },
      { providerOverride: 8000, globalTimeout: 15000 },
    ]);
    expect(mocks.execute.mock.calls.map(([options]) => options.signal)).toEqual([
      translatorRequest.signal,
      translatorRequest.signal,
    ]);
    expect(mocks.execute.mock.calls[0][0].connectTimeout).toBe(mocks.execute.mock.calls[1][0].connectTimeout);
  });

  it("returns 502 for a typed response-header timeout", async () => {
    mocks.execute.mockRejectedValue(new ConnectTimeoutError(8000));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Upstream response headers exceeded 8000ms");
  });

  it("returns 499 for exact caller cancellation", async () => {
    mocks.execute.mockRejectedValue(new DOMException("client left", "AbortError"));
    const response = await POST(request());
    expect(response.status).toBe(499);
    expect(await response.text()).toContain("client left");
  });

  it("retains 500 for unrelated programming failures", async () => {
    mocks.execute.mockRejectedValue(new TypeError("translator bug"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("translator bug");
  });
});
