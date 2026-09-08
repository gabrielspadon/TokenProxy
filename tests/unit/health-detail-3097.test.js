import { describe, it, expect, vi, beforeEach } from "vitest";

// #3097 — readiness + passive provider monitoring at GET /api/health/detail.
//
// The two invariants worth a test:
//   1. IT ALWAYS ANSWERS 200. /api/health is the liveness probe read by the
//      Dockerfile HEALTHCHECK and external liveness checks; a sibling that
//      500s on a degraded database would train operators (and orchestrators)
//      to treat this family as restart-worthy. The verdict lives in the body.
//   2. AN ANONYMOUS CALLER TRIGGERS NO CONNECTION SCAN. Everything under
//      /api/health/ is public by prefix in src/dashboardGuard.js, and the scan
//      decrypts every enabled row, so it must be both gated and un-amplifiable.

const mocks = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  hasValidCliToken: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: mocks.getProviderConnections,
  isConnectionDegraded: (conn) => conn.degraded === true,
}));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/dashboardGuard", () => ({ hasValidCliToken: mocks.hasValidCliToken }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

const { GET } = await import("@/app/api/health/detail/route.js");

const request = (token) => ({ cookies: { get: () => (token ? { value: token } : undefined) } });
const healthyDb = { driver: "better-sqlite3", get: vi.fn(() => ({ ok: 1 })) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdapter.mockResolvedValue(healthyDb);
  mocks.getSettings.mockResolvedValue({ requireLogin: true });
  mocks.hasValidCliToken.mockResolvedValue(false);
  mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  mocks.getProviderConnections.mockResolvedValue([]);
});

describe("GET /api/health/detail", () => {
  it("gives an anonymous caller readiness only, and never scans connections", async () => {
    const body = await (await GET(request())).json();
    expect(body.detailed).toBe(false);
    expect(body.checks.upstreams.status).toBe("unknown");
    expect(body.checks.database).toEqual({ status: "ok" });
    expect(body.uptimeSeconds).toBeTypeOf("number");
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
  });

  it("proves the database with a real query rather than a handle check", async () => {
    await GET(request());
    expect(healthyDb.get).toHaveBeenCalledWith("SELECT 1 AS ok");
  });

  it("reports status error, still on HTTP 200, when the database is unreachable", async () => {
    mocks.getAdapter.mockRejectedValue(new Error("no driver"));
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.checks.database.status).toBe("error");
  });

  it("groups degraded connections per provider for an authenticated caller", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", name: "one", degraded: false },
      { id: "c2", provider: "claude", name: "two", degraded: true, testStatus: "unavailable", errorCode: 403 },
      { id: "c3", provider: "codex", name: "three", degraded: false },
    ]);
    const body = await (await GET(request("jwt"))).json();

    expect(body.detailed).toBe(true);
    expect(body.status).toBe("degraded");
    expect(body.checks.upstreams).toMatchObject({ status: "degraded", enabled: 3, degraded: 1 });
    expect(body.checks.upstreams.providers.map((p) => p.provider)).toEqual(["claude", "codex"]);
    const claude = body.checks.upstreams.providers[0];
    expect(claude).toMatchObject({ connections: 2, degraded: 1 });
    expect(claude.accounts).toEqual([
      { connectionId: "c2", account: "two", testStatus: "unavailable", errorCode: 403, rateLimitedUntil: null },
    ]);
    expect(body.checks.upstreams.providers[1].accounts).toEqual([]);
  });

  it("reports ok when every enabled connection is healthy", async () => {
    mocks.hasValidCliToken.mockResolvedValue(true);
    mocks.getProviderConnections.mockResolvedValue([{ id: "c1", provider: "kiro", degraded: false }]);
    const body = await (await GET(request())).json();
    expect(body.status).toBe("ok");
    expect(body.checks.upstreams.degraded).toBe(0);
  });

  it("treats requireLogin=false as an operator, matching the rest of /api/*", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    const body = await (await GET(request())).json();
    expect(body.detailed).toBe(true);
    expect(mocks.getProviderConnections).toHaveBeenCalledWith({ isActive: true });
  });
});
