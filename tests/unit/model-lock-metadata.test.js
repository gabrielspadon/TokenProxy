import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  FREE_TIER_PROVIDERS: {},
  // Both shapes auth.js reads: the id list for the reachable set and the
  // predicate for the virtual connection. A partial mock fails the whole file
  // with "No <name> export", not just the assertion that needed it.
  NO_AUTH_PROVIDER_IDS: [],
  resolveProviderId: (provider) => provider,
  isNoAuthProvider: () => false,
}));
vi.mock("@/sse/services/quotaGuard.js", () => ({
  evaluateQuota: vi.fn(async () => ({ paused: false })),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const {
  MODEL_LOCK_ALL,
  buildClearModelLocksUpdate,
  buildModelFailureUpdate,
  buildModelLockUpdateAt,
  getActiveModelFailure,
  getModelFailureKey,
  getModelLockKey,
} = await import("../../open-sse/services/accountFallback.js");
const {
  clearAccountError,
  getProviderCredentials,
  markAccountUnavailable,
} = await import("../../src/sse/services/auth.js");
const { projectClientModelStatus } = await import("../../open-sse/config/modelErrorClassifier.js");

const ALPHA = "alpha";
const BETA = "beta";
const NOW = new Date("2026-08-30T15:00:00.000Z");
const future = (minutes) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const past = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function pair(model, { until, status = 429, message = `${model} limited`, resetsAt = null, clientErrorStatus = status } = {}) {
  return {
    ...buildModelLockUpdateAt(model, until),
    ...buildModelFailureUpdate(model, {
      status,
      message,
      until,
      resetsAt,
      clientErrorStatus,
      unknownModelVerified: false,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dbMocks.getSettings.mockResolvedValue({});
  dbMocks.getProxyPools.mockResolvedValue([]);
  dbMocks.updateProviderConnection.mockResolvedValue(undefined);
});

describe("model-keyed failure metadata", () => {
  it("does not persist a lock for a generic HTTP 422 request error", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([{ id: "conn-1", provider: "demo", backoffLevel: 0 }]);

    await expect(markAccountUnavailable(
      "conn-1",
      422,
      "The request body cannot be processed",
      "demo",
      ALPHA,
    )).resolves.toEqual({ shouldFallback: false, cooldownMs: 0 });

    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("locks the (account, model) pair and rotates on a verified unknown-model signature", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([{ id: "conn-1", provider: "claude", backoffLevel: 0 }]);

    await expect(markAccountUnavailable(
      "conn-1",
      404,
      '{"type":"error","error":{"type":"not_found_error","message":"model: claude-fable-5-1"}}',
      "claude",
      "claude-fable-5-1",
      null,
      { clientErrorStatus: 404, unknownModelVerified: true },
    )).resolves.toEqual({ shouldFallback: true, cooldownMs: 0 });

    const write = dbMocks.updateProviderConnection.mock.calls[0][1];
    const lockKey = getModelLockKey("claude-fable-5-1");
    expect(write).toHaveProperty(lockKey);
    // 24h lock, model-scoped: other models on the account stay usable.
    expect(new Date(write[lockKey]).getTime()).toBe(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(write).not.toHaveProperty(MODEL_LOCK_ALL);
    expect(write[getModelFailureKey("claude-fable-5-1")]).toMatchObject({ unknownModelVerified: true });
  });

  // Fable is a separate entitlement lane: an account can hold quota for every
  // other model and still refuse Fable with 403. Without a model-scoped lock the
  // 403 status rule benches the whole account for two minutes and forgets, so
  // the pool retries the incapable account forever.
  it("locks only the refused model when an account lacks its entitlement", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([{ id: "conn-1", provider: "claude", backoffLevel: 0 }]);
    const payload = '{"type":"error","error":{"type":"permission_error","message":"Your account does not have access to claude-fable-5"}}';
    const { unknownModelVerified, clientErrorStatus } = projectClientModelStatus({
      provider: "claude",
      requestedModel: "claude-fable-5",
      status: 403,
      payload: JSON.parse(payload),
    });
    expect(unknownModelVerified).toBe(true);

    await expect(markAccountUnavailable(
      "conn-1",
      403,
      payload,
      "claude",
      "claude-fable-5",
      null,
      { clientErrorStatus, unknownModelVerified },
    )).resolves.toEqual({ shouldFallback: true, cooldownMs: 0 });

    const write = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(write).toHaveProperty(getModelLockKey("claude-fable-5"));
    expect(write).not.toHaveProperty(MODEL_LOCK_ALL);
    expect(write).not.toHaveProperty(getModelLockKey("claude-opus-5"));
    // A 403 stays a 403 to the caller; only "no such model" normalizes to 404.
    expect(write[getModelFailureKey("claude-fable-5")]).toMatchObject({
      clientErrorStatus: 403,
      unknownModelVerified: true,
    });
  });

  it("still passes an UNVERIFIED model_not_found through without locking (#2032)", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([{ id: "conn-1", provider: "claude", backoffLevel: 0 }]);

    await expect(markAccountUnavailable(
      "conn-1",
      404,
      "model_not_found: claude-typo",
      "claude",
      "claude-typo",
      null,
      { clientErrorStatus: 404, unknownModelVerified: false },
    )).resolves.toEqual({ shouldFallback: false, cooldownMs: 0 });

    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("writes independent alpha and beta lock pairs with the same exact expiry per pair", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([{ id: "conn-1", provider: "demo", backoffLevel: 0 }]);
    const alphaReset = NOW.getTime() + 60_000;

    await markAccountUnavailable("conn-1", 429, "alpha quota", "demo", ALPHA, alphaReset);
    await markAccountUnavailable("conn-1", 429, "beta quota", "demo", BETA, alphaReset);

    const alphaWrite = dbMocks.updateProviderConnection.mock.calls[0][1];
    const betaWrite = dbMocks.updateProviderConnection.mock.calls[1][1];
    expect(alphaWrite[getModelFailureKey(ALPHA)].until).toBe(alphaWrite[getModelLockKey(ALPHA)]);
    expect(alphaWrite[getModelFailureKey(ALPHA)]).toMatchObject({ status: 429, message: "alpha quota", resetsAt: new Date(alphaReset).toISOString() });
    expect(alphaWrite).not.toHaveProperty(getModelLockKey(BETA));
    expect(betaWrite[getModelFailureKey(BETA)].until).toBe(betaWrite[getModelLockKey(BETA)]);
    expect(betaWrite).not.toHaveProperty(getModelFailureKey(ALPHA));
  });

  it("selects only the requested model pair and gives account-wide state precedence", () => {
    const connection = {
      ...pair(ALPHA, { until: future(5), status: 429, message: "alpha only" }),
      ...pair(BETA, { until: future(10), status: 401, message: "beta only" }),
    };

    expect(getActiveModelFailure(connection, ALPHA)).toMatchObject({ until: future(5), status: 429, message: "alpha only" });
    expect(getActiveModelFailure(connection, BETA)).toMatchObject({ until: future(10), status: 401, message: "beta only" });

    Object.assign(connection, pair(null, { until: future(2), status: 402, message: "all accounts" }));
    expect(getActiveModelFailure(connection, ALPHA)).toMatchObject({
      lockKey: MODEL_LOCK_ALL,
      until: future(2),
      status: 402,
      message: "all accounts",
    });
  });

  it("returns metadata from the earliest selected lock rather than another model or connection", async () => {
    const early = {
      id: "early",
      provider: "demo",
      ...pair(ALPHA, { until: future(2), status: 429, message: "alpha early", clientErrorStatus: 404 }),
      ...pair(BETA, { until: future(1), status: 401, message: "beta earlier but unrelated" }),
    };
    const late = {
      id: "late",
      provider: "demo",
      ...pair(ALPHA, { until: future(4), status: 401, message: "alpha late" }),
    };
    dbMocks.getProviderConnections.mockResolvedValue([late, early]);

    await expect(getProviderCredentials("demo", null, ALPHA)).resolves.toMatchObject({
      allRateLimited: true,
      retryAfter: future(2),
      lastError: "alpha early",
      lastErrorCode: 429,
      clientErrorStatus: 404,
    });
  });

  it("keeps a strict preferred connection pinned when another account is available", async () => {
    const pinned = {
      id: "video-a",
      provider: "demo",
      ...pair(null, {
        until: future(5),
        status: 429,
        message: "video A is locked",
        clientErrorStatus: 404,
      }),
    };
    const available = {
      id: "video-b",
      provider: "demo",
      authType: "api_key",
      apiKey: "video-b-key",
      providerSpecificData: {},
    };
    dbMocks.getProviderConnections.mockResolvedValue([pinned, available]);

    await expect(getProviderCredentials(
      "demo",
      null,
      null,
      { preferredConnectionId: "video-a", strictPreferredConnection: true },
    )).resolves.toMatchObject({
      allRateLimited: true,
      retryAfter: future(5),
      lastError: "video A is locked",
      lastErrorCode: 429,
      clientErrorStatus: 404,
    });
  });

  it("does not borrow flat error state for a legacy lock without a matching pair", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([{
      id: "legacy",
      provider: "demo",
      [getModelLockKey(ALPHA)]: future(3),
      lastError: "beta secret reason",
      errorCode: 404,
    }]);

    await expect(getProviderCredentials("demo", null, ALPHA)).resolves.toMatchObject({
      allRateLimited: true,
      retryAfter: future(3),
      lastError: null,
      lastErrorCode: null,
      clientErrorStatus: null,
    });
  });

  it("stores a bounded, whitespace-sanitized reason with its selected pair", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([{ id: "conn-1", provider: "demo", backoffLevel: 0 }]);

    await markAccountUnavailable("conn-1", 429, "alpha quota\n\t reset after one minute", "demo", ALPHA);

    expect(dbMocks.updateProviderConnection.mock.calls[0][1][getModelFailureKey(ALPHA)].message)
      .toBe("alpha quota reset after one minute");
  });

  it("clears the successful and expired pairs while retaining another active pair", async () => {
    const connection = {
      id: "conn-1",
      testStatus: "unavailable",
      lastError: "legacy dashboard value",
      [getModelLockKey(ALPHA)]: future(5),
      [getModelFailureKey(ALPHA)]: { until: future(5), status: 429, message: "alpha" },
      [getModelLockKey(BETA)]: future(10),
      [getModelFailureKey(BETA)]: { until: future(10), status: 401, message: "beta" },
      [getModelLockKey("expired")]: past(1),
      [getModelFailureKey("expired")]: { until: past(1), status: 500, message: "expired" },
    };

    await clearAccountError("conn-1", connection, ALPHA);

    expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith("conn-1", expect.objectContaining({
      [getModelLockKey(ALPHA)]: null,
      [getModelFailureKey(ALPHA)]: null,
      [getModelLockKey("expired")]: null,
      [getModelFailureKey("expired")]: null,
    }));
    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).not.toHaveProperty(getModelLockKey(BETA));
    expect(update).not.toHaveProperty(getModelFailureKey(BETA));
  });

  it("clears lock metadata with every legacy clear-all lock update", () => {
    const update = buildClearModelLocksUpdate({
      ...pair(ALPHA, { until: future(5) }),
      ...pair(BETA, { until: future(10) }),
    });

    expect(update).toMatchObject({
      [getModelLockKey(ALPHA)]: null,
      [getModelFailureKey(ALPHA)]: null,
      [getModelLockKey(BETA)]: null,
      [getModelFailureKey(BETA)]: null,
    });
  });
});
