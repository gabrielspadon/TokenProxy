import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// Written against the live contract in docs/contract/04-keys-usage-auth.md and
// the handlers under src/app/api/keys/**. Not yet run: /dashboard/keys exists on
// the isolated instance only after the lead rebuilds it there.

const RAW = "sk-machine0000000-deadbeefdeadbeefdeadbeefdeadbeef-0badc0de";

// One row in the shape GET /api/keys really returns: rowToKey() plus the two
// fields the route merges. `key` carries the full plaintext secret, always.
function row(over = {}) {
  return {
    id: "key-1", key: RAW, name: "agent laptop", machineId: "machine0000000",
    isActive: true, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: null, isExpired: false,
    maxPromptTokens: null, maxCompletionTokens: null, maxCostUsd: null, allowedModels: null,
    usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, requests: 0 },
    deviceCount: 0,
    ...over,
  };
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test("no key issued reads as an empty state that says what to do next", async ({ page }) => {
  await page.route("**/api/keys", (r) => r.fulfill(json(200, { keys: [] })));
  await page.goto("/dashboard/keys");
  await expect(page.getByText("No key is issued. Create one to let a tool route through this gateway.")).toBeVisible();
});

test("no raw key is rendered in the list", async ({ page }) => {
  await page.route("**/api/keys", (r) => r.fulfill(json(200, { keys: [row()] })));
  await page.goto("/dashboard/keys");
  await expect(page.getByText("agent laptop")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(RAW);
  await expect(page.locator("body")).not.toContainText("deadbeef");
});

test("a key with no ceiling reads no ceiling, never zero", async ({ page }) => {
  await page.route("**/api/keys", (r) => r.fulfill(json(200, { keys: [row()] })));
  await page.goto("/dashboard/keys");
  await page.getByText("Details").click();
  const cost = page.locator(".keys-ceiling", { hasText: "Cost" });
  await expect(cost.locator(".unreported")).toHaveText("No ceiling");
});

test("a failing poll keeps the last good list and says it is stale", async ({ page }) => {
  let first = true;
  await page.route("**/api/keys", (r) => {
    if (first) { first = false; return r.fulfill(json(200, { keys: [row()] })); }
    return r.fulfill(json(500, { error: "Failed to fetch keys" }));
  });
  await page.goto("/dashboard/keys");
  await expect(page.getByText("agent laptop")).toBeVisible();
  const status = page.locator(".screen-head .fresh").first();
  await expect(status).toHaveAttribute("data-state", "stale", { timeout: 25000 });
  await expect(page.getByText("agent laptop")).toBeVisible();
});

test("a forbidden read is refused as its own sentence", async ({ page }) => {
  await page.route("**/api/keys", (r) => r.fulfill(json(401, { error: "Unauthorized", source: "tokenproxy" })));
  await page.goto("/dashboard/keys");
  await expect(page.getByText("Your session has ended.")).toBeVisible();
  await expect(page.getByText("Sign in again.")).toBeVisible();
});

test("revoke names its blast radius and that it cannot be undone", async ({ page }) => {
  await page.route("**/api/keys", (r) => r.fulfill(json(200, { keys: [row()] })));
  await page.goto("/dashboard/keys");
  await page.getByText("Details").click();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toContainText("Every client still using it is refused from that moment.");
  await expect(dialog).toContainText("None. A revoked key cannot be restored");
  await expect(dialog.getByRole("button", { name: "Revoke" })).toHaveClass(/danger/);
});

test("a 400 from the create route is rendered with the server's own words", async ({ page }) => {
  await page.route("**/api/keys", (r) => (r.request().method() === "POST"
    ? r.fulfill(json(400, { error: "Name is required" }))
    : r.fulfill(json(200, { keys: [] }))));
  await page.goto("/dashboard/keys");
  await page.getByRole("button", { name: "Create a key" }).click();
  await page.locator("dialog.confirm").getByRole("button", { name: "Create" }).click();
  await expect(page.locator("dialog.confirm")).toContainText("The gateway refused the input.");
  await expect(page.locator("dialog.confirm")).toContainText("Name is required");
});

test("the created key is shown once, in the dialog only", async ({ page }) => {
  await page.route("**/api/keys", (r) => (r.request().method() === "POST"
    ? r.fulfill(json(201, { key: RAW, name: "new", id: "key-2", machineId: "machine0000000", expiresAt: null, maxPromptTokens: null, maxCompletionTokens: null, maxCostUsd: null, allowedModels: null }))
    : r.fulfill(json(200, { keys: [] }))));
  await page.goto("/dashboard/keys");
  await page.getByRole("button", { name: "Create a key" }).click();
  await page.getByLabel("Name").fill("new");
  await page.locator("dialog.confirm").getByRole("button", { name: "Create" }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toContainText("This key is shown once. Copy it now.");
  await expect(dialog.locator(".keys-secret")).toHaveText(RAW);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("body")).not.toContainText(RAW);
});
