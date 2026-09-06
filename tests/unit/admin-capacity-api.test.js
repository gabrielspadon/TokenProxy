import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(), conns: vi.fn(), conn: vi.fn(), windows: vi.fn(), oneWindow: vi.fn(),
  drains: vi.fn(), qualifications: vi.fn(), settings: vi.fn(), disabled: vi.fn(), nodes: vi.fn(),
}));
vi.mock("@/lib/admin/guard.js", () => ({ requireAdmin: mocks.guard }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({ getProviderConnections: mocks.conns, getProviderConnectionById: mocks.conn, isConnectionDegraded: () => false }));
vi.mock("@/lib/db/repos/quotaWindowsRepo.js", () => ({ getAllWindows: mocks.windows, getWindows: mocks.oneWindow }));
vi.mock("@/lib/admin/state.js", () => ({ readAllDrainDocs: mocks.drains, readAllQualifications: mocks.qualifications }));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/db/repos/disabledModelsRepo.js", () => ({ getDisabledModels: mocks.disabled }));
vi.mock("@/lib/db/repos/nodesRepo.js", () => ({ getProviderNodes: mocks.nodes }));

import { GET as quota } from "../../src/app/api/admin/quota/route.js";
import { GET as oneQuota } from "../../src/app/api/admin/quota/[connectionId]/route.js";
import { GET as eligibility } from "../../src/app/api/admin/eligibility/route.js";
import { adminAuthClass, adminDecision } from "../../src/lib/admin/policy.js";

const observedAt = "2026-09-06T17:59:00.000Z";
const req = (query = "provider=claude&model=claude-fable-4.8") => new Request(`http://localhost/api/admin/eligibility?${query}`);
const conns = Array.from({ length: 24 }, (_, i) => ({ id: `account-${i}`, provider: "claude", isActive: true,
  providerSpecificData: { enabledModels: i < 3 ? ["claude-fable-4.8"] : ["claude-sonnet-4.6"], secret: "SYNTHETIC_SECRET" },
  accessToken: "SYNTHETIC_SECRET" }));
// 3 unobserved accounts, 18 accounts with two scopes and 3 with one scope.
const windows = new Map(conns.slice(3).map((c, i) => [c.id, Array.from({ length: i < 18 ? 2 : 1 }, (_, j) => ({
  scope: j ? "weekly (7d)" : "session (5h)", remaining: null, limit: null,
  observedAt, resetAt: null, confidence: "unknown", secret: "SYNTHETIC_SECRET",
}))]));

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-06T18:00:00Z"));
  mocks.guard.mockResolvedValue(null); mocks.conns.mockResolvedValue(conns); mocks.windows.mockResolvedValue(windows);
  mocks.conn.mockResolvedValue(conns[0]); mocks.oneWindow.mockResolvedValue([]);
  mocks.drains.mockResolvedValue({}); mocks.qualifications.mockResolvedValue({});
  mocks.settings.mockResolvedValue({}); mocks.disabled.mockResolvedValue({});
  mocks.nodes.mockResolvedValue([]);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No upstream contact allowed"); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("passive capacity and eligibility API", () => {
  it("returns every account and all 39 stored scopes in one batch without mutation or contact", async () => {
    const before = JSON.stringify({ conns, windows: [...windows] });
    const response = await quota(req()); const body = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.snapshots).toHaveLength(24);
    expect(body.snapshots.reduce((n, s) => n + s.windows.length, 0)).toBe(39);
    expect(body.snapshots.slice(0, 3).every((s) => s.windows.length === 0)).toBe(true);
    expect(body.snapshots.every((s) => s.asOf === body.asOf)).toBe(true);
    expect(mocks.conns).toHaveBeenCalledOnce(); expect(mocks.windows).toHaveBeenCalledOnce();
    expect(JSON.stringify({ conns, windows: [...windows] })).toBe(before);
    expect(JSON.stringify(body)).not.toContain("SYNTHETIC_SECRET"); expect(fetch).not.toHaveBeenCalled();
  });
  it("returns 24 eligibility cells with only 3 configured for the requested model", async () => {
    const response = await eligibility(req()); const body = await response.json();
    expect(response.status).toBe(200); expect(body.accounts).toHaveLength(24);
    expect(body.accounts.filter((a) => a.verdict === "admissible")).toHaveLength(3);
    expect(body.accounts.filter((a) => a.verdict === "blocked")).toHaveLength(21);
    expect(body.accounts.every((a) => a.modelSupport.upstreamVerified === false)).toBe(true);
    for (const read of [mocks.conns, mocks.windows, mocks.drains, mocks.qualifications, mocks.settings, mocks.disabled, mocks.nodes]) expect(read).toHaveBeenCalledOnce();
    expect(JSON.stringify(body)).not.toContain("SYNTHETIC_SECRET"); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["openai-compatible-fixture-node", "fixture-proxy"])("the actual endpoint resolves configured %s without provider discovery", async (provider) => {
    mocks.nodes.mockResolvedValue([{ id: "openai-compatible-fixture-node", prefix: "fixture-proxy", type: "openai-compatible", baseUrl: "SYNTHETIC_SECRET" }]);
    mocks.conns.mockResolvedValue([{ id: "node-account", provider: "openai-compatible-fixture-node", isActive: true, providerSpecificData: { enabledModels: ["vendor/model"] } }]);
    mocks.disabled.mockResolvedValue({ "fixture-proxy::node-account": ["vendor/model"] });
    const response = await eligibility(req(`provider=${provider}&model=vendor%2Fmodel`));
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.requested.provider).toBe("openai-compatible-fixture-node");
    expect(body.accounts[0].verdict).toBe("blocked");
    expect(body.accounts[0].reasons.some((r) => r.code === "model-disabled")).toBe(true);
    expect(body.accounts[0].reasons.some((r) => r.code === "provider-mismatch")).toBe(false);
    expect(mocks.nodes).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("SYNTHETIC_SECRET");
  });
  it.each(["", "provider=claude", "provider=claude&model=%00", `provider=claude&model=${"x".repeat(513)}`])("rejects malformed query %j before reading state", async (query) => {
    expect((await eligibility(req(query))).status).toBe(400);
    expect(mocks.conns).not.toHaveBeenCalled(); expect(mocks.windows).not.toHaveBeenCalled();
  });
  it("requires operator authorization and returns the guard refusal before state reads", async () => {
    expect(adminAuthClass("/api/admin/eligibility")).toBe("operator");
    const decision = adminDecision({ authClass: "operator", mutating: false, operator: false, inference: true, loopback: true });
    expect(decision.status).toBe(403);
    const refusal = Response.json(decision, { status: decision.status }); mocks.guard.mockResolvedValue(refusal);
    expect(await eligibility(req())).toBe(refusal); expect(await quota(req())).toBe(refusal);
    expect(mocks.conns).not.toHaveBeenCalled(); expect(mocks.windows).not.toHaveBeenCalled();
  });
  it("distinguishes an unobserved account from an absent account", async () => {
    let response = await oneQuota(req(), { params: Promise.resolve({ connectionId: "account-0" }) });
    expect(response.status).toBe(200); expect((await response.json()).windows).toEqual([]);
    mocks.conn.mockResolvedValue(null);
    response = await oneQuota(req(), { params: Promise.resolve({ connectionId: "missing" }) });
    expect(response.status).toBe(404); expect(mocks.oneWindow).toHaveBeenCalledOnce();
  });
  it.each([quota, eligibility])("redacts storage errors instead of returning credential-bearing exception text", async (handler) => {
    mocks.conns.mockRejectedValue(new Error("SYNTHETIC_SECRET"));
    const response = await handler(req()); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("SYNTHETIC_SECRET");
  });
});
