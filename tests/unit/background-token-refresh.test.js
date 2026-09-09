/**
 * Background OAuth token-refresh scheduler.
 *
 * Covers pure selection (selectConnectionsNeedingRefresh) and a fake tick that
 * exercises checkAndRefreshToken dispatch + fail-open per connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

function conn(overrides = {}) {
  return {
    id: "c1",
    provider: "grok-cli",
    authType: "oauth",
    refreshToken: "rt-1",
    expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    isActive: true,
    ...overrides,
  };
}

describe("selectConnectionsNeedingRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("selects oauth grok-cli connection expiring in 10 minutes", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString() })],
      NOW
    );
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("c1");
  });

  it("skips connection expiring in 2 hours", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ expiresAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString() })],
      NOW
    );
    expect(list).toHaveLength(0);
  });

  it("never selects apikey connections", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [
        conn({ authType: "apikey", refreshToken: "rt" }),
        conn({ id: "c2", authType: "api_key", refreshToken: "rt" }),
      ],
      NOW
    );
    expect(list).toHaveLength(0);
  });

  it("skips oauth connection without refreshToken", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ refreshToken: null }), conn({ id: "c2", refreshToken: undefined })],
      NOW
    );
    expect(list).toHaveLength(0);
  });

  it("selects already-expired oauth connection", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ expiresAt: new Date(NOW - 60 * 1000).toISOString() })],
      NOW
    );
    expect(list).toHaveLength(1);
  });
});

describe("runBackgroundTokenRefreshTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls refresh only for due connections and swallows per-connection errors", async () => {
    const due = conn({
      id: "due",
      expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    });
    const notDue = conn({
      id: "not-due",
      expiresAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString(),
    });
    const apikey = conn({
      id: "key",
      authType: "apikey",
      expiresAt: new Date(NOW + 60 * 1000).toISOString(),
    });

    const refreshConnection = vi.fn(async (c) => {
      if (c.id === "due") throw new Error("boom");
      return c;
    });
    const loadConnections = vi.fn(async () => [due, notDue, apikey]);

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await expect(
      runBackgroundTokenRefreshTick({ loadConnections, refreshConnection })
    ).resolves.toBeUndefined();

    expect(loadConnections).toHaveBeenCalledTimes(1);
    expect(refreshConnection).toHaveBeenCalledTimes(1);
    expect(refreshConnection.mock.calls[0][0].id).toBe("due");
  });

  it("does not call refresh when nothing is due", async () => {
    const refreshConnection = vi.fn();
    const loadConnections = vi.fn(async () => [
      conn({
        expiresAt: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(),
      }),
    ]);

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await runBackgroundTokenRefreshTick({ loadConnections, refreshConnection });

    expect(refreshConnection).not.toHaveBeenCalled();
  });

  it("stays silent at INFO on a fully successful tick", async () => {
    const completed = conn({
      id: "connection-id-must-never-log-completed",
      provider: "codex",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refreshConnection = vi.fn(async () => {});

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [completed],
      refreshConnection,
    });

    // A tick that refreshed everything it meant to refresh is nominal: no
    // INFO narration, no warn. (The DEBUG summary is a separate test below.)
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("still names the provider on a failed refresh and never logs connection ids", async () => {
    const completed = conn({
      id: "connection-id-must-never-log-completed",
      provider: "codex",
    });
    const failed = conn({
      id: "connection-id-must-never-log-failed",
      provider: "grok-cli",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refreshConnection = vi.fn(async (connection) => {
      if (connection === failed) throw new Error("upstream rejected refresh");
    });

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [completed, failed],
      refreshConnection,
    });

    const output = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join(" ");
    expect(output).not.toContain(completed.id);
    expect(output).not.toContain(failed.id);
    expect(output).toContain("grok-cli");
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("keeps exactly one DEBUG tick summary under LOG_LEVEL=DEBUG", async () => {
    vi.stubEnv("LOG_LEVEL", "DEBUG");
    vi.resetModules();
    const completed = conn({ id: "c-ok", provider: "codex" });
    const failed = conn({ id: "c-fail", provider: "grok-cli" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refreshConnection = vi.fn(async (connection) => {
      if (connection === failed) throw new Error("upstream rejected refresh");
    });

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [completed, failed],
      refreshConnection,
    });

    const summaries = logSpy.mock.calls
      .flat()
      .filter((l) => l.includes("Connection refresh tick finished"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('"due":2');
    expect(summaries[0]).toContain('"refreshed":1');
    logSpy.mockRestore();
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("swallows top-level load errors", async () => {
    const refreshConnection = vi.fn();
    const loadConnections = vi.fn(async () => {
      throw new Error("db down");
    });

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await expect(
      runBackgroundTokenRefreshTick({ loadConnections, refreshConnection })
    ).resolves.toBeUndefined();
    expect(refreshConnection).not.toHaveBeenCalled();
  });
});

describe("start/stop guards", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    const mod = await import("../../src/sse/services/backgroundTokenRefresh.js");
    mod.stopBackgroundTokenRefresh();
    vi.resetModules();
  });

  it("honors DISABLE_BACKGROUND_TOKEN_REFRESH kill-switch", async () => {
    vi.stubEnv("DISABLE_BACKGROUND_TOKEN_REFRESH", "1");
    const { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    expect(startBackgroundTokenRefresh()).toBe(false);
    stopBackgroundTokenRefresh();
  });

  it("is idempotent: second start is no-op", async () => {
    vi.stubEnv("DISABLE_BACKGROUND_TOKEN_REFRESH", "");
    const { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const first = startBackgroundTokenRefresh({ intervalMs: 60_000 });
    const second = startBackgroundTokenRefresh({ intervalMs: 60_000 });
    expect(first).toBe(true);
    expect(second).toBe(false);
    stopBackgroundTokenRefresh();
  });
});
