import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.JWT_SECRET = "explicit-outcome-fixture-signing-secret-0123456789"; process.env.TOKENPROXY_PEER_TOKEN = "explicit-outcome-fixture-peer-proof"; });
const { getAdapter } = await import("../../src/lib/db/driver.js");
const { getContextEvents } = await import("../../src/lib/db/repos/contextClientEventsRepo.js");
const { parseContextEventFilter } = await import("../../src/lib/db/analytics/contextEvents.mjs");
const { POST } = await import("../../src/app/api/v1/context/events/route.js");
const { GET } = await import("../../src/app/api/context/events/route.js");
const { createDashboardAuthToken } = await import("../../src/lib/auth/dashboardSession.js");
afterAll(async () => { await globalThis._contextAnalytics?.client.close(); delete globalThis._contextAnalytics; });

// Task outcomes are explicit client reports. Nothing here infers an outcome
// from a request that merely completed, and unknown stays unknown.
const db = await getAdapter();
const API_KEY = "outcome-fixture-key", KEY_ID = "outcome-fixture-key-id";
const post = (body, key = API_KEY) => POST(new Request("http://localhost/api/v1/context/events", { method: "POST", headers: key ? { Authorization: `Bearer ${key}` } : {}, body: typeof body === "string" ? body : JSON.stringify(body) }));
const outcome = (extra = {}) => ({ eventId: randomUUID(), type: "task_outcome", occurredAt: new Date().toISOString(), clientId: "private-client", taskId: "private-task", outcome: "success", ...extra });
const count = () => db.get("SELECT COUNT(*) AS n FROM contextClientEvents").n;
beforeEach(() => {
  db.run("DELETE FROM contextClientEvents"); db.run("DELETE FROM apiKeys"); db.run("DELETE FROM requestStats");
  db.run("INSERT INTO apiKeys(id,key,createdAt) VALUES(?,?,?)", [KEY_ID, API_KEY, new Date().toISOString()]);
});

describe("explicit task outcome API", () => {
  it("requires authentication and never records an anonymous outcome", async () => {
    expect((await post(outcome(), null)).status).toBe(401);
    expect((await post(outcome(), "not-a-key")).status).toBe(401);
    expect(count()).toBe(0);
  });
  it.each(["success", "failure", "cancelled", "unknown"])("retains an explicit %s outcome under its exact event id", async (value) => {
    const body = outcome({ outcome: value });
    const response = await post(body);
    expect(response.status).toBe(201);
    const { event, duplicate } = await response.json();
    expect(duplicate).toBe(false);
    expect(event).toMatchObject({ clientEventId: body.eventId.toLowerCase(), type: "task_outcome", outcome: value, providerVerified: false });
    expect(event.taskRef).toMatch(/^ctx1_/);
  });
  it("treats an exact resend as a duplicate and a reused id with different evidence as a conflict", async () => {
    const body = outcome({ outcome: "failure" });
    expect((await post(body)).status).toBe(201);
    const again = await post(body);
    expect(again.status).toBe(200);
    expect((await again.json()).duplicate).toBe(true);
    const conflict = await post({ ...body, outcome: "success" });
    expect(conflict.status).toBe(409);
    expect(count()).toBe(1);
    expect(db.get("SELECT outcome FROM contextClientEvents").outcome).toBe("failure");
  });
  it("refuses an outcome without a task, an outcome value outside the contract, and an outcome on a non-outcome event", async () => {
    for (const bad of [outcome({ taskId: undefined }), outcome({ outcome: "probably-fine" }), outcome({ outcome: undefined }), { ...outcome(), type: "task_start" }, outcome({ type: "compaction" })]) {
      const response = await post(bad);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_context_event");
    }
    expect(count()).toBe(0);
  });
  it("refuses malformed ids and bodies before any write", async () => {
    expect((await post(outcome({ eventId: "not-a-uuid" }))).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post(outcome({ extraField: 1 }))).status).toBe(400);
    expect(count()).toBe(0);
  });
  it("links an outcome only to an exact request that belongs to the same key", async () => {
    const mine = randomUUID(), theirs = randomUUID();
    db.run("INSERT INTO apiKeys(id,key,createdAt) VALUES('other-id','other-key',?)", [new Date().toISOString()]);
    for (const [id, keyId] of [[mine, KEY_ID], [theirs, "other-id"]]) db.run("INSERT INTO requestStats(id,timestamp,provider,model,status,clientKeyId,logicalRequestId) VALUES(?,?,'test','test','success',?,?)", [id, new Date().toISOString(), keyId, randomUUID()]);
    expect((await post(outcome({ requestId: theirs }))).status).toBe(404);
    expect((await post(outcome({ requestId: randomUUID() }))).status).toBe(404);
    const linked = await post(outcome({ requestId: mine }));
    expect(linked.status).toBe(201);
    expect((await linked.json()).event.requestId).toBe(mine);
    expect(count()).toBe(1);
  });
  it("a successful request without a report has no outcome, and the admin read shows exactly what was reported", async () => {
    db.run("INSERT INTO requestStats(id,timestamp,provider,model,status,clientKeyId,logicalRequestId) VALUES(?,?,'test','test','success',?,?)", [randomUUID(), new Date().toISOString(), KEY_ID, randomUUID()]);
    await post(outcome({ outcome: "unknown" }));
    await post(outcome({ outcome: "cancelled" }));
    const token = await createDashboardAuthToken();
    const response = await GET({ url: "http://localhost/api/context/events?pageSize=10", method: "GET", headers: new Headers(), cookies: { get: () => ({ value: token }) } });
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.pagination.totalItems).toBe(2);
    expect(page.events.map((item) => item.outcome).sort()).toEqual(["cancelled", "unknown"]);
    expect(page.events.every((item) => item.providerVerified === false)).toBe(true);
    const events = await getContextEvents(parseContextEventFilter(new URLSearchParams({ pageSize: "10" })));
    expect(events.events).toHaveLength(2);
  });
});
