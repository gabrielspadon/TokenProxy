// getUsageStats aggregates daily byApiKey buckets whose stored keys embed the
// RAW API key (`${apiKey}|${model}|${provider}`, usageRepo aggregateEntryToDay).
// The 7d/30d/60d/all periods used to re-emit that raw key as the object key of
// stats.byApiKey, leaking it through /api/usage/stats. The 24h path already
// keyed by apiKeyMasked; every period must now do the same.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// These fixtures exercise production display behavior. Origin-boundary tests
// separately prove that actual test processes cannot self-label their rows.
vi.mock('../../src/lib/db/telemetryOrigin.js', () => ({ processTelemetryOrigin: () => 'production' }));

let tempDir;
let db;

const RAW_KEY = "sk-ant-raw-leak-canary-0123456789abcdef";

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-maskedkey-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.saveRequestUsage({
    provider: "openai",
    model: "gpt-x",
    connectionId: "c1",
    apiKey: RAW_KEY,
    endpoint: "/v1/chat",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

afterAll(() => {
  try {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* windows keeps the sqlite file open */
  }
});

describe("usage stats byApiKey masking", () => {
  for (const period of ["7d", "30d", "60d", "all"]) {
    it(`emits no raw API key in byApiKey keys for period ${period}`, async () => {
      const stats = await db.getUsageStats(period);
      const serialized = JSON.stringify({
        keys: Object.keys(stats.byApiKey),
        values: Object.values(stats.byApiKey),
      });
      expect(serialized).not.toContain(RAW_KEY);
      expect(serialized).not.toContain("sk-ant-raw");
      const entry = Object.values(stats.byApiKey).find((k) => k.apiKeyMasked);
      expect(entry).toBeDefined();
      expect(
        Object.keys(stats.byApiKey).some(
          (k) => k.startsWith(RAW_KEY.slice(0, 8)) && k.includes(RAW_KEY),
        ),
      ).toBe(false);
    });
  }
});
