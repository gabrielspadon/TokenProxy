// A key today is unlimited: whoever holds it can spend the operator's whole
// provider quota, and the only lever is pausing it after the fact (#3371).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { exceededLimit, hasLimits, pickLimits } from "@/lib/db/repos/apiKeysRepo.js";
import { MIGRATIONS, latestVersion } from "@/lib/db/migrations/index.js";
import { TABLES, SCHEMA_VERSION, buildCreateTableSql } from "@/lib/db/schema.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-key-limits-"));
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
});

// Recorded the way saveRequestUsage records it: one usageHistory row per
// request, carrying the raw key it was authenticated with.
// The path POST /api/keys takes: create the key, then set its ceilings.
async function newKey(name, limits) {
  const created = await db.createApiKey(name, "machine-a");
  const stored = await db.updateApiKey(created.id, limits);
  return { ...created, ...stored };
}

function spend(key, promptTokens, completionTokens, cost) {
  adapter.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status)
     VALUES(?, 'test', 'test-model', ?, ?, ?, ?, 'ok')`,
    [new Date().toISOString(), key, promptTokens, completionTokens, cost],
  );
}

describe("the schema change is additive (#3371)", () => {
  it("the three ceilings are declared nullable, so an existing row keeps NULL", () => {
    const cols = TABLES.apiKeys.columns;
    expect(cols.maxPromptTokens).toBe("INTEGER");
    expect(cols.maxCompletionTokens).toBe("INTEGER");
    expect(cols.maxCostUsd).toBe("REAL");
    for (const def of [cols.maxPromptTokens, cols.maxCompletionTokens, cols.maxCostUsd]) {
      expect(def).not.toMatch(/NOT NULL|DEFAULT/i);
    }
  });

  it("the enforcement query has an index, so it is not a scan of an unpruned table", () => {
    expect(TABLES.usageHistory.indexes).toContain(
      "CREATE INDEX IF NOT EXISTS idx_uh_apikey ON usageHistory(apiKey)",
    );
  });

  it("SCHEMA_VERSION is stamped, which is what arms the pre-change backup", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("no versioned migration was added, so the chain is unchanged", () => {
    // Additive columns and indexes are syncSchemaFromTables' job; a migration
    // file is for the destructive changes it cannot do. The ceilings are in the
    // declarative schema, so the chain stays at its initial version.
    expect(latestVersion()).toBe(1);
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("the columns and the lookup index actually exist on a booted DB", () => {
    const cols = adapter.all("PRAGMA table_info(apiKeys)").map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["maxPromptTokens", "maxCompletionTokens", "maxCostUsd"]));
    const idx = adapter.all("PRAGMA index_list(usageHistory)").map((i) => i.name);
    expect(idx).toContain("idx_uh_apikey");
  });

  it("an install that already has the columns re-syncs without a failure", () => {
    const before = adapter.all("PRAGMA table_info(apiKeys)").length;
    adapter.exec(buildCreateTableSql("apiKeys", TABLES.apiKeys));
    for (const idx of TABLES.usageHistory.indexes) adapter.exec(idx);
    expect(adapter.all("PRAGMA table_info(apiKeys)").length).toBe(before);
  });
});

describe("a key with no ceiling behaves exactly as before", () => {
  it("creating without limits leaves all three null", async () => {
    const k = await db.createApiKey("no-limits", "machine-a");
    expect(k.maxPromptTokens).toBeNull();
    expect(k.maxCompletionTokens).toBeNull();
    expect(k.maxCostUsd).toBeNull();
    expect(hasLimits(k)).toBe(false);
  });

  it("it validates however much it has already spent", async () => {
    const k = await db.createApiKey("unlimited", "machine-a");
    spend(k.key, 10_000_000, 10_000_000, 9999);
    expect(await db.validateApiKey(k.key)).toBe(true);
  });
});

describe("a ceiling stops the key at request-auth time", () => {
  it("prompt tokens: under the ceiling passes, at or over it refuses", async () => {
    const k = await newKey("in", { maxPromptTokens: 1000 });
    spend(k.key, 900, 0, 0);
    expect(await db.validateApiKey(k.key)).toBe(true);
    spend(k.key, 100, 0, 0);
    expect(await db.validateApiKey(k.key)).toBe(false);
  });

  it("completion tokens are counted separately from prompt tokens", async () => {
    const k = await newKey("out", { maxCompletionTokens: 500 });
    spend(k.key, 100_000, 400, 0);
    expect(await db.validateApiKey(k.key)).toBe(true);
    spend(k.key, 0, 100, 0);
    expect(await db.validateApiKey(k.key)).toBe(false);
  });

  it("money: the USD ceiling refuses once the summed cost reaches it", async () => {
    const k = await newKey("budget", { maxCostUsd: 1.5 });
    spend(k.key, 10, 10, 1.25);
    expect(await db.validateApiKey(k.key)).toBe(true);
    spend(k.key, 10, 10, 0.3);
    expect(await db.validateApiKey(k.key)).toBe(false);
  });

  it("another key's spend does not count against this one", async () => {
    const mine = await newKey("mine", { maxCostUsd: 1 });
    const other = await db.createApiKey("other", "machine-a");
    spend(other.key, 999, 999, 100);
    expect(await db.validateApiKey(mine.key)).toBe(true);
  });

  it("getExceededLimit names which ceiling was hit", async () => {
    const k = await newKey("named", { maxCompletionTokens: 5 });
    spend(k.key, 0, 5, 0);
    expect(await db.getExceededLimit(k.key)).toBe("completionTokens");
  });

  it("raising the ceiling revives the key without reissuing it", async () => {
    const k = await newKey("raise", { maxPromptTokens: 100 });
    spend(k.key, 150, 0, 0);
    expect(await db.validateApiKey(k.key)).toBe(false);
    await db.updateApiKey(k.id, { maxPromptTokens: 1000 });
    expect(await db.validateApiKey(k.key)).toBe(true);
  });

  it("clearing the ceiling to null makes the key unlimited again", async () => {
    const k = await newKey("clear", { maxCostUsd: 0.5 });
    spend(k.key, 0, 0, 1);
    expect(await db.validateApiKey(k.key)).toBe(false);
    await db.updateApiKey(k.id, { maxCostUsd: null });
    expect(await db.validateApiKey(k.key)).toBe(true);
  });
});

describe("a fumbled ceiling does not become an arbitrary budget", () => {
  it("an unparseable or negative value stores as no ceiling", async () => {
    const k = await newKey("bad", {
      maxPromptTokens: "not-a-number",
      maxCompletionTokens: -5,
      maxCostUsd: Infinity,
    });
    expect(k.maxPromptTokens).toBeNull();
    expect(k.maxCompletionTokens).toBeNull();
    expect(k.maxCostUsd).toBeNull();
  });

  it("zero IS a real ceiling, which freezes the key without deleting it", async () => {
    const k = await newKey("frozen", { maxCostUsd: 0 });
    expect(k.maxCostUsd).toBe(0);
    expect(await db.validateApiKey(k.key)).toBe(false);
  });

  it("a token ceiling is stored as a whole number", async () => {
    const k = await newKey("floor", { maxPromptTokens: "1500.9" });
    expect(k.maxPromptTokens).toBe(1500);
  });
});

describe("the pure comparison", () => {
  const usage = { promptTokens: 10, completionTokens: 10, costUsd: 1 };

  it("reports null when every ceiling is absent", () => {
    expect(exceededLimit({}, usage)).toBeNull();
  });

  it("reports the first ceiling reached, and reaching it exactly counts", () => {
    expect(exceededLimit({ maxPromptTokens: 10 }, usage)).toBe("promptTokens");
    expect(exceededLimit({ maxPromptTokens: 11 }, usage)).toBeNull();
    expect(exceededLimit({ maxCostUsd: 1 }, usage)).toBe("costUsd");
  });
});

describe("spend is reported next to the ceiling", () => {
  it("getApiKeyUsage sums the key's own history", async () => {
    const k = await db.createApiKey("sum", "machine-a");
    spend(k.key, 5, 7, 0.25);
    spend(k.key, 5, 3, 0.75);
    expect(await db.getApiKeyUsage(k.key)).toEqual({
      promptTokens: 10, completionTokens: 10, costUsd: 1, requests: 2,
    });
  });

  it("a key that has never been used reports zeros rather than nothing", async () => {
    const k = await db.createApiKey("unused", "machine-a");
    expect(await db.getApiKeyUsage(k.key)).toEqual({
      promptTokens: 0, completionTokens: 0, costUsd: 0, requests: 0,
    });
  });

  it("getApiKeyUsageTotals answers for every key in one pass", async () => {
    const a = await db.createApiKey("a", "machine-a");
    const b = await db.createApiKey("b", "machine-a");
    spend(a.key, 1, 2, 0.1);
    spend(b.key, 3, 4, 0.2);
    const totals = await db.getApiKeyUsageTotals();
    expect(totals[a.key]).toMatchObject({ promptTokens: 1, completionTokens: 2, requests: 1 });
    expect(totals[b.key]).toMatchObject({ promptTokens: 3, completionTokens: 4, requests: 1 });
  });
});

describe("the API surface carries it without breaking older callers", () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

  it("POST accepts the three optional ceilings and reports them back", () => {
    const route = read("../../src/app/api/keys/route.js");
    expect(route).toContain("const limits = pickLimits(body);");
    expect(route).toContain("maxCostUsd: stored.maxCostUsd");
  });

  it("a body with no ceiling in it creates exactly the key it always did", () => {
    const route = read("../../src/app/api/keys/route.js");
    // The #2351 create path is untouched; the second write only happens when
    // the caller actually named a ceiling.
    expect(route).toContain("createApiKey(name, machineId, expiresAt)");
    expect(route).toContain("Object.keys(limits).length");
    expect(pickLimits({ name: "x" })).toEqual({});
  });

  it("GET pairs each key's ceilings with what it has already spent", () => {
    const route = read("../../src/app/api/keys/route.js");
    expect(route).toContain("getKeyUsageSnapshot");
    expect(route).toContain("usage: history?.totals[k.id] ?? null");
  });

  it("PUT sets each ceiling independently and leaves omitted ones alone", () => {
    const route = read("../../src/app/api/keys/[id]/route.js");
    expect(route).toContain("Object.assign(updateData, pickLimits(body));");
    expect(pickLimits({ maxCostUsd: 2 })).toEqual({ maxCostUsd: 2 });
    // An explicit null is a clear, which is not the same as omitting the field.
    expect(pickLimits({ maxPromptTokens: null })).toEqual({ maxPromptTokens: null });
  });
});
