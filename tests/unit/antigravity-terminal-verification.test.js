import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ saveRequestDetail: vi.fn(), appendRequestLog: vi.fn(), trackPendingRequest: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: mocks.saveRequestDetail,
  appendRequestLog: mocks.appendRequestLog,
  trackPendingRequest: mocks.trackPendingRequest,
}));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail, extra = {}) => ({ ...detail, ...extra })),
  extractRequestConfig: vi.fn(() => ({})),
  extractUsageFromResponse: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
  formatDoneLine: vi.fn(() => "done"),
  doneFields: vi.fn(() => ({ t: 1, in: 9, out: 5, cr: 0, cw: 0, ttft: 1 })),
}));

const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { buildOnStreamComplete, handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { peekStreamForContent } = await import("../../open-sse/utils/streamContent.js");

const VALIDATION_URLS = [
  "https://accounts.google.com/AccountChooser?opaque=project-secret",
  "https://accounts.google.com/v3/signin/challenge/pwd?opaque=onboard-secret",
];

function usefulBody(content = "completed") {
  return { choices: [{ message: { content }, finish_reason: "stop" }] };
}

function terminalSpy() {
  return vi.fn();
}

function nonStreamingCtx(providerResponse, notify = terminalSpy(), reqLogger = null) {
  return {
    providerResponse,
    provider: "antigravity",
    model: "gemini-3.7-flash",
    sourceFormat: "openai",
    targetFormat: "openai",
    body: { model: "gemini-3.7-flash", stream: false },
    stream: false,
    translatedBody: {}, finalBody: {}, requestStartTime: Date.now(), connectionId: "conn-terminal", apiKey: "key",
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {} }, onRequestSuccess: vi.fn(),
    onVerificationSuccess: notify, notifyTerminalVerificationSuccess: notify,
    reqLogger: reqLogger || { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() }, toolNameMap: null, customToolNames: null,
    trackDone: vi.fn(), appendLog: vi.fn(), pxpipe: null, reqTag: "TERM", log: { line: vi.fn(), warn: vi.fn() },
  };
}

function forcedCtx(providerResponse, notify = terminalSpy()) {
  return {
    providerResponse, provider: "antigravity", model: "gemini-3.7-flash", sourceFormat: "openai", targetFormat: "openai",
    body: { model: "gemini-3.7-flash", stream: false }, stream: false, translatedBody: {}, finalBody: {}, requestStartTime: Date.now(),
    connectionId: "conn-terminal", apiKey: "key", clientRawRequest: { endpoint: "/v1/chat/completions", body: {} },
    onRequestSuccess: vi.fn(), onVerificationSuccess: notify, notifyTerminalVerificationSuccess: notify,
    customToolNames: null, trackDone: vi.fn(), appendLog: vi.fn(), reqTag: "TERM", log: { line: vi.fn() },
  };
}

function streamCtx(notify = terminalSpy()) {
  return {
    provider: "antigravity", model: "gemini-3.7-flash", connectionId: "conn-terminal", apiKey: "key", requestStartTime: Date.now(),
    body: {}, stream: true, finalBody: null, translatedBody: null, clientRawRequest: { endpoint: "/v1/chat/completions", body: {} },
    pxpipe: null, reqTag: "TERM", log: { line: vi.fn(), warn: vi.fn() },
    onVerificationSuccess: notify, notifyTerminalVerificationSuccess: notify,
  };
}

function sseResponse(text) {
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function chunkedSseResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

function chunkedJsonResponse(chunks) {
  const encoder = new TextEncoder();
  const encodedChunks = chunks.map((chunk) => encoder.encode(chunk));
  let index = 0;
  const cancel = vi.fn(async () => {});
  const releaseLock = vi.fn();
  return {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader: () => ({
        read: async () => (index < encodedChunks.length
          ? { done: false, value: encodedChunks[index++] }
          : { done: true, value: undefined }),
        cancel,
        releaseLock,
      }),
    },
    cancel,
    releaseLock,
  };
}

function validationFrame() {
  return {
    error: {
      code: 403,
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          domain: "cloudcode-pa.googleapis.com",
          reason: "VALIDATION_REQUIRED",
        },
        { "@type": "type.googleapis.com/google.rpc.Help", links: VALIDATION_URLS.map((url) => ({ url })) },
      ],
    },
  };
}

