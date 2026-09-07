import { describe, it, expect } from "vitest";
import { getProviderFallbackInitials, getProviderIconSrc } from "@/shared/utils/providerIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";

describe("one rule for the provider badge (#1831)", () => {
  it("a registry provider keeps the badge it declares", () => {
    // AI_PROVIDERS flattens the registry display block onto the entry.
    const declared = Object.values(AI_PROVIDERS).find((p) => p.textIcon);
    expect(declared).toBeTruthy();
    expect(getProviderFallbackInitials(declared.id)).toBe(declared.textIcon);
  });

  it("a custom provider reads as what it is compatible with, not as its id", () => {
    // The id prefix is an internal detail; the compatibility is the only thing
    // actually known about a custom provider.
    expect(getProviderFallbackInitials("openai-compatible-myhost")).toBe("OC");
    expect(getProviderFallbackInitials("anthropic-compatible-myhost")).toBe("AC");
  });

  it("keeps custom protocol compatibility separate from provider branding", () => {
    expect(
      getProviderIconSrc("openai-compatible-chat-7915e96f-9d42-4076-80d1-fb56e3358d75"),
    ).toBeNull();
    expect(getProviderIconSrc("anthropic-compatible-private")).toBeNull();
    expect(getProviderIconSrc("custom-embedding-private")).toBeNull();
  });

  it("resolves registry marks locally without third-party asset requests", () => {
    expect(getProviderIconSrc("devin")).toBe("/providers/devin-cli.png");
    for (const id of Object.keys(AI_PROVIDERS)) {
      const src = getProviderIconSrc(id);
      expect(src === null || src.startsWith('/providers/'), id).toBe(true);
    }
  });

  it("a custom embedding provider gets its own badge rather than a generic one", () => {
    expect(getProviderFallbackInitials("custom-embedding-myhost")).toBe("CE");
  });

  it("anything else takes the name a human sees, not the internal id", () => {
    expect(getProviderFallbackInitials("some-unknown-id", "Zed Cloud")).toBe("ZE");
  });

  it("falls back to the id only when there is no display name", () => {
    expect(getProviderFallbackInitials("weird-thing")).toBe("WE");
  });

  it("never returns an empty badge", () => {
    for (const input of [undefined, null, "", "   "]) {
      expect(getProviderFallbackInitials(input), String(input)).toBe("??");
    }
  });

  it("a regional sibling resolves to the one brand mark, not a second copy", () => {
    // glm-cn shipped a byte-identical duplicate of glm.png; two files of the
    // same bytes drift apart the moment one is updated.
    expect(getProviderIconSrc("kimi-cn")).toBe("/providers/kimi.png");
    expect(getProviderIconSrc("glm-cn")).toBe("/providers/glm.png");
  });

  it("is stable, so two surfaces cannot disagree", () => {
    const twice = [
      getProviderFallbackInitials("openai-compatible-x", "My Host"),
      getProviderFallbackInitials("openai-compatible-x"),
    ];
    expect(new Set(twice).size).toBe(1);
  });
});
