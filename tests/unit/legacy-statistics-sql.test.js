import { beforeAll, describe, expect, it } from "vitest";

const { getAdapter } = await import("../../src/lib/db/driver.js");
const { getBoundedLegacySeries } = await import("../../src/app/api/usage/statistics/route.js");
let db;

beforeAll(async () => {
  db = await getAdapter();
  db.run(`INSERT INTO requestStats(id,timestamp,promptTokens,completionTokens,cachedTokens,cacheCreationTokens)
    VALUES(?,?,?,?,?,?)`, ["legacy-series-a", "2026-09-11T00:01:00.000Z", 12, 3, 2, 1]);
  db.run(`INSERT INTO requestStats(id,timestamp,promptTokens,completionTokens,cachedTokens,cacheCreationTokens)
    VALUES(?,?,?,?,?,?)`, ["legacy-series-b", "2026-09-11T00:04:00.000Z", 4, 1, 0, 0]);
  db.run(`INSERT INTO requestStats(id,timestamp,promptTokens,completionTokens,cachedTokens,cacheCreationTokens)
    VALUES(?,?,?,?,?,?)`, ["legacy-series-outside", "2026-09-12T00:00:00.000Z", 999, 999, 0, 0]);
});

describe("legacy statistics bounded SQL", () => {
  it("executes against SQLite, conserves token splits, and honors the exclusive end", async () => {
    const series = await getBoundedLegacySeries({
      startDate: "2026-09-11T00:00:00.000Z",
      endDate: "2026-09-11T23:59:59.999Z",
    }, 86400000);
    expect(series).toEqual([expect.objectContaining({
      requests: 2,
      totalTokens: 20,
      inputTokens: 13,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
      cacheHitRate: 2 / 15,
    })]);
  });
});
