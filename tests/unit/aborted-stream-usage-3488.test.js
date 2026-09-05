import { describe, expect, it, vi } from "vitest";

import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

/**
 * Recording lived only in the transform stream's `flush`. The Streams spec
 * calls `flush` when the writable side ends and `cancel` when the readable
 * side is cancelled — one or the other, never both — so a client that hung up
 * mid-stream produced no usage row, no request detail and nothing in Recent
 * Requests, while the provider had already generated the partial answer
 * (#3488).
 */
const encoder = new TextEncoder();

function chunk(text) {
  return encoder.encode(
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`,
  );
}

function build(onStreamComplete) {
  return createSSETransformStreamWithLogger(
    FORMATS.OPENAI,
    FORMATS.OPENAI,
    "openai",
    null,
    null,
    "gpt-4.1",
    "conn-1",
    { messages: [{ role: "user", content: "hi" }] },
    onStreamComplete,
    "sk-test",
  );
}

/** Feed some content, then hang up the way a disconnecting client does. */
async function abortMidStream(stream) {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  // Cancelling the readable errors the writable with the cancel reason;
  // observe writer.closed or that rejection surfaces as an unhandled one.
  writer.closed.catch(() => {});
  writer.write(chunk("Hello")).catch(() => {});
  await reader.read();
  writer.write(chunk(" world")).catch(() => {});
  await reader.read();
  await reader.cancel("client_closed");
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Feed some content and let the upstream finish normally. */
async function completeStream(stream) {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const drain = (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  })();
  await writer.write(chunk("Hello"));
  await writer.close();
  await drain;
}

describe("a client that hangs up mid-stream", () => {
  it("still reports the stream as finished", async () => {
    const onStreamComplete = vi.fn();
    await abortMidStream(build(onStreamComplete));
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it("reports it as aborted, not as a normal completion", async () => {
    const onStreamComplete = vi.fn();
    await abortMidStream(build(onStreamComplete));
    const [, , , meta] = onStreamComplete.mock.calls[0];
    expect(meta?.aborted).toBe(true);
  });

  it("keeps the content generated before the hang-up", async () => {
    const onStreamComplete = vi.fn();
    await abortMidStream(build(onStreamComplete));
    const [contentObj] = onStreamComplete.mock.calls[0];
    expect(contentObj.content).toContain("Hello");
  });

  it("reports usage so the partial generation is accounted for", async () => {
    const onStreamComplete = vi.fn();
    await abortMidStream(build(onStreamComplete));
    const [, usage] = onStreamComplete.mock.calls[0];
    expect(usage).toBeTruthy();
    expect(usage.completion_tokens).toBeGreaterThan(0);
  });
});

describe("a stream that ends normally", () => {
  it("still reports exactly once, and not as aborted", async () => {
    const onStreamComplete = vi.fn();
    await completeStream(build(onStreamComplete));
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    const [, , , meta] = onStreamComplete.mock.calls[0];
    expect(meta?.aborted ?? false).toBe(false);
  });

  it("does not report a second time if the reader is cancelled afterwards", async () => {
    const onStreamComplete = vi.fn();
    const stream = build(onStreamComplete);
    await completeStream(stream);
    await stream.readable.cancel("late").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });
});

describe("a stream cancelled before anything arrived", () => {
  it("reports once, as aborted, without inventing content", async () => {
    const onStreamComplete = vi.fn();
    const stream = build(onStreamComplete);
    stream.writable.getWriter().closed.catch(() => {});
    await stream.readable.cancel("client_closed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    const [contentObj, , , meta] = onStreamComplete.mock.calls[0];
    expect(meta?.aborted).toBe(true);
    expect(contentObj.content).toBe("");
  });
});

describe("passthrough streams", () => {
  /**
   * TRANSLATE keeps usage on `state`; PASSTHROUGH keeps it in a closure
   * variable. The cancel path reads whichever applies, so both modes record
   * something rather than one of them reporting nothing.
   */
  it("also record the partial turn when the client hangs up", async () => {
    const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
    const onStreamComplete = vi.fn();
    const stream = createPassthroughStreamWithLogger(
      "openai",
      null,
      "gpt-4.1",
      "conn-1",
      { messages: [{ role: "user", content: "hi" }] },
      onStreamComplete,
      "sk-test",
    );

    await abortMidStream(stream);

    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    const [contentObj, usage, , meta] = onStreamComplete.mock.calls[0];
    expect(meta?.aborted).toBe(true);
    expect(contentObj.content).toContain("Hello");
    expect(usage?.completion_tokens).toBeGreaterThan(0);
  });
});
