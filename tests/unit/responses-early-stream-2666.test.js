import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeferredResponsesResponse } from "../../open-sse/utils/responsesStreamBridge.js";

const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
const dispatchMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({ getComboModels: vi.fn(), getModelInfo: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
const comboMocks = vi.hoisted(() => ({ handleComboChat: vi.fn(), handleFusionChat: vi.fn() }));

vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: authMocks.clearAccountError,
  extractApiKey: () => null,
  getProviderCredentials: authMocks.getProviderCredentials,
  getReachableProviders: vi.fn(async () => new Set()),
  isValidApiKey: vi.fn(async () => true),
  markAccountUnavailable: authMocks.markAccountUnavailable,
}));
vi.mock("open-sse/handlers/chatCore.js", () => dispatchMocks);
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  detectRequiredCapabilities: vi.fn(() => []),
  handleComboChat: comboMocks.handleComboChat,
  handleFusionChat: comboMocks.handleFusionChat,
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let responsesRoute;
let handleChat;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function responseFrom(bytes) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function success(bytes) {
  return { success: true, response: responseFrom(bytes) };
}

function credentials() {
  return {
    connectionId: "account-a",
    connectionName: "account-a",
    apiKey: "provider-key",
    providerSpecificData: {},
  };
}

function request(body, signal) {
  return new Request("http://localhost/api/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(body),
  });
}

async function readAll(stream) {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

beforeAll(async () => {
  ({ handleChat } = await import("../../src/sse/handlers/chat.js"));
  responsesRoute = await import("../../src/app/api/v1/responses/route.js");
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  settingsMocks.getSettings.mockResolvedValue({
    requireApiKey: false,
    providerThinking: {},
    cavemanEnabled: false,
    ponytailEnabled: false,
    ccFilterNaming: false,
    connectTimeoutMs: 15_000,
    providerStrategies: { codex: { connectTimeoutMs: 8_000 } },
  });
  modelMocks.getComboModels.mockResolvedValue(null);
  modelMocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5.6-sol" });
  comboMocks.handleComboChat.mockImplementation(async ({ body, models, handleSingleModel }) => (
    handleSingleModel(body, models[0])
  ));
  authMocks.getProviderCredentials.mockResolvedValue(credentials());
  authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, cooldownMs: 0 });
});

