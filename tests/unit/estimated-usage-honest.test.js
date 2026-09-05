import { describe, expect, it } from "vitest";
import { estimateUsage, formatUsage } from "../../open-sse/utils/usageTracking.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// The client-visible usage number is the number that gets recorded. Any headroom
// padding added here reaches the harness, which sizes its context window and its
// compaction trigger from it, so a padded count makes the harness compact early
// and reason from a truncated history.
describe("estimated usage is reported without padding", () => {
  it("reports the OpenAI shape exactly as counted", () => {
    const usage = formatUsage(1000, 50, FORMATS.OPENAI);
    expect(usage).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      estimated: true,
    });
  });

  it("reports the Claude shape exactly as counted", () => {
    const usage = formatUsage(800, 20, FORMATS.CLAUDE);
    expect(usage).toEqual({
      input_tokens: 800,
      output_tokens: 20,
      estimated: true,
    });
  });

  it("keeps the estimate self-consistent so total equals its parts", () => {
    const usage = estimateUsage(
      { messages: [{ role: "user", content: "hello world" }] },
      40,
      FORMATS.OPENAI,
    );
    expect(usage.estimated).toBe(true);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.prompt_tokens).toBeLessThan(100);
  });
});
