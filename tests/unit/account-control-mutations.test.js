import { beforeEach, describe, expect, it, vi } from "vitest";
import * as repo from "@/lib/db/repos/connectionsRepo.js";
import { captureAccountControls } from "@/shared/utils/accountControls.js";
import { GET, PUT } from "@/app/api/providers/[id]/route.js";

const race = vi.hoisted(() => ({ afterRead: null }));
vi.mock("@/models", async () => {
  const actual = await import("@/lib/db/repos/connectionsRepo.js");
  return {
    ...actual,
    getProxyPoolById: vi.fn(),
    getProviderConnectionById: async id => {
      const connection = await actual.getProviderConnectionById(id);
      const afterRead = race.afterRead;
      race.afterRead = null;
      if (afterRead) await afterRead();
      return connection;
    },
  };
});
vi.mock("@/sse/services/tokenRefresh", () => ({ releaseConnection: vi.fn() }));
vi.mock("@/lib/antigravityVerification", () => ({ invalidateAntigravityVerificationConnection: vi.fn() }));

let account;
const params = id => ({ params: Promise.resolve({ id }) });
const put = (id, body) => PUT(new Request(`http://localhost/api/providers/${id}`, {
  method: "PUT", body: JSON.stringify(body),
}), params(id));
const get = async id => (await (await GET(null, params(id))).json()).connection;

beforeEach(async () => {
  race.afterRead = null;
  for (const connection of await repo.getProviderConnections()) await repo.deleteProviderConnection(connection.id);
  account = await repo.createProviderConnection({
    provider: "claude", authType: "oauth", name: "Synthetic controls",
    accessToken: "synthetic-old", providerSpecificData: { quota: { remaining: 60 }, identity: "synthetic" },
  });
  account = await repo.getProviderConnectionById(account.id);
});

describe("account policy mutations", () => {
  it("refuses invalid JSON and non-object bodies without writing account data", async () => {
    const before = await repo.getProviderConnectionById(account.id);
    for (const body of ["{", "null", "[]", "true", '"text"']) {
      const response = await PUT(new Request(`http://localhost/api/providers/${account.id}`, {
        method: "PUT", body,
      }), params(account.id));
      expect(response.status).toBe(400);
      expect(await repo.getProviderConnectionById(account.id)).toEqual(before);
    }
  });

  it("preserves a refresh between route read and write for guarded and legacy narrow updates", async () => {
    for (const guarded of [true, false]) {
      const expectedControls = captureAccountControls(await get(account.id));
      const refreshed = { quota: { remaining: guarded ? 35 : 20 }, identity: "synthetic-new" };
      race.afterRead = () => repo.updateProviderConnection(account.id, { accessToken: "synthetic-refreshed", providerSpecificData: refreshed });
      const response = await put(account.id, {
        isActive: !expectedControls.isActive, quotaPauseThresholds: { weekly: 15, disabled: 0 },
        ...(guarded ? { expectedControls } : {}),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).connection.accessToken).toBeUndefined();
      expect(await repo.getProviderConnectionById(account.id)).toMatchObject({
        accessToken: "synthetic-refreshed", providerSpecificData: refreshed,
        isActive: !expectedControls.isActive, quotaPauseThresholds: { weekly: 15 },
      });
      expect((await get(account.id)).quotaPauseThresholds).toEqual({ weekly: 15 });
    }
  });

  it("rejects a concurrent change to each policy field atomically, even after the route read", async () => {
    for (const concurrent of [{ isActive: false }, { quotaPauseThresholds: { weekly: 30 } }, { priority: 99 }]) {
      await repo.updateProviderConnection(account.id, { isActive: true, quotaPauseThresholds: {}, priority: 1 });
      if (concurrent.priority) await repo.createProviderConnection({ provider: "claude", authType: "oauth", name: "Synthetic peer", priority: 2 });
      const expectedControls = captureAccountControls(await get(account.id));
      let concurrentState;
      race.afterRead = async () => {
        await repo.updateProviderConnection(account.id, concurrent);
        concurrentState = await repo.getProviderConnectionById(account.id);
      };
      const response = await put(account.id, { isActive: false, quotaPauseThresholds: { weekly: 10 }, expectedControls });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Account controls changed; reload before saving", code: "CONTROL_CONFLICT" });
      expect(await repo.getProviderConnectionById(account.id)).toEqual(concurrentState);
    }
  });

  it("rejects malformed snapshots, invalid controls, and unrelated writes without changing the row", async () => {
    const expectedControls = captureAccountControls(await get(account.id));
    const before = await repo.getProviderConnectionById(account.id);
    for (const invalid of [
      { expectedControls: null }, { expectedControls: {} },
      { expectedControls: { ...expectedControls, accessToken: "synthetic" } },
      { isActive: "false" }, { priority: 0 }, { priority: 1.5 },
      { quotaPauseThresholds: [] }, { quotaPauseThresholds: { weekly: "20" } },
      { quotaPauseThresholds: { weekly: 101 } }, { quotaPauseThresholds: { weekly: -1 } },
      { providerSpecificData: { quota: null } }, { apiKey: "synthetic" },
    ]) {
      expect((await put(account.id, { isActive: false, expectedControls, ...invalid })).status).toBe(400);
      expect(await repo.getProviderConnectionById(account.id)).toEqual(before);
    }
  });

  it("compares threshold maps independently of insertion order and returns persisted priority after renumbering", async () => {
    await repo.updateProviderConnection(account.id, { quotaPauseThresholds: { weekly: 25, daily: 5 } });
    const expectedControls = captureAccountControls(await get(account.id));
    expectedControls.quotaPauseThresholds = { weekly: 25, daily: 5 };
    const response = await put(account.id, { priority: 50, expectedControls });
    expect(response.status).toBe(200);
    const saved = (await response.json()).connection;
    expect(saved.priority).toBe(1);
    expect(captureAccountControls(saved)).toEqual(captureAccountControls(await get(account.id)));
  });

  it("does not resurrect a connection deleted between the route read and transaction", async () => {
    const expectedControls = captureAccountControls(await get(account.id));
    race.afterRead = () => repo.deleteProviderConnection(account.id);
    expect((await put(account.id, { isActive: false, expectedControls })).status).toBe(404);
    expect(await repo.getProviderConnectionById(account.id)).toBeNull();
  });
});
