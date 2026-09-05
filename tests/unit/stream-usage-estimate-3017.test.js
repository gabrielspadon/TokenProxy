import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasValidUsage, estimateUsage } from "open-sse/utils/usageTracking.js";

const src = readFileSync(new URL("../../open-sse/handlers/chatCore/streamingHandler.js", import.meta.url), "utf8");

// A combo relayed in STREAM mode logged "IN 0 · OUT 0" and wrote no usageHistory
// row, while the same key and model over plain non-streaming JSON reported real
// counts (#3017). Non-stream reads the numbers out of the response body; stream
// depends on the upstream emitting a usage block, and some do not.
describe("a completed stream without upstream usage is estimated (#3017)", () => {
  it("the success path estimates, not just the interrupted path", () => {
    const complete = src.indexOf("const onStreamComplete =");
    const abandoned = src.indexOf("const onStreamAbandoned =");
    const firstEstimate = src.indexOf("estimateUsage(", complete);
    expect(complete).toBeGreaterThan(0);
    expect(firstEstimate).toBeGreaterThan(complete);
    // It must land inside onStreamComplete, before onStreamAbandoned begins.
    expect(firstEstimate).toBeLessThan(abandoned);
  });

  it("it only fills in when the upstream gave nothing usable", () => {
    expect(src).toContain("if (!hasValidUsage(usage) && contentObj?.content?.trim?.()) {");
  });

  it("it needs text to estimate from, and does not invent numbers otherwise", () => {
    // With no content and no usage there is nothing to base an estimate on;
    // fabricating one would be worse than the zero it replaces.
    const i = src.indexOf("if (!hasValidUsage(usage) &&");
    const block = src.slice(i, i + 260);
    expect(block).toContain("contentObj?.content?.trim?.()");
  });

  it("the interrupted path still estimates too", () => {
    // The inline estimate moved into resolvePartialUsage; the interrupted
    // path (onStreamAbandoned) must route through it.
    const abandoned = src.indexOf("const onStreamAbandoned =");
    expect(abandoned).toBeGreaterThan(0);
    expect(src.indexOf("resolvePartialUsage(streamState", abandoned)).toBeGreaterThan(abandoned);
    const helper = readFileSync(
      new URL("../../open-sse/utils/usageTracking.js", import.meta.url),
      "utf8",
    );
    expect(helper).toContain("if (!streamState.content) return null;");
    expect(helper).toContain("return estimateUsage(body, streamState.content.length");
  });
});

// The predicate and the estimator this leans on, exercised directly.
describe("the usage fallback behaves as the fix assumes", () => {
  it("a missing or all-zero usage is not valid", () => {
    expect(hasValidUsage(null)).toBe(false);
    expect(hasValidUsage(undefined)).toBe(false);
    expect(hasValidUsage({})).toBe(false);
    expect(hasValidUsage({ prompt_tokens: 0, completion_tokens: 0 })).toBe(false);
  });

  it("a real usage block is left alone", () => {
    expect(hasValidUsage({ prompt_tokens: 5, completion_tokens: 16 })).toBe(true);
  });

  it("an estimate produces non-zero counts from content", () => {
    const est = estimateUsage({ messages: [{ role: "user", content: "hello there" }] }, 400);
    expect(hasValidUsage(est)).toBe(true);
  });
});
