// 今天要看一下昨天、前天的统计情况就无法筛选了 — the Usage page offers only fixed
// trailing windows (today/24h/7d/30d/60d/all), so yesterday alone, or the day
// before, cannot be selected (#3442).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { resolveDayRange } from "@/lib/db/repos/usageRepo.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-usage-range-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  adapter.run("DELETE FROM usageHistory");
  adapter.run("DELETE FROM usageDaily");
});

const dateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d;
}

// The shape saveRequestUsage rolls up into: one usageDaily row per local day,
// plus the history rows the same write produces.
function recordDay(day, { requests, promptTokens, completionTokens, cost }) {
  adapter.run(
    `INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`,
    [dateKey(day), JSON.stringify({
      promptTokens, completionTokens, cachedTokens: 0, cost,
      byProvider: { openai: { requests, promptTokens, completionTokens, cachedTokens: 0, cost } },
      byModel: { "gpt|openai": { requests, promptTokens, completionTokens, cachedTokens: 0, cost, rawModel: "gpt", provider: "openai" } },
      byAccount: {}, byApiKey: {}, byEndpoint: {},
    })],
  );
  for (let index = 0; index < requests; index++) adapter.run(
    `INSERT INTO usageHistory(timestamp, provider, model, endpoint, promptTokens, completionTokens, cost, status, tokens)
     VALUES(?, 'openai', 'gpt', '/v1/chat/completions', ?, ?, ?, 'ok', '{}')`,
    [day.toISOString(), promptTokens / requests, completionTokens / requests, cost / requests],
  );
}

describe("the range is parsed before it is trusted", () => {
  it("no startDate means no range, so the period keeps deciding", () => {
    expect(resolveDayRange(null)).toBeNull();
    expect(resolveDayRange({})).toBeNull();
    expect(resolveDayRange({ endDate: "2026-08-30" })).toBeNull();
  });

  it("an unparseable date is not a range", () => {
    expect(resolveDayRange({ startDate: "yesterday please" })).toBeNull();
  });

  it("a backwards range is refused rather than silently swapped", () => {
    expect(resolveDayRange({ startDate: "2026-08-30", endDate: "2026-08-01" })).toBeNull();
  });

  it("one day is a range covering that whole local day", () => {
    const win = resolveDayRange({ startDate: "2026-08-30" });
    expect(win.startKey).toBe("2026-08-30");
    expect(win.endKey).toBe("2026-08-30");
    expect(new Date(win.startIso).getHours()).toBe(0);
    expect(new Date(win.endIso).getHours()).toBe(23);
  });

  it("a missing endDate means the single start day, not from-then-to-now", () => {
    expect(resolveDayRange({ startDate: "2026-08-01" }).endKey).toBe("2026-08-01");
  });

  it("both ends are inclusive", () => {
    const win = resolveDayRange({ startDate: "2026-08-01", endDate: "2026-08-03" });
    expect(win.startKey).toBe("2026-08-01");
    expect(win.endKey).toBe("2026-08-03");
  });
});

