// Issue #2483: a model asked for at low effort and the same model at high are
// two different costs, and usage showed them as one line. Nothing recorded
// which reasoning a request ran with, so there was nothing to group by.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { summarizeReasoning } from "open-sse/handlers/chatCore/requestDetail.js";
import { buildRecentRequestRow } from "../../src/lib/db/repos/usageRepo.js";

describe("the label a request is grouped by (#2483)", () => {
  it("reads the OpenAI flat effort", () => {
    expect(summarizeReasoning({ reasoning_effort: "high" })).toBe("high");
  });

  it("reads the Responses nested effort", () => {
    expect(summarizeReasoning({ reasoning: { effort: "medium" } })).toBe("medium");
  });

  it("reads Claude's explicit output_config effort", () => {
    expect(summarizeReasoning({ output_config: { effort: "low" } })).toBe("low");
  });

  it("calls a disabled thinking block off, in every shape", () => {
    expect(summarizeReasoning({ thinking: { type: "disabled" } })).toBe("off");
    expect(summarizeReasoning({ think: false })).toBe("off");
    expect(summarizeReasoning({ output_config: { effort: "none" } })).toBe("off");
  });

  it("calls an enabled block with no budget auto", () => {
    expect(summarizeReasoning({ thinking: { type: "enabled" } })).toBe("auto");
    expect(summarizeReasoning({ think: true })).toBe("auto");
  });

  it("buckets a token budget by thousands, so a budget is a group and not a row", () => {
    expect(summarizeReasoning({ thinking: { type: "enabled", budget_tokens: 10000 } })).toBe("10k");
    expect(summarizeReasoning({ thinking: { type: "enabled", budget_tokens: 12400 } })).toBe("12k");
    expect(summarizeReasoning({ thinking: { type: "enabled", budget_tokens: 800 } })).toBe("800");
  });

  it("reads Ollama's own spelling", () => {
    expect(summarizeReasoning({ think: "high" })).toBe("high");
  });

  it("is undefined when the request asked for no reasoning at all", () => {
    expect(summarizeReasoning({ messages: [] })).toBeUndefined();
    expect(summarizeReasoning(null)).toBeUndefined();
    expect(summarizeReasoning(undefined)).toBeUndefined();
  });
});

describe("what is grouped (#2483)", () => {
  it("labels the body that went upstream, so an injected override counts", () => {
    // chatCore injects a provider-level thinking override onto the body it
    // translates; the client's own body would not carry it, and the request
    // still ran at that effort.
    const clientBody = { messages: [] };
    const translated = { messages: [], reasoning_effort: "high" };
    expect(summarizeReasoning(clientBody)).toBeUndefined();
    expect(summarizeReasoning(translated)).toBe("high");
  });
});

// The rollup half: a new dimension beside byModel rather than a new key inside
// it, because changing byModel's key would change every consumer of it.
describe("the rollup dimension (#2483)", () => {
  const repo = readFileSync(new URL("../../src/lib/db/repos/usageRepo.js", import.meta.url), "utf8");

  it("persists the label in meta, beside requestedModel", () => {
    expect(repo).toContain("reasoningEffort: entry.reasoningEffort || null");
  });

  it("reads it back on both history paths", () => {
    // The in-memory ring carries the parsed field and a usageHistory row carries
    // it inside a JSON meta string; one reader serves both, so exercise the
    // behaviour rather than counting occurrences of a call expression.
    expect(buildRecentRequestRow({ reasoningEffort: "high" }).reasoningEffort).toBe("high");
    expect(buildRecentRequestRow({ meta: JSON.stringify({ reasoningEffort: "12k" }) }).reasoningEffort).toBe("12k");
    expect(buildRecentRequestRow({ meta: JSON.stringify({ requestedModel: "m" }) }).reasoningEffort).toBeNull();
  });

  it("counts into its own dimension, leaving byModel's key alone", () => {
    expect(repo).toContain("day.byReasoning ||= {}");
    expect(repo).toContain("addToCounter(day.byReasoning, reasoningKey");
    // byModel still keys on model|provider, with no effort in it.
    expect(repo).toContain("const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;");
  });

  it("skips a request that asked for no reasoning rather than bucketing it", () => {
    expect(repo).toContain("if (entry.reasoningEffort) {");
  });
});
