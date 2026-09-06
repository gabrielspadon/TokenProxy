import { beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/dashboardGuard", () => ({
  hasValidCliToken: vi.fn(async request => request.headers.get("x-operator") === "yes"),
  isLocalRequest: request => request.headers.get("x-peer") !== "remote",
}));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: vi.fn(async () => false) }));
vi.mock("@/lib/auth/clientApiKey", () => ({ resolveClientApiKey: vi.fn(async request => ({ valid: request.headers.has("x-inference") })) }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "fixture-machine") }));
import { initDb } from "@/lib/db/index.js";
import { getAdapter } from "@/lib/db/driver.js";
import { createApiKey, getApiKeyById } from "@/lib/db/repos/apiKeysRepo.js";
import * as list from "@/app/api/keys/route.js";
import * as detail from "@/app/api/keys/[id]/route.js";
import { GET as devices } from "@/app/api/keys/devices/route.js";
import { POST as reveal } from "@/app/api/keys/[id]/reveal/route.js";
import { publicApiKey } from "@/lib/admin/publicApiKey.js";
import { updateApiKey } from "@/lib/db/repos/apiKeysRepo.js";
import { reserveBudget, markBudgetDispatched, markBudgetUncertain } from "@/lib/db/repos/budgetRepo.js";
import { keyBudgetState } from "../../src/app/dashboard/keys/budget.js";

let db, key;
const request = (path = "/api/keys", method = "GET", body, headers = { "x-operator": "yes" }) => new Request(`http://localhost${path}`, {
  method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
});
const context = () => ({ params: Promise.resolve({ id: key.id }) });
beforeAll(async () => { await initDb(); db = await getAdapter(); });
beforeEach(async () => { db.run("DELETE FROM apiKeys"); key = await createApiKey("Fixture key", "fixture-machine"); });

it("redacts stored secrets from list, detail, update and device responses", async () => {
  for (const response of [await list.GET(request()), await detail.GET(request(`/api/keys/${key.id}`), context()),
    await detail.PUT(request(`/api/keys/${key.id}`, "PUT", { isActive: false }), context()), await devices(request("/api/keys/devices"))]) {
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(key.key);
  }
  const row = (await (await list.GET(request())).json()).keys[0];
  expect(row).toMatchObject({ id: key.id, secretRedacted: true, keyPreview: `••••${key.key.slice(-4)}` });
  expect(row).not.toHaveProperty("key");
  expect((await getApiKeyById(key.id)).key).toBe(key.key);
});

it("discloses exactly the selected key only through the explicit operator action", async () => {
  const other = await createApiKey("Other", "fixture-machine");
  const response = await reveal(request(`/api/keys/${key.id}/reveal`, "POST"), context());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({ id: key.id, key: key.key, disclosure: "explicit-operator-request" });
  expect(JSON.stringify(body)).not.toContain(other.key);
  expect((await getApiKeyById(key.id)).isActive).toBe(true);
});

it("returns a newly issued credential once in the creation response", async () => {
  const response = await list.POST(request("/api/keys", "POST", { name: "New client" }));
  expect(response.status).toBe(201);
  const issued = await response.json();
  expect(issued.key).toBe((await getApiKeyById(issued.id)).key);
  expect(await (await list.GET(request())).text()).not.toContain(issued.key);
});

it.each([[{}, 401], [{ "x-inference": "yes" }, 403], [{ "x-operator": "yes", "x-peer": "remote" }, 403]])("refuses unauthorized disclosure and writes with %j", async (headers, status) => {
  const before = JSON.stringify(db.all("SELECT * FROM apiKeys ORDER BY id"));
  for (const response of [await reveal(request(`/api/keys/${key.id}/reveal`, "POST", undefined, headers), context()),
    await detail.PUT(request(`/api/keys/${key.id}`, "PUT", { isActive: false }, headers), context()),
    await list.POST(request("/api/keys", "POST", { name: "Unauthorized" }, headers)),
    await list.DELETE(request(`/api/keys?id=${key.id}`, "DELETE", undefined, headers))]) {
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(key.key);
  }
  expect(JSON.stringify(db.all("SELECT * FROM apiKeys ORDER BY id"))).toBe(before);
});

it("does not disclose key metadata to an anonymous or inference-only caller", async () => {
  for (const [headers, status] of [[{}, 401], [{ "x-inference": "yes" }, 403]]) {
    expect((await list.GET(request("/api/keys", "GET", undefined, headers))).status).toBe(status);
    expect((await detail.GET(request(`/api/keys/${key.id}`, "GET", undefined, headers), context())).status).toBe(status);
    expect((await devices(request("/api/keys/devices", "GET", undefined, headers))).status).toBe(status);
  }
});

it("does not inherit future private fields through public projection", () => {
  const publicRow = publicApiKey({ id: "fixture", key: "tiny", futurePrivate: "secret", tokenHash: "secret" });
  expect(publicRow).toEqual({ id: "fixture", keyPreview: "••••", secretRedacted: true });
});

it("reports a missing key without disclosing other credentials", async () => {
  const response = await reveal(request("/api/keys/missing/reveal", "POST"), { params: Promise.resolve({ id: "missing" }) });
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain(key.key);
});

it("refreshes exact held allowance after dispatch uncertainty without disclosing the key", async () => {
  await updateApiKey(key.id, { maxCostUsd: 10, budgetPolicy: 'reserve-remaining' });
  const requestId = 'c76e7779-ecfa-4050-8545-d7f8e41ef17c';
  await reserveBudget({ apiKey: key.key, requestId, logicalRequestId: requestId, bounds: {}, dispatchCoverage: 'physical-dispatch' });
  await markBudgetDispatched(requestId);
  await markBudgetUncertain(requestId, 'fixture-interruption');
  const response = await list.GET(request());
  const body = await response.json(), row = body.keys[0];
  expect(JSON.stringify(body)).not.toContain(key.key);
  expect(row.budget).toMatchObject({ apiKeyId: key.id, policy: 'reserve-remaining', providerChargeConfirmed: false,
    recorded: { costUsd: 0 }, outstanding: { requests: 1, uncertain: 1, costUsd: 10 } });
  expect(keyBudgetState(row)).toMatchObject({ state: 'held', label: 'Allowance held' });
});
