import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// A 200 carrying no content block used to bench the ACCOUNT for seven minutes
// (EMPTY_CONTENT_COOLDOWN_MS). Measured on production 2026-09-11: twelve such
// locks in one hour, every one of them landing on the only two seats still
// serving, which emptied the eligible pool and produced
//   SEL refused ... why="none-eligible"
// thirteen seconds later, while the client saw
//   502 Empty response content ... (reset after 6m 51s)
// — the countdown being the lock itself, not a timeout.
//
// An empty reply is a property of THAT response: a max_tokens stop that spent
// its budget on thinking, a refusal, or a body whose only block is
// redacted_thinking. It is not evidence the credential is broken, so it must
// not remove the account from rotation. The request still fails, and chat.js's
// per-request exclude set still moves the retry to another seat, so nothing loops.
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const nonStreaming = read("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const chat = read("../../src/sse/handlers/chat.js");
const sseToJson = read("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

// The block that returns the empty-content failure, isolated so a lock added
// anywhere else in the file cannot make this pass by accident.
const emptyContentReturn = nonStreaming.slice(
  nonStreaming.indexOf("if (!hasUsefulContent("),
  nonStreaming.indexOf("if (onRequestSuccess && provider ===")
);

describe("an empty response fails the request without benching the account", () => {
  it("locates the empty-content branch it is asserting on", () => {
    expect(emptyContentReturn).toContain("Empty response content from");
    expect(emptyContentReturn.length).toBeGreaterThan(0);
  });

  // Asserts on the CALL, not on the word: the block's comment explains the
  // history and necessarily names the constant, so a bare substring check
  // would fail on prose while the code was already correct.
  it("passes no forced cooldown deadline on the empty-content return", () => {
    expect(emptyContentReturn).not.toContain("Date.now() + EMPTY_CONTENT_COOLDOWN_MS");
  });

  it("does not tell the decision log it locked", () => {
    expect(emptyContentReturn).toContain('why: "no-content", lock: false');
    expect(emptyContentReturn).not.toContain('why: "no-content", lock: true');
  });

  for (const [label, src] of [["chat.js", chat], ["sseToJsonHandler", sseToJson]]) {
    it(`${label} arms no empty-content lock either`, () => {
      expect(src).not.toContain("EMPTY_CONTENT_COOLDOWN_MS");
      expect(src).not.toContain('why: "no-content", lock: true');
    });
  }

  // Over-correction guard. An upstream that puts its OWN error into a 200 body is
  // a backend signal rather than an empty answer, and that path keeps its lock:
  // without it the same account is re-tried immediately and the error is written
  // into the conversation as if it were the model's reply.
  it("keeps the lock on the upstream-error-in-content path", () => {
    const upstreamErrorBlock = nonStreaming.slice(
      nonStreaming.indexOf("const upstreamError = detectUpstreamErrorContent("),
      nonStreaming.indexOf("if (!hasUsefulContent(")
    );
    expect(upstreamErrorBlock).toContain("EMPTY_CONTENT_COOLDOWN_MS");
  });
});
