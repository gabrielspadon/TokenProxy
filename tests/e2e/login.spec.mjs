import { test, expect } from "playwright/test";
import { json } from "./helpers.mjs";

async function submit(page, password = "wrong") {
  await page.goto("/login");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("401 names the attempts left before lockout", async ({ page }) => {
  await page.route("**/api/auth/login", (r) => r.fulfill(json(401, { error: "Invalid password. 3 attempt(s) left before lockout.", remainingBeforeLock: 3 })));
  await submit(page);
  await expect(page.getByText("That password is not right.")).toBeVisible();
  await expect(page.getByText("Attempts left before lockout")).toBeVisible();
  await expect(page.locator("dd", { hasText: "3" })).toBeVisible();
});

test("429 counts down and disables the form", async ({ page }) => {
  await page.route("**/api/auth/login", (r) => r.fulfill(json(429, { error: "Too many failed attempts. Try again in 30s.", retryAfter: 30 }, { "retry-after": "30" })));
  await submit(page);
  await expect(page.getByText("Too many failed attempts from this address.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
  await expect(page.getByLabel("Password")).toBeDisabled();
});

test("default password refusal says what to change", async ({ page }) => {
  await page.route("**/api/auth/login", (r) => r.fulfill(json(403, { success: false, error: "Default password must be changed before remote access.", mustChangePassword: true })));
  await submit(page, "123456");
  await expect(page.getByText("The default password is still set, so remote sign-in is refused.")).toBeVisible();
  await expect(page.getByText(/INITIAL_PASSWORD/)).toBeVisible();
});

test("password disabled offers single sign-on", async ({ page }) => {
  await page.route("**/api/auth/login", (r) => r.fulfill(json(403, { error: "Password login is disabled. Use SAML SSO sign in." })));
  await submit(page);
  await expect(page.getByText("Password sign-in is turned off.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with SAML" })).toHaveAttribute("href", "/api/auth/saml/start");
});

test("sso mode hides the password form", async ({ page }) => {
  await page.route("**/api/auth/status", (r) => r.fulfill(json(200, { requireLogin: true, authMode: "oidc", oidcConfigured: true, oidcLoginLabel: "Sign in with Okta", hasPassword: true, authenticated: false })));
  await page.goto("/login");
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in with Okta" })).toHaveAttribute("href", "/api/auth/oidc/start");
});

test("start failure from the query is shown", async ({ page }) => {
  await page.goto("/login?error=oidc_not_configured");
  await expect(page.getByText("OIDC is not configured on this gateway.")).toBeVisible();
});

test("a wrong password against the live gateway is refused, never a generic error", async ({ page }) => {
  await submit(page, "definitely-not-the-password");
  await expect(page.getByText("That password is not right.")).toBeVisible();
  await expect(page.getByText(/^error$/i)).toHaveCount(0);
});
