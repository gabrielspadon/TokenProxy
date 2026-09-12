import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";

let tempDir, dbPath;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqljs-persist-"));
  dbPath = path.join(tempDir, "data.sqlite");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("sqljs atomic persist", () => {
  it("writes the database file on close after writes", async () => {
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.run("CREATE TABLE t (v TEXT)");
    adapter.run("INSERT INTO t (v) VALUES (?)", ["hello"]);
    adapter.close();
    expect(fs.existsSync(dbPath)).toBe(true);
    const reopen = await createSqlJsAdapter(dbPath);
    expect(reopen.get("SELECT v FROM t").v).toBe("hello");
    reopen.close();
  });

  it("leaves no .tmp file behind after a successful persist", async () => {
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.exec("CREATE TABLE t (v INTEGER)");
    adapter.close();
    expect(fs.existsSync(dbPath + ".tmp")).toBe(false);
  });

  it("keeps the previous file intact when the persist write fails", async () => {
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.run("CREATE TABLE t (v TEXT)");
    adapter.run("INSERT INTO t (v) VALUES (?)", ["old"]);
    adapter.close();
    const oldBytes = fs.readFileSync(dbPath);

    // Inject the same EACCES as an unwritable filesystem. Permission bits do
    // not deny writes to uid 0 inside a user namespace, so chmod is not a
    // portable failure mechanism for this integration test.
    const next = await createSqlJsAdapter(dbPath);
    next.run("INSERT INTO t (v) VALUES (?)", ["new"]);
    const realOpenSync = fs.openSync.bind(fs);
    const openSync = vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
      if (file === dbPath + ".tmp") throw Object.assign(new Error("synthetic persist EACCES"), { code: "EACCES" });
      return realOpenSync(file, ...args);
    });
    try {
      expect(() => next.close()).toThrow(/EACCES/); // persist surfaces the failure, db stays in memory
    } finally {
      openSync.mockRestore();
    }

    expect(fs.readFileSync(dbPath).equals(oldBytes)).toBe(true);
  });

  it("removes a stale .tmp left by a crashed prior run", async () => {
    fs.writeFileSync(dbPath + ".tmp", "garbage");
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.exec("CREATE TABLE t (v INTEGER)");
    adapter.close();
    expect(fs.readFileSync(dbPath).length).toBeGreaterThan(0);
    expect(fs.existsSync(dbPath + ".tmp")).toBe(false);
  });

  it.runIf(process.platform !== "win32")("never follows a hostile snapshot symlink", async () => {
    const victim = path.join(tempDir, "victim");
    fs.writeFileSync(victim, "do-not-overwrite");
    fs.symlinkSync(victim, dbPath + ".tmp");
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.exec("CREATE TABLE t (v INTEGER)");
    expect(() => adapter.flush()).toThrow();
    expect(fs.readFileSync(victim, "utf8")).toBe("do-not-overwrite");
    expect(fs.lstatSync(dbPath + ".tmp").isSymbolicLink()).toBe(true);
  });

  it("publishes a critical transaction before returning without requiring close", async () => {
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.exec("CREATE TABLE t (v TEXT)");
    adapter.flush();

    const result = adapter.criticalTransaction(() => {
      adapter.run("INSERT INTO t (v) VALUES (?)", ["acknowledged"]);
      return 71;
    });

    expect(result).toBe(71);
    const concurrent = await createSqlJsAdapter(dbPath);
    expect(concurrent.get("SELECT v FROM t").v).toBe("acknowledged");
    concurrent.close();
    adapter.close();
  });

  it.each(["ENOSPC", "EIO"])("does not acknowledge or retain a critical write when publication fails with %s", async (code) => {
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.exec("CREATE TABLE t (v TEXT)");
    adapter.run("INSERT INTO t (v) VALUES (?)", ["published"]);
    adapter.flush();
    const before = fs.readFileSync(dbPath);
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation((target, ...args) => {
      if (typeof target === "number") throw Object.assign(new Error(`fixture ${code}`), { code });
      return Reflect.apply(fs.writeFileSync, fs, [target, ...args]);
    });
    try {
      expect(() => adapter.criticalTransaction(() => {
        adapter.run("INSERT INTO t (v) VALUES (?)", ["unacknowledged"]);
      })).toThrow(expect.objectContaining({ code }));
    } finally {
      write.mockRestore();
    }
    expect(adapter.all("SELECT v FROM t ORDER BY rowid")).toEqual([{ v: "published" }]);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(fs.existsSync(dbPath + ".tmp")).toBe(false);
    adapter.close();
  });

  it("waits for the durable file and directory syncs before acknowledging", async () => {
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.exec("CREATE TABLE t (v TEXT)");
    adapter.flush();
    const syncs = [];
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => { syncs.push(fd); });
    try {
      adapter.criticalTransaction(() => adapter.run("INSERT INTO t VALUES (?)", ["synced"]));
    } finally {
      fsync.mockRestore();
    }
    expect(syncs).toHaveLength(process.platform === "win32" ? 1 : 2);
    adapter.close();
  });

  it("does not acknowledge while an injected storage sync is delayed", async () => {
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.exec("CREATE TABLE t (v TEXT)");
    adapter.flush();
    let delayed = false;
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      if (!delayed) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        delayed = true;
      }
    });
    const started = performance.now();
    try {
      adapter.criticalTransaction(() => adapter.run("INSERT INTO t VALUES (?)", ["after-sync"]));
    } finally {
      fsync.mockRestore();
    }
    expect(delayed).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
    adapter.close();
  });

  it("rejects async and nested critical callbacks without mutating the database", async () => {
    const adapter = await createSqlJsAdapter(dbPath);
    adapter.exec("CREATE TABLE t (v TEXT)");
    adapter.flush();
    expect(() => adapter.criticalTransaction(async () => {})).toThrow(expect.objectContaining({ code: "CRITICAL_TRANSACTION_ASYNC" }));
    expect(() => adapter.transaction(() => adapter.criticalTransaction(() => {})))
      .toThrow(expect.objectContaining({ code: "CRITICAL_TRANSACTION_NESTED" }));
    expect(() => adapter.criticalTransaction(() => adapter.transaction(() => {})))
      .toThrow(expect.objectContaining({ code: "CRITICAL_TRANSACTION_NESTED" }));
    expect(adapter.get("SELECT COUNT(*) AS n FROM t").n).toBe(0);
    adapter.close();
  });
});
