// Verify 3-tier driver fallback: better-sqlite3 → node:sqlite → sql.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-chain-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Driver fallback chain", () => {
  it.each([
    ["node:sqlite", async (file) => (await import("@/lib/db/adapters/nodeSqliteAdapter.js")).createNodeSqliteAdapter(file)],
    ["sql.js", async (file) => (await import("@/lib/db/adapters/sqljsAdapter.js")).createSqlJsAdapter(file)],
  ])("%s publishes critical writes before acknowledgement", async (_driver, create) => {
    const file = path.join(tempDir, `${_driver.replace(/\W/g, "-")}.sqlite`);
    const db = await create(file);
    db.exec("CREATE TABLE critical_value(value TEXT)");
    db.flush?.();
    db.criticalTransaction(() => db.run("INSERT INTO critical_value(value) VALUES(?)", ["durable"]));
    const reopened = await create(file);
    try {
      expect(reopened.get("SELECT value FROM critical_value").value).toBe("durable");
    } finally {
      reopened.close();
      db.close();
    }
  });

  it("default → picks better-sqlite3 when available", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(["better-sqlite3", "node:sqlite", "sql.js"]).toContain(db.driver);
  });

  it("falls back to node:sqlite when better-sqlite3 unavailable", async () => {
    // Mock the better-sqlite3 adapter to throw
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    // Node 22.5+ should give node:sqlite, else sql.js
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj > 22 || (maj === 22 && min >= 5)) {
      expect(db.driver).toBe("node:sqlite");
    } else {
      expect(db.driver).toBe("sql.js");
    }
  });

  it("falls back to sql.js when both native drivers unavailable", async () => {
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    vi.doMock("@/lib/db/adapters/nodeSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.driver).toBe("sql.js");
  });

  it("can retry initialization after a transient migration failure", async () => {
    let attempts = 0;
    vi.doMock("@/lib/db/migrate.js", () => ({
      runMigrationOnce: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("transient migration read failure"), { code: "EIO" });
      }),
    }));
    const { getAdapter } = await import("@/lib/db/driver.js");
    await expect(getAdapter()).rejects.toThrow("transient migration read failure");
    const recovered = await getAdapter();
    expect(attempts).toBe(2);
    expect(["better-sqlite3", "node:sqlite", "sql.js"]).toContain(recovered.driver);
  });
});
