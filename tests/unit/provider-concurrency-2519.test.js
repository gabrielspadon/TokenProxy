// Keep any accidental DB touch away from the user's real ~/.tokenproxy store.
process.env.DATA_DIR = process.env.DATA_DIR || "/tmp/tokenproxy-test-data-2519";

import { beforeEach, describe, expect, it, vi } from "vitest";

const active = vi.hoisted(() => ({ rows: [], recent: [], error: null }));

vi.mock("@/lib/usageDb.js", () => ({
  getActiveRequests: async () => {
    if (active.error) throw active.error;
    return {
      activeRequests: active.rows,
      recentRequests: active.recent,
      errorProvider: "",
      activeSessions: [],
    };
  },
  trackPendingRequest: () => {},
  appendRequestLog: async () => {},
  saveRequestDetail: async () => {},
  statsEmitter: { emit: () => {}, on: () => {}, off: () => {} },
  saveRequestUsage: async () => {},
  getUsageHistory: async () => [],
  getUsageStats: async () => ({}),
  getUsageStatsInRange: async () => ({}),
  getChartData: async () => ({}),
  getRecentLogs: async () => [],
  getRequestDetails: async () => [],
  getRequestDetailById: async () => null,
}));

const { providerConcurrencyOverflow } = await import("@/sse/handlers/chat.js");

const settingsWith = (values) => ({ providerStrategies: { kiro: values } });

// #2519 asks for a concurrency setting for models used in combo mode. The cap
// is per provider because providerStrategies is the settings bag this handler
// already reads, and refusing with 503 is what combo/account fallback already
// treats as "try the next candidate".
describe("per-provider concurrency cap (#2519)", () => {
  beforeEach(() => {
    active.rows = [];
    active.recent = [];
    active.error = null;
  });

  it("is off when nothing is configured", async () => {
    expect(await providerConcurrencyOverflow("kiro", {})).toBeNull();
  });

  it("allows a request below the cap", async () => {
    active.rows = [{ provider: "kiro", model: "claude-sonnet-5", count: 1 }];
    expect(await providerConcurrencyOverflow("kiro", settingsWith({ maxConcurrent: 2 }))).toBeNull();
  });

  it("refuses once the provider is at the cap, and says the numbers", async () => {
    active.rows = [
      { provider: "kiro", model: "claude-sonnet-5", count: 1 },
      { provider: "kiro", model: "gpt-5.6-sol", count: 1 },
    ];
    const refusal = await providerConcurrencyOverflow("kiro", settingsWith({ maxConcurrent: 2 }));
    expect(refusal).toContain("2/2");
  });

  it("counts only the provider being routed to", async () => {
    active.rows = [
      { provider: "codex", model: "gpt-5.6-sol", count: 9 },
      { provider: "kiro", model: "claude-sonnet-5", count: 1 },
    ];
    expect(await providerConcurrencyOverflow("kiro", settingsWith({ maxConcurrent: 2 }))).toBeNull();
  });

  it("does not count completed requests from the snapshot", async () => {
    active.rows = [{ provider: "kiro", model: "claude-sonnet-5", count: 1 }];
    active.recent = [{ provider: "kiro", model: "claude-sonnet-5", count: 9 }];
    expect(await providerConcurrencyOverflow("kiro", settingsWith({ maxConcurrent: 2 }))).toBeNull();
  });

  it("fails open when the active snapshot cannot be read", async () => {
    active.error = new Error("snapshot unavailable");
    expect(await providerConcurrencyOverflow("kiro", settingsWith({ maxConcurrent: 2 }))).toBeNull();
  });

  // A malformed setting must not throttle routing to zero.
  it.each([0, -1, 1.5, "2", null, true])("fails open on %p", async (maxConcurrent) => {
    active.rows = [{ provider: "kiro", model: "claude-sonnet-5", count: 99 }];
    expect(await providerConcurrencyOverflow("kiro", settingsWith({ maxConcurrent }))).toBeNull();
  });
});
