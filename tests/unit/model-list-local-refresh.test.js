import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, stat } from "node:fs/promises";

const state = vi.hoisted(() => ({
  live: vi.fn(async () => ({ models: [{ id: "gpt-live", kind: "llm" }] })),
  credentialWrite: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => [{
    id: "openai-one",
    provider: "openai",
    isActive: true,
    apiKey: "secret",
    providerSpecificData: {},
  }]),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getFreeModels: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn(),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
vi.mock("@/shared/constants/models", () => ({
  PROVIDER_MODELS: { openai: [{ id: "gpt-static" }] },
  PROVIDER_ID_TO_ALIAS: { openai: "openai" },
  getModelKind: (model) => model?.kind || model?.type || null,
}));
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: { openai: { serviceKinds: ["llm"] } },
  FREE_PROVIDERS: {},
  FREE_TIER_PROVIDERS: {},
  NO_AUTH_PROVIDER_IDS: [],
  getProviderAlias: () => "openai",
  isOpenAICompatibleProvider: () => false,
  isAnthropicCompatibleProvider: () => false,
}));
vi.mock("open-sse/providers/capabilities.js", () => ({
  capabilitiesFromServiceKind: () => null,
  getCapabilitiesForModel: () => ({ contextWindow: 128000, maxOutput: 16384 }),
}));
vi.mock("open-sse/providers/thinkingLevels.js", () => ({ getThinkingLevels: () => null }));
vi.mock("@/app/api/providers/[id]/models/liveCatalog.js", () => ({
  resolveLiveOpenAIModels: state.live,
  resolveLiveCodexModels: state.live,
}));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: state.credentialWrite }));

const {
  GET,
  getPublicModelCatalogState,
  refreshPublicModelCatalog,
  resetPublicModelCatalogForTests,
} = await import("@/app/api/v1/models/route.js");

describe("public model-list local reads and refresh", () => {
  beforeEach(() => {
    state.live.mockClear();
    state.credentialWrite.mockClear();
    resetPublicModelCatalogForTests();
  });
  it("serves 100 concurrent public reads without provider calls or credential writes", async () => {
    const responses = await Promise.all(Array.from({ length: 100 }, () =>
      GET(new Request("http://127.0.0.1/v1/models"))));
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(state.live).not.toHaveBeenCalled();
    expect(state.credentialWrite).not.toHaveBeenCalled();
    expect(bodies.every((body) => body.data.some((model) => model.id === "openai/gpt-static"))).toBe(true);
  });

  it("coalesces concurrent background and explicit refreshes into one live fetch", async () => {
    let release;
    state.live.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const background = refreshPublicModelCatalog({ reason: "background" });
    const explicit = refreshPublicModelCatalog({ reason: "explicit" });
    await vi.waitFor(() => expect(state.live).toHaveBeenCalledTimes(1));
    release({ models: [{ id: "gpt-live", kind: "llm" }] });
    const [first, second] = await Promise.all([background, explicit]);

    expect(first).toEqual(second);
    expect(state.live).toHaveBeenCalledTimes(1);
    const catalogState = getPublicModelCatalogState();
    expect(catalogState).toMatchObject({ running: false, available: true });
    const persisted = await readFile(catalogState.file, "utf8");
    expect(JSON.parse(persisted)).toMatchObject({ schema: 1, entries: expect.any(Object) });
    expect(persisted).not.toContain("secret");
    expect((await stat(catalogState.file)).mode & 0o777).toBe(0o600);
    const body = await (await GET(new Request("http://127.0.0.1/v1/models"))).json();
    expect(body.data.some((model) => model.id === "openai/gpt-live")).toBe(true);
    expect(state.live).toHaveBeenCalledTimes(1);
  });
});
