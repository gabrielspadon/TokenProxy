// #1625 — GitHub/Gemini requests were recorded as `success` while their captured
// content was the literal "[Streaming in progress...]" placeholder. The row is
// written when the stream is handed to the client, before its outcome exists,
// and a second write replaces it when the stream finishes. Writing it as
// `success` meant that whenever the second write never landed, the surviving
// placeholder already claimed a success nobody had observed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveRequestDetail = vi.fn(() => Promise.resolve());

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail,
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  trackPendingRequest: vi.fn(),
}));

const { handleStreamingResponse, buildOnStreamComplete } = await import(
  "open-sse/handlers/chatCore/streamingHandler.js"
);

function sseResponse(chunks) {
  const headers = new Map();
  headers.get = (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null);
  return {
    status: 200,
    headers,
    text: async () => chunks.join(""),
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    }),
  };
}

const contentFrame = `data: ${JSON.stringify({
  choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
})}\n\n`;

const baseParams = {
  provider: "github",
  model: "gemini-3.1-pro-preview",
  sourceFormat: "openai",
  targetFormat: "openai",
  userAgent: "test-agent",
  body: { stream: true, model: "gemini-3.1-pro-preview", messages: [{ role: "user", content: "hi" }] },
  translatedBody: { model: "upstream-id" },
  finalBody: { model: "upstream-id" },
  requestStartTime: Date.now(),
  connectionId: "conn-1625",
  apiKey: "k",
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
  streamDetailId: "detail-1625",
  pxpipe: null,
  reqTag: "REQ_1625",
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn(), line: vi.fn() },
};

describe("#1625 the in-progress row does not claim an outcome it has not seen", () => {
  beforeEach(() => saveRequestDetail.mockClear());

  it("writes the placeholder row as pending, not success", async () => {
    const res = await handleStreamingResponse({
      ...baseParams,
      providerResponse: sseResponse([contentFrame]),
    });

    expect(res.success).toBe(true);
    expect(saveRequestDetail).toHaveBeenCalledTimes(1);
    const detail = saveRequestDetail.mock.calls[0][0];
    expect(detail.id).toBe("detail-1625");
    expect(detail.response.content).toBe("[Streaming in progress...]");
    expect(detail.status).not.toBe("success");
    expect(detail.status).toBe("pending");
  });

  it("still lets the completing write set success on the same row", async () => {
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete({
      provider: "github",
      model: "gemini-3.1-pro-preview",
      connectionId: "conn-1625",
      apiKey: "k",
      requestStartTime: Date.now(),
      body: baseParams.body,
      stream: true,
      log: baseParams.log,
      reqTag: "REQ_1625",
    });

    // A row reads success only from an observed terminal; without one it stays
    // unknown, which is the invariant the first case in this file covers.
    onStreamComplete({ content: "hello", thinking: null }, { prompt_tokens: 3, completion_tokens: 2 }, Date.now(),
      { terminalEvidence: { state: "succeeded", reason: "stream-complete", source: "provider-stream" } });

    const finalRow = saveRequestDetail.mock.calls.find((c) => c[0].id === streamDetailId)[0];
    expect(finalRow.status).toBe("success");
    expect(finalRow.response.content).toBe("hello");
  });

  it("marks an interrupted stream cancelled rather than leaving it pending", async () => {
    const { onStreamAbandoned, streamDetailId } = buildOnStreamComplete({
      provider: "github",
      model: "gemini-3.1-pro-preview",
      connectionId: "conn-1625",
      apiKey: "k",
      requestStartTime: Date.now(),
      body: baseParams.body,
      stream: true,
      log: baseParams.log,
      reqTag: "REQ_1625",
    });

    onStreamAbandoned("stall_timeout");

    const finalRow = saveRequestDetail.mock.calls.find((c) => c[0].id === streamDetailId)[0];
    expect(finalRow.status).toBe("cancelled");
  });
});
