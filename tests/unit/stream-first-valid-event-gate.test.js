import { describe, it, expect, vi } from "vitest";
import { handleStreamingResponse } from "open-sse/handlers/chatCore/streamingHandler.js";

// The success callback fires from the completion path the stream's own flush
// drives, so a test must read the body to the end before asserting on it.
async function drain(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Streaming first-valid-event gate (Issue 2951 Finding 3)", () => {
  const baseParams = {
    provider: "nvidia",
    model: "meta/llama-3.1-70b-instruct",
    sourceFormat: "openai",
    targetFormat: "openai",
    userAgent: "test-agent",
    body: { stream: true },
    translatedBody: {},
    finalBody: {},
    requestStartTime: Date.now(),
    connectionId: "conn-nv-1",
    apiKey: "nv-key",
    clientRawRequest: null,
    reqLogger: { logTargetRequest: () => {}, logError: () => {} },
    toolNameMap: null,
    customToolNames: null,
    streamController: {
      signal: new AbortController().signal,
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
    },
    onStreamComplete: vi.fn(),
    streamDetailId: "detail-test",
    pxpipe: null,
    reqTag: "REQ_TEST",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn(), line: vi.fn() },
  };

  it("Case 1: Empty stream (0 bytes) returns success=false and does NOT call onRequestSuccess", async () => {
    const onRequestSuccess = vi.fn();
    const mockProviderResponse = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    };
    mockProviderResponse.headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null);

    const res = await handleStreamingResponse({
      ...baseParams,
      providerResponse: mockProviderResponse,
      onRequestSuccess,
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe(502);
    expect(res.error).toMatch(/empty stream/i);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("Case 2: JSON error disguised in 200 stream returns success=false and does NOT call onRequestSuccess", async () => {
    const onRequestSuccess = vi.fn();
    const errorJson = JSON.stringify({ error: { message: "Model overloaded", status: 503 } });
    const mockProviderResponse = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(errorJson));
          controller.close();
        },
      }),
    };
    mockProviderResponse.headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null);

    const res = await handleStreamingResponse({
      ...baseParams,
      providerResponse: mockProviderResponse,
      onRequestSuccess,
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe(503);
    expect(res.error).toMatch(/Model overloaded/i);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("Case 3: Non-SSE HTML response returns success=false and does NOT call onRequestSuccess", async () => {
    const onRequestSuccess = vi.fn();
    const mockProviderResponse = {
      status: 500,
      headers: new Map([["content-type", "text/html"]]),
      text: async () => "<html><head><title>Internal Cloudflare Error</title></head><body>500</body></html>",
    };
    mockProviderResponse.headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/html" : null);

    const res = await handleStreamingResponse({
      ...baseParams,
      providerResponse: mockProviderResponse,
      onRequestSuccess,
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe(500);
    expect(res.error).toMatch(/Internal Cloudflare Error/i);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("returns typed 499 without an account error when the caller aborts the non-SSE body drain", async () => {
    const caller = new AbortController();
    const streamController = {
      ...baseParams.streamController,
      handleError: vi.fn(),
    };
    const mockProviderResponse = {
      status: 500,
      headers: new Map([["content-type", "text/html"]]),
      text: () => new Promise((_, reject) => {
        caller.signal.addEventListener("abort", () => {
          reject(new DOMException("caller disconnected", "AbortError"));
        }, { once: true });
        caller.abort("caller disconnected");
      }),
    };
    mockProviderResponse.headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/html" : null);

    const result = await handleStreamingResponse({
      ...baseParams,
      providerResponse: mockProviderResponse,
      streamController,
      callerSignal: caller.signal,
    });

    expect(result).toMatchObject({ success: false, clientAborted: true, status: 499 });
    expect(streamController.handleError).not.toHaveBeenCalled();
  });

  it("returns typed 499 without an account error when the caller aborts the first reader read", async () => {
    const caller = new AbortController();
    const streamController = {
      ...baseParams.streamController,
      handleError: vi.fn(),
    };
    const reader = {
      read: () => new Promise((_, reject) => {
        caller.signal.addEventListener("abort", () => {
          reject(new DOMException("caller disconnected", "AbortError"));
        }, { once: true });
        caller.abort("caller disconnected");
      }),
      releaseLock: vi.fn(),
    };
    const mockProviderResponse = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: { getReader: () => reader },
    };
    mockProviderResponse.headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null);

    const result = await handleStreamingResponse({
      ...baseParams,
      providerResponse: mockProviderResponse,
      streamController,
      callerSignal: caller.signal,
    });

    expect(result).toMatchObject({ success: false, clientAborted: true, status: 499 });
    expect(streamController.handleError).not.toHaveBeenCalled();
  });

  it("keeps an ordinary first reader failure as a 502 account error", async () => {
    const streamController = {
      ...baseParams.streamController,
      handleError: vi.fn(),
    };
    const readError = new Error("upstream socket reset");
    const mockProviderResponse = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: { getReader: () => ({ read: async () => { throw readError; } }) },
    };
    mockProviderResponse.headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null);

    const result = await handleStreamingResponse({
      ...baseParams,
      providerResponse: mockProviderResponse,
      streamController,
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.clientAborted).toBeUndefined();
    expect(streamController.handleError).toHaveBeenCalledWith(readError);
  });

  it("Case 4: Valid stream with data returns success=true and calls onRequestSuccess", async () => {
    const onRequestSuccess = vi.fn();
    const sseChunk = 'data: {"id":"1","choices":[{"delta":{"content":"Hi"}}]}\n\n';
    const sseDone = "data: [DONE]\n\n";

    const mockProviderResponse = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseChunk));
          controller.enqueue(new TextEncoder().encode(sseDone));
          controller.close();
        },
      }),
    };
    mockProviderResponse.headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null);

    const res = await handleStreamingResponse({
      ...baseParams,
      providerResponse: mockProviderResponse,
      onRequestSuccess,
    });

    expect(res.success).toBe(true);
    expect(res.response).toBeDefined();

    // The account is cleared on an observed terminal, not on the first frame:
    // nothing is claimed until the client has actually consumed the stream.
    expect(onRequestSuccess).not.toHaveBeenCalled();

    // Verify response body can be read and contains the original stream data
    const text = await drain(res.response.body);
    expect(text).toContain("data:");

    await settle();
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  it("Case 5: Null body returns success=false and 502", async () => {
    const onRequestSuccess = vi.fn();
    const mockProviderResponse = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: null,
    };
    mockProviderResponse.headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null);

    const res = await handleStreamingResponse({
      ...baseParams,
      providerResponse: mockProviderResponse,
      onRequestSuccess,
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe(502);
    expect(res.error).toMatch(/no response body/i);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("Case 6: Raw string error in JSON returns success=false and 502", async () => {
    const onRequestSuccess = vi.fn();
    const rawErrorJson = JSON.stringify({ error: "Invalid API key format" });
    const mockProviderResponse = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(rawErrorJson));
          controller.close();
        },
      }),
    };
    mockProviderResponse.headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null);

    const res = await handleStreamingResponse({
      ...baseParams,
      providerResponse: mockProviderResponse,
      onRequestSuccess,
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe(502);
    expect(res.error).toBe("Invalid API key format");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("Case 7: FastAPI detail error payload returns success=false and 502", async () => {
    const onRequestSuccess = vi.fn();
    const detailJson = JSON.stringify({ detail: "Gateway timeout upstream" });
    const mockProviderResponse = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(detailJson));
          controller.close();
        },
      }),
    };
    mockProviderResponse.headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null);

    const res = await handleStreamingResponse({
      ...baseParams,
      providerResponse: mockProviderResponse,
      onRequestSuccess,
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe(502);
    expect(res.error).toBe("Gateway timeout upstream");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("Case 8: Assistant output containing the word 'error' in normal payload is NOT treated as an error", async () => {
    const onRequestSuccess = vi.fn();
    const normalPayload = JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ delta: { content: "Here is how to fix the error in your code" } }]
    });
    const sseChunk = `data: ${normalPayload}\n\n`;

    const mockProviderResponse = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseChunk));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    };
    mockProviderResponse.headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null);

    const res = await handleStreamingResponse({
      ...baseParams,
      providerResponse: mockProviderResponse,
      onRequestSuccess,
    });

    expect(res.success).toBe(true);
    await drain(res.response.body);
    await settle();
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });
});
