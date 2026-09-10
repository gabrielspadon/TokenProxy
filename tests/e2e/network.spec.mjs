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

// The pools and nodes inventories are boards behind the page's task switch,
// and destructive controls are Advanced-only, so every test states both.
test.beforeEach(async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    localStorage.setItem("tokenproxy.navigation-mode", JSON.stringify("advanced"));
  });
});
const task = (page, name) => page.getByRole("tab", { name, exact: true }).click();

test("no node and no pool reads as empty states that say what to do next", async ({ page }) => {
  await stub(page);
  await page.goto("/dashboard/network");
  await task(page, "Nodes");
  await expect(page.getByText("No node is registered. Add one to route through a custom endpoint.")).toBeVisible();
  await task(page, "Pools");
  await expect(page.getByText("No pool exists. Add one to give a connection or a provider strategy somewhere to route through.")).toBeVisible();
});

test("a failing pool poll keeps the last good list and says it is stale", async ({ page }) => {
  await page.route("**/api/provider-nodes", (r) => r.fulfill(json(200, { nodes: [] })));
  await page.route("**/api/settings", (r) => (r.request().method() === "GET" ? r.fulfill(EMPTY.settings().body) : r.continue()));
  // React's development double-invoke aborts the first effect's read, so the
  // good body has to survive two requests or the abort consumes it and the
  // screen never sees a successful list at all.
  let good = 2;
  await page.route("**/api/proxy-pools*", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    if (good > 0) { good -= 1; return r.fulfill(json(200, { proxyPools: [pool()] })); }
    return r.fulfill(json(500, { error: "Failed to fetch proxy pools" }));
  });
  await page.goto("/dashboard/network");
  await task(page, "Pools");
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
  await task(page, "Pools");
  await expect(page.getByText("Your session has ended.")).toBeVisible();
  await expect(page.getByText("Sign in again.")).toBeVisible();
});

test("deleting a pool names how many connections are bound to it, in place", async ({ page }) => {
  await stub(page, { pools: [pool({ boundConnectionCount: 3 })] });
  await page.goto("/dashboard/network");
  await task(page, "Pools");
  await page.getByRole("button", { name: "Delete pool us relay", exact: true }).click();
  // Confirmation is inline: a sentence and a Confirm/Cancel pair, never a dialog.
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("3 connections bound to this pool will be refused");
  await expect(confirm.getByRole("button", { name: "Delete pool", exact: true })).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("a 400 from the pool create route is rendered with the server's own words", async ({ page }) => {
  await stub(page);
  await page.route("**/api/proxy-pools", (r) => (r.request().method() === "POST"
    ? r.fulfill(json(400, { error: "Proxy URL is required" }))
    : r.continue()));
  await page.goto("/dashboard/network");
  await task(page, "Pools");
  await page.getByRole("button", { name: "Add a pool", exact: true }).click();
  const add = page.getByRole("group", { name: "Add a proxy pool" });
  await add.getByLabel("Name", { exact: true }).fill("new pool");
  await add.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByText("The gateway refused the input.")).toBeVisible();
  await expect(page.getByText("Proxy URL is required")).toBeVisible();
});

test("a proxy URL with userinfo is rendered without its password", async ({ page }) => {
  await stub(page, { pools: [pool()] });
  await page.goto("/dashboard/network");
  await task(page, "Pools");
  await expect(page.getByText("scraper", { exact: false })).not.toBeVisible().catch(() => {});
  await expect(page.locator("body")).not.toContainText("hunter2");
  await expect(page.locator("body")).toContainText("•••@10.0.0.5:3128");
});

test("the outbound proxy toggle names that every upstream call uses it", async ({ page }) => {
  await stub(page);
  await page.goto("/dashboard/network");
  await page.getByRole("button", { name: "Set an outbound proxy", exact: true }).click();
  const form = page.getByRole("group", { name: "Outbound proxy" });
  await form.getByLabel("Proxy URL", { exact: true }).fill("http://10.0.0.9:8080");
  await form.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toContainText("Every upstream call not routed through a specific pool uses this proxy from now on.");
});
