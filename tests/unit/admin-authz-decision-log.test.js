// AUTHZ — admin authorization decision lines (docs/logging-design.md rows 6-8).
// Covers the adminDecision contract (by= discriminator, presented/required,
// mutation flag), the shared collector's line shapes, and the /api/admin
// route-gate collector end to end. The frozen admin ABI wire fields
// (status/code/error) are asserted unchanged alongside.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ __adminError: true, status: init?.status, body }),
  },
}));

const guardMocks = vi.hoisted(() => ({
  hasValidCliToken: vi.fn(),
  isLocalRequest: vi.fn(),
}));
const sessionMocks = vi.hoisted(() => ({ verifyDashboardAuthToken: vi.fn() }));
const keyMocks = vi.hoisted(() => ({ resolveClientApiKey: vi.fn() }));
const repoMocks = vi.hoisted(() => ({ validateApiKey: vi.fn() }));

vi.mock("@/dashboardGuard", () => ({
  hasValidCliToken: guardMocks.hasValidCliToken,
  isLocalRequest: guardMocks.isLocalRequest,
}));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: sessionMocks.verifyDashboardAuthToken,
}));
vi.mock("@/lib/auth/clientApiKey", () => ({
  resolveClientApiKey: keyMocks.resolveClientApiKey,
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  validateApiKey: repoMocks.validateApiKey,
}));

import { __decide } from "@/shared/observability/decide.js";
import { logAdminAuthz } from "@/lib/admin/authzLog.js";
import { adminDecision } from "@/lib/admin/policy.js";

let lines = [];
let spy;

beforeEach(() => {
  __decide.resetState();
  __decide.disableSink(); // the NDJSON half is fs; these assert the console line
  lines = [];
  spy = vi.spyOn(console, "log").mockImplementation((l) => lines.push(l));
  vi.stubEnv("TOKENPROXY_PEER_TOKEN", "peer-secret");
});
afterEach(() => {
  spy.mockRestore();
  vi.unstubAllEnvs();
});

const admitLines = () => lines.filter((l) => l.includes("AUTHZ.admit"));
const adminRequest = (path = "/api/admin/health", init = {}) =>
  new Request(`http://localhost:20127${path}`, {
    method: "GET",
    headers: { "x-tp-peer-token": "peer-secret", "x-tp-real-ip": "127.0.0.1" },
    ...init,
  });

describe("adminDecision contract", () => {
  it("admits inference class by each of the three conditions, named", () => {
    expect(adminDecision({ authClass: "inference", mutating: false, operator: true, inference: true, loopback: true }))
      .toEqual({ allow: true, by: "operator" });
    expect(adminDecision({ authClass: "inference", mutating: false, operator: false, inference: true, loopback: true }))
      .toEqual({ allow: true, by: "inference" });
    expect(adminDecision({ authClass: "inference", mutating: false, operator: false, inference: false, loopback: true }))
      .toEqual({ allow: true, by: "loopback" });
  });

  it("carries presented/required on the inference-class 401 and keeps the wire", () => {
    const d = adminDecision({ authClass: "inference", mutating: false, operator: false, inference: false, loopback: false });
    expect(d).toMatchObject({
      allow: false,
      status: 401,
      code: "unauthorized",
      presented: "none",
      required: "inference",
    });
    expect(typeof d.error).toBe("string");
  });

  it("carries presented=inference/required=operator on the 403 forbidden_class", () => {
    const d = adminDecision({ authClass: "operator", mutating: false, operator: false, inference: true, loopback: false });
    expect(d).toMatchObject({
      allow: false,
      status: 403,
      code: "forbidden_class",
      presented: "inference",
      required: "operator",
    });
  });

  it("marks the non-loopback mutation refusal so the collector names the peer", () => {
    const d = adminDecision({ authClass: "operator", mutating: true, operator: true, inference: false, loopback: false });
    expect(d).toMatchObject({ allow: false, status: 403, code: "forbidden_loopback", mutation: true });
  });
});

