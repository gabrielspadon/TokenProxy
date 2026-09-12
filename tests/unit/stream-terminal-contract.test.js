import { describe, expect, it, vi } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import {
  createSseTerminalObserver,
  MAX_SSE_TERMINAL_RECORD_BYTES,
} from "../../open-sse/utils/streamTerminal.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function responseFrom(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function passthroughTransform() {
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
  });
}

function flushTerminalTransform() {
  return new TransformStream({
    transform() {},
    flush(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}

function trackingController() {
  let connected = true;
  const events = [];
  return {
    events,
    controller: {
      signal: new AbortController().signal,
      startTime: Date.now(),
      isConnected: () => connected,
      handleComplete: () => {
        connected = false;
        events.push("complete");
      },
      handleError: (error) => {
        connected = false;
        events.push(["error", error]);
      },
      handleDisconnect: (reason) => {
        connected = false;
        events.push(["disconnect", reason]);
      },
      abort: () => {
        connected = false;
      },
    },
  };
}

async function readAll(stream) {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function terminalOptions(format, onIncompleteStream = vi.fn()) {
  return {
    stallTimeoutMs: 10_000,
    ttftTimeoutMs: 10_000,
    keepaliveMs: 0,
    terminalObserver: createSseTerminalObserver(format),
    onIncompleteStream,
  };
}

describe("post-transform SSE terminal contract", () => {
  it("uses the emitted Claude bytes, not source prose, to choose normal completion", async () => {
    const { controller, events } = trackingController();
    const onStreamComplete = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: responseFrom([`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`]),
      provider: "openai",
      model: "gpt-4o",
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.CLAUDE,
      body: { stream: true },
      stream: true,
      requestStartTime: Date.now(),
      connectionId: "terminal-contract",
      apiKey: null,
      onRequestSuccess: vi.fn(),
      reqLogger: { appendProviderChunk() {}, appendConvertedChunk() {} },
      streamController: controller,
      onStreamComplete,
      streamDetailId: "terminal-contract-normal",
      streamState: {},
    });

    const output = await readAll(result.response.body);
    expect(output).toContain("event: message_stop");
    expect(events).toEqual(["complete"]);
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it("routes emitted Claude EOF without message_stop through error instead of success", async () => {
    const { controller, events } = trackingController();
    const onStreamComplete = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: responseFrom([`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "message_stop" } })}\n\n`]),
      provider: "openai",
      model: "gpt-4o",
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.CLAUDE,
      body: { stream: true },
      stream: true,
      requestStartTime: Date.now(),
      connectionId: "terminal-contract",
      apiKey: null,
      onRequestSuccess: vi.fn(),
      reqLogger: { appendProviderChunk() {}, appendConvertedChunk() {} },
      streamController: controller,
      onStreamComplete,
      streamDetailId: "terminal-contract-incomplete",
      streamState: {},
    });

    const output = await readAll(result.response.body);
    expect(output).toContain("event: error");
    expect(events[0][0]).toBe("error");
    expect(onStreamComplete).not.toHaveBeenCalled();
  });

  it("keeps a transform-flush OpenAI terminal healthy without synthesis or delay", async () => {
    const { controller, events } = trackingController();
    const onIncompleteStream = vi.fn();
    const output = await readAll(pipeWithDisconnect(
      responseFrom(["data: upstream-content\n\n"]),
      flushTerminalTransform(),
      controller,
      terminalOptions(FORMATS.OPENAI, onIncompleteStream),
    ));

    expect(output).toBe("data: [DONE]\n\n");
    expect(events).toEqual(["complete"]);
    expect(onIncompleteStream).not.toHaveBeenCalled();
  });

  it("turns an incomplete supported EOF into one typed terminal and abandonment", async () => {
    const { controller, events } = trackingController();
    const onIncompleteStream = vi.fn();
    const output = await readAll(pipeWithDisconnect(
      responseFrom([`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\n`]),
      passthroughTransform(),
      controller,
      terminalOptions(FORMATS.OPENAI, onIncompleteStream),
    ));

    expect(output).toContain("partial");
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(output).toContain('"code":"stream_incomplete"');
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe("error");
    expect(onIncompleteStream).toHaveBeenCalledTimes(1);
  });

  it("does not turn literal Claude terminal prose into a normal completion", async () => {
    const { controller, events } = trackingController();
    const onIncompleteStream = vi.fn();
    const output = await readAll(pipeWithDisconnect(
      responseFrom([`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "message_stop" } })}\n\n`]),
      passthroughTransform(),
      controller,
      terminalOptions(FORMATS.CLAUDE, onIncompleteStream),
    ));

    expect(output).toContain('event: error');
    expect(output).toContain('"type":"error"');
    expect(events[0][0]).toBe("error");
    expect(onIncompleteStream).toHaveBeenCalledTimes(1);
  });

  it("synthesizes once after overflow reaches EOF and never completes", async () => {
    const { controller, events } = trackingController();
    const onIncompleteStream = vi.fn();
    const output = await readAll(pipeWithDisconnect(
      responseFrom([`data: ${"x".repeat(MAX_SSE_TERMINAL_RECORD_BYTES + 1)}\n\n`]),
      passthroughTransform(),
      controller,
      terminalOptions(FORMATS.OPENAI, onIncompleteStream),
    ));

    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(events[0][0]).toBe("error");
    expect(onIncompleteStream).toHaveBeenCalledTimes(1);
  });

  it("emits a typed terminal before the TTFT watchdog abandons a supported stream", async () => {
    const { controller, events } = trackingController();
    const onIncompleteStream = vi.fn();
    const output = await readAll(pipeWithDisconnect(
      new Response(new ReadableStream({ start() {} })),
      passthroughTransform(),
      controller,
      {
        ...terminalOptions(FORMATS.OPENAI, onIncompleteStream),
        ttftTimeoutMs: 25,
      },
    ));

    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(events[0][0]).toBe("error");
    expect(onIncompleteStream).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["network reset", () => {
      let upstream;
      const response = new Response(new ReadableStream({
        start(controller) {
          upstream = controller;
        },
      }));
      queueMicrotask(() => {
        upstream.enqueue(encoder.encode("data: partial\n\n"));
        upstream.error(new Error("socket hang up"));
      });
      return [response, passthroughTransform()];
    }],
    ["transform error", () => [
      responseFrom(["data: partial\n\n"]),
      new TransformStream({
        transform() {
          throw new Error("translator failed");
        },
      }),
    ]],
  ])("synthesizes once when a supported stream ends via %s", async (_kind, makePipeline) => {
    const { controller, events } = trackingController();
    const onIncompleteStream = vi.fn();
    const [response, transform] = makePipeline();
    const output = await readAll(pipeWithDisconnect(
      response,
      transform,
      controller,
      terminalOptions(FORMATS.OPENAI, onIncompleteStream),
    ));

    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(events[0][0]).toBe("error");
    expect(onIncompleteStream).toHaveBeenCalledTimes(1);
  });

  it("keeps downstream cancellation as a disconnect without a synthetic terminal", async () => {
    let upstream;
    const { controller, events } = trackingController();
    const onIncompleteStream = vi.fn();
    const response = new Response(new ReadableStream({
      start(streamController) {
        upstream = streamController;
      },
    }));
    const output = pipeWithDisconnect(
      response,
      passthroughTransform(),
      controller,
      terminalOptions(FORMATS.OPENAI, onIncompleteStream),
    );
    const reader = output.getReader();
    await reader.cancel("client left");
    upstream.close();

    expect(events).toEqual([["disconnect", "client left"]]);
    expect(onIncompleteStream).not.toHaveBeenCalled();
  });

  it("treats an in-flight caller abort as a disconnect without a synthetic terminal", async () => {
    const caller = new AbortController();
    const { controller, events } = trackingController();
    const onIncompleteStream = vi.fn();
    const output = pipeWithDisconnect(
      new Response(new ReadableStream({ start() {} })),
      passthroughTransform(),
      controller,
      {
        ...terminalOptions(FORMATS.OPENAI, onIncompleteStream),
        callerSignal: caller.signal,
        ttftTimeoutMs: 25,
      },
    );
    const reader = output.getReader();
    const pendingRead = reader.read();

    caller.abort("request closed");

    await expect(pendingRead).resolves.toMatchObject({ done: true });
    expect(events).toEqual([["disconnect", "caller_aborted"]]);
    expect(onIncompleteStream).not.toHaveBeenCalled();
  });

  it("passes a caller abort through the streaming handler without an incomplete terminal", async () => {
    const caller = new AbortController();
    const { controller, events } = trackingController();
    let upstream;
    const providerResponse = new Response(new ReadableStream({
      start(streamController) {
        upstream = streamController;
        streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\n`));
        caller.signal.addEventListener("abort", () => {
          upstream.error(new DOMException("request closed", "AbortError"));
        }, { once: true });
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const onStreamComplete = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse,
      provider: "openai",
      model: "gpt-4o",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      body: { stream: true },
      stream: true,
      requestStartTime: Date.now(),
      connectionId: "terminal-caller-abort",
      apiKey: null,
      onRequestSuccess: vi.fn(),
      reqLogger: { appendProviderChunk() {}, appendConvertedChunk() {} },
      streamController: controller,
      onStreamComplete,
      streamDetailId: "terminal-caller-abort",
      streamState: {},
      callerSignal: caller.signal,
    });
    const reader = result.response.body.getReader();

    expect((await reader.read()).done).toBe(false);
    caller.abort("request closed");

    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(events).toEqual([["disconnect", "caller_aborted"]]);
    expect(onStreamComplete).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Number),
      { aborted: true, terminalEvidence: { state: "cancelled", reason: "caller-cancelled", source: "gateway-stream" } },
    );
  });
});
