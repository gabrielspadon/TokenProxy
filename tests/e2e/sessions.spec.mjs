import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// Written against the live contract of GET /api/admin/receipts,
// GET /api/admin/receipts/{receiptId} and GET /api/usage/stream, verified on
// the isolated instance. Not yet executed: /dashboard/sessions only exists on
// 20143 once the lead rebuilds.

const CONNS = {
  status: "ok",
  checks: {
    database: { status: "ok", driver: "better-sqlite3", latencyMs: 0, error: null },
    connections: [
      { connectionId: "conn-old", provider: "anthropic", displayName: "claude-a", status: "healthy", isActive: true, isDraining: false, lastQualifiedAt: null, lastError: null },
      { connectionId: "conn-new", provider: "openai", displayName: "openai-1", status: "healthy", isActive: true, isDraining: false, lastQualifiedAt: null, lastError: null },
    ],
  },
};

const WINDOW = (over) => ({ scope: "5h", remaining: 0, limit: 100, resetAt: new Date(Date.now() + 3600e3).toISOString(), observedAt: new Date().toISOString(), confidence: "measured", ...over });

const RECEIPT = {
  receiptId: "rcpt-1",
  timestamp: new Date().toISOString(),
  trigger: "exhausted",
  model: "claude-sonnet-4",
  sessionHash: "SESSIONHASHSECRET0000000000000000",
  oldConnectionId: "conn-old",
  newConnectionId: "conn-new",
  windows: { old: [WINDOW()], new: [WINDOW({ remaining: 90 })] },
};

const FIRST_PIN = {
  receiptId: "rcpt-2",
  timestamp: new Date(Date.now() - 60000).toISOString(),
  trigger: "manual",
  model: "gpt-5",
  sessionHash: "SESSIONHASHSECRET1111111111111111",
  oldConnectionId: null,
  newConnectionId: "conn-new",
  windows: { old: null, new: [] },
};

const streamFrame = (payload) => ({
  status: 200,
  contentType: "text/event-stream",
  body: `data: ${JSON.stringify({ totalCost: 0, activeRequests: [], recentRequests: [], errorProvider: null, ...payload })}\n\n`,
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await page.route("**/api/admin/health/detail", (r) => r.fulfill(json(200, CONNS)));
});

test("the usage stream goes stale and the last frame stays on screen", async ({ page }) => {
  await page.route("**/api/admin/receipts*", (r) => r.fulfill(json(200, { receipts: [], nextCursor: null })));
  await page.route("**/api/usage/stream*", (r) => r.abort());
  await page.goto("/dashboard/sessions");
  const status = page.locator(".screen-head .fresh").first();
  await expect(status).toHaveAttribute("data-state", /connecting|reconnecting/);
  await expect(status).toHaveAttribute("data-state", "stale", { timeout: 15000 });
  await expect(page.getByText("The usage stream stopped.")).toBeVisible();
});

test("an empty switch log says what writes the first receipt", async ({ page }) => {
  await page.route("**/api/admin/receipts*", (r) => r.fulfill(json(200, { receipts: [], nextCursor: null })));
  await page.route("**/api/usage/stream*", (r) => r.fulfill(streamFrame({ activeSessions: [] })));
  await page.goto("/dashboard/sessions");
  await expect(page.getByText("No switch has been recorded yet. The first time a session is pinned to an account is itself written here.")).toBeVisible();
  await expect(page.getByText("No session is in flight right now. One appears here while a request it owns is open.")).toBeVisible();
});

test("a forbidden_class refusal is its own sentence", async ({ page }) => {
  await page.route("**/api/admin/receipts*", (r) => r.fulfill(json(403, { error: "An operator credential is required. An inference API key does not satisfy this endpoint.", code: "forbidden_class", source: "tokenproxy-admin" })));
  await page.route("**/api/usage/stream*", (r) => r.fulfill(streamFrame({ activeSessions: [] })));
  await page.goto("/dashboard/sessions");
  await expect(page.getByText("An inference API key does not satisfy this endpoint.")).toBeVisible();
  await expect(page.getByText("Sign in as the operator.")).toBeVisible();
});

