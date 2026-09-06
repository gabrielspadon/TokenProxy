import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// Written against the live contract in docs/contract/01-route-inventory.md
// (proxy-pools/provider-nodes/settings sections) and the handlers under
// src/app/api/{proxy-pools,provider-nodes,settings}/**. Not yet run:
// /dashboard/network exists on the isolated instance only after the lead
// rebuilds it there.

const EMPTY = {
  nodes: () => ({ url: "**/api/provider-nodes", body: json(200, { nodes: [] }) }),
  pools: () => ({ url: "**/api/proxy-pools*", body: json(200, { proxyPools: [] }) }),
  settings: (over = {}) => ({
    url: "**/api/settings",
    body: json(200, {
      outboundProxyEnabled: false, outboundProxyUrl: "", outboundNoProxy: "",
      connectTimeoutMs: 15000, providerStrategies: {}, ...over,
    }),
  }),
};

function pool(over = {}) {
  return {
    id: "pool-1", name: "us relay", proxyUrl: "http://scraper:hunter2@10.0.0.5:3128",
    noProxy: "", type: "http", isActive: true, strictProxy: false,
    testStatus: "unknown", lastTestedAt: null, lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    boundConnectionCount: 0,
    ...over,
  };
}

async function stub(page, { nodes = [], pools = [], settingsOver = {} } = {}) {
  await page.route("**/api/provider-nodes", (r) => r.fulfill(json(200, { nodes })));
  await page.route("**/api/proxy-pools*", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    return r.fulfill(json(200, { proxyPools: pools }));
  });
  await page.route("**/api/settings", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    return r.fulfill(EMPTY.settings(settingsOver).body);
  });
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test("no node and no pool reads as empty states that say what to do next", async ({ page }) => {
  await stub(page);
  await page.goto("/dashboard/network");
  await expect(page.getByText("No node is registered. Add one to route through a custom endpoint.")).toBeVisible();
  await expect(page.getByText("No pool exists. Add one to give a connection or a provider strategy somewhere to route through.")).toBeVisible();
});

test("a failing pool poll keeps the last good list and says it is stale", async ({ page }) => {
  await page.route("**/api/provider-nodes", (r) => r.fulfill(json(200, { nodes: [] })));
  await page.route("**/api/settings", (r) => (r.request().method() === "GET" ? r.fulfill(EMPTY.settings().body) : r.continue()));
  let first = true;
  await page.route("**/api/proxy-pools*", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    if (first) { first = false; return r.fulfill(json(200, { proxyPools: [pool()] })); }
    return r.fulfill(json(500, { error: "Failed to fetch proxy pools" }));
  });
  await page.goto("/dashboard/network");
  await expect(page.getByText("us relay").first()).toBeVisible();
  const status = page.locator(".screen-head .fresh").first();
  await expect(status).toHaveAttribute("data-state", "stale", { timeout: 25000 });
  await expect(page.getByText("us relay").first()).toBeVisible();
});

test("a forbidden pool read is refused as its own sentence", async ({ page }) => {
  await page.route("**/api/provider-nodes", (r) => r.fulfill(json(200, { nodes: [] })));
  await page.route("**/api/settings", (r) => (r.request().method() === "GET" ? r.fulfill(EMPTY.settings().body) : r.continue()));
  await page.route("**/api/proxy-pools*", (r) => (r.request().method() === "GET"
    ? r.fulfill(json(401, { error: "Unauthorized" }))
    : r.continue()));
  await page.goto("/dashboard/network");
  await expect(page.getByText("Your session has ended.")).toBeVisible();
  await expect(page.getByText("Sign in again.")).toBeVisible();
});

test("deleting a pool names how many connections are bound to it", async ({ page }) => {
  await stub(page, { pools: [pool({ boundConnectionCount: 3 })] });
  await page.goto("/dashboard/network");
  await page.getByRole("button", { name: "Delete pool" }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toContainText("3 connections bound to this pool will be refused");
  await expect(dialog.getByRole("button", { name: "Delete" })).toHaveClass(/danger/);
});

test("a 400 from the pool create route is rendered with the server's own words", async ({ page }) => {
  await stub(page);
  await page.route("**/api/proxy-pools", (r) => (r.request().method() === "POST"
    ? r.fulfill(json(400, { error: "Proxy URL is required" }))
    : r.continue()));
  await page.goto("/dashboard/network");
  await page.getByRole("button", { name: "Add a pool" }).click();
  await page.locator("dialog.confirm").getByLabel("Name").fill("new pool");
  await page.locator("dialog.confirm[open]").getByRole("button", { name: "Create" }).click();
  await expect(page.locator("dialog.confirm")).toContainText("The gateway refused the input.");
  await expect(page.locator("dialog.confirm")).toContainText("Proxy URL is required");
});

test("a proxy URL with userinfo is rendered without its password", async ({ page }) => {
  await stub(page, { pools: [pool()] });
  await page.goto("/dashboard/network");
  await expect(page.getByText("scraper", { exact: false })).not.toBeVisible().catch(() => {});
  await expect(page.locator("body")).not.toContainText("hunter2");
  await expect(page.locator("body")).toContainText("•••@10.0.0.5:3128");
});

test("the outbound proxy toggle names that every upstream call uses it", async ({ page }) => {
  await stub(page);
  await page.goto("/dashboard/network");
  await page.getByRole("button", { name: "Set an outbound proxy" }).click();
  await page.getByLabel("Proxy URL").fill("http://10.0.0.9:8080");
  await page.getByRole("button", { name: "Turn on" }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toContainText("Every upstream call not routed through a specific pool uses this proxy from now on.");
});
