import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// Written against the real contract (docs/contract/06-tools-system.md section 3
// and src/app/api/notifications/**), not run: /dashboard/notifications exists
// on the isolated instance only after the lead rebuilds it. Every write is
// fulfilled by page.route, so no spec can save a webhook or send a real test.
const EVENTS = ["provider.unhealthy", "provider.recovered", "high.error.rate"];
const RATE = { threshold: 0.5, windowSeconds: 300, minSamples: 20 };
const SIGNING = "s3cr3t-signing-value";

const feed = (config, deliveries = []) => json(200, { config, events: EVENTS, deliveries });
const bare = { enabled: false, endpoints: [], errorRate: RATE };
const configured = {
  enabled: true,
  errorRate: RATE,
  // The GET redacts: the stored value is replaced by `hasSecret` (route.js:31-34).
  endpoints: [{ id: "wh-1", url: "https://hooks.example.com/services/T000", events: EVENTS, hasSecret: true, active: true }],
};

test.beforeEach(async ({ page }) => { await signIn(page); });

test("with nothing configured it says so and names what to do next", async ({ page }) => {
  await page.route("**/api/notifications", (r) => r.fulfill(feed(bare)));
  await page.goto("/dashboard/notifications");
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  await expect(page.getByText("No destination is configured. Add one below; until then nothing is sent anywhere.")).toBeVisible();
  await expect(page.getByText("Never sent. A delivery appears here once an event fires.")).toBeVisible();
  await expect(page.locator(".notifications-log")).toHaveCount(0);
});

test("a poll that starts failing reads stale with the last good data still visible", async ({ page }) => {
  let served = 0;
  await page.route("**/api/notifications", (r) =>
    r.fulfill(served++ === 0 ? feed(configured) : json(500, { error: "db locked" })));
  await page.goto("/dashboard/notifications");
  await expect(page.getByText("Set", { exact: true })).toBeVisible();
  const fresh = page.locator(".screen-head .fresh").first();
  await expect(fresh).toHaveAttribute("data-state", "stale", { timeout: 20000 });
  await expect(page.getByText("Set", { exact: true })).toBeVisible();
});

test("a denied read renders its own sentence, not a raw status", async ({ page }) => {
  // dashboardGuard's tier-6 deny-by-default is the only auth failure this route
  // produces: a plain 401 {error:"Unauthorized", source:"tokenproxy"}
  // (src/dashboardGuard.js:348,354). The admin-ABI 403 shapes in refusal.js
  // are unreachable here (docs/contract/06-tools-system.md section 3).
  await page.route("**/api/notifications", (r) =>
    r.fulfill(json(401, { error: "Unauthorized", source: "tokenproxy" })));
  await page.goto("/dashboard/notifications");
  await expect(page.getByText("Your session has ended.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("HTTP 401");
});

test("clearing a destination names that nothing more is delivered there, and only fires on confirm", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/notifications", async (r) => {
    if (r.request().method() === "PUT") { writes += 1; return r.fulfill(json(200, { config: { ...configured, endpoints: [] } })); }
    return r.fulfill(feed(configured));
  });
  await page.goto("/dashboard/notifications");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toContainText("The address is removed, and no further event is delivered there.");
  await expect(dialog).toContainText("Nothing. Add the destination again to send there.");
  expect(writes).toBe(0);
  await dialog.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("Destination cleared")).toBeVisible();
  expect(writes).toBe(1);
});

test("the server's own 400 string is what the dialog shows", async ({ page }) => {
  await page.route("**/api/notifications", async (r) => {
    if (r.request().method() === "PUT") return r.fulfill(json(400, { error: "Blocked URL: private IP" }));
    return r.fulfill(feed(configured));
  });
  await page.goto("/dashboard/notifications");
  await page.getByRole("button", { name: "Turn off", exact: true }).click();
  const dialog = page.locator("dialog.confirm");
  await dialog.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(dialog.getByText("The gateway refused the input.")).toBeVisible();
  await expect(dialog.getByText("Blocked URL: private IP")).toBeVisible();
});

test("a stored signing value is never rendered, and a URL's user info is masked", async ({ page }) => {
  await page.route("**/api/notifications", (r) => r.fulfill(feed({
    ...configured,
    // A server that leaked the stored value back must still not put it on screen.
    endpoints: [{ id: "wh-1", url: `https://user:${SIGNING}@hooks.example.com/services/AAAAAAAAAAAAAAAAAAAAAA`, events: EVENTS, hasSecret: true, secret: SIGNING, active: true }],
  })));
  await page.goto("/dashboard/notifications");
  await expect(page.getByText("Set", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(SIGNING);
  await expect(page.locator("body")).toContainText("•••@hooks.example.com");
});

test("the signing input is a password field and is empty again after a save", async ({ page }) => {
  await page.route("**/api/notifications", async (r) => {
    if (r.request().method() === "PUT") return r.fulfill(json(200, { config: configured }));
    return r.fulfill(feed(configured));
  });
  await page.goto("/dashboard/notifications");
  await page.getByRole("button", { name: "Change", exact: true }).click();
  const field = page.getByLabel("Signing value");
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toHaveAttribute("autocomplete", "off");
  await field.fill(SIGNING);
  await page.getByRole("button", { name: "Save destination", exact: true }).first().click();
  // Cleared the moment it is submitted, while the form is still on screen.
  await expect(field).toHaveValue("");
  await page.locator("dialog.confirm").getByRole("button", { name: "Save destination", exact: true }).click();
  await expect(page.getByText("Destination saved")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(SIGNING);
});

test("a test send is confirmed as irreversible and reports the exact failure", async ({ page }) => {
  let sends = 0;
  await page.route("**/api/notifications", (r) => r.fulfill(feed(configured)));
  await page.route("**/api/notifications/test", (r) => {
    sends += 1;
    return r.fulfill(json(200, { ok: false, status: null, attempts: 1, error: "blocked: endpoint does not resolve to a public address" }));
  });
  await page.goto("/dashboard/notifications");
  await page.getByRole("button", { name: "Send test", exact: true }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toContainText("Nothing. A message already sent cannot be recalled.");
  expect(sends).toBe(0);
  await dialog.getByRole("button", { name: "Send test", exact: true }).click();
  await expect(page.getByText("The test did not arrive.")).toBeVisible();
  await expect(page.getByText("blocked: endpoint does not resolve to a public address")).toBeVisible();
  expect(sends).toBe(1);
});
