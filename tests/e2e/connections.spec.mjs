import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// Behaviour evidence.mjs cannot see: 412 rendered from a drain, 409 from a
// recheck and a rollback, the delete confirmation naming its blast radius,
// and no credential ever reaching the DOM. Routes mocked per
// /tmp/connections-contract.md and docs/contract/02-admin-quota-drain.md.

const SECRET = "sk-live-deadbeefdeadbeefdeadbeefdeadbeef";

function conn(over = {}) {
  return {
    id: "c-1", provider: "openai", authType: "apikey", name: "work account",
    email: "ops@example.com", priority: 1, isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    quotaPauseThresholds: {}, providerSpecificData: {},
    ...over,
  };
}

function qual(over = {}) {
  return {
    connectionId: "c-1", provider: "openai", displayName: "work account",
    status: "healthy", isActive: true, isDraining: false,
    lastQualifiedAt: "2026-01-02T00:00:00.000Z", lastError: null,
    generation: { ok: true, model: "gpt-5", latencyMs: 420, error: null },
    quota: [{ scope: "5h", remaining: 40, limit: 100, resetAt: "2026-01-02T05:00:00.000Z", observedAt: "2026-01-02T00:00:00.000Z", confidence: "reported" }],
    ...over,
  };
}

function drainRow(over = {}) {
  return { connectionId: "c-1", isDraining: false, requestedAt: null, activeStreams: 0, completedAt: null, version: "v-1", ...over };
}

