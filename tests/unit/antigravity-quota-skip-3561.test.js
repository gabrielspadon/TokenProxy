// #3561 — skip an exhausted Antigravity account/model pair before the upstream retry.
//
// The load-bearing claim is that the quota key is DERIVABLE from what the usage
// layer already parses, so no live account is needed to know it: Antigravity's
// quota buckets are keyed by the registry model id, which is the same string
// routing carries as `model`. The first block proves that end to end through the
// real registry and the real snapshot deriver; the rest pins the skip's edges.
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn(),
  updateProviderStrategyProxyPoolSnapshotIfBound: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({ kind: "usable" })),
  toConnectionProxyOptions: vi.fn(() => ({})),
}));
vi.mock("@/shared/constants/providers.js", async (importOriginal) => ({
  ...(await importOriginal()),
  FREE_PROVIDERS: {},
  FREE_TIER_PROVIDERS: {},
  NO_AUTH_PROVIDER_IDS: new Set(),
  isNoAuthProvider: () => false,
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/services/quotaGuard.js", () => ({
  evaluateQuota: vi.fn(async connection => ({ paused: false, snapshot: connection.lastQuotaSnapshot || null })),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

const {
  getActiveModelFailure,
  getEarliestModelLockUntil,
  getExhaustedQuotaWindow,
  getModelLockKey,
  isModelLockActive,
} = await import("../../open-sse/services/accountFallback.js");
const { deriveQuotaSnapshot } = await import("../../src/shared/utils/quotaPause.js");
const { default: antigravityRegistry } = await import("../../open-sse/providers/registry/antigravity.js");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

const NOW = new Date("2026-08-31T12:00:00.000Z");
const future = (min) => new Date(NOW.getTime() + min * 60_000).toISOString();
const past = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();

// A real Antigravity model id, read from the registry rather than typed in, so a
// rename in the registry fails this test instead of silently decoupling it.
const MODEL = antigravityRegistry.models.find((m) => m.id === "gemini-3.7-flash-high").id;
const OTHER_MODEL = antigravityRegistry.models.find((m) => m.id === "claude-sonnet-4-6").id;

// The exact shape getAntigravityUsage emits (open-sse/services/usage/google.js):
// quotas keyed by the upstream model key, carrying remainingPercentage + resetAt.
function antigravityUsage(entries) {
  return {
    plan: "Google AI Pro",
    quotas: Object.fromEntries(entries.map(([key, remainingPercentage, resetAt]) => [
      key,
      { used: 1000, total: 1000, remainingPercentage, resetAt, unlimited: false },
    ])),
  };
}

function antigravityConnection(id, usage, extra = {}) {
  return {
    id,
    provider: "antigravity",
    authType: "oauth",
    accessToken: `${id}-token`,
    providerSpecificData: {},
    lastQuotaSnapshot: usage ? deriveQuotaSnapshot("antigravity", usage) : undefined,
    ...extra,
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

describe("the quota key is derivable without a live account", () => {
  it("carries the registry model id from the usage payload into the snapshot key", () => {
    const snapshot = deriveQuotaSnapshot("antigravity", antigravityUsage([[MODEL, 0, future(45)]]));
    expect(snapshot.windows.map((w) => w.key)).toEqual([MODEL]);
    // Same string the router already passes as `model` for ag/<id>.
    expect(antigravityRegistry.models.some((m) => m.id === snapshot.windows[0].key)).toBe(true);
  });
});

describe("getExhaustedQuotaWindow", () => {
  it("reports the exhausted pair with the upstream reset time", () => {
    const conn = antigravityConnection("a", antigravityUsage([[MODEL, 0, future(45)]]));
    expect(getExhaustedQuotaWindow(conn, MODEL)).toEqual({ key: MODEL, until: future(45) });
  });

  it("stays silent for another model on the same account", () => {
    const conn = antigravityConnection("a", antigravityUsage([
      [MODEL, 0, future(45)],
      [OTHER_MODEL, 60, future(45)],
    ]));
    expect(getExhaustedQuotaWindow(conn, OTHER_MODEL)).toBeNull();
  });

  it("stays silent once the reset time has passed", () => {
    const conn = antigravityConnection("a", antigravityUsage([[MODEL, 0, past(1)]]));
    expect(getExhaustedQuotaWindow(conn, MODEL)).toBeNull();
  });

  it("stays silent at 0% with no reset time, the shape a model with no quotaInfo takes", () => {
    const conn = antigravityConnection("a", antigravityUsage([[MODEL, 0, null]]));
    expect(getExhaustedQuotaWindow(conn, MODEL)).toBeNull();
  });

  it("stays silent on an unlimited window", () => {
    const conn = antigravityConnection("a", null);
    conn.lastQuotaSnapshot = { windows: [{ key: MODEL, remainingPercentage: 0, resetAt: future(45), unlimited: true }] };
    expect(getExhaustedQuotaWindow(conn, MODEL)).toBeNull();
  });

  it("stays silent for a provider whose quota windows are not model-keyed", () => {
    const conn = antigravityConnection("a", antigravityUsage([[MODEL, 0, future(45)]]), { provider: "claude" });
    expect(getExhaustedQuotaWindow(conn, MODEL)).toBeNull();
  });

  it("fails open with no snapshot, a malformed snapshot, or no model", () => {
    expect(getExhaustedQuotaWindow(antigravityConnection("a", null), MODEL)).toBeNull();
    expect(getExhaustedQuotaWindow({ provider: "antigravity", lastQuotaSnapshot: { windows: "x" } }, MODEL)).toBeNull();
    expect(getExhaustedQuotaWindow(antigravityConnection("a", antigravityUsage([[MODEL, 0, future(45)]])), null)).toBeNull();
    expect(getExhaustedQuotaWindow(null, MODEL)).toBeNull();
  });
});

describe("selection reads the exhausted pair as unavailable", () => {
  it("skips only the exhausted model and answers with its reset time", () => {
    const conn = antigravityConnection("a", antigravityUsage([
      [MODEL, 0, future(45)],
      [OTHER_MODEL, 40, future(45)],
    ]));
    expect(isModelLockActive(conn, MODEL)).toBe(true);
    expect(isModelLockActive(conn, OTHER_MODEL)).toBe(false);
    expect(getActiveModelFailure(conn, MODEL)).toMatchObject({
      lockKey: getModelLockKey(MODEL),
      until: future(45),
      status: 429,
      resetsAt: future(45),
    });
    expect(getEarliestModelLockUntil(conn, MODEL)).toBe(future(45));
    // No email or other account identity leaks into the client-facing reason.
    expect(getActiveModelFailure(conn, MODEL).message).toBe(`Quota exhausted for ${MODEL}`);
  });

  it("lets a standing timed lock keep precedence over the quota reading", () => {
    const conn = antigravityConnection("a", antigravityUsage([[MODEL, 0, future(45)]]), {
      [getModelLockKey(MODEL)]: future(5),
    });
    expect(getActiveModelFailure(conn, MODEL).until).toBe(future(5));
  });

  it("routes past the exhausted account to one that still has the model", async () => {
    const exhausted = antigravityConnection("out", antigravityUsage([[MODEL, 0, future(45)]]));
    const healthy = antigravityConnection("ok", antigravityUsage([[MODEL, 80, future(45)]]));
    dbMocks.getProviderConnections.mockResolvedValue([exhausted, healthy]);

    await expect(getProviderCredentials("antigravity", null, MODEL))
      .resolves.toMatchObject({ connectionId: "ok" });
  });

  it("still serves the exhausted account for a model it has quota for", async () => {
    const conn = antigravityConnection("out", antigravityUsage([
      [MODEL, 0, future(45)],
      [OTHER_MODEL, 80, future(45)],
    ]));
    dbMocks.getProviderConnections.mockResolvedValue([conn]);

    await expect(getProviderCredentials("antigravity", null, OTHER_MODEL))
      .resolves.toMatchObject({ connectionId: "out" });
  });

  it("reports retry timing from the earliest cached reset when every account is out", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      antigravityConnection("late", antigravityUsage([[MODEL, 0, future(90)]])),
      antigravityConnection("early", antigravityUsage([[MODEL, 0, future(30)]])),
    ]);

    await expect(getProviderCredentials("antigravity", null, MODEL)).resolves.toMatchObject({
      allRateLimited: true,
      retryAfter: future(30),
      lastErrorCode: 429,
    });
  });
});
