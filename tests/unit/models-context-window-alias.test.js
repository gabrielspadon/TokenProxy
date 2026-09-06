import { describe, it, expect, vi, beforeEach } from "vitest";

// Claude Code resolves a model's context window from
// `entry?.runtime?.max_input_tokens ?? entry?.context_window` and reads no
// other key. This gateway emitted context_length (and the nested camelCase
// capabilities.contextWindow) but never context_window, so the client scored
// every listed model as unknown and fell back to its built-in catalogue.
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn().mockResolvedValue([]),
  getCombos: vi.fn().mockResolvedValue([]),
  getCustomModels: vi.fn().mockResolvedValue([]),
  getModelAliases: vi.fn().mockResolvedValue({}),
  getFreeModels: vi.fn().mockResolvedValue({}),
  getSettings: vi.fn().mockResolvedValue({}),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn().mockResolvedValue({}),
}));

const { getProviderConnections } = await import("@/lib/localDb");
const { buildModelsList } = await import("@/app/api/v1/models/route.js");

describe("/v1/models mirrors context_length into context_window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "anthropic", isActive: true, providerSpecificData: {} },
    ]);
  });

  it("carries context_window === context_length wherever the window is known", async () => {
    const listed = await buildModelsList(["llm"]);
    const withLength = listed.filter((m) => Number.isFinite(m.context_length));

    expect(withLength.length).toBeGreaterThan(0);
    for (const model of withLength) {
      expect(model.context_window).toBe(model.context_length);
    }
  });

  it("omits the key entirely rather than emitting a zero for an unknown window", async () => {
    // A webSearch entry is provider-as-model and carries no token limits, so it
    // must stay unadorned: Claude Code clamps to [8192, 1e6], and a 0 would be
    // read as 8192 rather than as "no answer here, use the catalogue".
    const listed = await buildModelsList(["webSearch"]);
    const unknown = listed.filter((m) => !Number.isFinite(m.context_length));

    expect(unknown.length).toBeGreaterThan(0);
    for (const model of unknown) {
      expect(model).not.toHaveProperty("context_window");
    }
  });
});