async function readAvailableStreamText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // The validation gate terminates the unsafe upstream stream after retaining safe frames.
  }
  return text + decoder.decode();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveRequestDetail.mockResolvedValue(undefined);
  mocks.appendRequestLog.mockResolvedValue(undefined);
});

describe("Antigravity terminal verification success", () => {
  const completionProof = { terminalEvidence: { state: "succeeded", reason: "stream-complete", source: "provider-stream" } };
  it("notifies verification only after useful non-stream output", async () => {
    const notify = terminalSpy();
    await expect(handleNonStreamingResponse(nonStreamingCtx(new Response(JSON.stringify(usefulBody()), { headers: { "content-type": "application/json" } }), notify))).resolves.toMatchObject({ success: true });
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not notify from malformed non-stream JSON", async () => {
    const notify = terminalSpy();
    await handleNonStreamingResponse(nonStreamingCtx(new Response("not json", { headers: { "content-type": "application/json" } }), notify));
    expect(notify).not.toHaveBeenCalled();
  });

  it("redacts disguised HTTP-200 structured errors before non-stream sinks", async () => {
    const notify = terminalSpy();
    const logger = { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() };
    const disguised = {
      error: {
        code: 403,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            domain: "cloudcode-pa.googleapis.com",
            reason: "VALIDATION_REQUIRED",
          },
          { "@type": "type.googleapis.com/google.rpc.Help", links: VALIDATION_URLS.map((url) => ({ url })) },
        ],
      },
    };
    await handleNonStreamingResponse(nonStreamingCtx(new Response(JSON.stringify(disguised), { headers: { "content-type": "application/json" } }), notify, logger));
    expect(notify).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.logProviderResponse.mock.calls)).not.toContain(VALIDATION_URLS[0]);
    expect(JSON.stringify(logger.logProviderResponse.mock.calls)).not.toContain("project-secret");
    expect(JSON.stringify(logger.logProviderResponse.mock.calls)).not.toContain("onboard-secret");
  });

  it("does not notify from an empty non-stream response", async () => {
    const notify = terminalSpy();
    await handleNonStreamingResponse(nonStreamingCtx(new Response(JSON.stringify(usefulBody("")), { headers: { "content-type": "application/json" } }), notify));
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies verification after useful forced SSE-to-JSON output", async () => {
    const notify = terminalSpy();
    const sse = `data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: "complete" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    await expect(handleForcedSSEToJson(forcedCtx(sseResponse(sse), notify))).resolves.toMatchObject({ success: true });
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not notify from malformed forced SSE-to-JSON output", async () => {
    const notify = terminalSpy();
    await handleForcedSSEToJson(forcedCtx(sseResponse("data: malformed\n\n"), notify));
    expect(notify).not.toHaveBeenCalled();
  });

  it("treats a forced Antigravity structural candidates-empty SSE frame as ordinary empty output", async () => {
    const notify = terminalSpy();
    const ctx = forcedCtx(sseResponse(`data: ${JSON.stringify({ candidates: [{ content: { parts: [] } }] })}\n\n`), notify);
    ctx.targetFormat = "antigravity";

    const result = await handleForcedSSEToJson(ctx);

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(ctx.onRequestSuccess).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects a thought-only Antigravity STOP frame before it reaches the client", async () => {
    const opaqueThought = "internal-antigravity-thought";
    const streamController = {
      signal: new AbortController().signal,
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleDisconnect: vi.fn(),
      handleError: vi.fn(),
    };
    const onRequestSuccess = vi.fn();
    const result = await handleStreamingResponse({
      ...streamCtx(),
      providerResponse: sseResponse(`data: ${JSON.stringify({
        candidates: [{
          content: { role: "model", parts: [{ thought: true, text: opaqueThought }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 12, thoughtsTokenCount: 9, candidatesTokenCount: 9, totalTokenCount: 21 },
      })}\n\n`),
      sourceFormat: "openai",
      targetFormat: "openai",
      userAgent: "test",
      onRequestSuccess,
      reqLogger: { logTargetRequest: vi.fn(), logError: vi.fn() },
      toolNameMap: null,
      customToolNames: null,
      streamController,
      onStreamComplete: vi.fn(),
      streamDetailId: "stream-thought-only-stop",
      streamState: {},
      log: { line: vi.fn(), warn: vi.fn(), errorLine: vi.fn() },
    });
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 502, error: "Antigravity upstream request failed" });
    expect(clientPayload).not.toContain(opaqueThought);
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(streamController.handleError).toHaveBeenCalledOnce();
  });

  it("replays buffered Antigravity thought frames once visible output follows", async () => {
    const thoughtFrame = { response: { candidates: [{ content: { role: "model", parts: [{ thought: true, text: "thinking first" }] } }] } };
    const visibleFrame = { response: { candidates: [{ content: { role: "model", parts: [{ text: "visible reply" }] }, finishReason: "STOP" }] } };
    const result = await peekStreamForContent(
      sseResponse(`data: ${JSON.stringify(thoughtFrame)}\n\ndata: ${JSON.stringify(visibleFrame)}\n\n`),
      undefined,
      { requireActionableGeminiOutput: true },
    );

    expect(result.hasContent).toBe(true);
    const replayed = await new Response(result.body).text();
    expect(replayed).toContain("thinking first");
    expect(replayed).toContain("visible reply");
  });

  it("uses the fixed Antigravity message for a forced SSE opaque error", async () => {
    const opaque = "opaque-forced-sse-secret";
    const result = await handleForcedSSEToJson(
      forcedCtx(sseResponse(`data: ${JSON.stringify({ error: { message: opaque } })}\n\n`)),
    );
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 502, error: "Antigravity upstream request failed" });
    expect(JSON.stringify([clientPayload, result])).not.toContain(opaque);
  });

  it("uses the fixed Antigravity message when forced SSE reading throws an opaque diagnostic", async () => {
    const opaque = "opaque-forced-sse-read-secret";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await handleForcedSSEToJson(forcedCtx({
      headers: new Headers({ "content-type": "text/event-stream" }),
      text: async () => { throw new Error(opaque); },
    }));
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 502, error: "Antigravity upstream request failed" });
    expect(JSON.stringify([clientPayload, result, error.mock.calls])).not.toContain(opaque);
  });

  it("defers Antigravity account-health success until terminal stream completion", async () => {
    const notify = terminalSpy();
    const accountHealth = vi.fn();
    const streamController = {
      signal: new AbortController().signal,
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleDisconnect: vi.fn(),
      handleError: vi.fn(),
    };
    const response = {
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`));
          controller.close();
        },
      }),
    };
    const result = await handleStreamingResponse({
      providerResponse: response, provider: "antigravity", model: "gemini-3.7-flash", sourceFormat: "openai", targetFormat: "openai",
      userAgent: "test", body: { stream: true }, stream: true, translatedBody: {}, finalBody: {}, requestStartTime: Date.now(),
      connectionId: "conn-terminal", apiKey: "key", clientRawRequest: null, onRequestSuccess: accountHealth,
      onVerificationSuccess: notify, reqLogger: { logTargetRequest: vi.fn(), logError: vi.fn() }, toolNameMap: null, customToolNames: null,
      streamController, onStreamComplete: vi.fn(), streamDetailId: "stream-1", streamState: {},
      pxpipe: null, reqTag: "TERM", log: { line: vi.fn(), warn: vi.fn(), errorLine: vi.fn() },
    });
    await Promise.resolve();
    expect(accountHealth).not.toHaveBeenCalled();
    const output = await readAvailableStreamText(result.response);
    await Promise.resolve();
    expect(output).toContain("first");
    expect(streamController.handleError).toHaveBeenCalledOnce();
    expect(accountHealth).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("uses a fixed Antigravity error for an opaque structured streaming failure", async () => {
    const opaqueMessage = "opaque-upstream-stream-secret";
    const log = { line: vi.fn(), warn: vi.fn(), errorLine: vi.fn() };
    const streamController = {
      signal: new AbortController().signal,
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleDisconnect: vi.fn(),
      handleError: vi.fn(),
    };
    const result = await handleStreamingResponse({
      ...streamCtx(),
      providerResponse: sseResponse(JSON.stringify({ error: { status: 502, message: opaqueMessage } })),
      sourceFormat: "openai",
      targetFormat: "openai",
      userAgent: "test",
      onRequestSuccess: vi.fn(),
      reqLogger: { logTargetRequest: vi.fn(), logError: vi.fn() },
      toolNameMap: null,
      customToolNames: null,
      streamController,
      onStreamComplete: vi.fn(),
      streamDetailId: "stream-opaque-error",
      streamState: {},
      log,
    });
    const clientPayload = await result.response.text();
    const sinks = JSON.stringify([clientPayload, result.error, log.errorLine.mock.calls, streamController.handleError.mock.calls]);

    expect(result).toMatchObject({
      success: false,
      status: 502,
      error: "Antigravity upstream request failed",
    });
    expect(sinks).not.toContain(opaqueMessage);
  });

  it("uses a fixed Antigravity error for an opaque non-SSE title", async () => {
    const opaqueTitle = "opaque-upstream-html-title";
    const log = { line: vi.fn(), warn: vi.fn(), errorLine: vi.fn() };
    const streamController = {
      signal: new AbortController().signal,
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleDisconnect: vi.fn(),
      handleError: vi.fn(),
    };
    const result = await handleStreamingResponse({
      ...streamCtx(),
      providerResponse: new Response(`<html><title>${opaqueTitle}</title></html>`, {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
      sourceFormat: "openai",
      targetFormat: "openai",
      userAgent: "test",
      onRequestSuccess: vi.fn(),
      reqLogger: { logTargetRequest: vi.fn(), logError: vi.fn() },
      toolNameMap: null,
      customToolNames: null,
      streamController,
      onStreamComplete: vi.fn(),
      streamDetailId: "stream-opaque-title",
      streamState: {},
      log,
    });
    const clientPayload = await result.response.text();
    const sinks = JSON.stringify([clientPayload, result.error, log.errorLine.mock.calls, streamController.handleError.mock.calls]);

    expect(result).toMatchObject({
      success: false,
      status: 502,
      error: "Antigravity upstream request failed",
    });
    expect(sinks).not.toContain(opaqueTitle);
  });

  it("uses a fixed Antigravity error for an opaque stream-read exception", async () => {
    const opaqueReadError = new Error("opaque-upstream-stream-read");
    const log = { line: vi.fn(), warn: vi.fn(), errorLine: vi.fn() };
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const streamController = {
      signal: new AbortController().signal,
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleDisconnect: vi.fn(),
      handleError: vi.fn(),
    };
    const result = await handleStreamingResponse({
      ...streamCtx(),
      providerResponse: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: {
          getReader: () => ({
            read: async () => { throw opaqueReadError; },
            cancel,
            releaseLock,
          }),
        },
      },
      sourceFormat: "openai",
      targetFormat: "openai",
      userAgent: "test",
      onRequestSuccess: vi.fn(),
      reqLogger: { logTargetRequest: vi.fn(), logError: vi.fn() },
      toolNameMap: null,
      customToolNames: null,
      streamController,
      onStreamComplete: vi.fn(),
      streamDetailId: "stream-opaque-read",
      streamState: {},
      log,
    });
    const clientPayload = await result.response.text();
    const sinks = JSON.stringify([clientPayload, result.error, log.errorLine.mock.calls, streamController.handleError.mock.calls]);

    expect(result).toMatchObject({
      success: false,
      status: 502,
      error: "Antigravity upstream request failed",
    });
    expect(sinks).not.toContain(opaqueReadError.message);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("preflights a normal Antigravity data frame before it can reach stream sinks", async () => {
    const onValidationRequired = vi.fn();
    const logger = { appendProviderChunk: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn() };
    const log = { line: vi.fn(), warn: vi.fn(), errorLine: vi.fn() };
    const frame = {
      error: {
        code: 403,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            domain: "cloudcode-pa.googleapis.com",
            reason: "VALIDATION_REQUIRED",
          },
          { "@type": "type.googleapis.com/google.rpc.Help", links: VALIDATION_URLS.map((url) => ({ url })) },
        ],
      },
    };
    const result = await handleStreamingResponse({
      ...streamCtx(),
      providerResponse: sseResponse(`data: ${JSON.stringify(frame)}\n\n`),
      sourceFormat: "openai",
      targetFormat: "openai",
      userAgent: "test",
      onRequestSuccess: vi.fn(),
      onValidationRequired,
      verificationContext: { connectionId: "conn-terminal", observationId: "obs-stream", challengeIdAtStart: "challenge-stream" },
      reqLogger: logger,
      toolNameMap: null,
      customToolNames: null,
      streamController: { signal: new AbortController().signal, isConnected: () => true, handleComplete: vi.fn(), handleDisconnect: vi.fn(), handleError: vi.fn() },
      onStreamComplete: vi.fn(),
      streamDetailId: "stream-frame",
      streamState: {},
      log,
    });
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 403 });
    expect(onValidationRequired).toHaveBeenCalledWith({
      validation: { kind: "antigravity_validation_required", url: VALIDATION_URLS[0], source: "chat" },
      observationId: "obs-stream",
    });
    expect(clientPayload).not.toContain(VALIDATION_URLS[0]);
    expect(clientPayload).not.toContain("project-secret");
    expect(JSON.stringify([logger, log, mocks.saveRequestDetail.mock.calls])).not.toContain(VALIDATION_URLS[0]);
    expect(JSON.stringify([logger, log, mocks.saveRequestDetail.mock.calls])).not.toContain("onboard-secret");
  });

  it("preflights an initial Antigravity generic SSE error before every stream sink", async () => {
    const opaque = "opaque-initial-sse-error-secret";
    const logger = { appendProviderChunk: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn() };
    const log = { line: vi.fn(), warn: vi.fn(), errorLine: vi.fn() };
    const streamController = { signal: new AbortController().signal, isConnected: () => true, handleComplete: vi.fn(), handleDisconnect: vi.fn(), handleError: vi.fn() };
    const result = await handleStreamingResponse({
      ...streamCtx(), providerResponse: sseResponse(`data: ${JSON.stringify({ error: { message: opaque } })}\n\n`),
      sourceFormat: "openai", targetFormat: "openai", userAgent: "test", onRequestSuccess: vi.fn(),
      reqLogger: logger, toolNameMap: null, customToolNames: null, streamController, onStreamComplete: vi.fn(), streamDetailId: "stream-initial-sse-error", streamState: {}, log,
    });
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 502, error: "Antigravity upstream request failed" });
    expect(JSON.stringify([clientPayload, result, logger, log, streamController.handleError.mock.calls])).not.toContain(opaque);
  });

  it("preflights a later Antigravity generic SSE error before every stream sink", async () => {
    const opaque = "opaque-later-sse-error-secret";
    const logger = { appendProviderChunk: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn() };
    const log = { line: vi.fn(), warn: vi.fn(), errorLine: vi.fn() };
    const streamController = { signal: new AbortController().signal, isConnected: () => true, handleComplete: vi.fn(), handleDisconnect: vi.fn(), handleError: vi.fn() };
    const result = await handleStreamingResponse({
      ...streamCtx(),
      providerResponse: chunkedSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ordinary frame" } }] })}\n\n`,
        `data: ${JSON.stringify({ error: { message: opaque } })}\n\n`,
      ]),
      sourceFormat: "openai", targetFormat: "openai", userAgent: "test", onRequestSuccess: vi.fn(),
      reqLogger: logger, toolNameMap: null, customToolNames: null, streamController, onStreamComplete: vi.fn(), streamDetailId: "stream-later-sse-error", streamState: {}, log,
    });
    const clientPayload = await readAvailableStreamText(result.response);

    expect(clientPayload).toContain("ordinary frame");
    expect(JSON.stringify([clientPayload, logger, log, streamController.handleError.mock.calls])).not.toContain(opaque);
    expect(streamController.handleError).toHaveBeenCalledWith(expect.objectContaining({ message: "Antigravity upstream request failed" }));
  });

  it("classifies a complete Antigravity JSON RPC validation body before stream sinks", async () => {
    const onValidationRequired = vi.fn();
    const logger = { appendProviderChunk: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn() };
    const log = { line: vi.fn(), warn: vi.fn(), errorLine: vi.fn() };
    const streamController = { signal: new AbortController().signal, isConnected: () => true, handleComplete: vi.fn(), handleDisconnect: vi.fn(), handleError: vi.fn() };
    const result = await handleStreamingResponse({
      ...streamCtx(),
      providerResponse: new Response(JSON.stringify(validationFrame()), { headers: { "content-type": "application/json" } }),
      sourceFormat: "openai", targetFormat: "openai", userAgent: "test", onRequestSuccess: vi.fn(), onValidationRequired,
      verificationContext: { connectionId: "conn-terminal", observationId: "obs-json-complete", challengeIdAtStart: "challenge-json-complete" },
      reqLogger: logger, toolNameMap: null, customToolNames: null, streamController, onStreamComplete: vi.fn(), streamDetailId: "stream-json-complete", streamState: {}, log,
    });
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 403, error: "Antigravity account verification required" });
    expect(onValidationRequired).toHaveBeenCalledWith({
      validation: { kind: "antigravity_validation_required", url: VALIDATION_URLS[0], source: "chat" },
      observationId: "obs-json-complete",
    });
    expect(JSON.stringify([clientPayload, logger, log, streamController.handleError.mock.calls])).not.toContain(VALIDATION_URLS[0]);
    expect(JSON.stringify([clientPayload, logger, log, streamController.handleError.mock.calls])).not.toContain("project-secret");
  });

  it("classifies a split Antigravity JSON RPC validation body before returning a stream", async () => {
    const onValidationRequired = vi.fn();
    const logger = { appendProviderChunk: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn() };
    const log = { line: vi.fn(), warn: vi.fn(), errorLine: vi.fn() };
    const streamController = { signal: new AbortController().signal, isConnected: () => true, handleComplete: vi.fn(), handleDisconnect: vi.fn(), handleError: vi.fn() };
    const body = JSON.stringify(validationFrame());
    const splitAt = Math.floor(body.length / 2);
    const providerResponse = chunkedJsonResponse([body.slice(0, splitAt), body.slice(splitAt)]);
    const result = await handleStreamingResponse({
      ...streamCtx(),
      providerResponse,
      sourceFormat: "openai", targetFormat: "openai", userAgent: "test", onRequestSuccess: vi.fn(), onValidationRequired,
      verificationContext: { connectionId: "conn-terminal", observationId: "obs-json-split", challengeIdAtStart: "challenge-json-split" },
      reqLogger: logger, toolNameMap: null, customToolNames: null, streamController, onStreamComplete: vi.fn(), streamDetailId: "stream-json-split", streamState: {}, log,
    });
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 403, error: "Antigravity account verification required" });
    expect(onValidationRequired).toHaveBeenCalledWith({
      validation: { kind: "antigravity_validation_required", url: VALIDATION_URLS[0], source: "chat" },
      observationId: "obs-json-split",
    });
    expect(JSON.stringify([clientPayload, logger, log, streamController.handleError.mock.calls])).not.toContain(VALIDATION_URLS[0]);
    expect(JSON.stringify([clientPayload, logger, log, streamController.handleError.mock.calls])).not.toContain("onboard-secret");
    expect(providerResponse.cancel).toHaveBeenCalledOnce();
    expect(providerResponse.releaseLock).toHaveBeenCalledOnce();
  });

  it("gates a later split Antigravity validation frame before stream sinks", async () => {
    const healthStates = [];
    const onValidationRequired = vi.fn(async () => healthStates.push("unavailable"));
    const logger = { appendProviderChunk: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn() };
    const log = { line: vi.fn(), warn: vi.fn(), errorLine: vi.fn() };
    const validationSse = `data: ${JSON.stringify(validationFrame())}\n\n`;
    const splitAt = Math.floor(validationSse.length / 2);
    const streamController = {
      signal: new AbortController().signal,
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleDisconnect: vi.fn(),
      handleError: vi.fn(),
    };
    const result = await handleStreamingResponse({
      ...streamCtx(),
      providerResponse: chunkedSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ordinary frame" } }] })}\n\n`,
        validationSse.slice(0, splitAt),
        validationSse.slice(splitAt),
      ]),
      sourceFormat: "openai",
      targetFormat: "openai",
      userAgent: "test",
      onRequestSuccess: async () => healthStates.push("available"),
      onValidationRequired,
      verificationContext: { connectionId: "conn-terminal", observationId: "obs-later", challengeIdAtStart: "challenge-later" },
      reqLogger: logger,
      toolNameMap: null,
      customToolNames: null,
      streamController,
      onStreamComplete: vi.fn(),
      streamDetailId: "stream-later-frame",
      streamState: {},
      log,
    });
    const clientPayload = await readAvailableStreamText(result.response);

    expect(onValidationRequired).toHaveBeenCalledWith({
      validation: { kind: "antigravity_validation_required", url: VALIDATION_URLS[0], source: "chat" },
      observationId: "obs-later",
    });
    expect(clientPayload).toContain("ordinary frame");
    expect(clientPayload).not.toContain(VALIDATION_URLS[0]);
    expect(clientPayload).not.toContain("project-secret");
    expect(JSON.stringify([logger, log, mocks.saveRequestDetail.mock.calls])).not.toContain(VALIDATION_URLS[0]);
    expect(JSON.stringify([logger, log, mocks.saveRequestDetail.mock.calls])).not.toContain("onboard-secret");
    expect(streamController.handleError).toHaveBeenCalled();
    expect(healthStates).toEqual(["unavailable"]);
  });

  it("gates Antigravity validation before forced SSE-to-JSON conversion sinks", async () => {
    const onValidationRequired = vi.fn();
    const ctx = {
      ...forcedCtx(sseResponse(`data: ${JSON.stringify({ candidates: [] })}\n\ndata: ${JSON.stringify(validationFrame())}\n\n`)),
      targetFormat: "antigravity",
      onValidationRequired,
      verificationContext: { connectionId: "conn-terminal", observationId: "obs-forced", challengeIdAtStart: "challenge-forced" },
    };
    const result = await handleForcedSSEToJson(ctx);
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 403 });
    expect(onValidationRequired).toHaveBeenCalledWith({
      validation: { kind: "antigravity_validation_required", url: VALIDATION_URLS[0], source: "chat" },
      observationId: "obs-forced",
    });
    expect(ctx.onRequestSuccess).not.toHaveBeenCalled();
    expect(ctx.trackDone).not.toHaveBeenCalled();
    expect(ctx.appendLog).not.toHaveBeenCalled();
    expect(clientPayload).not.toContain(VALIDATION_URLS[0]);
    expect(clientPayload).not.toContain("project-secret");
  });

  it("gates Antigravity validation before dynamic non-stream SSE sinks", async () => {
    const onValidationRequired = vi.fn();
    const logger = { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() };
    const ctx = {
      ...nonStreamingCtx(sseResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: "ordinary frame" } }] })}\n\ndata: ${JSON.stringify(validationFrame())}\n\n`), terminalSpy(), logger),
      onValidationRequired,
      verificationContext: { connectionId: "conn-terminal", observationId: "obs-nonstream", challengeIdAtStart: "challenge-nonstream" },
    };
    const result = await handleNonStreamingResponse(ctx);
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 403 });
    expect(onValidationRequired).toHaveBeenCalledWith({
      validation: { kind: "antigravity_validation_required", url: VALIDATION_URLS[0], source: "chat" },
      observationId: "obs-nonstream",
    });
    expect(ctx.onRequestSuccess).not.toHaveBeenCalled();
    expect(ctx.trackDone).not.toHaveBeenCalled();
    expect(ctx.appendLog).not.toHaveBeenCalled();
    expect(logger.logProviderResponse).not.toHaveBeenCalled();
    expect(clientPayload).not.toContain(VALIDATION_URLS[0]);
    expect(clientPayload).not.toContain("onboard-secret");
  });

  it("gates Antigravity 200 JSON validation before non-stream sinks", async () => {
    const notify = terminalSpy();
    const onValidationRequired = vi.fn();
    const logger = { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() };
    const ctx = {
      ...nonStreamingCtx(
        new Response(JSON.stringify(validationFrame()), { headers: { "content-type": "application/json" } }),
        notify,
        logger,
      ),
      onValidationRequired,
      verificationContext: { connectionId: "conn-terminal", observationId: "obs-direct-json", challengeIdAtStart: "challenge-direct-json" },
    };

    const result = await handleNonStreamingResponse(ctx);
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 403 });
    expect(onValidationRequired).toHaveBeenCalledWith({
      validation: { kind: "antigravity_validation_required", url: VALIDATION_URLS[0], source: "chat" },
      observationId: "obs-direct-json",
    });
    expect(ctx.onRequestSuccess).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(logger.logProviderResponse).not.toHaveBeenCalled();
    expect(logger.logConvertedResponse).not.toHaveBeenCalled();
    expect(clientPayload).not.toContain(VALIDATION_URLS[0]);
    expect(clientPayload).not.toContain("project-secret");
  });

  it("uses the fixed Antigravity message for a 200 non-stream JSON diagnostic", async () => {
    const opaque = "opaque-nonstream-json-secret";
    const logger = { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() };
    const result = await handleNonStreamingResponse(nonStreamingCtx(
      new Response(JSON.stringify({ error: { message: opaque } }), { headers: { "content-type": "application/json" } }),
      terminalSpy(),
      logger,
    ));
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 502, error: "Antigravity upstream request failed" });
    expect(JSON.stringify([clientPayload, logger, result])).not.toContain(opaque);
  });

  it("uses the fixed Antigravity message when non-stream SSE reading throws an opaque diagnostic", async () => {
    const opaque = "opaque-nonstream-sse-read-secret";
    const logger = { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await handleNonStreamingResponse(nonStreamingCtx({
      headers: new Headers({ "content-type": "text/event-stream" }),
      text: async () => { throw new Error(opaque); },
    }, terminalSpy(), logger));
    const clientPayload = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 502, error: "Antigravity upstream request failed" });
    expect(JSON.stringify([clientPayload, logger, result, error.mock.calls])).not.toContain(opaque);
  });

  it("does not clear Antigravity account health before rejecting empty 200 JSON", async () => {
    const accountHealth = vi.fn();
    const ctx = {
      ...nonStreamingCtx(
        new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), {
          headers: { "content-type": "application/json" },
        }),
      ),
      onRequestSuccess: accountHealth,
    };

    const result = await handleNonStreamingResponse(ctx);
    await Promise.resolve();

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(accountHealth).not.toHaveBeenCalled();
  });

  it("notifies at non-aborted terminal text completion", () => {
    const notify = terminalSpy();
    const { onStreamComplete } = buildOnStreamComplete(streamCtx(notify));
    onStreamComplete({ content: "terminal text" }, { completion_tokens: 0 }, Date.now(), completionProof);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("notifies at non-aborted terminal thinking completion", () => {
    const notify = terminalSpy();
    const { onStreamComplete } = buildOnStreamComplete(streamCtx(notify));
    onStreamComplete({ thinking: "terminal reasoning" }, { completion_tokens: 0 }, Date.now(), completionProof);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("notifies at non-aborted terminal output-token completion", () => {
    const notify = terminalSpy();
    const { onStreamComplete } = buildOnStreamComplete(streamCtx(notify));
    onStreamComplete({}, { completion_tokens: 3 }, Date.now(), completionProof);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not notify at empty EOF", () => {
    const notify = terminalSpy();
    const { onStreamComplete } = buildOnStreamComplete(streamCtx(notify));
    onStreamComplete({}, { completion_tokens: 0 }, Date.now());
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not notify from an aborted completion", () => {
    const notify = terminalSpy();
    const { onStreamComplete } = buildOnStreamComplete(streamCtx(notify));
    onStreamComplete({ content: "cancelled" }, { completion_tokens: 2 }, Date.now(), { aborted: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not notify from abandoned streams", () => {
    const notify = terminalSpy();
    const { onStreamAbandoned } = buildOnStreamComplete(streamCtx(notify));
    onStreamAbandoned("upstream reset");
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies terminal verification at most once", () => {
    const notify = terminalSpy();
    const { onStreamComplete } = buildOnStreamComplete(streamCtx(notify));
    onStreamComplete({ content: "once" }, { completion_tokens: 1 }, Date.now(), completionProof);
    onStreamComplete({ content: "twice" }, { completion_tokens: 1 }, Date.now(), completionProof);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not clear verification after useful output with unsupported terminal evidence", () => {
    const notify = terminalSpy();
    const { onStreamComplete } = buildOnStreamComplete(streamCtx(notify));
    onStreamComplete({ content: "partial" }, { completion_tokens: 1 }, Date.now(), {
      terminalEvidence: { state: "unknown", reason: "unsupported-terminal", source: "gateway-stream" },
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
