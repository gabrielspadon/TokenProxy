// Revoking a set of API keys took one request and one confirm dialog per key
// (#2120). The single-key route is unchanged; this is the same operation over a
// set, so a leaked batch goes in one action instead of N.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
vi.mock("@/lib/admin/guard.js", () => ({ requireAdmin: vi.fn(async () => null) }));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let repo;
let route;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-bulk-keys-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
  route = await import("@/app/api/keys/route.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function seed(n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push((await db.createApiKey(`k${i}-${Math.random()}`, "machine-a")).id);
  return ids;
}

beforeEach(async () => {
  for (const k of await db.getApiKeys()) await db.deleteApiKey(k.id);
});

function del(qs) {
  return route.DELETE(new Request(`http://localhost/api/keys?${qs}`, { method: "DELETE" }));
}

describe("bulk API key revocation (#2120)", () => {
  it("removes every named key in one call and leaves the rest alone", async () => {
    const [a, b, c] = await seed(3);
    const res = await del(`id=${a}&id=${b}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ requested: 2, deleted: 2 });
    expect((await db.getApiKeys()).map((k) => k.id)).toEqual([c]);
  });

  it("an id that is already gone is a partial success, not a failure", async () => {
    const [a] = await seed(1);
    const res = await del(`id=${a}&id=does-not-exist`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ requested: 2, deleted: 1 });
    expect(await db.getApiKeys()).toEqual([]);
  });

  it("no id at all is rejected rather than treated as delete-everything", async () => {
    await seed(2);
    const res = await del("");
    expect(res.status).toBe(400);
    expect((await db.getApiKeys()).length).toBe(2);
  });

  it("the repo call is one statement and dedupes a repeated id", async () => {
    const [a] = await seed(1);
    expect(await repo.deleteApiKeys([a, a])).toBe(1);
    expect(await repo.deleteApiKeys([])).toBe(0);
    expect(await repo.deleteApiKeys(null)).toBe(0);
    // A non-string id must not reach the statement as a bound parameter.
    expect(await repo.deleteApiKeys([{}, 7, ""])).toBe(0);
  });

  it("the single-key route still works on its own", async () => {
    const [a] = await seed(1);
    const single = await import("@/app/api/keys/[id]/route.js");
    const res = await single.DELETE(new Request("http://localhost/api/keys/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: a }),
    });
    expect(res.status).toBe(200);
    expect(await db.getApiKeys()).toEqual([]);
  });
});
