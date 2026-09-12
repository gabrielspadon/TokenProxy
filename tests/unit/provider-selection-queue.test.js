import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  updateProviderConnection: vi.fn(),
  validateApiKey: vi.fn(),
}));

const proxyMocks = vi.hoisted(() => ({
  resolveConnectionProxyConfig: vi.fn(),
  toConnectionProxyOptions: vi.fn((config) => ({
    connectionProxyEnabled: config.connectionProxyEnabled,
    connectionProxyUrl: config.connectionProxyUrl,
    connectionNoProxy: config.connectionNoProxy,
    vercelRelayUrl: config.vercelRelayUrl,
    strictProxy: config.strictProxy,
    resolutionKind: config.resolutionKind,
  })),
  pickProxyPoolId: vi.fn(),
}));

const quotaMocks = vi.hoisted(() => ({
  evaluateQuota: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => proxyMocks);
vi.mock("@/sse/services/quotaGuard.js", () => quotaMocks);
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const auth = await import("@/sse/services/auth.js");
const { getProviderCredentials } = auth;
const { withRequestLifetime } = await import('open-sse/utils/requestLifetime.js');
const { releaseAccountLease, leaseRegistry } = await import('@/sse/services/accountLeaseRegistry.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function connection(provider, id) {
  return {
    id,
    provider,
    displayName: `${provider} ${id}`,
    authType: "api_key",
    apiKey: `${provider}-${id}-key`,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    expiresAt: null,
    expiresIn: null,
    lastRefreshAt: null,
    projectId: null,
    priority: 1,
    consecutiveUseCount: 0,
    providerSpecificData: {},
    testStatus: "active",
    lastError: null,
  };
}

async function drainMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("provider-scoped account-selection queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: {},
    });
    dbMocks.getProxyPools.mockResolvedValue([]);
    dbMocks.updateProviderConnection.mockResolvedValue(undefined);
    proxyMocks.resolveConnectionProxyConfig.mockResolvedValue({
      kind: "usable",
      resolutionKind: "unselected",
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      proxyPoolId: null,
      vercelRelayUrl: "",
      strictProxy: false,
    });
    proxyMocks.pickProxyPoolId.mockReturnValue(null);
    quotaMocks.evaluateQuota.mockResolvedValue({
      paused: false,
      reason: "disabled",
      snapshot: null,
    });
  });

  it("allows different providers to overlap while either selection is pending", async () => {
    const openaiGate = deferred();
    const anthropicGate = deferred();
    const openaiStarted = deferred();
    const started = [];
    dbMocks.getProviderConnections.mockImplementation(({ provider }) => {
      started.push(provider);
      if (provider === "openai") {
        openaiStarted.resolve();
        return openaiGate.promise;
      }
      if (provider === "anthropic") return anthropicGate.promise;
      throw new Error(`unexpected provider ${provider}`);
    });

    const first = getProviderCredentials("openai");
    await openaiStarted.promise;
    const second = getProviderCredentials("anthropic");

    try {
      await drainMicrotasks();
      expect(started).toEqual(["openai", "anthropic"]);
    } finally {
      openaiGate.resolve([connection("openai", "openai-1")]);
      anthropicGate.resolve([connection("anthropic", "anthropic-1")]);
      await Promise.allSettled([first, second]);
    }
  });

  it("serializes two selections for the same provider", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    let calls = 0;
    dbMocks.getProviderConnections.mockImplementation(({ provider }) => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        return firstGate.promise;
      }
      secondStarted.resolve();
      return secondGate.promise;
    });

    const first = getProviderCredentials("openai");
    await firstStarted.promise;
    const second = getProviderCredentials("openai");

    try {
      await drainMicrotasks();
      expect(calls).toBe(1);
      firstGate.resolve([connection("openai", "openai-1")]);
      await secondStarted.promise;
      expect(calls).toBe(2);
    } finally {
      firstGate.resolve([connection("openai", "openai-1")]);
      secondGate.resolve([connection("openai", "openai-2")]);
      await Promise.allSettled([first, second]);
    }
  });

  it("serializes an alias with its canonical provider ID", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const queriedProviders = [];
    dbMocks.getProviderConnections.mockImplementation(({ provider }) => {
      queriedProviders.push(provider);
      if (queriedProviders.length === 1) {
        firstStarted.resolve();
        return firstGate.promise;
      }
      secondStarted.resolve();
      return secondGate.promise;
    });

    const aliasSelection = getProviderCredentials("kc");
    await firstStarted.promise;
    const canonicalSelection = getProviderCredentials("kilocode");

    try {
      await drainMicrotasks();
      expect(queriedProviders).toEqual(["kilocode"]);
      firstGate.resolve([connection("kilocode", "kilo-1")]);
      await secondStarted.promise;
      expect(queriedProviders).toEqual(["kilocode", "kilocode"]);
    } finally {
      firstGate.resolve([connection("kilocode", "kilo-1")]);
      secondGate.resolve([connection("kilocode", "kilo-2")]);
      await Promise.allSettled([aliasSelection, canonicalSelection]);
    }
  });

  it("releases the next same-provider selection after rejection", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const firstStarted = deferred();
    let calls = 0;
    dbMocks.getProviderConnections.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        return firstGate.promise;
      }
      return secondGate.promise;
    });

    const firstError = new Error("database read failed");
    const first = getProviderCredentials("openai").then(
      () => null,
      (error) => error,
    );
    await firstStarted.promise;
    const second = getProviderCredentials("openai");

    try {
      await drainMicrotasks();
      expect(calls).toBe(1);
      firstGate.reject(firstError);
      expect(await first).toBe(firstError);
      await drainMicrotasks();
      expect(calls).toBe(2);
    } finally {
      firstGate.resolve([connection("openai", "openai-1")]);
      secondGate.resolve([connection("openai", "openai-2")]);
      await Promise.allSettled([first, second]);
    }
  });

  it("removes every provider queue entry after the selections settle", async () => {
    const openaiGate = deferred();
    const anthropicGate = deferred();
    dbMocks.getProviderConnections.mockImplementation(({ provider }) => {
      if (provider === "openai") return openaiGate.promise;
      if (provider === "anthropic") return anthropicGate.promise;
      throw new Error(`unexpected provider ${provider}`);
    });

    const first = getProviderCredentials("openai");
    const second = getProviderCredentials("anthropic");

    try {
      await drainMicrotasks();
      expect(auth._getProviderSelectionQueueSize?.()).toBe(2);
    } finally {
      openaiGate.resolve([connection("openai", "openai-1")]);
      anthropicGate.resolve([connection("anthropic", "anthropic-1")]);
      await Promise.allSettled([first, second]);
    }

    expect(auth._getProviderSelectionQueueSize?.()).toBe(0);
  });

  it("preserves filtering and preferred-account selection", async () => {
    const first = connection("openai", "openai-1");
    const preferred = connection("openai", "openai-2");
    dbMocks.getProviderConnections.mockResolvedValue([first, preferred]);

    const credentials = await getProviderCredentials(
      "openai",
      new Set([first.id]),
      "gpt-5.6-sol",
      { preferredConnectionId: preferred.id },
    );

    expect(credentials).toMatchObject({
      authType: "api_key",
      apiKey: "openai-openai-2-key",
      connectionId: "openai-2",
      connectionName: "openai openai-2",
      testStatus: "active",
      providerSpecificData: {
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: "",
        connectionProxyPoolId: null,
        vercelRelayUrl: "",
        strictProxy: false,
      },
    });
    expect(dbMocks.getProviderConnections).toHaveBeenCalledWith({
      provider: "openai",
      isActive: true,
    });
    expect(quotaMocks.evaluateQuota).toHaveBeenCalledTimes(1);
    expect(quotaMocks.evaluateQuota).toHaveBeenCalledWith(preferred);
    releaseAccountLease(credentials.accountLease);
  });

  it('lets another account of the same provider proceed during a cold quota read', async () => {
    const cold = deferred(), started = deferred();
    const a = connection('openai', 'cold-a'), b = connection('openai', 'warm-b');
    dbMocks.getProviderConnections.mockResolvedValue([a, b]);
    quotaMocks.evaluateQuota.mockImplementation(c => {
      if (c.id === a.id) { started.resolve(); return cold.promise; }
      return { paused: false, reason: 'ineligible', snapshot: null };
    });
    const first = getProviderCredentials('openai', null, 'fixture-model', { preferredConnectionId: a.id, strictPreferredConnection: true });
    await started.promise;
    try {
      const second = await getProviderCredentials('openai', null, 'fixture-model', { preferredConnectionId: b.id, strictPreferredConnection: true });
      expect(second.connectionId).toBe(b.id);
      releaseAccountLease(second.accountLease);
    } finally {
      cold.resolve({ paused: false, reason: 'no-data', failureClass: 'empty', snapshot: null });
      releaseAccountLease((await first)?.accountLease);
    }
  });

  it('revalidates credentials after the remote read before reserving an account', async () => {
    const pending = deferred(), started = deferred();
    let current = connection('openai', 'rotating-account');
    dbMocks.getProviderConnections.mockImplementation(async () => [current]);
    quotaMocks.evaluateQuota.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const selection = getProviderCredentials('openai', null, 'fixture-model', { preferredConnectionId: current.id });
    await started.promise;
    current = { ...current, apiKey: 'new-fixture-credential' };
    pending.resolve({ paused: false, reason: 'no-data', snapshot: null });
    const result = await selection;
    expect(result.apiKey).toBe('new-fixture-credential');
    expect(quotaMocks.evaluateQuota).toHaveBeenCalledTimes(2);
    releaseAccountLease(result.accountLease);
  });

  it('cancels a quota waiter without a late reservation or retained provider lock', async () => {
    const pending = deferred(), started = deferred();
    const account = connection('openai', 'cancelled-account');
    dbMocks.getProviderConnections.mockResolvedValue([account]);
    quotaMocks.evaluateQuota.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const controller = new AbortController();
    const selection = withRequestLifetime(controller.signal, () => getProviderCredentials('openai', null, 'fixture-model', { preferredConnectionId: account.id })).catch(error => error);
    await started.promise;
    controller.abort(new DOMException('fixture cancellation', 'AbortError'));
    expect((await selection).name).toBe('AbortError');
    pending.resolve({ paused: false, reason: 'no-data', snapshot: null });
    await drainMicrotasks();
    expect(leaseRegistry.inFlight(account.id)).toBe(0);
    expect(auth._getProviderSelectionQueueSize()).toBe(0);
    expect(dbMocks.getProviderConnections).toHaveBeenCalledTimes(1);
  });
});
