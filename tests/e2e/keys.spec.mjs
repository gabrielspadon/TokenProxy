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
  // No ceiling is drawn as an unknown line, never as an empty meter at zero.
  const card = page.locator('article[data-account-id="key-1"]');
  await expect(card).toContainText("No ceiling");
  await expect(card.locator('[role="meter"]')).toHaveCount(0);
  await card.getByRole("button", { name: "Configure agent laptop", exact: true }).click();
  await expect(page.getByLabel("Cost ceiling for agent laptop", { exact: true })).toHaveValue("");
});

test("a failing read keeps the last good list rather than emptying it", async ({ page }) => {
  let first = true;
  await page.route("**/api/keys", (r) => {
    if (first) { first = false; return r.fulfill(json(200, { keys: [row()] })); }
    return r.fulfill(json(500, { error: "Failed to fetch keys" }));
  });
  await page.goto("/dashboard/keys");
  await expect(page.getByText("agent laptop")).toBeVisible();
  // The freshness marker reports the fixture's own snapshot state on an
  // isolated preview, so what this holds is that a failing read never turns the
  // last good list into an empty one. Refresh forces the failing read rather
  // than waiting out the poll interval.
  await expect(page.locator(".fresh").first()).toBeVisible();
  await page.getByRole("button", { name: "Refresh keys", exact: true }).click();
  await page.waitForTimeout(1500);
  await expect(page.getByText("agent laptop")).toBeVisible();
  await expect(page.getByText("No key is issued.")).toHaveCount(0);
});

test("a forbidden read is refused as its own sentence", async ({ page }) => {
  await page.route("**/api/keys", (r) => r.fulfill(json(401, { error: "Unauthorized", source: "tokenproxy" })));
  await page.goto("/dashboard/keys");
  await expect(page.getByText("Your session has ended.")).toBeVisible();
  await expect(page.getByText("Sign in again.")).toBeVisible();
});

test("revoke names its blast radius and that it cannot be undone, beside the key", async ({ page }) => {
  let deleted = false;
  await page.route("**/api/keys", (r) => {
    if (r.request().method() === "DELETE") { deleted = true; return r.fulfill(json(200, { deleted: 1, requested: 1 })); }
    return r.fulfill(json(200, { keys: [row()] }));
  });
  await page.goto("/dashboard/keys");
  const card = page.locator('article[data-account-id="key-1"]');
  await card.getByRole("button", { name: "Configure agent laptop", exact: true }).click();
  await card.getByRole("button", { name: "Revoke", exact: true }).click();
  // The confirmation stands where the act does; there is no dialog anywhere.
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(card).toContainText("Every client still using it is refused from that moment.");
  await expect(card).toContainText("A revoked key cannot be restored");
  expect(deleted).toBe(false);
});

test("a 400 from the create route is rendered with the server's own words", async ({ page }) => {
  await page.route("**/api/keys", (r) => (r.request().method() === "POST"
    ? r.fulfill(json(400, { error: "Name is required" }))
    : r.fulfill(json(200, { keys: [] }))));
  await page.goto("/dashboard/keys");
  await page.getByRole("button", { name: "Create a key" }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("The gateway refused the input.")).toBeVisible();
  await expect(page.getByText("Name is required")).toBeVisible();
  await expect(page.locator("dialog")).toHaveCount(0);
});

test("the created key is shown once, on the board and nowhere else", async ({ page }) => {
  await page.route("**/api/keys", (r) => (r.request().method() === "POST"
    ? r.fulfill(json(201, { key: RAW, name: "new", id: "key-2", machineId: "machine0000000", expiresAt: null, maxPromptTokens: null, maxCompletionTokens: null, maxCostUsd: null, allowedModels: null }))
    : r.fulfill(json(200, { keys: [] }))));
  await page.goto("/dashboard/keys");
  await page.getByRole("button", { name: "Create a key" }).click();
  await page.getByLabel("New key name", { exact: true }).fill("new");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const shown = page.getByLabel("New key value");
  await expect(shown).toContainText("This key is shown once. Copy it now.");
  await expect(page.locator(".keys-secret")).toHaveValue(RAW);
  await expect(page.locator("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("body")).not.toContainText(RAW);
});
