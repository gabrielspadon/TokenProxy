import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("@/shared/constants/config", () => ({
  QUOTA_AUTOPING_CONFIG: {
    tickIntervalMs: 60000,
    pingLeadMs: 5000,
    refreshAheadMs: 300000,
    failureCooldownMs: 900000,
    providers: {
      claude: {
        settingsKey: "claudeAutoPing",
        quotaKey: "session (5h)",
        pingModel: "claude-haiku-4-5-20251001",
        pingText: "hi",
        pingMaxTokens: 1,
      },
      codex: {
        settingsKey: "codexAutoPing",
        quotaKey: "session",
        pingWhenResetAtSlides: true,
        resetAtDriftMs: 30000,
        minPingIntervalMs: 600000,
        skipWhenBlockingQuotaExhausted: true,
        pingModel: "gpt-5.5",
        pingText: "hi",
        pingInstructions: "Reply with OK.",
        pingReasoningEffort: "none",
      },
    },
  },
}));

// Spread the real module: the scheduler reaches the provider registry now, and
// the registry imports constants from here, so a mock that returns one key
// fails the whole file with "No <name> export" rather than one assertion.
vi.mock("open-sse/providers/shared.js", async (importOriginal) => ({
  ...(await importOriginal()),
  CLAUDE_CLI_SPOOF_HEADERS: { "anthropic-version": "2023-06-01" },
}));

vi.mock("open-sse/services/usage/shared.js", () => ({
  U: () => ({ baseUrl: "https://chatgpt.com/backend-api/codex/responses" }),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/services/usage/claude.js", () => ({
  getClaudeUsage: vi.fn(),
}));

vi.mock("open-sse/services/usage/codex.js", () => ({
  getCodexUsage: vi.fn(),
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(),
}));

// The poller already SEES an exhausted window before any real request does, and
// then threw that away: it returned without recording anything, so selection
// kept offering the account until a live request 429'd (#1125). Writing the
// provider's own reset onto `rateLimitedUntil` — the field
// accountFallback.filterAvailableAccounts already filters on — makes fallback
// skip it exactly the way it skips a paused account, and it lapses by itself.
describe("exhausted quota is recorded, not just detected (#1125)", () => {
  let runQuotaAutoPingTick;
  let getUsageForProvider;
  let deps;
  let state;
  let getCodexUsage;
  let getClaudeUsage;

  const CODEX_CONN = { id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" };
  const codexOnly = async ({ provider }) => (provider === "codex" ? [CODEX_CONN] : []);

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete global.__quotaAutoPing;

    ({ getCodexUsage } = await import("open-sse/services/usage/codex.js"));
    ({ getClaudeUsage } = await import("open-sse/services/usage/claude.js"));
    ({ runQuotaAutoPingTick } = await import("../../src/shared/services/quotaAutoPing.js"));
    ({ getUsageForProvider } = await import("open-sse/services/usage.js"));

    deps = {
      getSettings: vi.fn().mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } }),
      getProviderConnections: vi.fn(codexOnly),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      proxyAwareFetch: vi.fn().mockResolvedValue({ ok: true }),
      getExecutor: vi.fn(() => ({ execute: vi.fn() })),
      getUsageForProvider,
    };
    state = { running: false, resetCache: {}, failureCache: {} };
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  it("marks the account rate limited until the reported reset", async () => {
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled(); // still no ping
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", {
      rateLimitedUntil: "2026-01-01T17:01:00.000Z",
    });
  });

  it("what it writes is what account fallback filters on", async () => {
    const { filterAvailableAccounts } = await import("open-sse/services/accountFallback.js");
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    const [, patch] = deps.updateProviderConnection.mock.calls[0];
    expect(filterAvailableAccounts([{ ...CODEX_CONN, ...patch }])).toEqual([]);
  });

  it("does not rewrite a mark it already made", async () => {
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ ...CODEX_CONN, rateLimitedUntil: "2026-01-01T17:01:00.000Z" }] : []
    ));
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("leaves an account with quota left untouched", async () => {
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.updateProviderConnection).not.toHaveBeenCalledWith(
      "codex-1",
      expect.objectContaining({ rateLimitedUntil: expect.anything() }),
    );
  });

  it("a write failure never breaks the tick", async () => {
    deps.updateProviderConnection.mockRejectedValue(new Error("db locked"));
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await expect(runQuotaAutoPingTick(deps, state)).resolves.toBeUndefined();
    expect(getClaudeUsage).not.toHaveBeenCalled();
  });
});
