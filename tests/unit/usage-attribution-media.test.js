import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ apiKey: "synthetic", connectionId: "account", connectionName: "fixture", sessionHash: "f".repeat(64), sessionIdentitySource: "explicit" }),
  markAccountUnavailable: async () => ({ shouldFallback: false }), clearAccountError: vi.fn(), isValidApiKey: async () => false,
}));
vi.mock("../../src/lib/localDb.js", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/requestModel.js", () => ({ resolveRequestModel: async (model) => ({ provider: model.split('/')[0], model: model.split('/')[1] }) }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_, c) => c, updateProviderCredentials: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ refreshCredentials: mocks.refresh }) }));
const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
const { handleRerank } = await import("../../src/sse/handlers/rerank.js");
const { getAdapter } = await import("../../src/lib/db/driver.js");
const { readActivityAnalytics } = await import("../../src/lib/db/analytics/activityQueries.mjs");
const db = await getAdapter();
beforeEach(() => { db.run("DELETE FROM usageHistory"); db.run("DELETE FROM requestStats"); db.run("DELETE FROM contextSessions"); mocks.refresh.mockResolvedValue({ apiKey: "refreshed-synthetic" }); });
afterEach(() => vi.unstubAllGlobals());
const modalities = [
  ["embeddings", handleEmbeddings, { model: "openai/text-embedding-3-small", input: "fixture" }, { data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 12, total_tokens: 12 } }],
  ["rerank", handleRerank, { model: "cohere/rerank-v3.5", query: "fixture", documents: ["one", "two"] }, { results: [{ index: 0, relevance_score: 0.9 }], meta: { tokens: { input_tokens: 12 } } }],
];
describe("actual media requests preserve exact dispatch identity", () => {
  it.each(modalities)("%s links successful usage after an authentication retry", async (endpoint, handle, body, payload) => {
    const ids = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const pending = db.get("SELECT * FROM requestStats WHERE status='pending'");
      expect(pending.dispatchCoverage).toBe("physical-dispatch"); expect(pending.rateSnapshotId).toMatch(/^[a-f0-9]{64}$/);
      ids.push(pending.id);
      return ids.length === 1 ? Response.json({ error: { message: "expired" } }, { status: 401 }) : Response.json(payload);
    }));
    const response = await handle(new Request(`http://localhost/v1/${endpoint}`, { method: "POST", body: JSON.stringify(body) }));
    expect(response.status).toBe(200); expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2);
    const economics = readActivityAnalytics(db, { operation: "activity", view: "economics" });
    expect(economics.items).toHaveLength(1); expect(economics.items[0].requestId).toBe(ids[1]);
    expect(economics.items[0].attempt).toBe(2); expect(economics.items[0].reportedCostUsd).toBeNull();
    const activity = readActivityAnalytics(db, { operation: "activity", logicalRequestId: economics.items[0].logicalRequestId });
    expect(activity.summary).toMatchObject({ records: 2, logicalRequests: 1, physicalDispatchRows: 2, failed: 1, succeeded: 1 });
  });
  it.each(modalities)("%s validation does not create a dispatch or billable row", async (endpoint, handle, body) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const invalid = endpoint === "embeddings" ? { ...body, input: 12 } : { ...body, documents: [12] };
    const response = await handle(new Request(`http://localhost/v1/${endpoint}`, { method: "POST", body: JSON.stringify(invalid) }));
    expect(response.status).toBe(400); expect(fetch).not.toHaveBeenCalled();
    expect(db.get("SELECT COUNT(*) AS n FROM requestStats").n).toBe(0);
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(0);
  });
});
