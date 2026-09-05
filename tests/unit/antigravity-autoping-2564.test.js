// #2564 — auto-ping for Antigravity. Claude and Codex each meter ONE named
// window, so the scheduler resolved `quotaKey` as a literal. Antigravity meters
// per MODEL: its quota map is keyed by the registry model id, one window per
// quota family, so the scheduler had to learn a provider whose quota key is a
// SET and pick the window that actually governs the schedule.
//
// @/shared/constants/config is deliberately NOT mocked here. The opt-in gate and
// the quota keys are only worth asserting against the config the app ships; a
// mocked config would assert the fixture instead.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
  toConnectionProxyOptions: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("open-sse/services/usage/claude.js", () => ({ getClaudeUsage: vi.fn() }));
vi.mock("open-sse/services/usage/codex.js", () => ({ getCodexUsage: vi.fn() }));
vi.mock("open-sse/services/usage/google.js", () => ({ getAntigravityUsage: vi.fn() }));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: vi.fn() }));

const AG_CONNECTION = {
  id: "ag-1",
  provider: "antigravity",
  authType: "oauth",
  accessToken: "token",
  projectId: "project-1",
};

// Gemini rolls first, so it is the window that decides when this connection is
// next pinged; the Claude/GPT family rolls three days later.
const GEMINI_RESET = "2026-01-01T11:59:00.000Z";
const GPT_RESET = "2026-01-04T11:59:00.000Z";

function quotaFixture() {
  return {
    "gemini-3.5-flash-extra-low": { used: 0, total: 1000, resetAt: GEMINI_RESET },
    "gpt-oss-120b-medium": { used: 0, total: 1000, resetAt: GPT_RESET },
    // The map carries every metered model, not just the two the pinger pokes.
    "claude-sonnet-4-6": { used: 0, total: 1000, resetAt: "2026-01-02T11:59:00.000Z" },
  };
}

function okResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status, text: vi.fn().mockResolvedValue("") };
}

describe("resolveQuotaEntry (#2564)", () => {
  let resolveQuotaEntry;
  let QUOTA_AUTOPING_CONFIG;

  beforeEach(async () => {
    vi.resetModules();
    delete global.__quotaAutoPing;
    ({ resolveQuotaEntry } = await import("../../src/shared/services/quotaAutoPing.js"));
    ({ QUOTA_AUTOPING_CONFIG } = await import("../../src/shared/constants/config.js"));
  });

  it("resolves Claude's single named window exactly as a plain lookup did", () => {
    const quotas = { "session (5h)": { resetAt: GEMINI_RESET }, other: { resetAt: GPT_RESET } };
    const config = QUOTA_AUTOPING_CONFIG.providers.claude;
    expect(config.quotaKey).toBe("session (5h)");
    expect(resolveQuotaEntry(quotas, config)).toBe(quotas["session (5h)"]);
  });

  it("resolves Codex's single named window exactly as a plain lookup did", () => {
    const quotas = { session: { resetAt: GPT_RESET }, "session (5h)": { resetAt: GEMINI_RESET } };
    const config = QUOTA_AUTOPING_CONFIG.providers.codex;
    expect(config.quotaKey).toBe("session");
    expect(resolveQuotaEntry(quotas, config)).toBe(quotas.session);
  });

  it("keeps the single-key path free of the reset filter", () => {
    // A named window present but without a resetAt used to come back and let
    // pingConnection bail on `!resetAt`. Filtering it out here would change how
    // the two existing providers resolve theirs.
    const quotas = { session: { used: 3 } };
    expect(resolveQuotaEntry(quotas, { quotaKey: "session" })).toBe(quotas.session);
    expect(resolveQuotaEntry(quotas, { quotaKey: "absent" })).toBeUndefined();
    expect(resolveQuotaEntry(undefined, { quotaKey: "session" })).toBeUndefined();
  });

  it("picks the earliest reset when the quota key is a set of models", () => {
    const quotas = quotaFixture();
    const config = QUOTA_AUTOPING_CONFIG.providers.antigravity;
    expect(resolveQuotaEntry(quotas, config)).toBe(quotas["gemini-3.5-flash-extra-low"]);
  });

  it("does not let the order of the key list decide the governing window", () => {
    const quotas = quotaFixture();
    const keys = [...QUOTA_AUTOPING_CONFIG.providers.antigravity.quotaKeys].reverse();
    expect(resolveQuotaEntry(quotas, { quotaKeys: keys })).toBe(quotas["gemini-3.5-flash-extra-low"]);
  });

  it("skips a family whose reset is missing or unparseable", () => {
    const quotas = {
      a: { resetAt: "not a date" },
      b: { used: 0 },
      c: { resetAt: GPT_RESET },
    };
    expect(resolveQuotaEntry(quotas, { quotaKeys: ["a", "b", "c"] })).toBe(quotas.c);
  });

  it("resolves nothing when no family in the set has a reset", () => {
    expect(resolveQuotaEntry({ a: { used: 0 } }, { quotaKeys: ["a", "b"] })).toBeNull();
  });
});

