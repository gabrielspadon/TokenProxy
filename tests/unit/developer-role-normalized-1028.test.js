import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { getTargetFormat } from "../../open-sse/services/provider.js";

// "developer" is a Responses-API instruction role. filterToOpenAIFormat maps it
// to "system", but only when the target format is literally FORMATS.OPENAI, so
// every chat-completions-shaped target carrying its own format value received
// the role verbatim and dropped or ignored the instruction message — the
// reported "system prompt ignored" from a Codex-CLI-shaped client.
//
// These are PROVIDER ids, and translateRequest takes a FORMAT. Production
// resolves one from the other in resolveUpstreamRoute via getTargetFormat, so
// the test resolves it the same way instead of passing the provider id as if it
// were a format. kimi resolves to the Claude wire format, which carries its
// instruction turn in top-level `system` rather than in a system message, so
// the assertions read whichever channel the resolved format uses.
const CHAT_PROVIDERS = ["openai", "kimi", "step", "zai", "qwen", "ollama"];
const body = () => ({
  model: "m",
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "SYSTEM RULES" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ],
});
const translateFor = (provider, payload = body()) =>
  translateRequest("openai-responses", getTargetFormat(provider), "m", payload, false, null, provider);

const rolesFor = (provider) => (translateFor(provider)?.messages ?? []).map((m) => m.role);

// The instruction channel of the resolved wire format: a top-level `system`
// where the format has one (Claude), the system-role turn otherwise.
const instructionTextFor = (provider, payload = body()) => {
  const out = translateFor(provider, payload);
  if (out.system !== undefined) return JSON.stringify(out.system);
  const sys = out.messages.find((m) => m.role === "system");
  expect(sys, `${provider} produced no system turn`).toBeDefined();
  return JSON.stringify(sys.content);
};

describe("a developer role never reaches a chat-completions target (#1028 #1038)", () => {
  it.each(CHAT_PROVIDERS)("normalises developer to system for %s", (provider) => {
    const roles = rolesFor(provider);
    expect(roles, `${provider} received a developer role`).not.toContain("developer");
    // A Claude-format target hoists the instruction out of `messages` entirely,
    // so the system turn is only expected where the format keeps one.
    if (translateFor(provider).system === undefined) expect(roles).toContain("system");
  });

  it("keeps the instruction text, not just the role", () => {
    for (const provider of CHAT_PROVIDERS) {
      expect(instructionTextFor(provider), `${provider} dropped the instruction`).toContain("SYSTEM RULES");
    }
  });

  it("leaves user and assistant roles alone", () => {
    for (const provider of CHAT_PROVIDERS) expect(rolesFor(provider)).toContain("user");
  });

  it("still routes a top-level instructions string to a system turn", () => {
    const payload = () => ({ model: "m", instructions: "TOP LEVEL",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] });
    for (const provider of CHAT_PROVIDERS) {
      expect(instructionTextFor(provider, payload()), `${provider} dropped the instructions string`).toContain("TOP LEVEL");
    }
  });
});
