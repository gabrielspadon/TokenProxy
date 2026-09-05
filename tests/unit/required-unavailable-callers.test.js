import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn(),
  getDailyConnectionUsage: vi.fn(),
  getUsageForProvider: vi.fn(),
  getCodexRateLimitResetCredits: vi.fn(),
  consumeCodexRateLimitResetCredit: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
  getExecutor: vi.fn(),
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getFreeModels: vi.fn(),
  getDisabledModels: vi.fn(),
  getProviderNodes: vi.fn(),
  reconcileSeenModels: vi.fn(),
  getUnseenModels: vi.fn(),
  countUnseenModels: vi.fn(),
  getCachedResult: vi.fn(),
  setCachedResult: vi.fn(),
  resolveCursorModels: vi.fn(),
  getClaudeUsage: vi.fn(),
  getCodexUsage: vi.fn(),
  getCodexSubscriptionEntitlement: vi.fn(),
  proxyAwareFetch: vi.fn(),
  testProxyUrl: vi.fn(),
  getHotReloadConfig: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
  updateConnectionProxyPoolSnapshotIfBound: mocks.updateConnectionProxyPoolSnapshotIfBound,
  getDailyConnectionUsage: mocks.getDailyConnectionUsage,
  getSettings: mocks.getSettings,
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
  getFreeModels: mocks.getFreeModels,
}));

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateConnectionProxyPoolSnapshotIfBound: mocks.updateConnectionProxyPoolSnapshotIfBound,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  toConnectionProxyOptions: (config) => {
    if (config?.kind !== "usable") {
      const error = new Error("Required proxy is unavailable");
      error.name = "RequiredProxyUnavailableError";
      error.code = "required_proxy_unavailable";
      error.status = 503;
      error.reason = config?.reason;
      throw error;
    }
    return {
      connectionProxyEnabled: config.connectionProxyEnabled === true,
      connectionProxyUrl: config.connectionProxyUrl || "",
      connectionNoProxy: config.connectionNoProxy || "",
      vercelRelayUrl: config.vercelRelayUrl || "",
      strictProxy: config.strictProxy === true,
      resolutionKind: config.resolutionKind,
    };
  },
  isRequiredProxyUnavailableError: (error) => error?.code === "required_proxy_unavailable",
}));

vi.mock("@/lib/network/proxyTest", () => ({
  testProxyUrl: mocks.testProxyUrl,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
  getCodexRateLimitResetCredits: mocks.getCodexRateLimitResetCredits,
  consumeCodexRateLimitResetCredit: mocks.consumeCodexRateLimitResetCredit,
}));

vi.mock("open-sse/services/usage/claude.js", () => ({ getClaudeUsage: mocks.getClaudeUsage }));
vi.mock("open-sse/services/usage/codex.js", () => ({
  getCodexUsage: mocks.getCodexUsage,
  getCodexSubscriptionEntitlement: mocks.getCodexSubscriptionEntitlement,
}));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: mocks.getExecutor }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));
vi.mock("open-sse/services/cursorModels.js", () => ({ resolveCursorModels: mocks.resolveCursorModels }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("@/lib/newModelsCache", () => ({
  getCachedResult: mocks.getCachedResult,
  setCachedResult: mocks.setCachedResult,
}));
vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  reconcileSeenModels: mocks.reconcileSeenModels,
  getUnseenModels: mocks.getUnseenModels,
  countUnseenModels: mocks.countUnseenModels,
}));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: mocks.getSettings,
  updateSettings: vi.fn(),
}));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: mocks.getProviderConnections,
}));
vi.mock("@/lib/db/repos/nodesRepo.js", () => ({
  getProviderNodes: mocks.getProviderNodes,
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
}));

vi.mock("@/shared/constants/config", async (importOriginal) => ({
  ...(await importOriginal()),
  getHotReloadConfig: mocks.getHotReloadConfig,
}));

const requiredUnavailable = {
  kind: "required-unavailable",
  resolutionKind: "required-unavailable",
  reason: "selected-pool-unavailable",
  strictProxy: true,
};

