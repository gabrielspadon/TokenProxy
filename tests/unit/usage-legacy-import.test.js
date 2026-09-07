import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let adapter;
let usage;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-legacy-usage-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  usage = await import("@/lib/db/repos/usageRepo.js");
  const now = new Date();
  const timestamp = now.toISOString();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const provenance = { legacyImport: { contract: "nine-router-history-v1", sourceId: "test-source", apiKeyIdentity: "unavailable" } };
  for (const meta of [provenance, {}]) {
    adapter.run("INSERT INTO usageHistory(timestamp,provider,model,promptTokens,completionTokens,cost,meta) VALUES(?,?,?,?,?,?,?)",
      [timestamp, "provider", "model", 20, 5, 0.1, JSON.stringify(meta)]);
  }
  const values = { requests: 1, promptTokens: 20, completionTokens: 5, cost: 0.1, rawModel: "model", provider: "provider", apiKey: null };
  adapter.run("INSERT INTO usageDaily(dateKey,data) VALUES(?,?)", [dateKey, JSON.stringify({
    requests: 2, promptTokens: 40, completionTokens: 10, cost: 0.2,
    byProvider: { provider: { requests: 2, promptTokens: 40, completionTokens: 10, cost: 0.2 } },
    byApiKey: {
      "legacy-unavailable|model|provider": { ...values, legacyKeyUnavailable: true },
      "local-no-key|model|provider": values,
    },
  })]);
});

afterAll(() => {
  adapter?.close?.();
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("imported history with unavailable key identity", () => {
  for (const period of ["today", "24h", "7d", "30d", "60d", "all"]) {
    it(`reconciles totals without claiming anonymous access for ${period}`, async () => {
      const stats = await usage.getUsageStats(period);
      const keys = Object.values(stats.byApiKey);
      expect(keys).toHaveLength(2);
      expect(keys.find(row => row.apiKeyKey === "legacy-unavailable")).toMatchObject({
        keyName: "Legacy key unavailable", apiKeyMasked: null, requests: 1, promptTokens: 20, completionTokens: 5, cost: 0.1,
      });
      expect(keys.find(row => row.apiKeyKey === "local-no-key")).toMatchObject({ requests: 1, keyName: "Local (No API Key)" });
      expect(keys.reduce((sum, row) => sum + row.requests, 0)).toBe(stats.totalRequests);
      expect(keys.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(stats.totalCost);
    });
  }
});
