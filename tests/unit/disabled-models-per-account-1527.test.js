// Issue #1527 — disabled models were keyed by provider alias alone, so a set
// saved on one account applied to every account of that provider. The key is
// now `alias` (provider-wide, unchanged) or `alias::connectionId` (per account).
//
// The migration risk is the whole point of these tests: re-keying orphans every
// set an install has already saved, and a model silently becoming ENABLED again
// is worse than the missing feature. So a connection with no key of its own
// inherits the provider-wide one, and a connection-scoped write never touches
// the provider-wide key other connections still read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

const CONN_A = "conn-aaaa-1111";
const CONN_B = "conn-bbbb-2222";

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-disabled-1527-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(async () => {
  // An operator Enable retains an explicit empty override. A fresh-install
  // fixture requires absent keys, so clear only this isolated test database.
  const { getAdapter } = await import('@/lib/db/driver.js');
  const adapter = await getAdapter();
  adapter.run('DELETE FROM kv WHERE scope = ?', ['disabledModels']);
  const { invalidateDisabledModelsCache } = await import('@/lib/db/repos/disabledModelsRepo.js');
  invalidateDisabledModelsCache();
});

describe("disabled models are per account (#1527)", () => {
  it("an install with only provider-scoped entries still sees them", async () => {
    await db.disableModels("openai", ["gpt-4o-mini"]); // written before this change

    expect(await db.getDisabledByProvider("openai")).toEqual(["gpt-4o-mini"]);
    // Every account inherits it: nothing silently re-enables.
    expect(await db.getDisabledByProvider("openai", CONN_A)).toEqual(["gpt-4o-mini"]);
    expect(await db.getDisabledByProvider("openai", CONN_B)).toEqual(["gpt-4o-mini"]);
  });

  it("a connection with no entries of its own inherits rather than seeing nothing", async () => {
    await db.disableModels("openai", ["legacy-model"]);
    await db.disableModels("openai", ["only-on-a"], CONN_A);

    expect(await db.getDisabledByProvider("openai", CONN_B))
      .toEqual(["legacy-model"]);
  });

  it("a connection-scoped write does not disturb another connection", async () => {
    await db.disableModels("openai", ["shared-off"]);
    await db.disableModels("openai", ["a-only"], CONN_A);

    expect((await db.getDisabledByProvider("openai", CONN_A)).sort())
      .toEqual(["a-only", "shared-off"]); // seeded from what it was inheriting
    expect(await db.getDisabledByProvider("openai", CONN_B)).toEqual(["shared-off"]);
    expect(await db.getDisabledByProvider("openai")).toEqual(["shared-off"]);
  });

  it("re-enabling on one connection leaves the provider-wide set alone", async () => {
    await db.disableModels("openai", ["shared-off"]);
    await db.enableModels("openai", ["shared-off"], CONN_A);

    expect(await db.getDisabledByProvider("openai", CONN_A)).toEqual([]);
    expect(await db.getDisabledByProvider("openai", CONN_B)).toEqual(["shared-off"]);
    expect(await db.getDisabledByProvider("openai")).toEqual(["shared-off"]);
  });

  it("clearing a connection's last entry does not fall back and re-disable it", async () => {
    await db.disableModels("openai", ["shared-off"]);
    await db.enableModels("openai", [], CONN_A); // "enable everything on this account"

    expect(await db.getDisabledByProvider("openai", CONN_A)).toEqual([]);
    expect(await db.getDisabledByProvider("openai", CONN_B)).toEqual(["shared-off"]);
  });

  it("keeps the two accounts independent as each is edited", async () => {
    await db.disableModels("openai", ["a1"], CONN_A);
    await db.disableModels("openai", ["b1", "b2"], CONN_B);
    await db.enableModels("openai", ["b1"], CONN_B);

    expect(await db.getDisabledByProvider("openai", CONN_A)).toEqual(["a1"]);
    expect(await db.getDisabledByProvider("openai", CONN_B)).toEqual(["b2"]);
    expect(await db.getDisabledByProvider("openai")).toEqual([]);
  });

  it("provider-wide writes still behave exactly as before", async () => {
    await db.disableModels("openai", ["m1", "m2"]);
    expect((await db.getDisabledByProvider("openai")).sort()).toEqual(["m1", "m2"]);
    await db.enableModels("openai", ["m1"]);
    expect(await db.getDisabledByProvider("openai")).toEqual(["m2"]);
    await db.enableModels("openai", []);
    expect(await db.getDisabledByProvider("openai")).toEqual([]);
  });

  it("leaves the whole-map read that /v1/models uses keyed by alias", async () => {
    await db.disableModels("openai", ["shared-off"]);
    await db.disableModels("openai", ["a-only"], CONN_A);

    const all = await db.getDisabledModels();
    // Legacy consumers index by alias; the per-connection key sits beside it and
    // is ignored by them rather than shadowing the provider-wide list.
    expect(all.openai).toEqual(["shared-off"]);
    expect(all[`openai::${CONN_A}`].sort()).toEqual(["a-only", "shared-off"]);
  });
});
