import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// Written against docs/contract/05-shaping-translator.md and the live
// handlers on 20143. It has never been run: /dashboard/translation exists on
// that instance only after the lead rebuilds it.

test.beforeEach(async ({ page }) => { await signIn(page); });

test("the console stream reports reconnecting then stale when it cannot connect", async ({ page }) => {
  await page.route("**/api/translator/console-logs/stream*", (r) => r.abort());
  await page.goto("/dashboard/translation");
  const status = page.locator(".screen-head .fresh").first();
  await expect(status).toHaveAttribute("data-state", /connecting|reconnecting/);
  await expect(status).toHaveAttribute("data-state", "stale", { timeout: 15000 });
});

test("an empty console buffer says what to do next, not a blank list", async ({ page }) => {
  await page.route("**/api/translator/console-logs/stream*", (r) => r.fulfill({
    status: 200, contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ type: "init", logs: [] })}\n\n`,
  }));
  await page.goto("/dashboard/translation");
  await expect(page.getByText("No console record yet.")).toBeVisible();
});

test("a forbidden translate call renders its refusal sentence", async ({ page }) => {
  await page.route("**/api/translator/translate", (r) => r.fulfill(json(401, { error: "Unauthorized", source: "gateway" })));
  await page.goto("/dashboard/translation");
  await page.getByRole("button", { name: "Translate" }).click();
  await expect(page.getByText("Your session has ended.")).toBeVisible();
});

test("a bearer token in a log line renders redacted, never in the clear", async ({ page }) => {
  await page.route("**/api/translator/console-logs/stream*", (r) => r.fulfill({
    status: 200, contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ type: "init", logs: ["auth failed: Authorization: Bearer sk-live-SECRETVALUE for connection c1"] })}\n\n`,
  }));
  await page.goto("/dashboard/translation");
  await expect(page.locator(".translation-log")).toContainText("[redacted]");
  await expect(page.locator("body")).not.toContainText("SECRETVALUE");
});

test("pausing the console stops new lines from appending", async ({ page }) => {
  await page.route("**/api/translator/console-logs/stream*", (r) => r.fulfill({
    status: 200, contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ type: "init", logs: ["line one"] })}\n\n`,
  }));
  await page.goto("/dashboard/translation");
  await expect(page.locator(".translation-log li")).toHaveCount(1);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
});

test("clearing console records requires confirmation and states it is irreversible", async ({ page }) => {
  await page.route("**/api/translator/console-logs/stream*", (r) => r.fulfill({
    status: 200, contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ type: "init", logs: ["line one"] })}\n\n`,
  }));
  await page.goto("/dashboard/translation");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Every captured console line is discarded");
  await expect(page.getByRole("dialog")).toContainText("None. Records already cleared cannot be brought back.");
});

test("sending to a provider is gated behind a confirm naming quota and refresh", async ({ page }) => {
  await page.goto("/dashboard/translation");
  await page.locator("section[aria-labelledby=h-translate] label", { hasText: "Provider" }).locator("input").fill("chenzk");
  await page.locator("section[aria-labelledby=h-translate] label", { hasText: "Model" }).locator("input").fill("gpt-4o");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("spends real quota");
  await expect(page.getByRole("dialog")).toContainText("refresh during the call writes a new stored secret back");
});

test("depth 1 fills provider and model from a successful detect", async ({ page }) => {
  await page.route("**/api/translator/translate", (r) => r.fulfill(json(200, { success: true, result: { provider: "chenzk", model: "gpt-4o", sourceFormat: "openai", targetFormat: "openai" } })));
  await page.goto("/dashboard/translation");
  await page.getByRole("button", { name: "Translate" }).click();
  await expect(page.locator("section[aria-labelledby=h-translate] label", { hasText: "Provider" }).locator("input")).toHaveValue("chenzk");
  await expect(page.getByText("Not reported")).toBeVisible();
});