const connection = {
  id: "conn-required-proxy",
  provider: "codex",
  authType: "oauth",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  providerSpecificData: { proxyPoolId: "missing-pool", strictProxy: true },
};

const pairlessConnection = {
  ...connection,
  providerSpecificData: { proxyPoolId: "missing-pool" },
};

const cursorConnection = {
  ...connection,
  id: "cursor-required-proxy",
  provider: "cursor",
  isActive: true,
};

const usableStrictProxy = {
  kind: "usable",
  resolutionKind: "selected-proxy",
  connectionProxyEnabled: true,
  connectionProxyUrl: "https://proxy.test:8443",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
};

const strictProxyOptions = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "https://proxy.test:8443",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
  resolutionKind: "selected-proxy",
};

const intentionalDirectProxy = {
  kind: "usable",
  resolutionKind: "intentional-direct",
  connectionProxyEnabled: false,
  connectionProxyUrl: "",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: false,
};

const intentionalDirectOptions = {
  connectionProxyEnabled: false,
  connectionProxyUrl: "",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: false,
  resolutionKind: "intentional-direct",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveConnectionProxyConfig.mockResolvedValue(requiredUnavailable);
  mocks.updateConnectionProxyPoolSnapshotIfBound.mockResolvedValue(pairlessConnection);
  mocks.updateProviderConnection.mockResolvedValue(pairlessConnection);
  mocks.getProviderConnectionById.mockResolvedValue(pairlessConnection);
  mocks.refreshAndUpdateCredentials.mockResolvedValue({ connection });
  mocks.getSettings.mockResolvedValue({});
  mocks.getProviderConnections.mockResolvedValue([]);
  mocks.getCombos.mockResolvedValue([]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getFreeModels.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
  mocks.getProviderNodes.mockResolvedValue([]);
  mocks.getCachedResult.mockReturnValue(null);
  mocks.resolveCursorModels.mockResolvedValue(null);
  mocks.getHotReloadConfig.mockReturnValue({ models: ["model-required-proxy"] });
  mocks.getExecutor.mockReturnValue({ needsRefresh: () => false });
});

