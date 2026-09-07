import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// Every write on this screen is fulfilled here, so a spec run never starts,
// stops or reconfigures a transport on the instance it is pointed at.
const WRITES = [
  "**/api/tunnel/enable",
  "**/api/tunnel/disable",
  "**/api/tunnel/tailscale-enable",
  "**/api/tunnel/tailscale-disable",
];

const OFF = {
  tunnel: { enabled: false, settingsEnabled: false, tunnelUrl: "", shortId: "", publicUrl: "", running: false },
  tailscale: { enabled: false, settingsEnabled: false, tunnelUrl: "", running: false, loggedIn: false },
  download: { downloading: false, progress: 0 },
};
const HOST_OFF = { installed: true, loggedIn: false, platform: "linux", brewAvailable: false, daemonRunning: true, customDaemonRunning: true, systemDaemonRunning: true, hasCachedPassword: false };
const ACCESS = { requireLogin: true, tunnelDashboardAccess: true, tunnelUrl: "", tailscaleUrl: "" };

async function mockReads(page, { status = OFF, host = HOST_OFF, access = ACCESS } = {}) {
  await page.route("**/api/tunnel/status", (r) => r.fulfill(json(200, status)));
  await page.route("**/api/tunnel/tailscale-check", (r) => r.fulfill(json(200, host)));
  await page.route("**/api/settings/require-login", (r) => r.fulfill(json(200, access)));
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  for (const w of WRITES) await page.route(w, (r) => r.fulfill(json(200, { success: true })));
  await page.route("**/api/settings", (r) => (r.request().method() === "GET" ? r.fallback() : r.fulfill(json(200, { ok: true }))));
});

test("a transport that never ran says what to do next, and withholds an address it has none of", async ({ page }) => {
  await mockReads(page);
  await page.goto("/dashboard/remote");
  await expect(page.getByRole("heading", { name: "Remote", level: 1 })).toBeVisible();
  await expect(page.getByText("No relay has run on this machine yet. Start the relay to publish a public address.")).toBeVisible();
  const relay = page.locator("section", { has: page.getByRole("heading", { name: "Relay" }) });
  await expect(relay.locator(".unreported").first()).toHaveText("Not reported");
  await expect(relay).toContainText("No registered public address is stored. This status read does not test reachability.");
});

test("the switch and the process are read as two separate facts", async ({ page }) => {
  await mockReads(page, { status: { ...OFF, tunnel: { ...OFF.tunnel, settingsEnabled: true, running: false, shortId: "ab3k9z" } } });
  await page.goto("/dashboard/remote");
  await expect(page.getByText("The switch reads on, but no relay process is running.")).toBeVisible();
  const relay = page.locator("section", { has: page.getByRole("heading", { name: "Relay" }) });
  await expect(relay.locator(".status", { hasText: "Not running" })).toBeVisible();
  await expect(relay).toContainText("ab3k9z");
});

test("a poll that stops answering goes stale with the last good reading still on screen", async ({ page }) => {
  let n = 0;
  await page.route("**/api/tunnel/status", (r) => {
    n += 1;
    return n === 1
      ? r.fulfill(json(200, { ...OFF, tunnel: { ...OFF.tunnel, settingsEnabled: true, running: true, publicUrl: "https://rab3k9z.example.invalid", tunnelUrl: "https://direct.example.invalid", shortId: "ab3k9z" } }))
      : r.abort();
  });
  await page.route("**/api/tunnel/tailscale-check", (r) => r.fulfill(json(200, HOST_OFF)));
  await page.route("**/api/settings/require-login", (r) => r.fulfill(json(200, ACCESS)));
  await page.goto("/dashboard/remote");
  const fresh = page.locator(".screen-head .fresh").first();
  await expect(fresh).toHaveAttribute("data-state", "live");
  await expect(fresh).toHaveAttribute("data-state", "stale", { timeout: 20000 });
  await expect(page.getByText("https://rab3k9z.example.invalid")).toBeVisible();
});

test("a local-only refusal is rendered as its own sentence", async ({ page }) => {
  await mockReads(page);
  await page.route("**/api/tunnel/tailscale-check", (r) => r.fulfill(json(403, { error: "Local only: CLI token required" })));
  await page.goto("/dashboard/remote");
  await expect(page.getByText("This action is not allowed from here.")).toBeVisible();
  await expect(page.getByText("Local only: CLI token required")).toBeVisible();
});

test("starting a transport names internet reachability and what guards it", async ({ page }) => {
  await mockReads(page);
  await page.goto("/dashboard/remote");
  const relay = page.locator("section", { has: page.getByRole("heading", { name: "Relay" }) });
  const dialog = page.locator("dialog.confirm");
  await relay.getByRole("button", { name: "Start the relay" }).click();
  await expect(dialog).toContainText("reachable from the internet");
  await expect(dialog).toContainText("Sign-in is the only thing between that address and this surface.");
  await expect(dialog.locator("dt", { hasText: "Requires" })).toBeVisible();
  await expect(dialog).toContainText("A request from the machine that runs the gateway.");
  await dialog.getByRole("button", { name: "Start the relay" }).click();
  await expect(page.getByText("The process request was accepted. Inspect the refreshed status below; reachability remains unverified.")).toBeVisible();
});

test("stopping a transport names which remote clients lose access", async ({ page }) => {
  await mockReads(page, { status: { ...OFF, tunnel: { ...OFF.tunnel, settingsEnabled: true, running: true, enabled: true, shortId: "ab3k9z", publicUrl: "https://rab3k9z.example.invalid" } } });
  await page.goto("/dashboard/remote");
  const relay = page.locator("section", { has: page.getByRole("heading", { name: "Relay" }) });
  await relay.getByRole("button", { name: "Stop the relay" }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toContainText("Every remote client on them loses access");
  await expect(dialog).toContainText("The short identifier is kept, so the same public address returns");
});

test("a refused write keeps the gateway's own words inside the dialog", async ({ page }) => {
  await mockReads(page);
  await page.route("**/api/settings", (r) => (r.request().method() === "GET" ? r.fallback() : r.fulfill(json(400, { error: "Invalid disabled provider entry" }))));
  await page.goto("/dashboard/remote");
  const relay = page.locator("section", { has: page.getByRole("heading", { name: "Relay" }) });
  await relay.getByRole("button", { name: "Switch the relay on" }).click();
  const dialog = page.locator("dialog.confirm");
  await dialog.getByRole("button", { name: "Switch the relay on" }).click();
  await expect(dialog.getByText("The gateway refused the input.")).toBeVisible();
  await expect(dialog.getByText("Invalid disabled provider entry")).toBeVisible();
  await expect(dialog).toBeVisible();
});

test("a stored credential reads as Set and is never rendered", async ({ page }) => {
  await mockReads(page, { host: { ...HOST_OFF, loggedIn: true, hasCachedPassword: true, sudoPassword: "SECRET-sudo-1", authKey: "tskey-SECRET-2" } });
  await page.goto("/dashboard/remote");
  const mesh = page.locator("section", { has: page.getByRole("heading", { name: "Mesh" }) });
  await expect(mesh.getByText("Set", { exact: true })).toBeVisible();
  await expect(mesh).toContainText("Stored start-up password");
  await expect(page.locator("body")).not.toContainText("SECRET");
  await expect(page.locator("body")).not.toContainText("tskey-");
  await expect(page.locator("input[type=text]")).toHaveCount(0);
});