describe("Antigravity auto-ping is opt-in (#2564)", () => {
  let runQuotaAutoPingTick;
  let QUOTA_AUTOPING_CONFIG;
  let getAntigravityUsage;
  let getUsageForProvider;
  let deps;
  let state;
  let execute;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete global.__quotaAutoPing;

    ({ getAntigravityUsage } = await import("open-sse/services/usage/google.js"));
    ({ getUsageForProvider } = await import("open-sse/services/usage.js"));
    ({ runQuotaAutoPingTick } = await import("../../src/shared/services/quotaAutoPing.js"));
    ({ QUOTA_AUTOPING_CONFIG } = await import("../../src/shared/constants/config.js"));

    getAntigravityUsage.mockResolvedValue({ quotas: quotaFixture() });
    execute = vi.fn().mockResolvedValue({ response: okResponse() });

    deps = {
      getSettings: vi.fn().mockResolvedValue({}),
      getProviderConnections: vi.fn().mockResolvedValue([AG_CONNECTION]),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      proxyAwareFetch: vi.fn(),
      getExecutor: vi.fn(() => ({ execute })),
      getUsageForProvider,
    };
    state = { running: false, resetCache: {}, failureCache: {} };
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  it("ships a settings-gated entry rather than an always-on one", () => {
    const config = QUOTA_AUTOPING_CONFIG.providers.antigravity;
    expect(config.settingsKey).toBe("antigravityAutoPing");
    expect(config.quotaKeys.length).toBeGreaterThan(1);
    expect(config.quotaKey).toBeUndefined();
  });

  it("makes no request at all when the setting is absent", async () => {
    await runQuotaAutoPingTick(deps, state);
    expect(getAntigravityUsage).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("makes no request when the connection is listed but switched off", async () => {
    deps.getSettings.mockResolvedValue({ antigravityAutoPing: { connections: { "ag-1": false } } });
    await runQuotaAutoPingTick(deps, state);
    expect(getAntigravityUsage).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("pokes one model per quota family once the connection is switched on", async () => {
    deps.getSettings.mockResolvedValue({ antigravityAutoPing: { connections: { "ag-1": true } } });
    await runQuotaAutoPingTick(deps, state);

    expect(getAntigravityUsage).toHaveBeenCalledWith("token", undefined, expect.anything(), expect.anything());
    expect(execute).toHaveBeenCalledTimes(QUOTA_AUTOPING_CONFIG.providers.antigravity.quotaKeys.length);
    expect(execute.mock.calls.map(([call]) => call.model)).toEqual(
      QUOTA_AUTOPING_CONFIG.providers.antigravity.quotaKeys,
    );
  });

  it("records the governing reset, not whichever family came first in the map", async () => {
    deps.getSettings.mockResolvedValue({ antigravityAutoPing: { connections: { "ag-1": true } } });
    await runQuotaAutoPingTick(deps, state);

    expect(deps.updateProviderConnection).toHaveBeenCalledWith(
      "ag-1",
      expect.objectContaining({ lastPingedResetAt: GEMINI_RESET }),
    );
  });
});

describe("an account-level refusal does not walk the other families (#2564)", () => {
  let runQuotaAutoPingTick;
  let isAntigravityAccountRefusal;
  let getAntigravityUsage;
  let getUsageForProvider;
  let deps;
  let state;
  let execute;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete global.__quotaAutoPing;

    ({ getAntigravityUsage } = await import("open-sse/services/usage/google.js"));
    ({ getUsageForProvider } = await import("open-sse/services/usage.js"));
    ({ runQuotaAutoPingTick, isAntigravityAccountRefusal } =
      await import("../../src/shared/services/quotaAutoPing.js"));

    getAntigravityUsage.mockResolvedValue({ quotas: quotaFixture() });
    execute = vi.fn();

    deps = {
      getSettings: vi.fn().mockResolvedValue({ antigravityAutoPing: { connections: { "ag-1": true } } }),
      getProviderConnections: vi.fn().mockResolvedValue([AG_CONNECTION]),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      proxyAwareFetch: vi.fn(),
      getExecutor: vi.fn(() => ({ execute })),
      getUsageForProvider,
    };
    state = { running: false, resetCache: {}, failureCache: {} };
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  it("classifies auth and rate-limit statuses as being about the account", () => {
    for (const status of [401, 403, 429]) {
      expect(isAntigravityAccountRefusal(status), String(status)).toBe(true);
    }
    for (const status of [200, 400, 404, 500, 503]) {
      expect(isAntigravityAccountRefusal(status), String(status)).toBe(false);
    }
  });

  it.each([401, 403, 429])("stops after a %i instead of poking the next family", async (status) => {
    execute.mockResolvedValue({ response: okResponse(status) });
    await runQuotaAutoPingTick(deps, state);

    // Poking on would fire a second request at an endpoint already refusing this
    // account, which is exactly what a limiter is asking us not to do.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.failureCache["antigravity:ag-1"]).toBeTruthy();
  });

  it("keeps going past a model-scoped or transport failure", async () => {
    // Google's transport commonly answers 5xx after processing the request, and a
    // 404 is about that one model — neither says anything about the other family.
    execute
      .mockResolvedValueOnce({ response: okResponse(503) })
      .mockResolvedValueOnce({ response: okResponse(200) });
    await runQuotaAutoPingTick(deps, state);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith(
      "ag-1",
      expect.objectContaining({ lastPingedResetAt: GEMINI_RESET }),
    );
  });

  it("counts the tick as failed when every family threw", async () => {
    execute.mockRejectedValue(new Error("socket hang up"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.failureCache["antigravity:ag-1"]).toBeTruthy();
  });
});
