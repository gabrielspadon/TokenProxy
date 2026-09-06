import { describe, it, expect } from "vitest";
import { compressMessages as compressWithPolicy } from "../../open-sse/rtk/index.js";
// These fixtures validate the explicitly opted-in legacy filters.
const compressMessages = (body, enabled) => compressWithPolicy(body, enabled, { allowLossy: true });

// RTK's contract is that it skips failed tool results, because a failed result
// is a trace and compressing it destroys the evidence. The error marker is
// spelled differently per shape — Claude puts `is_error` on the block, OpenAI
// Responses puts `status` on the function_call_output, Kiro uses `isError` —
// and only the Claude block form was being checked, so an error result reached
// the compressor through the other three shapes.

function longDiff() {
  const lines = ["diff --git a/foo.js b/foo.js", "index abc..def 100644", "--- a/foo.js", "+++ b/foo.js", "@@ -1,3 +1,400 @@"];
  for (let i = 0; i < 400; i++) lines.push(`+added line ${i} ${"x".repeat(40)}`);
  return lines.join("\n");
}

const PAYLOAD = longDiff();

/** Returns true when RTK rewrote the payload in place. */
function compressed(body, read) {
  compressMessages(body, true);
  return read(body) !== PAYLOAD;
}

describe("RTK preserves failed tool results in every shape", () => {
  it("compresses an ordinary OpenAI tool message, string content", () => {
    const body = { messages: [{ role: "tool", content: PAYLOAD }] };
    expect(compressed(body, (b) => b.messages[0].content)).toBe(true);
  });

  it("leaves an OpenAI tool message marked status:error alone", () => {
    const body = { messages: [{ role: "tool", status: "error", content: PAYLOAD }] };
    expect(compressed(body, (b) => b.messages[0].content)).toBe(false);
  });

  it("leaves an OpenAI tool message marked is_error alone", () => {
    const body = { messages: [{ role: "tool", is_error: true, content: PAYLOAD }] };
    expect(compressed(body, (b) => b.messages[0].content)).toBe(false);
  });

  it("compresses an ordinary OpenAI tool message, array content", () => {
    const body = { messages: [{ role: "tool", content: [{ type: "text", text: PAYLOAD }] }] };
    expect(compressed(body, (b) => b.messages[0].content[0].text)).toBe(true);
  });

  it("leaves an array-content tool message marked status:error alone", () => {
    const body = { messages: [{ role: "tool", status: "error", content: [{ type: "text", text: PAYLOAD }] }] };
    expect(compressed(body, (b) => b.messages[0].content[0].text)).toBe(false);
  });

  it("compresses an ordinary Responses function_call_output", () => {
    const body = { input: [{ type: "function_call_output", output: PAYLOAD }] };
    expect(compressed(body, (b) => b.input[0].output)).toBe(true);
  });

  it("leaves a function_call_output marked status:error alone", () => {
    const body = { input: [{ type: "function_call_output", status: "error", output: PAYLOAD }] };
    expect(compressed(body, (b) => b.input[0].output)).toBe(false);
  });

  it("leaves a function_call_output marked is_error alone", () => {
    const body = { input: [{ type: "function_call_output", is_error: true, output: PAYLOAD }] };
    expect(compressed(body, (b) => b.input[0].output)).toBe(false);
  });

  it("still honours is_error on a Claude tool_result block", () => {
    const body = { messages: [{ role: "user", content: [{ type: "tool_result", is_error: true, content: PAYLOAD }] }] };
    expect(compressed(body, (b) => b.messages[0].content[0].content)).toBe(false);
  });

  it("honours the Kiro isError spelling on a tool_result block", () => {
    const body = { messages: [{ role: "user", content: [{ type: "tool_result", isError: true, content: PAYLOAD }] }] };
    expect(compressed(body, (b) => b.messages[0].content[0].content)).toBe(false);
  });
});
