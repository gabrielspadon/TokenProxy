import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveComboTokenSaver } from "open-sse/services/combo.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chat = readFileSync(join(root, "src/sse/handlers/chat.js"), "utf8");

const GLOBAL = {
  rtkEnabled: true,
  schemaDistillEnabled: false,
  headroomEnabled: true,
  cavemanEnabled: false,
  ponytailEnabled: false,
  pxpipeEnabled: true,
  thinkingStripEnabled: false,
  queryAwareCompressionEnabled: false,
  pairDropEnabled: false,
  embedReorderEnabled: false,
  midPrefixInjectEnabled: false,
  epochMicroEnabled: false,
  epochAutoEnabled: false,
};

describe("a combo's token-saver overrides reach the handler (#2289, #2037)", () => {
  it("the handler resolves them instead of reading the global flags directly", () => {
    expect(chat).toContain("const comboTokenSaver = resolveComboTokenSaver(comboChain, chatSettings);");
    for (const flag of ["rtkEnabled", "schemaDistillEnabled", "headroomEnabled", "cavemanEnabled", "ponytailEnabled", "pxpipeEnabled", "thinkingStripEnabled", "queryAwareCompressionEnabled", "pairDropEnabled", "embedReorderEnabled", "midPrefixInjectEnabled", "epochMicroEnabled", "epochAutoEnabled"]) {
      expect(chat, flag).toContain(`${flag}: comboTokenSaver.${flag},`);
      expect(chat, flag).not.toContain(`${flag}: !!chatSettings.${flag},`);
    }
  });

  it("the expensive lazy load follows the resolved flag, not the global one", () => {
    // Warming that module for a combo that has the saver off would pay a cost
    // the override exists to avoid.
    expect(chat).toContain("comboTokenSaver.pxpipeEnabled ? await getPxpipeTransform() : null");
  });

  it("a request outside a combo resolves to the global settings unchanged", () => {
    expect(resolveComboTokenSaver(null, GLOBAL)).toEqual(GLOBAL);
  });

  it("a combo that declares nothing behaves exactly as today", () => {
    const settings = { ...GLOBAL, comboStrategies: { mine: {} } };
    expect(resolveComboTokenSaver(new Set(["mine"]), settings)).toEqual(GLOBAL);
  });

  it("a combo overrides only the flags it names", () => {
    const settings = { ...GLOBAL, comboStrategies: { mine: { tokenSaver: { rtk: false } } } };
    expect(resolveComboTokenSaver(new Set(["mine"]), settings)).toEqual({ ...GLOBAL, rtkEnabled: false });
  });

  it("a combo can turn the whole saver off in one flag", () => {
    const settings = { ...GLOBAL, comboStrategies: { mine: { tokenSaver: { enabled: false } } } };
    expect(Object.values(resolveComboTokenSaver(new Set(["mine"]), settings)).every((v) => v === false)).toBe(true);
  });
});

describe("schema distillation is combo-wired (#2289)", () => {
  it("a combo can override the schema distiller independently", () => {
    const settings = { ...GLOBAL, comboStrategies: { mine: { tokenSaver: { schema: true } } } };
    expect(resolveComboTokenSaver(new Set(["mine"]), settings)).toEqual({
      ...GLOBAL,
      schemaDistillEnabled: true,
    });
  });

  it("the combo wiring test's flag list is exactly COMBO_TOKEN_SAVER_KEYS (no drift)", async () => {
    const { readFileSync } = await import("node:fs");
    const comboSrc = readFileSync(
      new URL("../../open-sse/services/combo.js", import.meta.url),
      "utf8",
    );
    const keys = [...comboSrc.matchAll(/^  (\w+): "(\w+)"/gm)].map((m) => m[2]);
    expect(keys).toEqual([
      "rtkEnabled",
      "schemaDistillEnabled",
      "headroomEnabled",
      "cavemanEnabled",
      "ponytailEnabled",
      "pxpipeEnabled",
      "thinkingStripEnabled",
      "queryAwareCompressionEnabled",
      "pairDropEnabled",
      "embedReorderEnabled",
      "midPrefixInjectEnabled",
      "epochMicroEnabled",
      "epochAutoEnabled",
    ]);
  });
});
