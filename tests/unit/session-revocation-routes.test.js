import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieFixture = vi.hoisted(() => ({
  values: new Map(),
  deleted: [],
  store: null,
}));

vi.hoisted(() => {
  process.env.JWT_SECRET = "session-revocation-route-fixture-key-0123456789";
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieFixture.store),
}));

const { getAdapter } = await import("@/lib/db/driver.js");
const { getSettings, updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
const {
  createDashboardAuthToken,
  verifyDashboardAuthToken,
} = await import("@/lib/auth/dashboardSession.js");
const { PATCH } = await import("@/app/api/settings/route.js");
const { POST: resetPassword } = await import("@/app/api/auth/reset-password/route.js");
const { POST: logout } = await import("@/app/api/auth/logout/route.js");

const db = await getAdapter();
const patch = (body) => PATCH(new Request("http://localhost/api/settings", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));

beforeEach(async () => {
  db.run("DELETE FROM _meta WHERE key = ?", ["dashboardSessionGeneration"]);
  await updateSettings({ password: null, authMode: "password", ssoType: "oidc", requireLogin: true });
  cookieFixture.values = new Map();
  cookieFixture.deleted = [];
  cookieFixture.store = {
    get: (name) => cookieFixture.values.has(name)
      ? { value: cookieFixture.values.get(name) }
      : undefined,
    delete: (name) => {
      cookieFixture.deleted.push(name);
      cookieFixture.values.delete(name);
    },
  };
});

async function issueSession(name = "operator") {
  const token = await createDashboardAuthToken({ sub: name });
  cookieFixture.values.set("auth_token", token);
  return token;
}

describe("dashboard session revocation routes", () => {
  it("atomically changes the password, revokes existing sessions and clears the initiating cookie", async () => {
    const stale = await issueSession();
    const response = await patch({ newPassword: "fixture-new-password" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ sessionRevoked: true, redirectTo: "/login" });
    expect(cookieFixture.deleted).toContain("auth_token");
    expect((await getSettings()).password).toMatch(/^\$2/);
    expect(db.get("SELECT value FROM _meta WHERE key = ?", ["dashboardSessionGeneration"]))
      .toBeTruthy();
    expect(await verifyDashboardAuthToken(stale)).toBe(false);
  });

  it("revokes prior sessions when the authentication mode changes", async () => {
    const stale = await issueSession();
    const response = await patch({ authMode: "sso", ssoType: "saml" });
    expect(await response.json()).toMatchObject({ sessionRevoked: true, redirectTo: "/login" });
    expect(await getSettings()).toMatchObject({ authMode: "sso", ssoType: "saml" });
    expect(await verifyDashboardAuthToken(stale)).toBe(false);
  });

  it("resets the password and revokes all existing sessions in one acknowledged mutation", async () => {
    await updateSettings({ password: "fixture-hash" });
    const stale = await issueSession();
    const response = await resetPassword();

    expect(await response.json()).toEqual({
      success: true,
      sessionRevoked: true,
      redirectTo: "/login",
    });
    expect((await getSettings()).password).toBeNull();
    expect(await verifyDashboardAuthToken(stale)).toBe(false);
  });

  it("signs out every session only for an authenticated caller", async () => {
    const first = await issueSession("first");
    const second = await createDashboardAuthToken({ sub: "second" });
    const response = await logout(new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allSessions: true }),
    }));

    expect(await response.json()).toMatchObject({ sessionRevoked: true, redirectTo: "/login" });
    expect(await Promise.all([
      verifyDashboardAuthToken(first),
      verifyDashboardAuthToken(second),
    ])).toEqual([false, false]);

    cookieFixture.values.clear();
    const denied = await logout(new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allSessions: true }),
    }));
    expect(denied.status).toBe(401);
  });

  it("preserves ordinary current-browser logout without changing other session validity", async () => {
    const first = await issueSession("first");
    const second = await createDashboardAuthToken({ sub: "second" });
    const response = await logout();

    expect(await response.json()).toEqual({ success: true });
    expect(cookieFixture.deleted).toContain("auth_token");
    expect(await verifyDashboardAuthToken(first)).toBe(true);
    expect(await verifyDashboardAuthToken(second)).toBe(true);
    expect(db.get("SELECT value FROM _meta WHERE key = ?", ["dashboardSessionGeneration"]))
      .toBeUndefined();
  });
});
