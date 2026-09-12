import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { translateRequest } from "../../open-sse/translator/index.js";
import { getTargetFormat } from "../../open-sse/services/provider.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

const exec = readFileSync(new URL("../../open-sse/executors/default.js", import.meta.url), "utf8");

// client_metadata is an Anthropic field. The claude->openai translators drop it,
// but an OpenAI-format CLIENT that sends it reaches an OpenAI-format provider
// untouched and a strict one answers 400. Keying the strip on a per-provider
// quirk made it whack-a-mole: only mistral and cerebras declared it.
describe("client_metadata never reaches an OpenAI-shaped upstream (#1157 #1442)", () => {
  it("is keyed on the upstream format, not on a per-provider quirk", () => {
    expect(exec).toContain('this.config.format !== "claude"');
    // The quirk is still honoured, so a claude-format provider can opt out.
    expect(exec).toContain("this.config.quirks?.dropClientMetadata ||");
  });

  it("covers the providers that reported the 400, which never declared the quirk", () => {
    for (const p of ["openai", "opencode-go"]) {
      expect(PROVIDERS[p]?.format, `${p} is not an openai-format provider`).toBe("openai");
      expect(PROVIDERS[p]?.quirks?.dropClientMetadata, `${p} would not need the fix`).toBeFalsy();
    }
  });

  it("leaves the field alone for an Anthropic upstream, which understands it", () => {
    expect(PROVIDERS.anthropic?.format).toBe("claude");
    expect(translateRequest("claude", "claude", "m",
      { model: "m", messages: [{ role: "user", content: "hi" }], client_metadata: { user_id: "u1" } },
      false, null, "anthropic")?.client_metadata).toEqual({ user_id: "u1" });
  });

  // These are PROVIDER ids and translateRequest takes a FORMAT, so the format is
  // resolved the way resolveUpstreamRoute does it. kimi resolves to the Claude
  // wire format and so belongs on the other side of this contract: it is the
  // upstream that understands the field, covered by the case above.
  it("the translator half still drops it on every openai-shaped target", () => {
    for (const p of ["openai", "opencode-go", "ollama"]) {
      const target = getTargetFormat(p);
      expect(target, `${p} is not an openai-shaped target`).not.toBe("claude");
      const out = translateRequest("claude", target, "m",
        { model: "m", messages: [{ role: "user", content: "hi" }], client_metadata: { user_id: "u1" } },
        false, null, p);
      expect(out?.client_metadata, `${p} kept client_metadata`).toBeUndefined();
    }
  });

  it("keeps it for a claude-format provider, which is why the strip is format-keyed", () => {
    expect(getTargetFormat("kimi")).toBe("claude");
    const out = translateRequest("claude", getTargetFormat("kimi"), "m",
      { model: "m", messages: [{ role: "user", content: "hi" }], client_metadata: { user_id: "u1" } },
      false, null, "kimi");
    expect(out?.client_metadata).toEqual({ user_id: "u1" });
  });

  it("the openai-to-openai passthrough is the gap the executor now closes", () => {
    // Nothing in the translator touches this path, which is why the strip has to
    // live in the executor.
    const out = translateRequest("openai", "openai", "m",
      { model: "m", messages: [{ role: "user", content: "hi" }], client_metadata: { user_id: "u1" } },
      false, null, "p");
    expect(out?.client_metadata).toEqual({ user_id: "u1" });
  });
});