function mockDetail(page, { c = conn(), q = qual(), d = drainRow() } = {}) {
  return Promise.all([
    page.route("**/api/providers/c-1", (r) => {
      if (r.request().method() === "GET") return r.fulfill(json(200, { connection: c }));
      return r.fallback();
    }),
    page.route("**/api/admin/qualification/c-1", (r) => r.fulfill(json(200, q))),
    page.route("**/api/admin/drain?all=true", (r) => r.fulfill(json(200, { connections: [d] }))),
    page.route("**/api/settings", (r) => r.fulfill(json(200, { providerStrategies: {} }))),
    page.route("**/api/proxy-pools", (r) => r.fulfill(json(200, { proxyPools: [] }))),
  ]);
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test("an empty list reads as an invitation, not an error", async ({ page }) => {
  await page.route("**/api/providers", (r) => r.fulfill(json(200, { connections: [] })));
  await page.route("**/api/admin/qualification", (r) => r.fulfill(json(200, { connections: [] })));
  await page.route("**/api/admin/drain?all=true", (r) => r.fulfill(json(200, { connections: [] })));
  await page.route("**/api/system/state**", (r) => r.fulfill(json(200, { measures: {}, providerHealth: { status: "ok", degradedProviders: [] } })));
  await page.route("**/api/admin/activation", (r) => r.fulfill(json(200, { active: null, history: [] })));
  await page.goto("/dashboard/connections");
  await expect(page.getByText("No connections yet. Add one and the gateway can start routing.")).toBeVisible();
});

test("a forbidden qualification read is refused as its own sentence", async ({ page }) => {
  await page.route("**/api/providers", (r) => r.fulfill(json(200, { connections: [conn()] })));
  await page.route("**/api/admin/qualification", (r) => r.fulfill(json(403, { error: "Admin reads are loopback-only.", code: "forbidden_loopback", source: "tokenproxy-admin" })));
  await page.route("**/api/admin/drain?all=true", (r) => r.fulfill(json(200, { connections: [] })));
  await page.route("**/api/system/state**", (r) => r.fulfill(json(200, { measures: {}, providerHealth: { status: "ok", degradedProviders: [] } })));
  await page.route("**/api/admin/activation", (r) => r.fulfill(json(200, { active: null, history: [] })));
  await page.goto("/dashboard/connections");
  await expect(page.getByText("State changes are loopback-bound.")).toBeVisible();
});

test("no credential is rendered on the detail even if the server leaked one", async ({ page }) => {
  await mockDetail(page, { c: conn({ apiKey: SECRET, providerSpecificData: { apiKey: SECRET } }) });
  await page.goto("/dashboard/connections/c-1");
  await expect(page.getByText("work account").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(SECRET);
  await expect(page.locator("body")).not.toContainText("deadbeef");
});

test("a stale drain version renders the 412 with the current version", async ({ page }) => {
  await mockDetail(page);
  await page.route("**/api/admin/drain/c-1", (r) => r.fulfill(json(412, {
    error: "ifMatch does not match the current DrainState.version.",
    code: "version_conflict", currentVersion: "v-9", source: "tokenproxy-admin",
  })));
  await page.goto("/dashboard/connections/c-1");
  await page.getByRole("button", { name: "Drain", exact: true }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toContainText("Streams already open run to their end.");
  await dialog.getByRole("button", { name: "Drain", exact: true }).click();
  await expect(dialog).toContainText("The record changed since you read it.");
  await expect(dialog).toContainText("v-9");
});

test("a recheck while draining renders the 409 sentence", async ({ page }) => {
  await mockDetail(page, { d: drainRow({ isDraining: true, requestedAt: "2026-01-02T00:00:00.000Z", version: "v-2" }) });
  await page.route("**/api/admin/qualification/c-1/recheck", (r) => r.fulfill(json(409, {
    error: "This connection is draining; a probe would send it new traffic.",
    code: "recheck_in_progress", source: "tokenproxy-admin",
  })));
  await page.goto("/dashboard/connections/c-1");
  await page.getByRole("button", { name: "Recheck", exact: true }).click();
  const dialog = page.locator("dialog.confirm");
  await dialog.getByRole("button", { name: "Recheck", exact: true }).click();
  await expect(dialog).toContainText("This connection is draining, so a probe is refused.");
});

test("delete asks first and names what is destroyed", async ({ page }) => {
  await mockDetail(page);
  let deleted = false;
  await page.route("**/api/providers/c-1", (r) => {
    if (r.request().method() === "DELETE") { deleted = true; return r.fulfill(json(200, { message: "Connection deleted successfully" })); }
    return r.fulfill(json(200, { connection: conn() }));
  });
  await page.goto("/dashboard/connections/c-1");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toContainText("The stored credential, the connection's configuration, and its place in the fallback order are destroyed.");
  await expect(dialog).toContainText("Nothing else cascades.");
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toHaveClass(/danger/);
  expect(deleted).toBe(false);
});

test("a rollback with nothing to roll back to renders the 409", async ({ page }) => {
  await page.route("**/api/providers", (r) => r.fulfill(json(200, { connections: [] })));
  await page.route("**/api/admin/qualification", (r) => r.fulfill(json(200, { connections: [] })));
  await page.route("**/api/admin/drain?all=true", (r) => r.fulfill(json(200, { connections: [] })));
  await page.route("**/api/system/state**", (r) => r.fulfill(json(200, { measures: {}, providerHealth: { status: "ok", degradedProviders: [] } })));
  await page.route("**/api/admin/activation", (r) => r.fulfill(json(200, {
    active: { releaseId: "build-2", version: "0.0.2", status: "active", activatedAt: "2026-01-01T00:00:00.000Z", previousReleaseId: "build-1", concurrencyVersion: "cv-1" },
    history: [],
  })));
  await page.route("**/api/admin/rollback", (r) => r.fulfill(json(409, {
    error: "No prior release to roll back to.", code: "no_prior_release", source: "tokenproxy-admin",
  })));
  await page.goto("/dashboard/connections");
  await page.getByRole("button", { name: "Roll back", exact: true }).click();
  const dialog = page.locator("dialog.confirm[open]");
  await dialog.getByRole("button", { name: "Roll back", exact: true }).click();
  await expect(dialog).toContainText("There is no earlier release to roll back to.");
});

test("the unreported facts are labelled as the gateway's silence, not zero", async ({ page }) => {
  await page.route("**/api/providers", (r) => r.fulfill(json(200, { connections: [conn()] })));
  await page.route("**/api/admin/qualification", (r) => r.fulfill(json(200, { connections: [qual()] })));
  await page.route("**/api/admin/drain?all=true", (r) => r.fulfill(json(200, { connections: [] })));
  await page.route("**/api/system/state**", (r) => r.fulfill(json(200, { measures: {}, providerHealth: { status: "ok", degradedProviders: [] } })));
  await page.route("**/api/admin/activation", (r) => r.fulfill(json(200, { active: null, history: [] })));
  await page.goto("/dashboard/connections");
  await expect(page.getByText("Not reported by the gateway")).toBeVisible();
});
