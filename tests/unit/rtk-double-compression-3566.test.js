import { describe, it, expect } from "vitest";
import { compressMessages as compressWithPolicy } from "open-sse/rtk/index.js";
// These fixtures validate the explicitly opted-in legacy filters.
const compressMessages = (body, enabled) => compressWithPolicy(body, enabled, { allowLossy: true });

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
