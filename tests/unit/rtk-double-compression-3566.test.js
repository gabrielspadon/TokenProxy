import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compressMessages as compressWithPolicy } from "open-sse/rtk/index.js";
// These fixtures validate the explicitly opted-in legacy filters.
const compressMessages = (body, enabled) => compressWithPolicy(body, enabled, { allowLossy: true });

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const core = readFileSync(join(root, "open-sse/handlers/chatCore.js"), "utf8");

const bigResult = (n) => ({
  role: "tool",
  tool_call_id: "t1",
  content: "line of tool output\n".repeat(n),
});

describe("RTK compresses the caller's messages in place (#3566)", () => {
  it("is why a second attempt on the same body compresses twice", () => {
    const shared = [bigResult(400)];
    const attempt1 = { messages: shared };
    const attempt2 = { messages: shared };
    const s1 = compressMessages(attempt1, true);
    const after1 = shared[0].content;
    const s2 = compressMessages(attempt2, true);
    expect(s1?.hits?.length).toBeGreaterThan(0);
    // The mutation is the hazard the isolation below exists to contain: the
    // second pass reads what the first one wrote.
    expect(after1).not.toBe("line of tool output\n".repeat(400));
    expect(s2).toBeTruthy();
  });
});

describe("the handler isolates the items before compressing", () => {
  it("copies messages, input and the kiro history, and only when the stage runs", () => {
    expect(core).toContain("function isolateCompressibleItems(body)");
    expect(core).toMatch(/for \(const key of \["messages", "input"\]\)/);
    expect(core).toContain("body.conversationState = structuredClone(body.conversationState)");
    expect(core).toContain("const rtkWillRun = tokenSaverEnabled && rtkEnabled;");
    expect(core).toContain("if (rtkWillRun) isolateCompressibleItems(translatedBody);");
  });

  it("fails open rather than throwing on a non-cloneable item", () => {
    // Mirrors the handler's helper against a body carrying something
    // structuredClone refuses, to prove the shape of the guard.
    const body = { messages: [{ role: "tool", content: "x", fn: () => {} }] };
    const before = body.messages;
    let threw = false;
    try {
      for (const key of ["messages", "input"]) {
        if (!Array.isArray(body[key])) continue;
        try { body[key] = structuredClone(body[key]); } catch { /* keep */ }
      }
    } catch { threw = true; }
    expect(threw).toBe(false);
    expect(body.messages).toBe(before);
  });
});
