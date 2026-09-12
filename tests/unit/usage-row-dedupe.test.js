// The usageHistory writer collapses a repeated save into the row it already
// holds. The match has to stay narrow: `timestamp` is an ISO string with
// millisecond resolution, so anything wider also swallows distinct requests
// that happen to share a millisecond.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVisibleTelemetryFixture } from "../fixtures/visible-telemetry.mjs";

// Public analytics and history deliberately exclude test-origin writes. The
// fixture verifies the origin of the rows each seeding call owns and
// re-identifies only those as a receipted synthetic import, so the public read
// under test stays the real one.
let visibleFixture;
async function withVisibleRows(produce) {
  visibleFixture ||= createVisibleTelemetryFixture(await (await import("@/lib/db/driver.js")).getAdapter(), "usage-row-dedupe");
  return visibleFixture(produce);
}

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-dedupe-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* windows keeps the sqlite file open */ }
});

const entry = (provider, extra = {}) => ({
  provider, model: "m", connectionId: "c1",
  tokens: { prompt_tokens: 10, completion_tokens: 5 },
  status: "ok", ...extra,
});

describe("usageHistory row identity", () => {
  it("keeps every request that shares a millisecond with another", async () => {
    const timestamp = new Date().toISOString();
    const N = 25;
    await withVisibleRows(() => Promise.all(Array.from({ length: N }, () =>
      db.saveRequestUsage(entry("same-ms", { timestamp, endpoint: "/v1/chat" })))));

    const rows = await db.getUsageHistory({ provider: "same-ms" });
    // Matching on the value tuple alone kept exactly one of these.
    expect(rows.length).toBe(N);

    const stats = await db.getUsageStats("24h");
    expect(stats.byProvider["same-ms"].requests).toBe(N);
    expect(stats.byProvider["same-ms"].promptTokens).toBe(N * 10);
  });

  it("keeps them when they carry no endpoint either", async () => {
    const timestamp = new Date().toISOString();
    await withVisibleRows(() => Promise.all([
      db.saveRequestUsage(entry("no-endpoint", { timestamp })),
      db.saveRequestUsage(entry("no-endpoint", { timestamp })),
    ]));
    expect((await db.getUsageHistory({ provider: "no-endpoint" })).length).toBe(2);
  });

  it("still completes a row that was written without its endpoint", async () => {
    const timestamp = new Date().toISOString();
    await withVisibleRows(async () => {
      await db.saveRequestUsage(entry("backfill", { timestamp, requestId: "exact-backfill-attempt" }));
      await db.saveRequestUsage(entry("backfill", { timestamp, requestId: "exact-backfill-attempt", endpoint: "/v1/messages" }));
    });

    const rows = await db.getUsageHistory({ provider: "backfill" });
    expect(rows.length).toBe(1);
    expect(rows[0].endpoint).toBe("/v1/messages");
  });

  it("does not fold a later request into an unrelated endpoint-less row", async () => {
    const timestamp = new Date().toISOString();
    await withVisibleRows(async () => {
      await db.saveRequestUsage(entry("distinct", { timestamp, model: "a" }));
      await db.saveRequestUsage(entry("distinct", { timestamp, model: "b", endpoint: "/v1/chat" }));
    });
    expect((await db.getUsageHistory({ provider: "distinct" })).length).toBe(2);
  });
});
