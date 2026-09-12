import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  cookies: vi.fn(),
  getSettings: vi.fn(),
  isOidcConfigured: vi.fn(),
  getDashboardAuthSession: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/auth/oidc", () => ({
  isOidcConfigured: mocks.isOidcConfigured,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: mocks.getDashboardAuthSession,
}));

const { GET } = await import("../../src/app/api/auth/status/route.js");

describe("GET /api/auth/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("INITIAL_PASSWORD", "");
    mocks.getSettings.mockResolvedValue({ requireLogin: true, authMode: "password" });
    mocks.cookies.mockResolvedValue({ get: vi.fn(() => ({ value: "session-token" })) });
    mocks.isOidcConfigured.mockReturnValue(false);
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [null, "", "default"],
    [null, "private-bootstrap-value", "environment"],
    ["stored-hash-value", "private-bootstrap-value", "stored"],
  ])("reports effective password source without exposing secrets (%s, configured env)", async (password, initial, source) => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, password });
    vi.stubEnv("INITIAL_PASSWORD", initial);
    const response = await GET();
    expect(response.body.passwordSource).toBe(source);
    expect(response.body.hasPassword).toBe(Boolean(password));
    expect(JSON.stringify(response.body)).not.toContain("private-bootstrap-value");
    expect(JSON.stringify(response.body)).not.toContain("stored-hash-value");
  });

  it("does not assert a default password when status is unreadable", async () => {
    mocks.getSettings.mockRejectedValue(new Error("unavailable"));
    const response = await GET();
    expect(response.body.passwordSource).toBeNull();
    expect(response.body.authenticated).toBe(false);
  });

  it("reports an authenticated session when the auth cookie is valid", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });

    const response = await GET();

    expect(response.body.authenticated).toBe(true);
    expect(mocks.getDashboardAuthSession).toHaveBeenCalledWith("session-token");
  });

  it("reports unauthenticated when the auth cookie is invalid", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.body.authenticated).toBe(false);
  });

  it("fails closed when status dependencies throw", async () => {
    mocks.getSettings.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();

    expect(response.body.authenticated).toBe(false);
    expect(response.body.requireLogin).toBe(true);
  });

  // The secret is read when a session is signed or verified, not when the module
  // is imported, so importing the route no longer requires one. What must stay
  // true is the direction of failure: issuing a session without a secret raises,
  // and verifying one answers "not a session" rather than throwing past the
  // caller. Asserting the import threw only ever proved where the read happened.
  it.each([undefined, ""])("fails during session initialization without a JWT secret (%j)", async (jwtSecret) => {
    const savedJwtSecret = process.env.JWT_SECRET;
    if (jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = jwtSecret;

    try {
      vi.resetModules();
      const session = await vi.importActual("../../src/lib/auth/dashboardSession.js");
      await expect(session.createDashboardAuthToken({ sub: "no-secret" }))
        .rejects.toThrow("JWT_SECRET environment variable is required");
      await expect(session.getDashboardAuthSession("any.token.value")).resolves.toBeNull();
      await expect(session.verifyDashboardAuthToken("any.token.value")).resolves.toBe(false);
    } finally {
      if (savedJwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = savedJwtSecret;
      vi.resetModules();
    }
  });
});
