import { test, expect } from "playwright/test";
import { signIn, json } from "./helpers.mjs";

// Written against docs/contract/04-keys-usage-auth.md and the live handlers on
// 20143. It has never been run: /dashboard/access exists on that instance only
// after the lead rebuilds it.

const STATUS = {
  requireLogin: true, authMode: "password", ssoType: "oidc",
  oidcConfigured: false, oidcLoginLabel: "Sign in with OIDC",
  samlConfigured: false, samlLoginLabel: "Sign in with SAML SSO",
  hasPassword: true, passwordSource: "stored", displayName: "Password user", loginMethod: "Password",
  authenticated: true, oidcName: null, oidcEmail: null, oidcLogin: false,
  samlName: null, samlEmail: null, samlLogin: false,
};

const SETTINGS = {
  requireLogin: true, requireApiKey: true,
  authMode: "password", ssoType: "oidc",
  oidcIssuerUrl: "", oidcClientId: "", oidcScopes: "openid profile email", oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "", samlIssuer: "urn:tokenproxy:sp", samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO", samlAttributeEmail: "email", samlAttributeName: "name",
  oidcConfigured: false, hasPassword: true,
};

// Every write is fulfilled here, so a spec run can never change the auth of the
// instance it is pointed at. Reads fall through to the real gateway unless a
// test overrides them.
async function sealWrites(page) {
  await page.route("**/api/settings", (r) => (r.request().method() === "GET" ? r.fallback() : r.fulfill(json(200, SETTINGS))));
  await page.route("**/api/auth/reset-password", (r) => r.fulfill(json(200, { success: true })));
  await page.route("**/api/auth/oidc/test", (r) => r.fulfill(json(200, { ok: true, discoveryOk: true, clientSecretTested: false, clientSecretValid: null, message: "Discovery loaded." })));
  await page.route("**/api/auth/saml/test", (r) => r.fulfill(json(200, { ok: true, certValid: true, message: "SAML 2.0 configuration verified successfully." })));
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await sealWrites(page);
});

test("the auth poll reports stale after a good read stops answering", async ({ page }) => {
  // One good read, then the 15s poll fails: the wait outlives the shared 30s
  // default, and the config is another slice's file.
  test.setTimeout(60000);
  let served = 0;
  await page.route("**/api/auth/status", (r) => (served++ === 0 ? r.fulfill(json(200, STATUS)) : r.abort()));
  await page.goto("/dashboard/access");
  const fresh = page.locator(".screen-head .fresh").first();
  await expect(fresh).toHaveAttribute("data-state", "live");
  await expect(fresh).toHaveAttribute("data-state", "stale", { timeout: 25000 });
  await expect(page.getByText("Password sign-in").first()).toBeVisible();
});

test("a forbidden settings read renders as its own sentence", async ({ page }) => {
  await page.route("**/api/settings", (r) => (r.request().method() === "GET"
    ? r.fulfill(json(403, { error: "Local only: CLI token required" }))
    : r.fulfill(json(200, SETTINGS))));
  await page.goto("/dashboard/access");
  await expect(page.getByText("This action is not allowed from here.")).toBeVisible();
  await expect(page.getByText("Local only: CLI token required")).toBeVisible();
});

test("turning sign-in off names exactly what stays protected", async ({ page }) => {
  await page.route("**/api/auth/status", (r) => r.fulfill(json(200, STATUS)));
  await page.goto("/dashboard/access");
  await expect(page.getByText("Shutting the gateway down.")).toBeVisible();
  await page.getByRole("button", { name: "Turn sign-in off" }).click();
  const dialog = page.locator("dialog.confirm[open]");
  await expect(dialog).toContainText("Anyone who can reach this port reads the dashboard and changes most settings without a password.");
  await expect(dialog).toContainText("Shutdown, database export and import, and update still ask for a session");
  await expect(dialog).toContainText("every change under the operator interface stays bound to this machine");
  await expect(dialog.getByRole("button", { name: "Turn sign-in off" })).toBeVisible();
});

