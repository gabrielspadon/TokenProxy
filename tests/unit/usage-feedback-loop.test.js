import { describe, expect, it } from "vitest";
import { createSseTerminalObserver } from "../../open-sse/utils/streamTerminal.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { resolvePartialUsage } from "../../open-sse/utils/usageTracking.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const decoder = new TextDecoder();

function sseStream(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// The client sizes its context window and its compaction trigger from the usage
// it is handed back. Every path that ends a request has to report what was spent,
// including the ones that end badly, or the client keeps counting from a total
// that stopped advancing and compacts against a history it has mismeasured.
describe("usage reaches the client on every terminal path", () => {
  it("carries the observed usage on an OpenAI incomplete terminal", () => {
    const usage = { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930 };
    const observer = createSseTerminalObserver(FORMATS.OPENAI, () => usage);
    const payload = decoder.decode(observer.buildIncompleteTerminal());
    const body = JSON.parse(payload.split("\n")[0].slice("data: ".length));
    expect(body.usage).toEqual(usage);
    expect(body.error.code).toBe("stream_incomplete");
    expect(payload).toContain("data: [DONE]");
  });

  it("carries the observed usage on a Claude incomplete terminal", () => {
    const observer = createSseTerminalObserver(
      FORMATS.CLAUDE,
      () => ({ input_tokens: 1200, output_tokens: 45, cache_read_input_tokens: 800 }),
    );
    const payload = decoder.decode(observer.buildIncompleteTerminal());
    expect(payload).toContain("event: message_delta");
    const delta = JSON.parse(payload.match(/^data: (.+)$/m)[1]);
    expect(delta.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 45,
      cache_read_input_tokens: 800,
    });
    expect(payload).toContain("event: error");
  });

  it("still emits a terminal when no usage was observed", () => {
    const observer = createSseTerminalObserver(FORMATS.OPENAI, () => null);
    const payload = decoder.decode(observer.buildIncompleteTerminal());
    const body = JSON.parse(payload.split("\n")[0].slice("data: ".length));
    expect(body.usage).toBeUndefined();
    expect(body.error.code).toBe("stream_incomplete");
  });

  it("never loses the terminal when the usage getter throws", () => {
    const observer = createSseTerminalObserver(FORMATS.OPENAI, () => {
      throw new Error("state gone");
    });
    expect(decoder.decode(observer.buildIncompleteTerminal())).toContain("stream_incomplete");
  });

  it("reports the tokens a failed Responses stream already spent", async () => {
    const result = await convertResponsesStreamToJson(sseStream(
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","usage":{"input_tokens":4096,"output_tokens":12,"total_tokens":4108}}}\n\n',
    ));
    expect(result.status).toBe("failed");
    expect(result.usage.input_tokens).toBe(4096);
    expect(result.usage.output_tokens).toBe(12);
    expect(result.usage.total_tokens).toBe(4108);
  });

  it("falls back to an estimate when the stream produced content but no usage frame", () => {
    const usage = resolvePartialUsage(
      { usage: null, content: "x".repeat(400) },
      { messages: [{ role: "user", content: "question" }] },
      FORMATS.OPENAI,
    );
    expect(usage.estimated).toBe(true);
    expect(usage.completion_tokens).toBeGreaterThan(0);
  });

  it("prefers the reported usage over an estimate", () => {
    const reported = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
    expect(resolvePartialUsage({ usage: reported, content: "abc" }, {}, FORMATS.OPENAI)).toBe(reported);
  });

  it("reports nothing when the stream produced nothing", () => {
    expect(resolvePartialUsage({ usage: null, content: "" }, {}, FORMATS.OPENAI)).toBeNull();
  });
});
