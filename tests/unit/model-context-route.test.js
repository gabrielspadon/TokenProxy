import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repoSettings: vi.fn(),
  mutateContextWindowOverrides: vi.fn(),
  repoConnections: vi.fn(),
  nodes: vi.fn(),
  localConnections: vi.fn(),
  combos: vi.fn(),
  customModels: vi.fn(),
  aliases: vi.fn(),
  freeModels: vi.fn(),
  localSettings: vi.fn(),
  disabledModels: vi.fn(),
  resolveProxy: vi.fn(),
  toProxyOptions: vi.fn(),
  resolveCursorModels: vi.fn(),
}));

vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: mocks.repoSettings,
  mutateContextWindowOverrides: mocks.mutateContextWindowOverrides,
}));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: mocks.repoConnections,
}));
vi.mock("@/lib/db/repos/nodesRepo.js", () => ({ getProviderNodes: mocks.nodes }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.localConnections,
  getCombos: mocks.combos,
  getCustomModels: mocks.customModels,
  getModelAliases: mocks.aliases,
  getFreeModels: mocks.freeModels,
  getSettings: mocks.localSettings,
  updateConnectionProxyPoolSnapshotIfBound: vi.fn(),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.disabledModels }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveProxy,
  toConnectionProxyOptions: mocks.toProxyOptions,
  isRequiredProxyUnavailableError: (error) => error?.code === "required_proxy_unavailable",
}));
vi.mock("open-sse/services/cursorModels.js", () => ({
  resolveCursorModels: mocks.resolveCursorModels,
}));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: vi.fn() }));
vi.mock("@/app/api/v1/models/route.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildModelsList: vi.fn(actual.buildModelsList) };
});

const { GET, PUT, DELETE, POST } = await import("@/app/api/model-context/route.js");
const { buildModelsList } = await import("@/app/api/v1/models/route.js");

const cursorConnection = {
  id: "cursor-local",
  provider: "cursor",
  isActive: true,
  accessToken: "SYNTHETIC_SECRET",
  providerSpecificData: { enabledModels: ["stored-model"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repoSettings.mockResolvedValue({ contextWindowOverrides: {} });
  mocks.mutateContextWindowOverrides.mockResolvedValue({ overrides: {} });
  mocks.repoConnections.mockResolvedValue([cursorConnection]);
  mocks.nodes.mockResolvedValue([]);
  mocks.localConnections.mockResolvedValue([cursorConnection]);
  mocks.combos.mockResolvedValue([]);
  mocks.customModels.mockResolvedValue([]);
  mocks.aliases.mockResolvedValue({});
  mocks.freeModels.mockResolvedValue({});
  mocks.localSettings.mockResolvedValue({});
  mocks.disabledModels.mockResolvedValue({});
  mocks.resolveProxy.mockResolvedValue({});
  mocks.toProxyOptions.mockReturnValue({});
  mocks.resolveCursorModels.mockResolvedValue({ models: [{ id: "remote-only" }] });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("provider contact is forbidden in this test"); }));
});

describe("/api/model-context", () => {
  it("uses local persisted/static inventory without resolving a provider or proxy sidecar", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(buildModelsList).toHaveBeenCalledWith(["llm"], { localOnly: true });
    expect(mocks.resolveProxy).not.toHaveBeenCalled();
    expect(mocks.resolveCursorModels).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(body.inventory).toEqual({ source: "local", dynamicCatalogs: false });
    expect(body.models.some((model) => model.model === "stored-model")).toBe(true);
    expect(body.models.some((model) => model.model === "remote-only")).toBe(false);
    expect(JSON.stringify(body)).not.toContain("SYNTHETIC_SECRET");
  });

  it("keeps the public model listing dynamic by default", async () => {
    mocks.localConnections.mockResolvedValue([{ ...cursorConnection, providerSpecificData: {} }]);
    const models = await buildModelsList(["llm"]);

    expect(mocks.resolveProxy).toHaveBeenCalledTimes(2);
    expect(mocks.resolveCursorModels).toHaveBeenCalledOnce();
    expect(models.some((model) => model.id.endsWith("/remote-only"))).toBe(true);
  });

  it("stores a trimmed positive safe integer override and rejects unsafe values", async () => {
    mocks.mutateContextWindowOverrides.mockResolvedValue({
      overrides: { "cursor/stored-model": 128000 },
    });
    const response = await PUT(new Request("http://localhost/api/model-context", {
      method: "PUT",
      body: JSON.stringify({ key: "  cursor/stored-model  ", contextWindow: 128000 }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      overrides: { "cursor/stored-model": 128000 },
    });
    expect(mocks.mutateContextWindowOverrides).toHaveBeenCalledWith({
      set: [{ key: "cursor/stored-model", contextWindow: 128000 }],
    });

    const invalid = await PUT(new Request("http://localhost/api/model-context", {
      method: "PUT",
      body: JSON.stringify({ key: "cursor/stored-model", contextWindow: Number.MAX_SAFE_INTEGER + 1 }),
    }));
    expect(invalid.status).toBe(400);
    expect(mocks.mutateContextWindowOverrides).toHaveBeenCalledOnce();
  });

  it("removes the same canonical key that PUT stores", async () => {
    mocks.repoSettings.mockResolvedValue({
      contextWindowOverrides: { "cursor/stored-model": 128000, retained: 8192 },
    });
    mocks.mutateContextWindowOverrides.mockResolvedValue({ overrides: { retained: 8192 } });

    const response = await DELETE(new Request(
      "http://localhost/api/model-context?key=%20cursor%2Fstored-model%20",
      { method: "DELETE" },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, overrides: { retained: 8192 } });
    expect(mocks.mutateContextWindowOverrides).toHaveBeenCalledWith({ deleteKeys: ["cursor/stored-model"] });
  });

  it("preserves bulk validation and counts while mutating the map atomically", async () => {
    mocks.mutateContextWindowOverrides.mockResolvedValue({
      overrides: { retained: 8192, "cursor/stored-model": 128000 },
      nSet: 1,
      nDel: 1,
    });

    const response = await POST(new Request("http://localhost/api/model-context", {
      method: "POST",
      body: JSON.stringify({
        set: [
          { key: "  cursor/stored-model ", contextWindow: 128000 },
          { key: "invalid", contextWindow: 0 },
        ],
        deleteKeys: ["stale", ""],
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      nSet: 1,
      nDel: 1,
      overrides: { retained: 8192, "cursor/stored-model": 128000 },
    });
    expect(mocks.mutateContextWindowOverrides).toHaveBeenCalledWith({
      set: [{ key: "cursor/stored-model", contextWindow: 128000 }],
      deleteKeys: ["stale"],
    });
  });
});
