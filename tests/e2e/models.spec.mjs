import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

test.beforeEach(async ({ page }) => { await signIn(page); });

test("empty catalog states its reason instead of an empty table", async ({ page }) => {
  await page.route("**/api/models", (r) => r.fulfill(json(200, { models: [] })));
  await page.goto("/dashboard/models");
  await page.getByRole("tab", { name: "Catalog controls", exact: true }).click();
  await expect(page.getByText("A model appears once a provider is connected.")).toBeVisible();
});

test("an unavailable catalog shows the read failure without claiming live data", async ({ page }) => {
  await page.route("**/api/models", (r) => r.abort());
  await page.goto("/dashboard/models");
  await page.getByRole("tab", { name: "Catalog controls", exact: true }).click();
  const status = page.locator(".screen-head .fresh").first();
  await expect(page.getByText("The gateway did not answer.", { exact: true })).toBeVisible();
  await expect(status).not.toHaveAttribute("data-state", "live");
});

test("a forbidden combo delete renders the admin refusal sentence", async ({ page }) => {
  await page.route("**/api/combos", (r) => r.fulfill(json(200, { combos: [{ id: "c1", name: "fast-chain", kind: "llm", models: ["a", "b"] }] })));
  await page.route("**/api/combos/c1", (r) => r.fulfill(json(403, { error: "State changes are loopback-bound.", code: "forbidden_loopback", source: "tokenproxy-admin" })));
  await page.goto("/dashboard/models");
  await page.getByRole("tab", { name: "Catalog controls", exact: true }).click();
  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  await expect(page.getByText("This connection is draining, so a probe is refused.")).toHaveCount(0);
  await expect(page.getByText("State changes are loopback-bound.")).toBeVisible();
});

test("deleting a combo names its blast radius before it fires", async ({ page }) => {
  await page.route("**/api/combos", (r) => r.fulfill(json(200, { combos: [{ id: "c1", name: "fast-chain", kind: "llm", models: ["a", "b", "c"] }] })));
  await page.goto("/dashboard/models");
  await page.getByRole("tab", { name: "Catalog controls", exact: true }).click();
  await page.getByRole("button", { name: "Delete" }).first().click();
  await expect(page.getByText('A client addressing "fast-chain" directly is refused')).toBeVisible();
  await expect(page.getByText("each of its 3 member models keeps routing on its own name")).toBeVisible();
});

test("a 400 validation string from the gateway is rendered verbatim", async ({ page }) => {
  await page.route("**/api/models", (r) => r.fulfill(json(200, { models: [{ provider: "openai", model: "gpt-4o", name: "gpt-4o", fullModel: "openai/gpt-4o", routedModel: "gpt-4o", alias: "gpt-4o", caps: {} }] })));
  await page.route("**/api/models/alias", (r) => r.fulfill(json(400, { error: "alias must not collide with an existing model id" })));
  await page.goto("/dashboard/models");
  await page.getByRole("tab", { name: "Catalog controls", exact: true }).click();
  await page.getByRole("button", { name: "Set alias" }).click();
  await page.locator('.confirm input[type="text"]').fill("gpt-4o-fast");
  await page.locator("dialog.confirm[open]").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("alias must not collide with an existing model id")).toBeVisible();
});

test("search filters the catalog by id and by alias", async ({ page }) => {
  await page.route("**/api/models", (r) => r.fulfill(json(200, { models: [
    { provider: "openai", model: "gpt-4o", name: "gpt-4o", fullModel: "openai/gpt-4o", routedModel: "gpt-4o", alias: "gpt-4o", caps: {} },
    { provider: "anthropic", model: "claude-opus", name: "claude-opus", fullModel: "anthropic/claude-opus", routedModel: "claude-opus", alias: "opus-fast", caps: {} },
  ] })));
  await page.goto("/dashboard/models");
  await page.getByRole("tab", { name: "Catalog controls", exact: true }).click();
  await expect(page.locator(".models-row.row", { hasText: "openai/gpt-4o" })).toBeVisible();
  await page.locator('.models-search input[type="search"]').fill("opus-fast");
  await expect(page.locator(".models-row.row", { hasText: "openai/gpt-4o" })).toHaveCount(0);
  await expect(page.locator(".models-row.row", { hasText: "anthropic/claude-opus" })).toBeVisible();
});

test("a first-scan seed of new models is reported as noise, not as new work", async ({ page }) => {
  await page.route("**/api/models/new", (r) => r.fulfill(json(200, { groups: [], total: 0, totalUnseen: 0, seeded: true })));
  await page.goto("/dashboard/models");
  await page.getByRole("tab", { name: "Catalog controls", exact: true }).click();
  await expect(page.getByText("First scan seeded.")).toBeVisible();
});
