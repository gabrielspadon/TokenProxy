import { test, expect } from "playwright/test";
import { signIn } from "./helpers.mjs";

// The Tools page (§14 Local Tool Integrations, §15 Local Extension Bridge)
// has no live backend to poll or mutate: `/api/cli-tools/**` 404s (absent
// from the tree), and `/api/mcp/[plugin]/**` has no listing/status route.
// So there is no poll to go stale, no write to confirm or refuse, and no
// secret field to fetch. These tests assert what the page actually is: a
// static explanation of both concepts plus an explicit unreported-gap
// section, and the two invariants that still apply with no route involved
// (no session/secret identifiers ever appear, one h1, reachable from nav).
test.beforeEach(async ({ page }) => { await signIn(page); });

test("both sections render as empty state, since no route backs either", async ({ page }) => {
  await page.goto("/dashboard/tools");
  await expect(page.getByRole("heading", { name: "Tool integrations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Local extension bridge" })).toBeVisible();
  const empties = page.locator(".empty");
  await expect(empties).toHaveCount(2);
  await expect(empties.nth(0)).toContainText("No route currently answers which tools are present");
  await expect(empties.nth(1)).toContainText("No route reports which extensions are available");
});

test("the not-reported section names both gaps with their reason", async ({ page }) => {
  await page.goto("/dashboard/tools");
  const gap = page.locator("section", { has: page.getByRole("heading", { name: "Not reported" }) });
  await expect(gap.getByText(/no HTTP route calls them/)).toBeVisible();
  await expect(gap.getByText(/only its status is unreported here/)).toBeVisible();
});

test("freshness reads live with no poll behind it", async ({ page }) => {
  await page.goto("/dashboard/tools");
  await expect(page.locator(".screen-head .fresh").first()).toHaveAttribute("data-state", "live");
});

test("no session, request, or client identifier is ever rendered", async ({ page }) => {
  await page.goto("/dashboard/tools");
  const body = page.locator("body");
  await expect(body).not.toContainText(/sessionId|clientId|requestId/);
  await expect(body).not.toContainText(/•••|Set\b.*Not set/);
});

test("exactly one h1, and the page is reachable from nav", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Tools" }).click();
  await expect(page).toHaveURL(/\/dashboard\/tools$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tools");
});

test("no confirm dialog exists, since no action here mutates anything", async ({ page }) => {
  await page.goto("/dashboard/tools");
  await expect(page.locator("dialog.confirm")).toHaveCount(0);
  await expect(page.locator("button.danger, .button.danger")).toHaveCount(0);
});