describe("required proxy unavailable caller boundaries", () => {
  function useUnavailableCursorConnection() {
    mocks.getProviderConnections.mockResolvedValue([cursorConnection]);
    mocks.getProviderConnectionById.mockResolvedValue(cursorConnection);
  }

  async function expectRequiredProxyUnavailable(response) {
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Required proxy is unavailable",
      code: "required_proxy_unavailable",
    });
    expect(mocks.resolveCursorModels).not.toHaveBeenCalled();
  }

  async function expectBoundSnapshotOwner() {
    const [, owner] = mocks.resolveConnectionProxyConfig.mock.calls.at(-1);
    expect(owner).toEqual(expect.objectContaining({ persistPoolSnapshot: expect.any(Function) }));
    const pair = { proxyPoolId: "missing-pool", strictProxy: true };
    await owner.persistPoolSnapshot(pair);
    expect(mocks.updateConnectionProxyPoolSnapshotIfBound)
      .toHaveBeenCalledWith(pairlessConnection.id, "missing-pool", pair);
  }

  it("v1 Cursor models returns 503 before catalog or static fallback", async () => {
    useUnavailableCursorConnection();
    const { GET } = await import("@/app/api/v1/models/route.js");

    await expectRequiredProxyUnavailable(await GET(new Request("http://localhost/v1/models")));
  });

  it("v1 combo-only models returns 503 before a static Cursor fallback", async () => {
    useUnavailableCursorConnection();
    mocks.getSettings.mockResolvedValue({ exposeComboOnly: true });
    mocks.getCombos.mockResolvedValue([{ name: "combo-static-fallback" }]);
    const { GET } = await import("@/app/api/v1/models/route.js");

    await expectRequiredProxyUnavailable(await GET(new Request("http://localhost/v1/models")));
  });

  it("v1 non-LLM models returns 503 before a static Cursor fallback", async () => {
    useUnavailableCursorConnection();
    const { GET } = await import("@/app/api/v1/models/[...kind]/route.js");

    await expectRequiredProxyUnavailable(await GET(
      new Request("http://localhost/v1/models/image"),
      { params: Promise.resolve({ kind: "image" }) },
    ));
  });

  it("provider Cursor models returns 503 before catalog or static fallback", async () => {
    useUnavailableCursorConnection();
    const { GET } = await import("@/app/api/providers/[id]/models/route.js");

    await expectRequiredProxyUnavailable(await GET(
      new Request("http://localhost/api/providers/cursor-required-proxy/models"),
      { params: Promise.resolve({ id: cursorConnection.id }) },
    ));
  });

  it("new-model discovery rejects an unavailable Cursor selection before returning its cached fallback", async () => {
    useUnavailableCursorConnection();
    mocks.getCachedResult.mockReturnValue({ groups: [{ providerAlias: "cursor", models: [] }], total: 1 });
    const { GET } = await import("@/app/api/models/new/route.js");

    await expectRequiredProxyUnavailable(await GET());
    expect(mocks.setCachedResult).not.toHaveBeenCalled();
  });

  it("new-model discovery retains a valid cache when connection lookup is unavailable", async () => {
    const cached = { groups: [{ providerAlias: "openai", models: [] }], total: 1 };
    mocks.getProviderConnections.mockRejectedValue(new Error("database unavailable"));
    mocks.getCachedResult.mockReturnValue(cached);
    const { GET } = await import("@/app/api/models/new/route.js");

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(cached);
    expect(mocks.resolveCursorModels).not.toHaveBeenCalled();
  });

  it("model context rejects an unavailable Cursor selection before static entries mask it", async () => {
    useUnavailableCursorConnection();
    const { GET } = await import("@/app/api/model-context/route.js");

    await expectRequiredProxyUnavailable(await GET());
  });

  it("Cursor v1 catalog keeps an available strict route instead of falling back", async () => {
    mocks.getProviderConnections.mockResolvedValue([cursorConnection]);
    mocks.resolveConnectionProxyConfig.mockResolvedValue(usableStrictProxy);
    mocks.resolveCursorModels.mockResolvedValue({ models: [{ id: "cursor-live", name: "Cursor Live" }] });
    const { GET } = await import("@/app/api/v1/models/route.js");

    const response = await GET(new Request("http://localhost/v1/models"));

    expect(response.status).toBe(200);
    expect(mocks.resolveCursorModels).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: cursorConnection.accessToken }),
      expect.objectContaining({ proxyOptions: strictProxyOptions }),
    );
  });

  it("non-Cursor v1 models retain their normal static result", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ ...connection, provider: "openai", isActive: true }]);
    const { GET } = await import("@/app/api/v1/models/route.js");

    const response = await GET(new Request("http://localhost/v1/models"));

    expect(response.status).toBe(200);
    expect(mocks.resolveConnectionProxyConfig).not.toHaveBeenCalled();
    expect(mocks.resolveCursorModels).not.toHaveBeenCalled();
  });

  it("quota guard returns its no-live typed result before usage, even with a fresh snapshot", async () => {
    const { evaluateQuota } = await import("@/sse/services/quotaGuard.js");
    const result = await evaluateQuota({
      ...pairlessConnection,
      quotaPauseThresholds: { session: 10 },
      lastQuotaSnapshot: {
        windows: [{ key: "session", remainingPercentage: 90, unlimited: false }],
        fetchedAt: new Date().toISOString(),
      },
    });

    expect(result).toMatchObject({
      paused: false,
      reason: "required-proxy-unavailable",
      code: "required_proxy_unavailable",
    });
    expect(mocks.getUsageForProvider).not.toHaveBeenCalled();
    await expectBoundSnapshotOwner();
  });

  it("auto ping skips unavailable selection before refresh or usage", async () => {
    const { runQuotaAutoPingTick } = await import("@/shared/services/quotaAutoPing.js");
    const deps = {
      getSettings: vi.fn().mockResolvedValue({ codexAutoPing: { connections: { [connection.id]: true } } }),
      getProviderConnections: vi.fn().mockResolvedValue([connection]),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
      refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
      updateConnectionProxyPoolSnapshotIfBound: mocks.updateConnectionProxyPoolSnapshotIfBound,
      proxyAwareFetch: mocks.proxyAwareFetch,
      getExecutor: mocks.getExecutor,
    };
    const state = { running: false, resetCache: {}, failureCache: {} };

    await runQuotaAutoPingTick(deps, state);

    expect(mocks.refreshAndUpdateCredentials).not.toHaveBeenCalled();
    expect(mocks.getCodexUsage).not.toHaveBeenCalled();
    expect(mocks.getExecutor).not.toHaveBeenCalled();
    await expectBoundSnapshotOwner();
  });

  it("usage route returns 503 before credential refresh or usage", async () => {
    const { GET } = await import("@/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-required-proxy"), {
      params: Promise.resolve({ connectionId: connection.id }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Required proxy is unavailable",
      code: "required_proxy_unavailable",
    });
    expect(mocks.getExecutor).not.toHaveBeenCalled();
    expect(mocks.getUsageForProvider).not.toHaveBeenCalled();
    await expectBoundSnapshotOwner();
  });

  it.each([
    ["GET", "getCodexRateLimitResetCredits"],
    ["POST", "consumeCodexRateLimitResetCredit"],
  ])("Codex reset %s returns 503 before refresh or reset-credit egress", async (method, forbidden) => {
    const route = await import("@/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await route[method](new Request("http://localhost/api/usage/conn-required-proxy/codex-reset-credits", { method }), {
      params: Promise.resolve({ connectionId: connection.id }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Required proxy is unavailable",
      code: "required_proxy_unavailable",
    });
    expect(mocks.refreshAndUpdateCredentials).not.toHaveBeenCalled();
    expect(mocks[forbidden]).not.toHaveBeenCalled();
    await expectBoundSnapshotOwner();
  });

  it("hot reload returns 503 before credential refresh or poke", async () => {
    const { POST } = await import("@/app/api/providers/[id]/hotreload/route.js");
    const response = await POST(new Request("http://localhost/api/providers/conn-required-proxy/hotreload", { method: "POST" }), {
      params: Promise.resolve({ id: connection.id }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "Required proxy is unavailable",
      code: "required_proxy_unavailable",
    });
    expect(mocks.refreshAndUpdateCredentials).not.toHaveBeenCalled();
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
    await expectBoundSnapshotOwner();
  });

  it("provider test returns its typed failed-test shape before proxy testing", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      ...requiredUnavailable,
      connectionProxyEnabled: true,
      connectionProxyUrl: "https://proxy.test:8443",
    });
    mocks.testProxyUrl.mockResolvedValue({ ok: false, error: "must not run" });
    const { testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js");
    const result = await testSingleConnection(connection.id);

    expect(result).toMatchObject({
      valid: false,
      error: "Required proxy is unavailable",
      code: "required_proxy_unavailable",
      status: 503,
      latencyMs: 0,
    });
    expect(mocks.testProxyUrl).not.toHaveBeenCalled();
    await expectBoundSnapshotOwner();
  });

  it("quota guard preserves a usable strict proxy selection", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue(usableStrictProxy);
    mocks.getUsageForProvider.mockResolvedValue({
      quotas: { session: { remainingPercentage: 90, unlimited: false } },
    });
    const { evaluateQuota } = await import("@/sse/services/quotaGuard.js");

    await evaluateQuota({
      ...connection,
      quotaPauseThresholds: { session: 10 },
    });

    expect(mocks.getUsageForProvider).toHaveBeenCalledWith(
      expect.any(Object),
      strictProxyOptions,
      {},
    );
  });

  it("auto ping forwards selected strict options without permitting fallback", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.resolveConnectionProxyConfig.mockResolvedValue(usableStrictProxy);
    mocks.getUsageForProvider.mockResolvedValue({
      quotas: { session: { remaining: 1, total: 1, resetAt: new Date().toISOString() } },
    });
    const { runQuotaAutoPingTick } = await import("@/shared/services/quotaAutoPing.js");
    const deps = {
      getSettings: vi.fn().mockResolvedValue({ codexAutoPing: { connections: { [connection.id]: true } } }),
      getProviderConnections: vi.fn().mockResolvedValue([connection]),
      updateProviderConnection: vi.fn(),
      updateConnectionProxyPoolSnapshotIfBound: mocks.updateConnectionProxyPoolSnapshotIfBound,
      resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
      refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
      proxyAwareFetch: mocks.proxyAwareFetch,
      getExecutor: mocks.getExecutor,
      getUsageForProvider: mocks.getUsageForProvider,
    };

    await runQuotaAutoPingTick(deps, { running: false, resetCache: {}, failureCache: {} });

    expect(mocks.refreshAndUpdateCredentials)
      .toHaveBeenCalledWith(connection, false, strictProxyOptions);
    expect(mocks.getUsageForProvider).toHaveBeenCalledWith(connection, strictProxyOptions);
  });

  it("usage route forwards selected strict options without permitting fallback", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.resolveConnectionProxyConfig.mockResolvedValue(usableStrictProxy);
    mocks.getUsageForProvider.mockResolvedValue({ quotas: {} });
    mocks.getCodexSubscriptionEntitlement.mockResolvedValue(null);
    const { GET } = await import("@/app/api/usage/[connectionId]/route.js");

    const response = await GET(new Request("http://localhost/api/usage/conn-required-proxy"), {
      params: Promise.resolve({ connectionId: connection.id }),
    });

    expect(response.status).toBe(200);
    expect(mocks.getUsageForProvider)
      .toHaveBeenCalledWith(connection, strictProxyOptions, { force: false });
  });

  it("Codex reset forwards selected strict options without permitting fallback", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.resolveConnectionProxyConfig.mockResolvedValue(usableStrictProxy);
    mocks.getCodexRateLimitResetCredits.mockResolvedValue({ credits: 1 });
    const { GET } = await import("@/app/api/usage/[connectionId]/codex-reset-credits/route.js");

    const response = await GET(new Request("http://localhost/api/usage/conn-required-proxy/codex-reset-credits"), {
      params: Promise.resolve({ connectionId: connection.id }),
    });

    expect(response.status).toBe(200);
    expect(mocks.getCodexRateLimitResetCredits)
      .toHaveBeenCalledWith(connection.accessToken, strictProxyOptions, connection.providerSpecificData);
  });

  it("hot reload forwards selected strict options before its first upstream operation", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.resolveConnectionProxyConfig.mockResolvedValue(usableStrictProxy);
    mocks.refreshAndUpdateCredentials.mockRejectedValue(new Error("stop-before-poke"));
    const { POST } = await import("@/app/api/providers/[id]/hotreload/route.js");

    const response = await POST(new Request("http://localhost/api/providers/conn-required-proxy/hotreload", { method: "POST" }), {
      params: Promise.resolve({ id: connection.id }),
    });

    expect(response.status).toBe(500);
    expect(mocks.refreshAndUpdateCredentials)
      .toHaveBeenCalledWith(connection, false, strictProxyOptions);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("provider test forwards selected strict options without direct fallback", async () => {
    const apiKeyConnection = {
      ...connection,
      provider: "openai",
      authType: "apikey",
      apiKey: "api-key",
    };
    mocks.getProviderConnectionById.mockResolvedValue(apiKeyConnection);
    mocks.resolveConnectionProxyConfig.mockResolvedValue(usableStrictProxy);
    mocks.testProxyUrl.mockResolvedValue({ ok: true });
    mocks.proxyAwareFetch.mockResolvedValue({ ok: true, status: 200 });
    const { testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js");

    const result = await testSingleConnection(apiKeyConnection.id);

    expect(result).toMatchObject({ valid: true, error: null });
    expect(mocks.proxyAwareFetch)
      .toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.any(Object), strictProxyOptions);
  });

  it("Cline provider test dispatches selected strict probes through the effective route", async () => {
    const clineConnection = { ...connection, provider: "cline" };
    const originalFetch = globalThis.fetch;
    const rawFetch = vi.fn().mockRejectedValue(new Error("strict route bypassed"));
    globalThis.fetch = rawFetch;
    mocks.getProviderConnectionById.mockResolvedValue(clineConnection);
    mocks.resolveConnectionProxyConfig.mockResolvedValue(usableStrictProxy);
    mocks.testProxyUrl.mockResolvedValue({ ok: true });
    mocks.proxyAwareFetch.mockResolvedValue({ ok: true, status: 200 });
    try {
      const { testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js");
      const result = await testSingleConnection(clineConnection.id);

      expect(result).toMatchObject({ valid: true, error: null });
      expect(rawFetch).not.toHaveBeenCalled();
      expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
        "https://api.cline.bot/api/v1/users/me",
        expect.objectContaining({ method: "GET" }),
        strictProxyOptions,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Cline intentional-direct test does not re-enter global environment routing", async () => {
    const directConnection = {
      ...connection,
      provider: "cline",
      providerSpecificData: { connectionProxyMode: "direct" },
    };
    const originalFetch = globalThis.fetch;
    const rawFetch = vi.fn().mockRejectedValue(new Error("direct route bypassed"));
    globalThis.fetch = rawFetch;
    mocks.getProviderConnectionById.mockResolvedValue(directConnection);
    mocks.resolveConnectionProxyConfig.mockResolvedValue(intentionalDirectProxy);
    mocks.proxyAwareFetch.mockResolvedValue({ ok: true, status: 200 });
    try {
      const { testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js");
      const result = await testSingleConnection(directConnection.id);

      expect(result).toMatchObject({ valid: true, error: null });
      expect(rawFetch).not.toHaveBeenCalled();
      expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
        "https://api.cline.bot/api/v1/users/me",
        expect.objectContaining({ method: "GET" }),
        intentionalDirectOptions,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    ["scheduled", usableStrictProxy, strictProxyOptions, { proxyPoolId: "missing-pool", strictProxy: true }],
    ["scheduled", intentionalDirectProxy, intentionalDirectOptions, { connectionProxyMode: "direct" }],
    ["401 retry", usableStrictProxy, strictProxyOptions, { proxyPoolId: "missing-pool", strictProxy: true }],
    ["401 retry", intentionalDirectProxy, intentionalDirectOptions, { connectionProxyMode: "direct" }],
  ])("Cline %s refresh uses the resolved route for %s", async (flow, proxyConfig, proxyOptions, providerSpecificData) => {
    const refreshConnection = {
      ...connection,
      provider: "cline",
      providerSpecificData,
      expiresAt: flow === "scheduled" ? "2000-01-01T00:00:00.000Z" : undefined,
    };
    const originalFetch = globalThis.fetch;
    const rawFetch = vi.fn(() => { throw new Error("refresh route bypassed"); });
    globalThis.fetch = rawFetch;
    mocks.getProviderConnectionById.mockResolvedValue(refreshConnection);
    mocks.resolveConnectionProxyConfig.mockResolvedValue(proxyConfig);
    mocks.testProxyUrl.mockResolvedValue({ ok: true });
    mocks.proxyAwareFetch.mockReset();
    const refreshed = {
      ok: true,
      status: 200,
      json: async () => ({ data: { accessToken: "refreshed-token", expiresAt: "2099-01-01T00:00:00.000Z" } }),
    };
    const acceptedProbe = { ok: true, status: 200 };
    if (flow === "scheduled") {
      mocks.proxyAwareFetch
        .mockResolvedValueOnce(refreshed)
        .mockResolvedValueOnce(acceptedProbe);
    } else {
      mocks.proxyAwareFetch
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce(refreshed)
        .mockResolvedValueOnce(acceptedProbe);
    }

    try {
      const { testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js");
      const result = await testSingleConnection(refreshConnection.id);

      expect(result).toMatchObject({ valid: true, error: null, refreshed: true });
      expect(rawFetch).not.toHaveBeenCalled();
      expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
        "https://api.cline.bot/api/v1/auth/refresh",
        expect.objectContaining({ method: "POST" }),
        proxyOptions,
      );
      expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
        "https://api.cline.bot/api/v1/users/me",
        expect.objectContaining({ method: "GET" }),
        proxyOptions,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