test("a wrong current password is its own sentence, not an ended session", async ({ page }) => {
  await page.route("**/api/auth/status", (r) => r.fulfill(json(200, STATUS)));
  await page.route("**/api/settings", (r) => (r.request().method() === "GET"
    ? r.fulfill(json(200, SETTINGS))
    : r.fulfill(json(401, { error: "Invalid current password" }))));
  await page.goto("/dashboard/access");
  await page.getByRole("button", { name: "Change password" }).first().click();
  const dialog = page.locator("dialog.confirm[open]");
  await dialog.getByLabel("Current password").fill("wrong-one");
  await dialog.getByLabel("New password", { exact: true }).fill("a-new-password");
  await dialog.getByLabel("New password again").fill("a-new-password");
  await dialog.getByRole("button", { name: "Change password" }).click();
  await expect(dialog.getByText("That is not the current password.")).toBeVisible();
  await expect(dialog.getByText("Your session has ended.")).toHaveCount(0);
});

test("a stored client secret reads as Set and its value never reaches the page", async ({ page }) => {
  const secret = "oidc-client-secret-DO-NOT-RENDER";
  await page.route("**/api/auth/status", (r) => r.fulfill(json(200, { ...STATUS, authMode: "sso", ssoType: "oidc", oidcConfigured: true })));
  await page.route("**/api/settings", (r) => (r.request().method() === "GET"
    ? r.fulfill(json(200, { ...SETTINGS, authMode: "sso", oidcConfigured: true, oidcIssuerUrl: "https://idp.example.test", oidcClientId: "tokenproxy", oidcClientSecret: secret }))
    : r.fulfill(json(200, SETTINGS))));
  await page.goto("/dashboard/access");
  const row = page.locator("dl.facts").filter({ hasText: "Client secret" });
  await expect(row.getByText("Set", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(secret);
  await expect(page.locator("body")).not.toContainText("DO-NOT-RENDER");
  await expect(page.locator("body")).toContainText("tokenproxy");
});

test("password fields are empty again after a submit, refused as well as accepted", async ({ page }) => {
  await page.route("**/api/auth/status", (r) => r.fulfill(json(200, STATUS)));
  // Refused, so the dialog stays open and nothing re-mounts it: whatever the
  // fields hold now is what the submit itself left behind.
  await page.route("**/api/settings", (r) => (r.request().method() === "GET"
    ? r.fulfill(json(200, SETTINGS))
    : r.fulfill(json(401, { error: "Invalid current password" }))));
  await page.goto("/dashboard/access");
  await page.getByRole("button", { name: "Change password" }).first().click();
  const dialog = page.locator("dialog.confirm[open]");
  await dialog.getByLabel("Current password").fill("the-old-one");
  await dialog.getByLabel("New password", { exact: true }).fill("the-new-one");
  await dialog.getByLabel("New password again").fill("the-new-one");
  await dialog.getByRole("button", { name: "Change password" }).click();
  await expect(dialog.getByText("That is not the current password.")).toBeVisible();
  await expect(dialog.getByLabel("Current password")).toHaveValue("");
  await expect(dialog.getByLabel("New password", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("New password again")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("the-old-one");
});

test("the lockout rules read as facts, with the unreportable ones marked", async ({ page }) => {
  await page.route("**/api/auth/status", (r) => r.fulfill(json(200, STATUS)));
  await page.goto("/dashboard/access");
  const rules = page.locator("section", { hasText: "Lockout rules" }).last();
  await expect(rules.getByText("Five wrong passwords from one address lock that address out.")).toBeVisible();
  await expect(rules.getByText("30s")).toBeVisible();
  await expect(rules.locator(".unreported")).toHaveText("Not reported");
});

test("a default password is called out and no password value is ever rendered", async ({ page }) => {
  await page.route("**/api/auth/status", (r) => r.fulfill(json(200, { ...STATUS, hasPassword: false, passwordSource: "default" })));
  await page.route("**/api/settings", (r) => (r.request().method() === "GET"
    ? r.fulfill(json(200, { ...SETTINGS, hasPassword: false }))
    : r.fulfill(json(200, SETTINGS))));
  await page.goto("/dashboard/access");
  await expect(page.getByText("This installation is still on its default password.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("123456");
  await expect(page.locator("dl.facts").filter({ hasText: "Stored password" }).getByText("Not set")).toBeVisible();
});