describe("yesterday alone can be selected (#3442)", () => {
  beforeEach(() => {
    recordDay(daysAgo(2), { requests: 2, promptTokens: 200, completionTokens: 20, cost: 2 });
    recordDay(daysAgo(1), { requests: 1, promptTokens: 100, completionTokens: 10, cost: 1 });
    recordDay(daysAgo(0), { requests: 4, promptTokens: 400, completionTokens: 40, cost: 4 });
  });

  it("the totals are yesterday's only, excluding today and the day before", async () => {
    const y = dateKey(daysAgo(1));
    const stats = await db.getUsageStatsInRange("7d", { startDate: y, endDate: y });
    expect(stats.totalRequests).toBe(1);
    expect(stats.totalPromptTokens).toBe(100);
    expect(stats.totalCompletionTokens).toBe(10);
    expect(stats.totalCost).toBe(1);
  });

  it("the day before yesterday is separately selectable", async () => {
    const d = dateKey(daysAgo(2));
    const stats = await db.getUsageStatsInRange("7d", { startDate: d, endDate: d });
    expect(stats.totalRequests).toBe(2);
    expect(stats.totalPromptTokens).toBe(200);
  });

  it("a two-day range sums both days and still excludes today", async () => {
    const stats = await db.getUsageStatsInRange("7d", {
      startDate: dateKey(daysAgo(2)),
      endDate: dateKey(daysAgo(1)),
    });
    expect(stats.totalRequests).toBe(3);
    expect(stats.totalCost).toBe(3);
  });

  it("the range wins over the period, including over today and 24h", async () => {
    const y = dateKey(daysAgo(1));
    for (const period of ["today", "24h", "30d", "all"]) {
      const stats = await db.getUsageStatsInRange(period, { startDate: y, endDate: y });
      expect(stats.totalRequests).toBe(1);
    }
  });

  it("recentRequests is scoped to the range too, not left showing today", async () => {
    const y = dateKey(daysAgo(1));
    const stats = await db.getUsageStatsInRange("7d", { startDate: y, endDate: y });
    for (const r of stats.recentRequests) {
      expect(r.timestamp.slice(0, 10)).toBe(y);
    }
  });

  it("no range at all leaves every period exactly as it was", async () => {
    const all = await db.getUsageStats("all");
    expect(all.totalRequests).toBe(7);
    expect(all.totalCost).toBe(7);
  });

  it("a range with no traffic in it reports zero rather than falling back", async () => {
    const stats = await db.getUsageStatsInRange("all", { startDate: "2001-01-01", endDate: "2001-01-02" });
    expect(stats.totalRequests).toBe(0);
    expect(stats.totalCost).toBe(0);
  });
});

describe("the chart follows the same range", () => {
  beforeEach(() => {
    recordDay(daysAgo(2), { requests: 2, promptTokens: 200, completionTokens: 20, cost: 2 });
    recordDay(daysAgo(1), { requests: 1, promptTokens: 100, completionTokens: 10, cost: 1 });
    recordDay(daysAgo(0), { requests: 4, promptTokens: 400, completionTokens: 40, cost: 4 });
  });

  it("one bucket per day across the range, and only across the range", async () => {
    const data = await db.getChartData("7d", {
      startDate: dateKey(daysAgo(2)),
      endDate: dateKey(daysAgo(1)),
    });
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ tokens: 220, cost: 2 });
    expect(data[1]).toMatchObject({ tokens: 110, cost: 1 });
  });

  it("a day with no traffic is plotted as zero rather than dropped", async () => {
    const data = await db.getChartData("7d", {
      startDate: "2001-01-01",
      endDate: "2001-01-03",
    });
    expect(data).toHaveLength(3);
    expect(data.every((b) => b.tokens === 0 && b.cost === 0)).toBe(true);
  });

  it("a long range is grouped rather than returning a point per day forever", async () => {
    const data = await db.getChartData("7d", { startDate: "2001-01-01", endDate: "2003-01-01" });
    expect(data.length).toBeLessThanOrEqual(120);
    expect(data.length).toBeGreaterThan(0);
  });

  it("no range leaves the fixed periods untouched", async () => {
    expect(await db.getChartData("7d")).toHaveLength(7);
    expect(await db.getChartData("30d")).toHaveLength(30);
  });
});

describe("the range reaches the endpoints the page calls", () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

  it("the stats endpoint reads startDate/endDate and passes them through", () => {
    const route = read("../../src/app/api/usage/stats/route.js");
    expect(route).toContain('searchParams.get("startDate")');
    expect(route).toContain("getUsageStatsInRange(period, range)");
  });

  it("the chart endpoint does the same", () => {
    const route = read("../../src/app/api/usage/chart/route.js");
    expect(route).toContain('searchParams.get("startDate")');
    expect(route).toContain("getChartData(period, range)");
  });

  it("the live SSE stream is deliberately left on periods only", () => {
    // It exists to push live changes, and a historical range does not change.
    const route = read("../../src/app/api/usage/stream/route.js");
    expect(route).not.toContain('searchParams.get("startDate")');
    expect(route).toContain("getUsageStats(period)");
  });

  it("a request without startDate still reaches the old code path", () => {
    const route = read("../../src/app/api/usage/stats/route.js");
    expect(route).toContain("if (!startDate) return null;");
    // getUsageStats keeps its one-argument whole-period form, so nothing that
    // never heard of a range has to change.
    const repo = read("../../src/lib/db/repos/usageRepo.js");
    expect(repo).toContain('getUsageStats(period = "all")');
    expect(repo).toContain("return getUsageStatsInRange(period, null);");
  });
});
