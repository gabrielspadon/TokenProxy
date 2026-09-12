import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// These fixtures exercise production display behavior. Origin-boundary tests
// separately prove that actual test processes cannot self-label their rows.
vi.mock('../../src/lib/db/telemetryOrigin.js', () => ({ processTelemetryOrigin: () => 'production' }));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

const LEGACY_A = "sk-legacy-collision-alpha-0001";
const LEGACY_B = "sk-legacy-collision-beta-0002";
const REGISTERED = "sk-machine-reg123-crc";
const DELETED = "sk-machine-del123-crc";
const REGISTERED_ID = "registered-usage-key";
const DELETED_ID = "deleted-usage-key";

async function save(apiKey, provider = "identity-provider", model = "identity-model") {
  await db.saveRequestUsage({
    provider,
    model,
    connectionId: "identity-connection",
    apiKey,
    endpoint: "/v1/chat/completions",
    status: "ok",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    timestamp: new Date().toISOString(),
  });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-usage-key-identity-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const driver = await import("@/lib/db/driver.js");
  adapter = await driver.getAdapter();

  const createdAt = new Date().toISOString();
  adapter.run(
    "INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)",
    [REGISTERED_ID, REGISTERED, "Registered key", "machine", 1, createdAt],
  );
  adapter.run(
    "INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)",
    [DELETED_ID, DELETED, "Deleted key", "machine", 1, createdAt],
  );

  await save(LEGACY_A);
  await save(LEGACY_B);
  await save(REGISTERED);
  await save(REGISTERED, "identity-provider-2", "identity-model-2");
  await save(DELETED);
  await save(null);
  adapter.run("DELETE FROM apiKeys WHERE id = ?", [DELETED_ID]);
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("usage API-key identities (#2919)", () => {
  for (const period of ["today", "24h", "7d", "30d", "60d", "all"]) {
    it(`keeps every key identity and model/provider pair distinct for ${period}`, async () => {
      const [first, second] = await Promise.all([db.getUsageStats(period), db.getUsageStats(period)]);
      const rows = Object.values(first.byApiKey);

      expect(Object.keys(first.byApiKey).sort()).toEqual(Object.keys(second.byApiKey).sort());
      const salts = adapter.all("SELECT value FROM _meta WHERE key = ?", ["usageApiKeyIdentitySalt.v1"]);
      expect(salts).toHaveLength(1);
      expect(salts[0].value).toMatch(/^[0-9a-f]{64}$/);
      expect(rows).toHaveLength(6);
      expect(rows.filter((row) => row.apiKeyKey === `id:${REGISTERED_ID}`)).toHaveLength(2);
      expect(rows.some((row) => row.apiKeyKey === "local-no-key")).toBe(true);

      const unknownRows = rows.filter((row) => row.apiKeyMasked === "sk-legac***");
      expect(unknownRows).toHaveLength(2);
      expect(new Set(unknownRows.map((row) => row.apiKeyKey)).size).toBe(2);
      expect(new Set(unknownRows.map((row) => row.keyName)).size).toBe(2);
      expect(unknownRows.every((row) => /^sk-legac\*\*\* \([0-9a-f]{8}\)$/.test(row.keyName))).toBe(true);
      expect(unknownRows.every((row) => /^hmac:[0-9a-f]{32}$/.test(row.apiKeyKey))).toBe(true);

      const deleted = rows.find((row) => row.apiKeyMasked === "sk-***-del123***");
      expect(deleted?.apiKeyKey).toMatch(/^hmac:[0-9a-f]{32}$/);
      expect(rows.find((row) => row.apiKeyKey === `id:${REGISTERED_ID}`)?.keyName).toBe("Registered key");

      const serialized = JSON.stringify({ stats: first, history: await db.getUsageHistory() });
      for (const rawKey of [LEGACY_A, LEGACY_B, REGISTERED, DELETED]) {
        expect(serialized).not.toContain(rawKey);
      }
    });
  }
});
