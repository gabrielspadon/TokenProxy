import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-usage-chart-all-"));
process.env.DATA_DIR = TEMP_DATA_DIR;

const { getAdapter } = await import("../../src/lib/db/driver.js");
const { getChartData } = await import("../../src/lib/db/repos/usageRepo.js");
const { GET } = await import("../../src/app/api/usage/chart/route.js");

let db;

const insertDay = (dateKey, promptTokens, completionTokens, cost) =>
  db.run("INSERT INTO usageHistory(timestamp,promptTokens,completionTokens,cost,dataOrigin) VALUES(?,?,?,?, 'production')", [
    new Date(`${dateKey}T12:00:00`).toISOString(), promptTokens, completionTokens, cost,
  ]);

beforeAll(async () => {
  db = await getAdapter();
});

beforeEach(() => {
  db.run("DELETE FROM usageHistory");
});

describe("all-time usage charts (#2415)", () => {
  it("returns every lifetime day chronologically with a year-bearing label", async () => {
    insertDay("2024-01-01", 10, 1, 0.1);
    insertDay("2025-01-01", 20, 2, 0.2);
    insertDay("2026-01-01", 30, 3, 0.3);

    const chart = await getChartData("all");

    expect(chart.map(({ tokens, cost }) => ({ tokens, cost }))).toEqual([
      { tokens: 11, cost: 0.1 },
      { tokens: 22, cost: 0.2 },
      { tokens: 33, cost: 0.3 },
    ]);
    expect(chart.map(({ label }) => label)).toEqual(expect.arrayContaining([
      expect.stringContaining("2024"),
      expect.stringContaining("2025"),
      expect.stringContaining("2026"),
    ]));
  });

  it("serves all-time chart data from the chart API", async () => {
    insertDay("2024-01-01", 10, 1, 0.1);

    const response = await GET(new Request("http://localhost/api/usage/chart?period=all"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ tokens: 11, cost: 0.1 }),
    ]);
  });

  it("bounds long histories while preserving every bucket's totals", async () => {
    const start = Date.UTC(2020, 0, 1);
    for (let day = 0; day < 121; day += 1) {
      insertDay(new Date(start + day * 86400000).toISOString().slice(0, 10), 1, 0, 0);
    }

    const chart = await getChartData("all");

    expect(chart.length).toBeLessThanOrEqual(120);
    expect(chart.reduce((sum, point) => sum + point.tokens, 0)).toBe(121);
  });
});
