import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  refreshCredentials: vi.fn(),
  refreshWithRetry: vi.fn(),
  parseUpstreamError: vi.fn(),
  logTargetRequest: vi.fn(),
  logError: vi.fn(),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: mocks.execute,
    refreshCredentials: mocks.refreshCredentials,
    noAuth: false,
  })),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: (...args) => mocks.refreshWithRetry(...args) }));
vi.mock("../../open-sse/translator/index.js", () => ({ translateRequest: vi.fn((_from, _to, model, body) => ({ ...body, model })) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: mocks.logTargetRequest, logError: mocks.logError,
  })),
}));
vi.mock("../../open-sse/utils/clientDetector.js", () => ({ detectClientTool: vi.fn(() => null), isNativePassthrough: vi.fn(() => false) }));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("../../open-sse/utils/streamHandler.js", () => ({ createStreamController: vi.fn(() => ({ signal: undefined, handleComplete: vi.fn(), handleError: vi.fn() })) }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: vi.fn(), proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/translator/formats/claude.js", () => ({ normalizeClaudePassthrough: vi.fn(), anchorClaudeCache: vi.fn() }));
vi.mock("../../open-sse/utils/toolDeduper.js", () => ({ dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })) }));
vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({ compressMessages: vi.fn(() => null), formatRtkLog: vi.fn(() => "") }));
vi.mock("../../open-sse/rtk/headroom.js", () => ({ compressWithHeadroom: vi.fn(async () => null), formatHeadroomLog: vi.fn(() => ""), formatHeadroomSizeLog: vi.fn(() => ""), isHeadroomPhantomSavings: vi.fn(() => false) }));
vi.mock("../../open-sse/providers/capabilities.js", () => ({ getCapabilitiesForModel: vi.fn(() => ({})) }));
vi.mock("../../open-sse/translator/concerns/modality.js", () => ({ stripUnsupportedModalities: vi.fn(() => false) }));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
vi.mock("../../open-sse/translator/concerns/adaptiveStripper.js", () => ({ stripRejectedFields: vi.fn(() => null), addRejectedFields: vi.fn(), getRejectedFields: vi.fn(() => new Set()), extractRejectedFieldNamesFromError: vi.fn(() => []) }));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({ buildRequestDetail: vi.fn((detail) => detail), extractRequestConfig: vi.fn((body, stream) => ({ body, stream })) }));
vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message, response: Response.json({ error: { message } }, { status }) })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: (...args) => mocks.parseUpstreamError(...args),
}));
vi.mock("../../open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({ handleNonStreamingResponse: vi.fn(async ({ providerResponse }) => ({ success: true, response: providerResponse })) }));
vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({ handleForcedSSEToJson: vi.fn(async () => null) }));
vi.mock("../../open-sse/handlers/chatCore/streamingHandler.js", () => ({ buildOnStreamComplete: vi.fn(() => ({ onStreamComplete: vi.fn(), onStreamAbandoned: vi.fn(), streamDetailId: null, streamState: {} })), handleStreamingResponse: vi.fn(() => ({ success: true, response: new Response() })) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(() => Promise.resolve()), saveRequestDetail: mocks.saveRequestDetail }));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { ConnectTimeoutError } = await import("../../open-sse/utils/responseHeaderTimeout.js");

function result(status, { url, headers, body, responseFormat } = {}) {
  return {
    response: new Response(JSON.stringify({ status }), { status }),
    url: url ?? `https://upstream.test/${status}`,
    headers: headers ?? { "x-attempt": String(status) },
    transformedBody: body ?? { attempt: status },
    responseFormat,
  };
}

function options(provider = "antigravity") {
  const body = { model: "gemini-3.7-flash", messages: [{ role: "user", content: "hello" }], stream: false };
  return {
    body,
    modelInfo: { provider, model: "gemini-3.7-flash" },
    credentials: { accessToken: "expired", providerSpecificData: {} },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "application/json" } },
    connectionId: "conn-retry",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), errorLine: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refreshCredentials.mockResolvedValue({ accessToken: "fresh" });
  mocks.refreshWithRetry.mockImplementation(async (refresh) => refresh());
  mocks.parseUpstreamError.mockImplementation(async (response) => ({ statusCode: response.status, message: `retry status ${response.status}` }));
  mocks.saveRequestDetail.mockResolvedValue(undefined);
});

