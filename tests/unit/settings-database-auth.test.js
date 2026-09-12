import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  exportDb: vi.fn(),
  importDb: vi.fn(),
  getSettings: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  verifyDashboardPassword: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  hasValidCliToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  exportDb: mocks.exportDb,
  importDb: mocks.importDb,
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: mocks.applyOutboundProxyEnv,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardPassword: mocks.verifyDashboardPassword,
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

vi.mock("@/dashboardGuard", () => ({
  hasValidCliToken: mocks.hasValidCliToken,
}));

const { GET, POST } =
  await import("../../src/app/api/settings/database/route.js");

function request({
  cliToken = undefined,
  password = undefined,
  jwt = undefined,
  body = undefined,
} = {}) {
  const cookies = [];
  if (jwt) cookies.push({ name: "auth_token", value: jwt });
  return {
    headers: new Headers({
      ...(cliToken ? { "x-tp-cli-token": cliToken } : {}),
      ...(password ? { "x-tp-password": password } : {}),
    }),
    cookies: { get: (name) => cookies.find((c) => c.name === name) },
    json: async () => body,
  };
}

describe("settings/database auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportDb.mockResolvedValue({ ok: true });
    mocks.importDb.mockResolvedValue();
    mocks.getSettings.mockResolvedValue({});
  });

  it("rejects junk CLI token with no password (presence-only bypass)", async () => {
    mocks.hasValidCliToken.mockResolvedValue(false);
    mocks.verifyDashboardPassword.mockResolvedValue(false);

    const res = await GET(request({ cliToken: "junk" }));
    expect(res.status).toBe(401);
    expect(mocks.exportDb).not.toHaveBeenCalled();

    const postRes = await POST(
      request({ cliToken: "junk", body: { settings: {} } }),
    );
    expect(postRes.status).toBe(401);
    expect(mocks.importDb).not.toHaveBeenCalled();
  });

  it("accepts valid JWT plus correct password", async () => {
    mocks.hasValidCliToken.mockResolvedValue(false);
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    mocks.verifyDashboardPassword.mockResolvedValue(true);

    const res = await GET(
      request({ jwt: "valid.jwt.token", password: "secret" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.exportDb).toHaveBeenCalledOnce();

    const postRes = await POST(
      request({
        jwt: "valid.jwt.token",
        body: { settings: {}, password: "secret" },
      }),
    );
    expect(postRes.status).toBe(200);
    expect(mocks.importDb).toHaveBeenCalledWith({ settings: {} });
  });

  it("rejects valid identity with wrong password", async () => {
    mocks.hasValidCliToken.mockResolvedValue(true);
    mocks.verifyDashboardPassword.mockResolvedValue(false);

    const res = await GET(request({ cliToken: "valid", password: "wrong" }));
    expect(res.status).toBe(401);
    expect(mocks.exportDb).not.toHaveBeenCalled();
  });

  it("rejects a stale dashboard cookie even when the supplied password is correct", async () => {
    mocks.hasValidCliToken.mockResolvedValue(false);
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.verifyDashboardPassword.mockResolvedValue(true);

    const res = await GET(request({ jwt: "stale.generation.token", password: "secret" }));
    expect(res.status).toBe(401);
    expect(mocks.exportDb).not.toHaveBeenCalled();
  });
});
