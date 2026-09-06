import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// Written against the live contract, never run: /dashboard/system exists on the
// 20143 instance only after the lead rebuilds it. Every write is fulfilled by
// page.route, so no shutdown, update or import ever reaches the gateway.
const NEVER = ["**/api/version/shutdown", "**/api/version/update", "**/api/settings/database"];

test.beforeEach(async ({ page }) => {
  await signIn(page);
  // Fail loudly rather than silently if a mutation escapes a per-test route.
  for (const pattern of NEVER) {
    await page.route(pattern, (r) => r.fulfill(json(500, { error: "unmocked write reached the gateway" })));
  }
});

test("a poll that stops answering reads as stale with the last good data still visible", async ({ page }) => {
  await page.goto("/dashboard/system");
  await expect(page.getByRole("heading", { name: "Runtime", level: 2 })).toBeVisible();
  await expect(page.locator(".screen-head .fresh").first()).toHaveAttribute("data-state", "live");
  await page.route("**/api/admin/health", (r) => r.abort());
  const fresh = page.locator(".screen-head .fresh").first();
  await expect(fresh).toHaveAttribute("data-state", "stale", { timeout: 25000 });
  await expect(page.locator("dl.system-facts")).toContainText("Up");
});

test("a loopback refusal on the health detail is its own sentence", async ({ page }) => {
  await page.route("**/api/admin/health/detail", (r) => r.fulfill(json(403, {
    error: "State-changing admin endpoints are loopback-bound. Reach them through a tunnel that terminates as a loopback peer.",
    code: "forbidden_loopback",
    source: "tokenproxy-admin",
  })));
  await page.goto("/dashboard/system");
  await expect(page.getByText("State changes are loopback-bound.")).toBeVisible();
  await expect(page.getByText("Run this from the machine that hosts the gateway, or through a tunnel that ends as a loopback peer.")).toBeVisible();
});

test("the shutdown confirmation names what is cut and who restarts it", async ({ page }) => {
  await page.goto("/dashboard/system");
  await page.getByRole("button", { name: "Shut down" }).click();
  const dialog = page.locator("dialog.confirm[open]");
  await expect(dialog.getByRole("heading", { name: "Shut down" })).toBeVisible();
  await expect(dialog).toContainText("An operator credential. This holds even when sign-in is turned off.");
  await expect(dialog).toContainText("Stops the process. Every request in flight is cut, and every client is refused.");
  await expect(dialog).toContainText("Start TokenProxy again by hand on the machine that runs it.");
  // The same verb through the flow: button, confirm, notice.
  await page.unroute("**/api/version/shutdown");
  await page.route("**/api/version/shutdown", (r) => r.fulfill(json(200, { success: true, message: "Shutting down for manual update..." })));
  await dialog.getByRole("button", { name: "Shut down" }).click();
  await expect(page.getByText("Shutting down.")).toBeVisible();
});

test("the import confirmation names that the current database is destroyed", async ({ page }) => {
  await page.goto("/dashboard/system");
  await page.getByRole("button", { name: "Import a database" }).click();
  const dialog = page.locator("dialog.confirm[open]");
  await expect(dialog).toContainText("Replaces the whole database. Every connection, client key, combo and setting stored now is destroyed and replaced by the file's.");
  await expect(dialog).toContainText("Nothing. Export a backup first if what is stored now still matters.");
  await expect(dialog.locator("input[type=file]")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Import a database" })).toHaveClass(/danger/);
});

test("a wrong password says so inside the dialog and changes nothing", async ({ page }) => {
  await page.unroute("**/api/settings/database");
  await page.route("**/api/settings/database", (r) => r.fulfill(json(401, { error: "Invalid password" })));
  await page.goto("/dashboard/system");
  await page.getByRole("button", { name: "Export a backup" }).click();
  const dialog = page.locator("dialog.confirm[open]");
  await dialog.locator("input[type=password]").fill("wrong-password");
  await dialog.getByRole("button", { name: "Export a backup" }).click();
  await expect(dialog.locator(".notice")).toContainText("That password is not right.");
  await expect(dialog.locator(".notice")).toContainText("Nothing was changed. Type it again.");
  await expect(dialog).toBeVisible();
});

test("the password input is cleared after submit", async ({ page }) => {
  await page.unroute("**/api/settings/database");
  await page.route("**/api/settings/database", (r) => r.fulfill(json(401, { error: "Invalid password" })));
  await page.goto("/dashboard/system");
  await page.getByRole("button", { name: "Export a backup" }).click();
  const field = page.locator("dialog.confirm[open] input[type=password]");
  await field.fill("hunter2");
  await page.locator("dialog.confirm[open]").getByRole("button", { name: "Export a backup" }).click();
  await expect(page.locator("dialog.confirm[open] .notice")).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("hunter2");
});

test("a failed version lookup is not rendered as up to date", async ({ page }) => {
  await page.route("**/api/version", (r) => r.fulfill(json(200, { currentVersion: "0.0.1", latestVersion: null, hasUpdate: false, isTrayMode: false, buildSha: null })));
  await page.goto("/dashboard/system");
  const facts = page.locator("dl.system-facts");
  await expect(facts).not.toContainText("Up to date");
  const update = facts.locator("dt", { hasText: "Update" }).first();
  await expect(update.locator("+ dd .unreported")).toHaveText("Not reported");
  await expect(update.locator("+ dd .why")).toContainText("A failed lookup is not the same as being current");
});

test("the two gap facts are rendered as unreported, never invented", async ({ page }) => {
  await page.goto("/dashboard/system");
  const gap = page.locator("section", { has: page.getByRole("heading", { name: "Not reported", level: 2 }) });
  await expect(gap.locator(".bullets li")).toHaveCount(2);
  await expect(gap).toContainText("Whether a connection is being skipped because a quota window crossed its auto-pause threshold. Such a connection reads as healthy above.");
  await expect(gap).toContainText("Whether one model on a connection is locked out after a model-scoped failure, and until when.");
  // The runtime facts no route serves say so rather than guessing a path.
  const facts = page.locator("dl.system-facts");
  for (const label of ["Data directory", "Database file", "Timers and background jobs", "Restart after replacement"]) {
    await expect(facts.locator("dt", { hasText: label }).first().locator("+ dd .unreported")).toHaveText("Not reported");
  }
});
