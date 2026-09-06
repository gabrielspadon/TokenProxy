import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.JWT_SECRET = "usage-attribution-fixture-signing-secret-0123456789"; });
const mocks = vi.hoisted(() => ({ execute: vi.fn(), refresh: vi.fn(), fetch: vi.fn(), executor: null, noAuth: true }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => mocks.executor || ({ noAuth: mocks.noAuth, execute: mocks.execute, refreshCredentials: mocks.refresh }) }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => mocks.fetch(...args) }));
const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { getRequestIdentity } = await import("../../src/sse/services/requestIdentity.js");
const { GET } = await import("../../src/app/api/analytics/route.js");
const { createDashboardAuthToken } = await import("../../src/lib/auth/dashboardSession.js");
const { getAdapter } = await import("../../src/lib/db/driver.js");
const { updatePricing } = await import("../../src/lib/db/repos/pricingRepo.js");
const db = await getAdapter();
let token;
beforeAll(async () => { token = await createDashboardAuthToken(); });
afterAll(async () => { await globalThis._contextAnalytics?.client.close(); delete globalThis._contextAnalytics; });
beforeEach(() => {
  db.run("DELETE FROM usageHistory"); db.run("DELETE FROM requestStats"); db.run("DELETE FROM contextSessions");
  mocks.execute.mockReset(); mocks.refresh.mockReset(); mocks.fetch.mockReset(); mocks.executor = null; mocks.noAuth = true;
});
const completion = () => Response.json({ choices: [{ message: { role: "assistant", content: "fixture answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, cost_usd: 0.0003 } });
function args(request = new Request("http://localhost/v1/chat/completions")) {
  return { body: { model: "gpt-4o", messages: [{ role: "user", content: "fixture question" }], stream: false },
    modelInfo: { provider: "openrouter", model: "gpt-4o" }, credentials: { sessionHash: "e".repeat(64), sessionIdentitySource: "explicit", accessToken: "synthetic" },
    connectionId: "account-a", clientRawRequest: { headers: {}, body: { model: "openrouter/gpt-4o" }, endpoint: "/v1/chat/completions" },
    contextTelemetry: getRequestIdentity(request), log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
}
async function persisted(n = 1) {
  for (let i = 0; i < 100; i++) { const rows = db.all("SELECT * FROM usageHistory ORDER BY id"); if (rows.length === n && rows.every(row => db.get("SELECT status FROM requestStats WHERE id=?", [row.requestId])?.status !== "pending")) return rows; await new Promise(r => setTimeout(r, 5)); }
  throw Error("usage completion did not persist");
}
async function query(params) {
  const response = await GET({ url: "http://localhost/api/analytics?" + new URLSearchParams(params), method: "GET", headers: new Headers(), cookies: { get: () => ({ value: token }) } });
  expect(response.status).toBe(200); return response.json();
}
describe("mock dispatch through exact accounting and actual analytics worker", () => {
  it("uses one exact UUID from pending dispatch to completion and paged query after a rate change", async () => {
    await updatePricing({ openrouter: { "gpt-4o": { input: 2, output: 4 } } });
    let before;
    mocks.execute.mockImplementation(async () => {
      before = db.get("SELECT * FROM requestStats WHERE status='pending'");
      expect(before.rateSnapshotId).toMatch(/^[a-f0-9]{64}$/);
      expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(0);
      await updatePricing({ openrouter: { "gpt-4o": { input: 200, output: 400 } } });
      return { response: completion() };
    });
    const result = await handleChatCore(args()); await result.response.text();
    const [row] = await persisted();
    expect(row.requestId).toBe(before.id);
    const money = await query({ view: "economics", requestId: before.id, pageSize: "1" });
    expect(money.items[0]).toMatchObject({ requestId: before.id, logicalRequestId: before.logicalRequestId, rateSnapshotId: before.rateSnapshotId, attempt: 1, reportedCostUsd: 0.0003, costSource: "provider-reported" });
    expect(money.items[0].estimatedCostUsd).toBeCloseTo(0.00024, 12);
    expect(money.items[0].rateSnapshot.rates).toMatchObject({ input: 2, output: 4 });
    const activity = await query({ requestId: before.id });
    expect(activity.items[0].requestId).toBe(row.requestId);
    expect((await query({ view: "economics", sessionId: String(before.contextSessionId) })).summary.records).toBe(1);
    expect((await query({ view: "economics", projectId: "never-invented" })).summary.records).toBe(0);
  });
  it("links actual SSE completion and forced SSE-to-JSON completion to their physical attempts", async () => {
    const stream = 'data: '+JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] })+'\n\n'+
      'data: '+JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 5 } })+'\n\ndata: [DONE]\n\n';
    mocks.execute.mockImplementation(async () => ({ response: new Response(stream, { headers: { "content-type": "text/event-stream" } }) }));
    for (const streaming of [true, false]) {
      const a = args(); a.body.stream = streaming;
      const result = await handleChatCore(a); expect(result.success).toBe(true); await result.response.text();
    }
    const rows = await persisted(2);
    expect(new Set(rows.map(r => r.requestId)).size).toBe(2);
    for (const row of rows) expect(db.get("SELECT id,status FROM requestStats WHERE id=?", [row.requestId])).toMatchObject({ id: row.requestId, status: "success" });
  });
  it("separates a rejected authentication attempt from its successful retry without a second charge", async () => {
    mocks.noAuth = false; mocks.refresh.mockResolvedValue({ accessToken: "refreshed-synthetic" });
    mocks.execute.mockResolvedValueOnce({ response: Response.json({ error: { message: "expired" } }, { status: 401 }) }).mockResolvedValueOnce({ response: completion() });
    const result = await handleChatCore(args()); await result.response.text();
    const [row] = await persisted();
    const stats = db.all("SELECT * FROM requestStats ORDER BY attempt");
    expect(stats).toHaveLength(2); expect(stats.map(r => r.attempt)).toEqual([1, 2]);
    expect(stats[0].status).toBe("error"); expect(row.requestId).toBe(stats[1].id);
    expect(new Set(stats.map(r => r.logicalRequestId)).size).toBe(1);
    const attempts = await query({ logicalRequestId: row.logicalRequestId });
    expect(attempts.summary).toMatchObject({ attempts: 2, logicalRequests: 1 });
    expect((await query({ view: "economics", logicalRequestId: row.logicalRequestId })).summary).toMatchObject({ attempts: 1, logicalRequests: 1 });
  });
  it("gives concurrent logical requests distinct IDs, with shared counters only inside the same request", async () => {
    mocks.execute.mockImplementation(async () => ({ response: completion() }));
    const request = new Request("http://localhost/v1/chat/completions");
    const a = args(request), b = args(request), c = args();
    await Promise.all([a,b,c].map(async value => { const result = await handleChatCore(value); await result.response.text(); }));
    const rows = await persisted(3);
    expect(new Set(rows.map(r => r.requestId)).size).toBe(3);
    expect(rows.filter(r => r.logicalRequestId === a.contextTelemetry.logicalRequestId).map(r => r.attempt).sort()).toEqual([1,2]);
    expect((await query({ view: "economics" })).summary).toMatchObject({ attempts: 3, logicalRequests: 2 });
  });
  it("records every BaseExecutor wire retry while charging only its successful usage", async () => {
    mocks.executor = new BaseExecutor("openrouter", { baseUrl: "https://fixture.invalid/generate", noAuth: true, retry: { 503: { attempts: 1, delayMs: 0 } } });
    const dispatched = [];
    mocks.fetch.mockImplementation(async () => {
      const row = db.get("SELECT * FROM requestStats WHERE status='pending'");
      dispatched.push(row.id);
      expect(row.dispatchCoverage).toBe("physical-dispatch");
      return dispatched.length === 1 ? Response.json({ error: { message: "temporarily unavailable" } }, { status: 503, headers: { 'x-tokenproxy-replay-safe': 'true' } }) : completion();
    });
    const result = await handleChatCore(args()); await result.response.text();
    const [row] = await persisted();
    expect(dispatched).toHaveLength(2); expect(new Set(dispatched).size).toBe(2);
    expect(row.requestId).toBe(dispatched[1]);
    expect(row.dispatchCoverage).toBe("physical-dispatch");
    expect((await query({ logicalRequestId: row.logicalRequestId })).summary).toMatchObject({ attempts: 2, logicalRequests: 1, physicalDispatchRows: 2 });
  });
  it("records failed dispatch rate coverage without inventing billed usage", async () => {
    mocks.execute.mockRejectedValue(new Error("fixture connection failure"));
    const result = await handleChatCore(args()); expect(result.success).toBe(false);
    const data = await query({ view: "activity" });
    expect(data.summary).toMatchObject({ attempts: 1, failed: 1, rateSnapshotRows: 1 });
    expect((await query({ view: "economics" })).summary.records).toBe(0);
  });
});
