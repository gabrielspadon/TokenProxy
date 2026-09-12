// Issue/PR #577: a model the operator disabled vanished from /v1/models but
// still answered when asked for by name, because getModelInfo never consulted
// the disabled list. The combo half was closed by #1521; this is the direct
// path. The dashboard control says Disable, not Hide.
import { describe, expect, it, vi, beforeEach } from "vitest";

let disabled = {};
let throws = false;
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: async () => {
    if (throws) throw new Error("db unreadable");
    return disabled;
  },
}));

const { isModelDisabled } = await import("@/sse/services/model.js");

beforeEach(() => { disabled = {}; throws = false; });

describe("a disabled model is refused on the direct path (#577)", () => {
  it("reports a disabled alias/model as disabled", async () => {
    disabled = { cc: ["claude-opus-4-1"] };
    expect(await isModelDisabled("cc/claude-opus-4-1")).toBe(true);
  });

  it("leaves a sibling model of the same provider alone", async () => {
    disabled = { cc: ["claude-opus-4-1"] };
    expect(await isModelDisabled("cc/claude-sonnet-5")).toBe(false);
  });

  it("does not match the same model id under another provider", async () => {
    disabled = { cc: ["shared-name"] };
    expect(await isModelDisabled("other/shared-name")).toBe(false);
  });

  it("treats a bare id with no provider as not disabled", async () => {
    // A combo name has no alias/model shape; its members are filtered later.
    disabled = { cc: ["claude-opus-4-1"] };
    expect(await isModelDisabled("my-combo")).toBe(false);
    expect(await isModelDisabled("/leading-slash")).toBe(false);
  });

  it("fails OPEN when the disabled list cannot be read", async () => {
    // An unreadable list must not take routing down with it, which is the rule
    // filterDisabledComboMembers already follows.
    throws = true;
    expect(await isModelDisabled("cc/claude-opus-4-1")).toBe(false);
  });

  it("is false for a non-string, rather than throwing on the request path", async () => {
    for (const v of [null, undefined, 42, {}]) {
      expect(await isModelDisabled(v)).toBe(false);
    }
  });
});

describe("the chat handler enforces it (#577)", () => {
  it("checks before combo expansion and returns a 404", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/sse/handlers/chat.js", import.meta.url), "utf8");
    const disabledCheck = "await prepare(() => isModelDisabled(modelStr))";
    const comboExpansion = "await prepare(() => getComboModels(modelStr))";
    expect(src).toContain(disabledCheck);
    expect(src).toContain(comboExpansion);
    expect(src).toContain("HTTP_STATUS.NOT_FOUND");
    // Must sit ahead of getComboModels, so a disabled direct model never
    // reaches account selection or a rotation slot.
    expect(src.indexOf(disabledCheck)).toBeLessThan(src.indexOf(comboExpansion));
  });
});
