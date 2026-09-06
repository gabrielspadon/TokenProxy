import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: mocks.execute }),
}));

import { ConnectTimeoutError } from "../../open-sse/utils/responseHeaderTimeout.js";
import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";

const settings = {
  requireApiKey: false,
  connectTimeoutMs: 15000,
  providerStrategies: { antigravity: { connectTimeoutMs: 8000 } },
  comboStrategy: "fallback",
};

const credentials = {
  connectionId: "connection-1",
  accessToken: "token",
  providerSpecificData: { projectId: "project-1" },
};

function request(model = "antigravity/gemini-3.1-flash-image") {
  return new Request("http://localhost/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "paint a lighthouse" }),
  });
}

function imageSuccess(data = "aW1hZ2U=") {
  return {
    response: new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { data } }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  };
}

describe("image connect timeout propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockReset();
    mocks.getSettings.mockResolvedValue(settings);
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockImplementation(async (modelStr) => {
      const slash = modelStr.indexOf("/");
      return { provider: modelStr.slice(0, slash), model: modelStr.slice(slash + 1) };
    });
    mocks.getProviderCredentials.mockResolvedValue(credentials);
    mocks.checkAndRefreshToken.mockImplementation(async (provider, value) => value);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    mocks.execute.mockResolvedValue(imageSuccess());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes one provider/global context and the request signal into Antigravity", async () => {
    const imageRequest = request();
    const response = await handleImageGeneration(imageRequest);

    expect(response.status).toBe(200);
    expect(mocks.getSettings).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3.1-flash-image',
      connectTimeout: { providerOverride: 8000, globalTimeout: 15000 },
      signal: imageRequest.signal,
    }));
  });

  it('rejects an explicitly selected chat model without substituting an image model', async () => {
    const response = await handleImageGeneration(request('antigravity/claude-sonnet-4-6'));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Model 'claude-sonnet-4-6' does not support image generation");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('requires a model instead of silently selecting an image default', async () => {
    const incoming = new Request('http://localhost/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'paint a lighthouse' }) });
    const response = await handleImageGeneration(incoming);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Missing model');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("reuses the same settings snapshot across combo model fallback", async () => {
    vi.useFakeTimers();
    mocks.getComboModels.mockResolvedValue([
      "antigravity/gemini-3.1-flash-image-a",
      "antigravity/gemini-3.1-flash-image-b",
    ]);
    mocks.execute
      .mockResolvedValueOnce({ response: Response.json({ error: { message: 'Explicit upstream rejection' } }, { status: 503, headers: { 'x-tokenproxy-replay-safe': 'true' } }) })
      .mockResolvedValueOnce(imageSuccess("c2Vjb25k"));

    const pending = handleImageGeneration(request("image-combo"));
    await vi.advanceTimersByTimeAsync(5000);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(mocks.getSettings).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls.map(([options]) => options.connectTimeout)).toEqual([
      { providerOverride: 8000, globalTimeout: 15000 },
      { providerOverride: 8000, globalTimeout: 15000 },
    ]);
  });
  it('does not try the second combo member after an ambiguous image503',async()=>{
    mocks.getComboModels.mockResolvedValue(['antigravity/gemini-3.1-flash-image-a','antigravity/gemini-3.1-flash-image-b']);
    mocks.execute.mockResolvedValueOnce({response:Response.json({error:{message:'outcome unknown'}},{status:503})})
      .mockResolvedValueOnce(imageSuccess());
    const response=await handleImageGeneration(request('image-combo'));
    expect(response.status).toBe(502);expect(response.headers.get('x-should-retry')).toBe('false');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("returns 499 for caller cancellation without disabling the account", async () => {
    const reason = new DOMException("client left", "AbortError");
    mocks.execute.mockRejectedValue(reason);

    const response = await handleImageGeneration(request());

    expect(response.status).toBe(499);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("stops an image combo after caller cancellation", async () => {
    mocks.getComboModels.mockResolvedValue([
      "antigravity/gemini-3.1-flash-image-a",
      "antigravity/gemini-3.1-flash-image-b",
    ]);
    mocks.execute.mockRejectedValue(new DOMException("combo caller left", "AbortError"));

    const response = await handleImageGeneration(request("image-combo"));

    expect(response.status).toBe(499);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("maps an uncertain response-header timeout to 502 without replay or account rotation", async () => {
    mocks.execute.mockRejectedValue(new ConnectTimeoutError(8000));

    const response = await handleImageGeneration(request());

    expect(response.status).toBe(502);
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("stops an image combo after an uncertain response-header timeout", async () => {
    mocks.getComboModels.mockResolvedValue([
      'antigravity/gemini-3.1-flash-image-a',
      'antigravity/gemini-3.1-flash-image-b',
    ]);
    mocks.execute.mockRejectedValueOnce(new ConnectTimeoutError(8000)).mockResolvedValue(imageSuccess());
    const response = await handleImageGeneration(request('image-combo'));
    expect(response.status).toBe(502);
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});