describe("Antigravity refreshed response replacement", () => {
  it("replaces URL headers body format and target log after retry success", async () => {
    const original = result(401, { url: "https://upstream.test/original", headers: { original: "header" }, body: { original: true } });
    const retried = result(200, { url: "https://upstream.test/retry", headers: { retried: "header" }, body: { retried: true }, responseFormat: "antigravity" });
    mocks.execute.mockResolvedValueOnce(original).mockResolvedValueOnce(retried);

    await expect(handleChatCore(options())).resolves.toMatchObject({ success: true, response: retried.response });
    expect(mocks.logTargetRequest).toHaveBeenLastCalledWith(retried.url, retried.headers, retried.transformedBody);
  });

  it("replaces the original response with a retry 403 for typed error parsing", async () => {
    mocks.execute.mockResolvedValueOnce(result(401)).mockResolvedValueOnce(result(403));

    await expect(handleChatCore(options())).resolves.toMatchObject({ success: false, status: 403 });
    expect(mocks.parseUpstreamError).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }), expect.anything(), expect.objectContaining({signal:undefined}));
  });

  it("replaces the original response with a generic retry HTTP error", async () => {
    mocks.execute.mockResolvedValueOnce(result(401)).mockResolvedValueOnce(result(500));

    await expect(handleChatCore(options())).resolves.toMatchObject({ success: false, status: 500 });
  });

  it("maps a retry typed timeout", async () => {
    mocks.execute.mockResolvedValueOnce(result(401)).mockRejectedValueOnce(new ConnectTimeoutError(8000));
    await expect(handleChatCore(options())).resolves.toMatchObject({ success: false, status: 502 });
  });

  it("maps a retry abort", async () => {
    mocks.execute.mockResolvedValueOnce(result(401)).mockRejectedValueOnce(new DOMException("client left", "AbortError"));
    await expect(handleChatCore(options())).resolves.toMatchObject({ success: false, status: 499 });
  });

  it("maps other retry transport failures without resurrecting the original 401", async () => {
    mocks.execute.mockResolvedValueOnce(result(401)).mockRejectedValueOnce(new Error("socket closed"));
    await expect(handleChatCore(options())).resolves.toMatchObject({ success: false, status: 502 });
  });

  it("uses the fixed Antigravity message for transport diagnostics in every chatCore sink", async () => {
    const opaque = "opaque-chatcore-transport-secret";
    const input = options();
    mocks.execute.mockRejectedValueOnce(new Error(opaque));

    const response = await handleChatCore(input);
    const sinks = JSON.stringify([response, input.log.errorLine.mock.calls, mocks.saveRequestDetail.mock.calls, mocks.logError.mock.calls]);

    expect(response).toMatchObject({ success: false, status: 502, error: "Antigravity upstream request failed" });
    expect(sinks).not.toContain(opaque);
  });

  it("uses the fixed Antigravity message for parsed upstream diagnostics in every chatCore sink", async () => {
    const opaque = "opaque-chatcore-parsed-secret";
    const input = options();
    mocks.execute.mockResolvedValueOnce(result(500));
    mocks.parseUpstreamError.mockResolvedValueOnce({ statusCode: 500, message: opaque });

    const response = await handleChatCore(input);
    const sinks = JSON.stringify([response, input.log.errorLine.mock.calls, mocks.saveRequestDetail.mock.calls, mocks.logError.mock.calls]);

    expect(response).toMatchObject({ success: false, status: 500, error: "Antigravity upstream request failed" });
    expect(sinks).not.toContain(opaque);
  });

  it("preserves ordinary-provider transport error formatting", async () => {
    const opaque = "ordinary-provider-diagnostic";
    mocks.execute.mockRejectedValueOnce(new Error(opaque));

    await expect(handleChatCore(options("openai"))).resolves.toMatchObject({ success: false, status: 502, error: opaque });
  });
});
