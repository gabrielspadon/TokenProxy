// OpenAI → Kiro (AWS CodeWhisperer) request translation.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { resolveKiroModel } from "../../open-sse/config/kiroConstants.js";

const O2K = (body) => translateRequest(FORMATS.OPENAI, FORMATS.KIRO, "m", body, true, null, "kiro");
const O2KModel = (model, body) =>
  translateRequest(FORMATS.OPENAI, FORMATS.KIRO, model, body, true, null, "kiro");
const C2K = (model, body) =>
  translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, model, body, true, null, "kiro");
const R2K = (model, body) => translateRequest(
  FORMATS.OPENAI_RESPONSES,
  FORMATS.KIRO,
  model,
  body,
  true,
  null,
  "kiro"
);

describe("OpenAI → Kiro", () => {
  it.each([
    ["high", "gpt-5.6-sol"],
    ["medium", "gpt-5.6-terra"],
    ["low", "gpt-5.6-luna"],
  ])("preserves Responses reasoning.effort %s through the full Kiro route", (effort, model) => {
    const out = R2K(model, {
      input: "Use the requested effort",
      reasoning: { effort },
    });

    expect(out.additionalModelRequestFields).toEqual({
      reasoning: { effort },
    });
    expect((out?.conversationState?.currentMessage?.userInputMessage?.content || "")).not.toContain("<thinking_mode>");
    expect((out?.conversationState?.currentMessage?.userInputMessage?.content || "")).not.toContain("<max_thinking_length>");
  });

  // openai-to-kiro.js — safeJSONParse guards bad tool-call JSON (fixed in PR #1582)
  it("malformed tool arguments do not throw the whole request", () => {
    expect(() =>
      O2K({
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: "", tool_calls: [
            { id: "c1", type: "function", function: { name: "f", arguments: "{not json" } },
          ] },
          { role: "tool", tool_call_id: "c1", content: "r" },
        ],
      })
    ).not.toThrow();
  });

  it("respects client max_tokens", () => {
    const out = O2K({ max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(out.inferenceConfig?.maxTokens, "client max_tokens ignored").toBe(100);
  });

  it.each(["max_tokens", "max_completion_tokens", "max_output_tokens"])("maps %s before Kiro dispatch", (field) => {
    expect(O2K({ [field]: 137, messages: [{ role: "user", content: "hi" }] }).inferenceConfig.maxTokens).toBe(137);
  });

  it("preserves the Responses output limit through its Chat bridge", () => {
    expect(R2K("gpt-5.6-sol", { max_output_tokens: 113, input: "hi" }).inferenceConfig.maxTokens).toBe(113);
  });

  it("rejects remote images instead of replacing them with URL text", () => {
    expect(() => O2K({
      messages: [{ role: "user", content: [
        { type: "text", text: "see" },
        { type: "image_url", image_url: { url: "https://x.com/p.png" } },
      ] }],
    })).toThrow(/messages\[0\].content\[1\].*requires inline image data/);
  });
});

describe("Kiro upstream model IDs", () => {
  it.each([
    ["OpenAI", O2KModel, { messages: [{ role: "user", content: "hi" }] }],
    ["Claude", C2K, { messages: [{ role: "user", content: "hi" }] }],
  ])("normalizes Claude letter-dot-digit IDs from %s input", (_source, translate, body) => {
    const out = translate("claude-sonnet.5", body);
    expect(out.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-sonnet-5");
    expect(out._kiroUpstreamModel).toBe("claude-sonnet-5");
  });

  it.each([
    "claude-sonnet-4.5",
    "kimi-k2.5",
  ])("does not rewrite an already valid or non-Claude dotted ID", (model) => {
    const out = O2KModel(model, { messages: [{ role: "user", content: "hi" }] });
    expect(out.conversationState.currentMessage.userInputMessage.modelId).toBe(model);
  });

  it("strips synthetic suffixes before normalizing a dotted Claude ID", () => {
    expect(resolveKiroModel("claude-sonnet.5-thinking-agentic")).toEqual({
      upstream: "claude-sonnet-5",
      thinking: true,
      agentic: true,
    });
  });
});