describe("AUTHZ collector lines (logAdminAuthz)", () => {
  it("loopback admit with no key shows by=loopback and all three booleans, peer stamped", () => {
    logAdminAuthz(
      adminRequest(),
      { authClass: "inference", mutating: false, operator: false, inference: false, loopback: true },
      { allow: true, by: "loopback" }
    );
    expect(admitLines()).toHaveLength(1);
    const line = admitLines()[0];
    expect(line).toMatch(/rid=[0-9a-f]{8}/);
    expect(line).toContain("path=/api/admin/health");
    expect(line).toContain("class=inference");
    expect(line).toContain("by=loopback");
    expect(line).toContain("operator=false");
    expect(line).toContain("inference=false");
    expect(line).toContain("loopback=true");
    expect(line).toContain("peer=127.0.0.1");
  });

  it("admits by operator and by inference name their discriminator", () => {
    logAdminAuthz(
      adminRequest("/api/admin/drain"),
      { authClass: "operator", mutating: true, operator: true, inference: false, loopback: false },
      { allow: true, by: "operator" }
    );
    logAdminAuthz(
      adminRequest("/api/admin/health"),
      { authClass: "inference", mutating: false, operator: false, inference: true, loopback: false },
      { allow: true, by: "inference" }
    );
    const [op, inf] = admitLines();
    expect(op).toContain("by=operator");
    expect(op).toContain("operator=true");
    expect(inf).toContain("by=inference");
    expect(inf).toContain("inference=true");
  });

  it("refused carries presented and required; mutation-refused carries the peer class", () => {
    logAdminAuthz(
      adminRequest(),
      { authClass: "inference", mutating: false, operator: false, inference: false, loopback: false },
      { allow: false, status: 401, code: "unauthorized", error: "x", presented: "none", required: "inference" }
    );
    logAdminAuthz(
      adminRequest("/api/admin/activation"),
      { authClass: "operator", mutating: true, operator: true, inference: false, loopback: false },
      { allow: false, status: 403, code: "forbidden_loopback", error: "x", mutation: true }
    );
    const refused = lines.find((l) => l.includes("AUTHZ.refused"));
    expect(refused).toContain("presented=none");
    expect(refused).toContain("required=inference");
    const mutation = lines.find((l) => l.includes("AUTHZ.mutation-refused"));
    expect(mutation).toContain("path=/api/admin/activation");
    expect(mutation).toContain("peer=127.0.0.1");
  });

  it("treats a legacy null decision as an operator admit", () => {
    logAdminAuthz(
      adminRequest(),
      { authClass: "inference", mutating: false, operator: true, inference: false, loopback: true },
      null
    );
    expect(admitLines()[0]).toContain("by=operator");
  });

  it("classifies an unproven peer as unstamped rather than trusting its header", () => {
    const req = new Request("http://localhost:20127/api/admin/health");
    logAdminAuthz(
      req,
      { authClass: "inference", mutating: false, operator: false, inference: false, loopback: true },
      { allow: true, by: "loopback" }
    );
    expect(admitLines()[0]).toContain("peer=unstamped");
  });
});

describe("/api/admin route gate (guard.js) emits through the collector", () => {
  it("loopback GET /api/admin/health with no key emits AUTHZ.admit by=loopback", async () => {
    const { requireAdmin } = await import("@/lib/admin/guard.js");
    guardMocks.hasValidCliToken.mockResolvedValue(false);
    guardMocks.isLocalRequest.mockReturnValue(true);
    sessionMocks.verifyDashboardAuthToken.mockResolvedValue(null);
    keyMocks.resolveClientApiKey.mockResolvedValue({ valid: false, apiKey: null });

    const result = await requireAdmin(adminRequest());
    expect(result).toBeNull();
    const line = admitLines()[0];
    expect(line).toContain("AUTHZ.admit");
    expect(line).toContain("by=loopback");
    expect(line).toContain("path=/api/admin/health");
  });

  it("operator POST from a non-loopback peer refuses with the frozen wire and logs mutation-refused", async () => {
    const { requireAdmin } = await import("@/lib/admin/guard.js");
    guardMocks.hasValidCliToken.mockResolvedValue(true);
    guardMocks.isLocalRequest.mockReturnValue(false);

    const req = new Request("http://203.0.113.7/api/admin/drain", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const result = await requireAdmin(req);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("forbidden_loopback");
    const line = lines.find((l) => l.includes("AUTHZ.mutation-refused"));
    expect(line).toContain("peer=unstamped");
  });

  it("no credential at all refuses with the frozen 401 wire and logs refused presented=none", async () => {
    const { requireAdmin } = await import("@/lib/admin/guard.js");
    guardMocks.hasValidCliToken.mockResolvedValue(false);
    guardMocks.isLocalRequest.mockReturnValue(false);
    sessionMocks.verifyDashboardAuthToken.mockResolvedValue(null);
    keyMocks.resolveClientApiKey.mockResolvedValue({ valid: false, apiKey: null });

    const req = new Request("http://203.0.113.7/api/admin/health");
    const result = await requireAdmin(req);
    expect(result.status).toBe(401);
    expect(result.body.code).toBe("unauthorized");
    const line = lines.find((l) => l.includes("AUTHZ.refused"));
    expect(line).toContain("presented=none");
    expect(line).toContain("required=inference");
  });
});

// Isolate decision semantics from the separately qualified asynchronous transport.
vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));
