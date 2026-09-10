import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// The catalog is one board: state chips filter it, the alias saves from the row
// itself, and a destructive act confirms beside the row rather than in a layer.
const model = (over = {}) => ({ provider: "openai", model: "gpt-4o", name: "GPT-4o", fullModel: "openai/gpt-4o", routedModel: "gpt-4o", alias: "gpt-4o", aliases: [], caps: { contextWindow: 128000, maxOutput: 16384 }, ...over });
const entry = (page, id) => page.locator(`article[data-account-id="${id}"]`);
const toast = page => page.locator('[class*="Notification-root"]');

async function catalog(page) {
  await page.goto("/dashboard/models");
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Catalog", exact: true }).click();
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test("an empty catalog states its reason instead of an empty board", async ({ page }) => {
  await page.route("**/api/models", (r) => r.fulfill(json(200, { models: [] })));
  await page.route("**/api/models/new", (r) => r.fulfill(json(200, { groups: [], totalUnseen: 0 })));
  await page.route("**/api/models/disabled", (r) => r.fulfill(json(200, { disabled: {} })));
  await catalog(page);
  await expect(page.getByText("A model appears once a provider is connected.")).toBeVisible();
});

test("an unavailable catalog shows the read failure without claiming live data", async ({ page }) => {
  await page.route("**/api/models", (r) => r.abort());
  await catalog(page);
  await expect(page.locator('p[role="alert"]')).toContainText("The gateway did not answer.");
  await expect(page.locator("article[data-account-id]")).toHaveCount(0);
});

test("the catalog groups by state and each state chip is its filter", async ({ page }) => {
  await page.route("**/api/models", (r) => r.fulfill(json(200, { models: [model(), model({ provider: "anthropic", model: "claude-opus", name: "Claude Opus", fullModel: "anthropic/claude-opus", alias: "opus-fast", aliases: ["opus-fast"] })] })));
  await page.route("**/api/models/disabled", (r) => r.fulfill(json(200, { disabled: { openai: ["gpt-4o-mini"] } })));
  await page.route("**/api/models/new", (r) => r.fulfill(json(200, { groups: [], totalUnseen: 0 })));
  await catalog(page);
  await expect(entry(page, "openai/gpt-4o")).toHaveAttribute("data-bucket", "catalog");
  await expect(entry(page, "anthropic/claude-opus")).toHaveAttribute("data-bucket", "aliased");
  await expect(entry(page, "openai/gpt-4o-mini")).toHaveAttribute("data-bucket", "disabled");
  await page.getByRole("group", { name: "Catalog summary" }).getByRole("button", { name: /aliased/ }).click();
  await expect(page.locator("article[data-account-id]")).toHaveCount(1);
  await expect(entry(page, "anthropic/claude-opus")).toBeVisible();
});

test("search narrows the catalog by model id and by alias", async ({ page }) => {
  await page.route("**/api/models", (r) => r.fulfill(json(200, { models: [model(), model({ provider: "anthropic", model: "claude-opus", name: "Claude Opus", fullModel: "anthropic/claude-opus", alias: "opus-fast", aliases: ["opus-fast"] })] })));
  await catalog(page);
  await expect(entry(page, "openai/gpt-4o")).toBeVisible();
  await page.getByLabel("Search the catalog by model id or alias").fill("opus-fast");
  await expect(entry(page, "openai/gpt-4o")).toHaveCount(0);
  await expect(entry(page, "anthropic/claude-opus")).toBeVisible();
});

test("an alias saves from the row on Enter and a gateway refusal is rendered verbatim", async ({ page }) => {
  await page.route("**/api/models", (r) => r.fulfill(json(200, { models: [model()] })));
  await page.route("**/api/models/alias", (r) => r.fulfill(json(400, { error: "alias must not collide with an existing model id" })));
  await catalog(page);
  const field = entry(page, "openai/gpt-4o").getByLabel("Alias for openai/gpt-4o");
  await expect(field.locator("xpath=ancestor::dialog")).toHaveCount(0);
  await field.fill("gpt-4o-fast");
  await field.press("Enter");
  await expect(toast(page)).toContainText("alias must not collide with an existing model id");
});

test("disabling a model names its blast radius beside the row and sends nothing until confirmed", async ({ page }) => {
  const writes = [];
  await page.route("**/api/models", (r) => r.fulfill(json(200, { models: [model()] })));
  await page.route("**/api/models/disabled", (r) => {
    if (r.request().method() === "GET") return r.fulfill(json(200, { disabled: {} }));
    writes.push(r.request().postDataJSON());
    return r.fulfill(json(200, { ok: true }));
  });
  await catalog(page);
  const control = entry(page, "openai/gpt-4o").getByRole("button", { name: "Disable openai/gpt-4o" });
  await expect(control).toHaveAttribute("aria-label", "Disable openai/gpt-4o");
  await control.click();
  expect(writes).toEqual([]);
  const pair = entry(page, "openai/gpt-4o").getByRole("group", { name: "Confirm: Disable openai/gpt-4o" });
  await expect(pair).toBeVisible();
  await expect(pair.locator("xpath=ancestor::dialog")).toHaveCount(0);
  await pair.getByRole("button", { name: "Disable", exact: true }).click();
  await expect.poll(() => writes).toEqual([{ providerAlias: "openai", ids: ["gpt-4o"], connectionId: null }]);
});

test("a plan is deleted from its own row after an inline confirmation that names the radius", async ({ page }) => {
  const deletes = [];
  await page.route("**/api/models", (r) => r.fulfill(json(200, { models: [model()] })));
  await page.route("**/api/combos", (r) => r.fulfill(json(200, { combos: [{ id: "c1", name: "fast-chain", kind: "llm", models: ["a", "b", "c"] }] })));
  await page.route("**/api/combos/c1", (r) => { deletes.push(r.request().method()); return r.fulfill(json(403, { error: "State changes are loopback-bound.", code: "forbidden_loopback", source: "tokenproxy-admin" })); });
  await catalog(page);
  const plan = page.locator('article[data-account-id="c1"]');
  await plan.getByRole("button", { name: "Delete the plan fast-chain" }).click();
  expect(deletes).toEqual([]);
  const pair = plan.getByRole("group", { name: "Confirm: Delete the plan fast-chain" });
  await expect(pair).toBeVisible();
  await pair.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toast(page)).toContainText("State changes are loopback-bound.");
  expect(deletes).toEqual(["DELETE"]);
});

test("a first-scan seed of new models is reported as noise, not as new work", async ({ page }) => {
  await page.route("**/api/models/new", (r) => r.fulfill(json(200, { groups: [], total: 0, totalUnseen: 0, seeded: true })));
  await catalog(page);
  await expect(page.getByText("First scan seeded.")).toBeVisible();
});

test("the page carries the shared lens heading, the scope bar and five task tabs", async ({ page }) => {
  await page.goto("/dashboard/models");
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Shared analysis scope" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Model configuration tasks" }).getByRole("tab")).toHaveText(["Plans", "Catalog", "Routing", "Route preview", "History"]);
});