test("a switch names both connections and links the one it landed on", async ({ page }) => {
  await page.route("**/api/admin/receipts*", (r) => r.fulfill(json(200, { receipts: [RECEIPT], nextCursor: null })));
  await page.route("**/api/usage/stream*", (r) => r.fulfill(streamFrame({ activeSessions: [] })));
  await page.goto("/dashboard/sessions");
  await expect(page.getByText("Quota exhausted")).toBeVisible();
  await expect(page.getByRole("link", { name: "claude-a" })).toHaveAttribute("href", "/dashboard/connections/conn-old");
  await expect(page.getByRole("link", { name: "openai-1" })).toHaveAttribute("href", "/dashboard/connections/conn-new");
  await page.getByText("Quota evidence at the switch").click();
  await expect(page.getByText("Measured").first()).toBeVisible();
});

test("a first pin says there was no earlier account rather than showing a blank", async ({ page }) => {
  await page.route("**/api/admin/receipts*", (r) => r.fulfill(json(200, { receipts: [FIRST_PIN], nextCursor: null })));
  await page.route("**/api/usage/stream*", (r) => r.fulfill(streamFrame({ activeSessions: [] })));
  await page.goto("/dashboard/sessions");
  await expect(page.getByText("Nothing. This was the first pin of that session.")).toBeVisible();
});

test("a rejected cursor is reported where the operator paged", async ({ page }) => {
  await page.route("**/api/admin/receipts?**", (route) => {
    const url = route.request().url();
    if (url.includes("cursor=")) return route.fulfill(json(400, { error: "cursor is not a cursor issued by this endpoint.", code: "invalid_request", source: "tokenproxy-admin" }));
    return route.fulfill(json(200, { receipts: [RECEIPT], nextCursor: "b3Bh" }));
  });
  await page.route("**/api/usage/stream*", (r) => r.fulfill(streamFrame({ activeSessions: [] })));
  await page.goto("/dashboard/sessions");
  await page.getByRole("button", { name: "Show older" }).click();
  await expect(page.getByText("The gateway refused the input.")).toBeVisible();
});

test("a receipt id that no longer resolves reads as never happened", async ({ page }) => {
  await page.route("**/api/admin/receipts/*", (r) => r.fulfill(json(404, { error: "No receipt with id aged-out.", code: "not_found", source: "tokenproxy-admin" })));
  await page.route("**/api/admin/receipts?**", (r) => r.fulfill(json(200, { receipts: [], nextCursor: null })));
  await page.route("**/api/usage/stream*", (r) => r.fulfill(streamFrame({ activeSessions: [] })));
  await page.goto("/dashboard/sessions");
  await page.getByLabel("Receipt id").fill("aged-out");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText("Nothing exists at this id.")).toBeVisible();
});

test("no session identity is rendered, from the stream or from a receipt", async ({ page }) => {
  await page.route("**/api/admin/receipts*", (r) => r.fulfill(json(200, { receipts: [RECEIPT, FIRST_PIN], nextCursor: null })));
  await page.route("**/api/usage/stream*", (r) => r.fulfill(streamFrame({
    activeSessions: [{ requestId: "req-SECRET-1", clientId: "cli-SECRET-2", sessionId: "sess-SECRET-3", model: "claude-sonnet-4", provider: "anthropic", account: "claude-a", startedAt: new Date().toISOString(), promptTokens: 10, completionTokens: 2, status: "active" }],
  })));
  await page.goto("/dashboard/sessions");
  await expect(page.getByText("Running")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("SECRET");
  await expect(page.locator("body")).not.toContainText("SESSIONHASH");
  await expect(page.locator("body")).toContainText("anthropic");
});
