import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveComboMemberConnection } from "open-sse/services/combo.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chat = readFileSync(join(root, "src/sse/handlers/chat.js"), "utf8");

const SETTINGS = {
  comboStrategies: {
    mine: { memberConnections: { "openai/gpt-5": "conn-paid", "glm/glm-5": "conn-free" } },
    other: { memberConnections: { "openai/gpt-5": "conn-other" } },
  },
};

describe("a combo can pin one member to one account (#1477)", () => {
  it("returns the account named for that member", () => {
    expect(resolveComboMemberConnection(new Set(["mine"]), "openai/gpt-5", SETTINGS)).toBe("conn-paid");
    expect(resolveComboMemberConnection(new Set(["mine"]), "glm/glm-5", SETTINGS)).toBe("conn-free");
  });

  it("returns nothing for a member the combo does not name", () => {
    expect(resolveComboMemberConnection(new Set(["mine"]), "openai/gpt-4", SETTINGS)).toBeNull();
  });

  it("returns nothing outside a combo, so a plain request is unchanged", () => {
    expect(resolveComboMemberConnection(null, "openai/gpt-5", SETTINGS)).toBeNull();
  });

  it("the outermost combo wins, so a nested one cannot override the entry point", () => {
    // Same precedence the token-saver override uses.
    expect(resolveComboMemberConnection(["mine", "other"], "openai/gpt-5", SETTINGS)).toBe("conn-paid");
  });

  it("an inherited property is not a configured pin", () => {
    // A combo name is user-supplied and "constructor" passes the name regex.
    expect(resolveComboMemberConnection(new Set(["constructor"]), "openai/gpt-5", SETTINGS)).toBeNull();
    expect(resolveComboMemberConnection(new Set(["toString"]), "openai/gpt-5", SETTINGS)).toBeNull();
  });

  it("ignores a malformed map rather than throwing on it", () => {
    for (const bad of [
      { comboStrategies: { mine: { memberConnections: ["a"] } } },
      { comboStrategies: { mine: { memberConnections: { "openai/gpt-5": 7 } } } },
      { comboStrategies: { mine: { memberConnections: { "openai/gpt-5": "" } } } },
      { comboStrategies: [] },
      {},
      null,
    ]) {
      expect(resolveComboMemberConnection(new Set(["mine"]), "openai/gpt-5", bad)).toBeNull();
    }
  });

  it("the handler pins strictly, because a named account must not be substituted", () => {
    expect(chat).toContain("credentialOptions.strictPreferredConnection = true;");
    // The settings read is now the dispatch-scoped snapshot rather than a bare
    // getSettings() call, but it is still the SAME configuration this dispatch
    // resolves every other decision against, which is what pinning requires.
    expect(chat).toContain("resolveComboMemberConnection(comboChain, modelStr, await dispatchSettings())");
  });

  it("a replay pin still wins, since it is about reaching the account that just failed", () => {
    const replay = chat.indexOf("credentialOptions.preferredConnectionId = requestReplayConnectionId;");
    const pinned = chat.indexOf("else if (pinnedConnectionId) {");
    expect(replay).toBeGreaterThan(-1);
    expect(pinned).toBeGreaterThan(replay);
  });

  it("a plain request never pays the settings read", () => {
    expect(chat).toContain("const pinnedConnectionId = comboChain");
  });
});
