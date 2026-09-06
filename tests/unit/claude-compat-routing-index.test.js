// Coverage for buildClaudeRoutingIndex + stripContextSuffix in
// src/lib/claudeCompat.js. All db reads (@/lib/localDb) are mocked; the
// static-catalog expectations are DERIVED from the same constants module the
// implementation imports, so a catalog change never breaks these tests.
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = vi.hoisted(() => ({
  getCustomModels: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/localDb", () => dbMock);

import { buildClaudeRoutingIndex, stripContextSuffix } from "@/lib/claudeCompat.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";

beforeEach(() => {
  dbMock.getCustomModels.mockReset().mockResolvedValue([]);
  dbMock.getCombos.mockReset().mockResolvedValue([]);
  dbMock.getModelAliases.mockReset().mockResolvedValue({});
});

describe("buildClaudeRoutingIndex", () => {
  it("indexes the whole static catalog under alias and provider-id spellings", async () => {
    const { pairs, bare } = await buildClaudeRoutingIndex();
    for (const [alias, models] of Object.entries(PROVIDER_MODELS || {})) {
      for (const m of models || []) {
        if (m?.id) expect(pairs.has(`${alias}/${m.id}`)).toBe(true);
      }
    }
    for (const [providerId, alias] of Object.entries(PROVIDER_ID_TO_ALIAS || {})) {
      for (const m of PROVIDER_MODELS?.[alias] || []) {
        if (m?.id) expect(pairs.has(`${providerId}/${m.id}`)).toBe(true);
      }
    }
    expect(bare.size).toBe(0);
  });

  it("adds custom models under their alias and the mapped alias, skipping malformed rows", async () => {
    const providerId = Object.keys(PROVIDER_ID_TO_ALIAS || {}).find(
      (k) => PROVIDER_ID_TO_ALIAS[k] !== k,
    );
    const custom = [
      { id: "my-custom-model", providerAlias: "someprov" },
      { id: null, providerAlias: "someprov" }, // no id — skipped
      { id: "orphan-model" }, // no providerAlias — skipped
    ];
    if (providerId) custom.push({ id: "mapped-model", providerAlias: providerId });
    dbMock.getCustomModels.mockResolvedValue(custom);

    const { pairs } = await buildClaudeRoutingIndex();
    expect(pairs.has("someprov/my-custom-model")).toBe(true);
    expect(pairs.has("someprov/null")).toBe(false);
    expect([...pairs].some((p) => p.endsWith("/orphan-model"))).toBe(false);
    if (providerId) {
      expect(pairs.has(`${providerId}/mapped-model`)).toBe(true);
      expect(pairs.has(`${PROVIDER_ID_TO_ALIAS[providerId]}/mapped-model`)).toBe(true);
    }
  });

  it("adds alias-map keys as bare names and slash-values as pairs", async () => {
    dbMock.getModelAliases.mockResolvedValue({
      "fast-alias": "prov/some-model",
      "plain-alias": "no-slash-target",
    });
    const { pairs, bare } = await buildClaudeRoutingIndex();
    expect(bare.has("fast-alias")).toBe(true);
    expect(bare.has("plain-alias")).toBe(true);
    expect(pairs.has("prov/some-model")).toBe(true);
    expect(pairs.has("no-slash-target")).toBe(false);
  });

  it("adds combo names as bare, skipping nameless combos", async () => {
    dbMock.getCombos.mockResolvedValue([{ name: "my-combo" }, { id: "x" }, null]);
    const { bare } = await buildClaudeRoutingIndex();
    expect(bare.has("my-combo")).toBe(true);
    expect(bare.size).toBe(1);
  });

  it("survives every db read failing — static catalog alone remains", async () => {
    dbMock.getCustomModels.mockRejectedValue(new Error("db down"));
    dbMock.getModelAliases.mockRejectedValue(new Error("db down"));
    dbMock.getCombos.mockRejectedValue(new Error("db down"));
    const { pairs, bare } = await buildClaudeRoutingIndex();
    const staticCount = Object.entries(PROVIDER_MODELS || {}).reduce(
      (n, [, models]) => n + (models || []).filter((m) => m?.id).length,
      0,
    );
    expect(pairs.size).toBeGreaterThanOrEqual(staticCount > 0 ? 1 : 0);
    expect(bare.size).toBe(0);
  });
});

describe("stripContextSuffix", () => {
  it("removes a trailing [1m] case-insensitively", () => {
    expect(stripContextSuffix("prov/model[1m]")).toBe("prov/model");
    expect(stripContextSuffix("prov/model[1M]")).toBe("prov/model");
    expect(stripContextSuffix("prov/model")).toBe("prov/model");
  });

  it("returns the input unchanged when stripping would leave an empty id", () => {
    expect(stripContextSuffix("[1m]")).toBe("[1m]");
  });

  it("passes non-strings through", () => {
    expect(stripContextSuffix(undefined)).toBe(undefined);
    expect(stripContextSuffix(42)).toBe(42);
  });
});
