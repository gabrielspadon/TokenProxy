import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";

let db;
afterEach(() => { vi.restoreAllMocks(); db?.close(); db = null; });
async function fixture() {
  const file = join(fs.mkdtempSync(join(tmpdir(), "tp-sqljs-integrity-")), "data.sqlite");
  db = await createSqlJsAdapter(file);
  db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parentId INTEGER REFERENCES parent(id));");
  db.run("INSERT INTO parent(id) VALUES(?)", [1]);
  return file;
}
function assertIntegrity() {
  expect(db.get("PRAGMA foreign_keys").foreign_keys).toBe(1);
  expect(() => db.run("INSERT INTO child(parentId) VALUES(?)", [999])).toThrow();
  db.run("INSERT INTO child(parentId) VALUES(?)", [1]);
  expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
}

it("keeps foreign-key enforcement after an explicit durable snapshot flush", async () => {
  await fixture();
  db.flush();
  assertIntegrity();
  db.flush();
  assertIntegrity();
});

it("keeps foreign-key enforcement after a background snapshot save", async () => {
  const file = await fixture();
  await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true), { timeout: 1000, interval: 20 });
  assertIntegrity();
});

it("restores runtime constraints even when snapshot publication fails", async () => {
  await fixture();
  const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("fixture disk failure"); });
  expect(() => db.flush()).toThrow("fixture disk failure");
  assertIntegrity();
  rename.mockRestore();
  db.flush();
  assertIntegrity();
});
