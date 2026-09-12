import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// Written against the live contract on 20143, not run yet: /dashboard/usage
// only exists on that instance once the lead rebuilds it.

// A full stream frame, the shape /api/usage/stream sends verbatim: the whole
// getUsageStats result, with the four live keys freshly computed beside it.
function frame(over = {}) {
  return {
    period: "7d",
    totalRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedTokens: 0,
    totalCacheCreationTokens: 0,
    totalCost: 0,
    byProvider: {},
    byModel: {},
    byAccount: {},
    byApiKey: {},
    byEndpoint: {},
    pending: { byModel: {}, byAccount: {} },
    activeRequests: [],
    activeSessions: [],
    recentRequests: [],
    errorProvider: "",
    range: null,
    ...over,
  };
}

function sse(body) {
  return { status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify(body)}\n\n` };
}

// getStatsSummary's own empty-denominator rule: an average with zero samples
// is null, and a cache rate with nothing to divide is null.
const EMPTY_SUMMARY = {
  totalRequests: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheHitRate: null,
  latency: { avgLatencyMs: null, avgTtftMs: null, latencySamples: 0, ttftSamples: 0, requests: 0 },
};

const EMPTY_STATISTICS = {
  filters: { providers: [], models: [], accounts: [], accountsByProvider: {}, modelsByProvider: {}, modelsByAccount: {} },
  summary: EMPTY_SUMMARY,
  series: [],
  items: [],
  pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0, hasNext: false, hasPrev: false },
};

test.beforeEach(async ({ page }) => { await signIn(page); });

test("the economics screen reuses one initial all-facet projection", async ({ page }) => {
  const reads=[];
  await page.route("**/api/analytics?*",(route)=>{
    const query=new URL(route.request().url()).searchParams;
    reads.push(Object.fromEntries(query));
    route.fulfill(json(200,{
      source:'usageHistory',filters:Object.fromEntries(query),
      summary:{records:0,succeeded:0,failed:0,recordedPending:0,inputTokens:0,outputTokens:0,costSamples:0,recordedCostUsd:null},
      groups:[],groupPagination:{page:1,pageSize:12,totalItems:0,totalPages:0,hasNext:false,hasPrev:false},groupsTruncated:false,
      series:{bucketMs:null,points:[]},items:[],pagination:{page:1,pageSize:25,totalItems:0,totalPages:0,hasNext:false,hasPrev:false},
      units:{tokens:'tokens',cost:'USD',latency:'ms',time:'UTC'},definitions:{},
    }));
  });
  await page.goto("/dashboard/usage");
  await expect(page.getByRole('heading',{name:'Economics'})).toBeVisible();
  await expect.poll(()=>reads.length).toBe(1);
  expect(reads[0]).toMatchObject({view:'economics',facets:'summary,groups,series,items',pageSize:'25',sortBy:'timestamp',sortDirection:'desc'});
  expect(reads.some(query=>query.view==='activity')).toBe(false);
});

test("the usage stream reports reconnecting then stale when it cannot connect", async ({ page }) => {
  await page.route("**/api/usage/stream*", (r) => r.abort());
  await page.goto("/dashboard/usage");
  const status = page.locator(".screen-head .fresh").first();
  await expect(status).toHaveAttribute("data-state", /connecting|reconnecting/);
  await expect(status).toHaveAttribute("data-state", "stale", { timeout: 15000 });
  await expect(page.getByText("The usage stream stopped.")).toBeVisible();
});

test("an empty period says what to do next rather than showing zeros as data", async ({ page }) => {
  await page.route("**/api/usage/stream*", (r) => r.fulfill(sse(frame())));
  await page.route("**/api/usage/statistics*", (r) => r.fulfill(json(200, EMPTY_STATISTICS)));
  await page.route("**/api/usage/chart*", (r) => r.fulfill(json(200, [])));
  await page.route("**/api/usage/stats/health*", (r) => r.fulfill(json(200, { period: "7d", startDate: null, endDate: null, groupBy: "provider", rows: [] })));
  await page.goto("/dashboard/usage");
  await expect(page.getByText("No provider served a request in this period.")).toBeVisible();
  await expect(page.getByText("No request was recorded in this period. Send one through the gateway, or choose a longer period.")).toBeVisible();
  await expect(page.getByText("This period has no buckets to draw. Choose a longer period, or send a request through the gateway.")).toBeVisible();
});

test("a null average renders as not reported with its reason, never zero", async ({ page }) => {
  await page.route("**/api/usage/stream*", (r) => r.fulfill(sse(frame())));
  await page.route("**/api/usage/statistics*", (r) => r.fulfill(json(200, EMPTY_STATISTICS)));
  await page.goto("/dashboard/usage");
  const avg = page.locator(".measure", { hasText: "Average total time" });
  await expect(avg.locator(".unreported")).toHaveText("Not reported");
  await expect(avg.locator(".why")).not.toHaveText("");
  await expect(avg).not.toContainText(/\b0\b/);
  const rate = page.locator(".measure", { hasText: "Cache hit rate" });
  await expect(rate.locator(".unreported")).toHaveText("Not reported");
});

test("a group that measured no outcome reads as not measured, never a clean rate", async ({ page }) => {
  await page.route("**/api/usage/stream*", (r) => r.fulfill(sse(frame())));
  await page.route("**/api/usage/stats/health*", (r) => r.fulfill(json(200, {
    period: "7d", startDate: null, endDate: null, groupBy: "provider",
    rows: [{ provider: "prov-a", providerName: "Provider A", requests: 0, errors: 0, successRate: null, avgLatencyMs: null, avgTtftMs: null, latencySamples: 0, ttftSamples: 0 }],
  })));
  await page.goto("/dashboard/usage");
  const row = page.locator(".usage-health", { hasText: "Provider A" });
  await expect(row.locator(".unreported").first()).toHaveText("Not measured");
  await expect(row).not.toContainText("100%");
});

test("switching the period changes the stream url and every polled route", async ({ page }) => {
  const seen = [];
  await page.route("**/api/usage/stream*", (r) => { seen.push(new URL(r.request().url()).searchParams.get("period")); r.fulfill(sse(frame())); });
  await page.route("**/api/usage/chart*", (r) => { seen.push(new URL(r.request().url()).searchParams.get("period")); r.fulfill(json(200, [])); });
  await page.goto("/dashboard/usage");
  await expect.poll(() => seen.includes("7d")).toBe(true);
  await page.getByRole("radio", { name: "30 days" }).check();
  await expect.poll(() => seen.filter((p) => p === "30d").length, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
});

test("a forbidden statistics read is rendered as its own sentence", async ({ page }) => {
  await page.route("**/api/usage/stream*", (r) => r.fulfill(sse(frame())));
  await page.route("**/api/usage/statistics*", (r) => r.fulfill(json(403, { error: "Local only: CLI token required" })));
  await page.goto("/dashboard/usage");
  await expect(page.getByText("This action is not allowed from here.")).toBeVisible();
});

test("no request or session identity is rendered", async ({ page }) => {
  await page.route("**/api/usage/stream*", (r) => r.fulfill(sse(frame({
    totalCost: 1.25,
    activeRequests: [{ model: "m1", provider: "prov-a", account: "Work account", count: 2 }],
    activeSessions: [{ requestId: "req-SECRET-1", clientId: "cli-SECRET-2", sessionId: "sess-SECRET-3", model: "m1", provider: "prov-a", account: "Work account", startedAt: new Date().toISOString(), promptTokens: 10, completionTokens: 5, status: "active" }],
    recentRequests: [{ timestamp: new Date().toISOString(), model: "m1", requestedModel: null, reasoningEffort: null, provider: "prov-a", promptTokens: 10, completionTokens: 5, status: "ok", apiKey: "sk-***-SECRET4***" }],
  }))));
  await page.route("**/api/usage/statistics*", (r) => r.fulfill(json(200, {
    ...EMPTY_STATISTICS,
    items: [{ id: "row-SECRET-5", timestamp: new Date().toISOString(), provider: "prov-a", model: "m1", account: "Work account", status: "success", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, cacheHitRate: null, latencyMs: 120, ttftMs: 40 }],
    pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1, hasNext: false, hasPrev: false },
  })));
  await page.goto("/dashboard/usage");
  await expect(page.getByText("Work account").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("SECRET");
});

test("resetting every price override names what it destroys and offers no undo", async ({ page }) => {
  await page.route("**/api/usage/stream*", (r) => r.fulfill(sse(frame())));
  await page.route("**/api/pricing", (r) => r.fulfill(json(200, { "prov-a": { m1: { input: 3, output: 15 } } })));
  await page.goto("/dashboard/usage");
  await page.getByRole("button", { name: "Reset every price override" }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toContainText("Every price you have set, for every model of every provider, is deleted.");
  await expect(dialog).toContainText("There is none.");
  await expect(dialog.locator("button.danger")).toBeVisible();
});