describe("Responses early streaming bridge (#2666)", () => {
  it("rejects a malformed streaming request before opening the 200 bridge", async () => {
    const response = await responsesRoute.POST(request({
      model: "codex/gpt-5.6-sol",
      stream: true,
      input: [{ type: "function_call", call_id: "call_1", name: "", arguments: "{}" }],
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()).error.message).toContain("Invalid request body");
    expect(dispatchMocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("opens a real SSE response before routing settles and forwards successful bytes unchanged", async () => {
    const pending = deferred();
    let started = false;
    const upstreamBytes = encoder.encode("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");

    const response = createDeferredResponsesResponse(async () => {
      started = true;
      return pending.promise;
    });

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const reader = response.body.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(": connected\n\n");
    await Promise.resolve();
    expect(started).toBe(true);

    pending.resolve(responseFrom(upstreamBytes));
    expect(await reader.read()).toMatchObject({ done: false, value: upstreamBytes });
    expect(await reader.read()).toMatchObject({ done: true });
  });

  it("converts a delayed non-SSE failure into a safe Responses terminal without provider text", async () => {
    const response = createDeferredResponsesResponse(async () => Response.json({
      error: { message: "provider credential=super-secret must not reach the client" },
    }, { status: 503 }));

    const text = await readAll(response.body);

    expect(text).toContain(": connected\n\n");
    expect(text).toContain("event: response.failed");
    expect(text).toContain('"code":"upstream_error"');
    expect(text).toContain("request failed before stream started");
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain("super-secret");
  });

  it("keeps explicit Responses streaming live while passing the parsed body and bridge signal to chat", async () => {
    const caller = new AbortController();
    const body = {
      model: "codex/gpt-5.6-sol",
      stream: true,
      input: "hello",
    };
    const upstreamBytes = encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n");
    let coreOptions;
    dispatchMocks.handleChatCore.mockImplementation(async (options) => {
      coreOptions = options;
      return success(upstreamBytes);
    });

    const response = await responsesRoute.POST(request(body, caller.signal));
    const reader = response.body.getReader();

    expect(decoder.decode((await reader.read()).value)).toBe(": connected\n\n");
    await vi.waitFor(() => expect(coreOptions).toBeDefined());
    expect(coreOptions.body).toEqual(body);
    expect(coreOptions.callerSignal).not.toBe(caller.signal);
    expect(decoder.decode((await reader.read()).value)).toBe(decoder.decode(upstreamBytes));

    await reader.cancel("client closed");
    expect(coreOptions.callerSignal).toMatchObject({ aborted: true });
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("keeps a supplied bridge signal through nested combo callbacks", async () => {
    const bridge = new AbortController();
    const body = {
      model: "outer-combo",
      stream: true,
      input: "hello",
    };
    const upstreamBytes = encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n");
    modelMocks.getComboModels.mockImplementation(async (model) => {
      if (model === "outer-combo") return ["inner-combo"];
      if (model === "inner-combo") return ["codex/gpt-5.6-sol"];
      return null;
    });
    modelMocks.getModelInfo.mockImplementation(async (model) => (
      model === "codex/gpt-5.6-sol"
        ? { provider: "codex", model: "gpt-5.6-sol" }
        : { provider: null, model: null }
    ));
    dispatchMocks.handleChatCore.mockResolvedValue(success(upstreamBytes));

    const response = await handleChat(request(body), null, { body, signal: bridge.signal });

    expect(response.status).toBe(200);
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(dispatchMocks.handleChatCore.mock.calls[0][0].callerSignal).toBe(bridge.signal);
  });

  it("cancels an explicit Responses request while routing without scheduling account fallback", async () => {
    let coreOptions;
    dispatchMocks.handleChatCore.mockImplementation((options) => {
      coreOptions = options;
      return new Promise(() => {});
    });
    const body = {
      model: "codex/gpt-5.6-sol",
      stream: true,
      input: "wait for route selection",
    };

    const response = await responsesRoute.POST(request(body));
    const reader = response.body.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(": connected\n\n");
    await vi.waitFor(() => expect(coreOptions).toBeDefined());

    await reader.cancel("client closed while routing");

    expect(coreOptions.callerSignal).toMatchObject({ aborted: true });
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("does not fall back when a cancelled bridge receives a late empty success", async () => {
    const bridge = new AbortController();
    const lateResult = deferred();
    const body = {
      model: "codex/gpt-5.6-sol",
      stream: true,
      input: "cancel before empty upstream reply",
    };
    dispatchMocks.handleChatCore.mockImplementation(() => lateResult.promise);
    authMocks.getProviderCredentials
      .mockResolvedValueOnce(credentials())
      .mockResolvedValue(null);

    const chat = handleChat(request(body), null, { body, signal: bridge.signal });
    await vi.waitFor(() => expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1));
    bridge.abort("client closed while upstream was pending");
    lateResult.resolve(success(encoder.encode("data: [DONE]\n\n")));

    const response = await chat;

    expect(response.status).toBe(499);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when cancellation arrives during the empty-stream peek", async () => {
    const bridge = new AbortController();
    const peekReaderAttached = deferred();
    let upstreamController;
    const emptyStream = new ReadableStream({
      start(controller) {
        upstreamController = controller;
      },
    });
    const originalGetReader = emptyStream.getReader.bind(emptyStream);
    emptyStream.getReader = (...args) => {
      peekReaderAttached.resolve();
      return originalGetReader(...args);
    };
    const body = {
      model: "codex/gpt-5.6-sol",
      stream: true,
      input: "cancel during empty-stream peek",
    };
    dispatchMocks.handleChatCore.mockResolvedValue({
      success: true,
      response: new Response(emptyStream, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    });
    authMocks.getProviderCredentials
      .mockResolvedValueOnce(credentials())
      .mockResolvedValue(null);

    const chat = handleChat(request(body), null, { body, signal: bridge.signal });
    await vi.waitFor(() => expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1));
    await peekReaderAttached.promise;
    bridge.abort("client closed during empty-stream peek");
    upstreamController.close();

    const response = await chat;

    expect(response.status).toBe(499);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it.each([false, "true", undefined])("leaves non-explicit stream=%j on the normal response path", async (stream) => {
    const body = {
      model: "codex/gpt-5.6-sol",
      ...(stream === undefined ? {} : { stream }),
      input: "non-streaming request",
    };
    dispatchMocks.handleChatCore.mockResolvedValue({
      success: true,
      response: Response.json({ output_text: "complete response" }),
    });

    const response = await responsesRoute.POST(request(body));

    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ output_text: "complete response" });
  });
});
