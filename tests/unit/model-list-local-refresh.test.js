import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { credentialRevision } from "open-sse/services/tokenRefresh/credentialRevision.js";

const state = vi.hoisted(() => ({
  live: vi.fn(async () => ({ models: [{ id: "gpt-live", kind: "llm" }] })),
  credentialWrite: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => [
    {
      id: "openai-one",
      provider: "openai",
      isActive: true,
      apiKey: "secret",
      providerSpecificData: {},
    },
  ]),
  getProviderConnectionById: vi.fn(async () => ({
    id: "openai-one",
    provider: "openai",
    isActive: true,
    apiKey: "secret",
    providerSpecificData: {},
  })),
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
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: state.credentialWrite,
}));

const {
  GET,
  getPublicModelCatalogState,
  refreshPublicModelCatalog,
  resetPublicModelCatalogForTests,
} = await import("@/app/api/v1/models/route.js");
const { readLiveCatalog, refreshLiveCatalog, refreshPublicModelCatalogWith } =
  await import("@/app/api/v1/models/catalogSnapshot.js");

describe("public model-list local reads and refresh", () => {
  beforeEach(() => {
    state.live.mockClear();
    state.credentialWrite.mockClear();
    resetPublicModelCatalogForTests();
  });
  it("serves 100 concurrent public reads without provider calls or credential writes", async () => {
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => GET(new Request("http://127.0.0.1/v1/models")))
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(state.live).not.toHaveBeenCalled();
    expect(state.credentialWrite).not.toHaveBeenCalled();
    expect(
      bodies.every((body) => body.data.some((model) => model.id === "openai/gpt-static"))
    ).toBe(true);
  });

  it("coalesces concurrent background and explicit refreshes into one live fetch", async () => {
    let release;
    state.live.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
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

  it("releases a timed-out owner and blocks its late publication", async () => {
    const connection = {
      id: "openai-one",
      provider: "openai",
      apiKey: "secret",
      credentialRevisionId: "revision-a",
      providerSpecificData: {},
    };
    let release;
    const stale = refreshLiveCatalog(
      "openai",
      connection,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      { currentRevision: async () => credentialRevision(connection), timeoutMs: 20 }
    );
    await expect(stale).rejects.toMatchObject({ code: "CATALOG_REFRESH_TIMEOUT" });
    await refreshLiveCatalog("openai", connection, async () => ({ models: [{ id: "newer" }] }), {
      currentRevision: async () => credentialRevision(connection),
      timeoutMs: 100,
    });
    release({ models: [{ id: "stale" }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readLiveCatalog("openai", connection)?.models).toEqual([{ id: "newer" }]);
  });

  it("rejects publication after an ABA credential revision change", async () => {
    const connection = {
      id: "openai-one",
      provider: "openai",
      apiKey: "same-secret",
      credentialRevisionId: "revision-a",
      providerSpecificData: {},
    };
    let authoritative = credentialRevision(connection);
    let release;
    const pending = refreshLiveCatalog(
      "openai",
      connection,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      { currentRevision: async () => authoritative, timeoutMs: 100 }
    );
    authoritative = credentialRevision({ ...connection, credentialRevisionId: "revision-b" });
    release({ models: [{ id: "stale-after-aba" }] });
    await pending;
    expect(readLiveCatalog("openai", connection)).toBeNull();
  });

  it("bounds whole-refresh ownership and closes log classifications", async () => {
    const logs = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation((...args) => logs.push(args.join(" ")));
    const timedOut = await refreshPublicModelCatalogWith(() => new Promise(() => {}), {
      reason: "opaque-reason-canary",
      timeoutMs: 20,
    });
    expect(timedOut).toEqual({ refreshed: false, error: "catalog refresh failed" });
    const recovered = await refreshPublicModelCatalogWith(async () => [], {
      reason: "explicit",
      timeoutMs: 100,
    });
    expect(recovered.refreshed).toBe(true);
    const opaque = new Error("opaque-message-canary");
    opaque.name = "opaque-name-canary";
    state.live.mockRejectedValueOnce(opaque);
    await refreshPublicModelCatalog({ reason: "opaque-reason-canary", timeoutMs: 100 });
    expect(logs.join(" ")).not.toMatch(/opaque-(?:reason|message|name)-canary/);
    expect(logs.join(" ")).toMatch(/reason=explicit/);
    log.mockRestore();
    warn.mockRestore();
  });
});
