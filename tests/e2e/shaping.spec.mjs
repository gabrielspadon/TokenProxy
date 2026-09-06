import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// Shapes below are the real ones: /api/token-saver/stats returns
// {windows,timeline,recent,pxpipe,sources} with per-saver `stages`
// (src/lib/tokenSaver/events.js), /api/pxpipe/status the library-mode status,
// /api/pxpipe/health {healthy,checks,error}. Written against the contract in
// docs/contract/05-shaping-translator.md; not yet run, the page reaches 20143
// only after the lead rebuilds.

const WINDOW = { requests: 0, applied: 0, bypassed: 0, errors: 0, charsReduced: 0, proxyTokensSaved: 0, bodyBytesReduced: 0, headroomRequests: 0, estTokensSaved: 0, imagesGenerated: 0, avgMs: 0, stages: {} };
const windows = (over = {}) => ({ all: { ...WINDOW, ...over }, today: { ...WINDOW }, yesterday: { ...WINDOW }, last7d: { ...WINDOW }, last30d: { ...WINDOW } });
const stats = (over = {}) => ({ windows: windows(over), timeline: [], recent: [], pxpipe: { windows: { all: {} }, timeline: [], recent: [] }, sources: {} });

test.beforeEach(async ({ page }) => { await signIn(page); });

test("a stale poll keeps the last good numbers on screen", async ({ page }) => {
  let served = 0;
  await page.route("**/api/token-saver/stats*", (r) => {
    served += 1;
    return served === 1
      ? r.fulfill(json(200, stats({ requests: 41, applied: 30, stages: { rtk: { requests: 41, applied: 30, bytesSaved: -8192 } } })))
      : r.fulfill(json(503, { error: "token saver statistics unavailable" }));
  });
  await page.goto("/dashboard/shaping");
  await expect(page.locator(".measure", { hasText: "Requests shaped, all time" })).toContainText("41");
  const fresh = page.locator("#h-bytes").locator("xpath=..").locator(".fresh");
  await expect(fresh).toHaveAttribute("data-state", "stale", { timeout: 25000 });
  await expect(page.locator(".measure", { hasText: "Requests shaped, all time" })).toContainText("41");
});

test("a ledger that never fired says what makes a number appear", async ({ page }) => {
  await page.route("**/api/token-saver/stats*", (r) => r.fulfill(json(200, stats())));
  await page.goto("/dashboard/shaping");
  await expect(page.getByText("No stage has saved a byte yet. Numbers appear after the first request that a layer rewrites.")).toBeVisible();
});

test("a forbidden settings read renders its own refusal sentence", async ({ page }) => {
  await page.route("**/api/settings", (r) => r.fulfill(json(403, { error: "Loopback only" })));
  await page.goto("/dashboard/shaping");
  await expect(page.getByText("This action is not allowed from here.")).toBeVisible();
  await expect(page.getByText("Loopback only")).toBeVisible();
});

test("a stage with no record reads as not reported, never zero", async ({ page }) => {
  await page.route("**/api/token-saver/stats*", (r) => r.fulfill(json(200, stats({ requests: 4, applied: 4, stages: { rtk: { requests: 4, applied: 4, bytesSaved: -400 } } }))));
  await page.goto("/dashboard/shaping");
  const px = page.locator(".shaping-stage", { hasText: "pxpipe" });
  await expect(px.locator(".unreported")).toHaveText("Not reported");
  await expect(px).not.toContainText(/\b0\b/);
  await expect(px.locator(".why")).not.toHaveText("");
});

test("the errored counter is unreported with the fail-open reason, not zero", async ({ page }) => {
  await page.route("**/api/token-saver/stats*", (r) => r.fulfill(json(200, stats({ requests: 9, applied: 9 }))));
  await page.goto("/dashboard/shaping");
  const errored = page.locator(".measure", { hasText: "Errored" });
  await expect(errored.locator(".unreported")).toHaveText("Not reported");
  await expect(errored).not.toContainText(/\b0\b/);
});

test("turning a layer off keeps one verb and names what in-flight requests do", async ({ page }) => {
  await page.goto("/dashboard/shaping");
  const row = page.locator(".shaping-layer", { hasText: "Tool result reducer" });
  await row.getByRole("button", { name: "Turn off" }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog.getByRole("heading", { name: "Turn off a layer" })).toBeVisible();
  await expect(dialog).toContainText("Tool result reducer");
  await expect(dialog).toContainText("New requests skip this layer. New requests take the change. A request already in flight keeps the stack it started with.");
  await expect(dialog).toContainText("Turn it back on here. Numbers already recorded stay.");
  await expect(dialog.getByRole("button", { name: "Turn off" })).toBeVisible();
});

test("a 400 from a threshold save shows the gateway's own words in the dialog", async ({ page }) => {
  await page.route("**/api/settings", async (r) => {
    if (r.request().method() !== "PATCH") return r.fallback();
    return r.fulfill(json(400, { error: "connectTimeoutMs must be an integer from 1000 through 120000" }));
  });
  await page.goto("/dashboard/shaping");
  await page.locator(".field", { hasText: "Time to wait before abandoning" }).locator("input").fill("1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const dialog = page.locator("dialog.confirm");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByText("The gateway refused the input.")).toBeVisible();
  await expect(dialog.getByText("connectTimeoutMs must be an integer from 1000 through 120000")).toBeVisible();
});

test("install is marked irreversible and the four service facts stay separate", async ({ page }) => {
  await page.route("**/api/pxpipe/status", (r) => r.fulfill(json(200, { installed: true, installing: false, version: "1.2.3", path: null, running: false, loadedAt: null, uptimeMs: 0, npmAvailable: true, mode: "library", enabled: true, autoInstall: true, minChars: 25000, timeoutMs: 15000 })));
  await page.route("**/api/pxpipe/health", (r) => r.fulfill(json(200, { healthy: false, checks: [{ id: "module", label: "Transform module loads", ok: false, detail: "boom" }], error: "Cannot load module: boom" })));
  await page.goto("/dashboard/shaping");
  await expect(page.getByText("Installed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Not loaded")).toBeVisible();
  await expect(page.getByText("Allowed").first()).toBeVisible();
  await expect(page.getByText("The self-test did not pass.")).toBeVisible();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toContainText("None. The previous installation is gone. Install again to replace it.");
  await expect(dialog.locator("button.danger")).toHaveText("Install");
});
