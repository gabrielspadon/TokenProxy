import { describe, it, expect } from "vitest";
import { projectEligibility } from "../../src/lib/admin/eligibility.js";

const now = Date.parse("2026-09-06T18:00:00Z");
const observedAt = "2026-09-06T17:59:00.000Z";
const resetAt = "2026-09-06T20:00:00.000Z";
const model = "claude-fable-4.8";
const allowed = (id = "configured") => ({ id, provider: "claude", isActive: true,
  providerSpecificData: { enabledModels: [model] }, accessToken: "SYNTHETIC_SECRET" });
const project = (connections, extra = {}) => projectEligibility({ connections, provider: "claude", model,
  windowsByConnection: new Map(), now, ...extra });

describe("passive account and model evidence", () => {
  it("distinguishes explicit local permission from unknown provider entitlement", () => {
    const result = project([allowed(), { id: "unrestricted", provider: "claude", isActive: true, testStatus: "active" },
      { ...allowed("excluded"), providerSpecificData: { enabledModels: ["different-model"] } }]);
    expect(result.accounts.map((a) => a.verdict)).toEqual(["admissible", "unknown", "blocked"]);
    expect(result.accounts.map((a) => a.modelSupport.status)).toEqual(["configured", "unknown", "excluded"]);
    expect(result.accounts[1].localAdmission).toBe("allowed");
    expect(result.upstreamVerified).toBe(false);
    expect(result.accounts.every((a) => a.modelSupport.upstreamVerified === false)).toBe(true);
  });
  it("never promotes a credential check or default active status to model verification", () => {
    const result = project([{ id: "c", provider: "codex", isActive: true, testStatus: "active" }], {
      provider: "codex", model: "gpt-5.6", qualifications: { c: { ok: true, model: "gpt-5.6", checkedAt: observedAt, error: "SYNTHETIC_SECRET" } },
    }).accounts[0];
    expect(result.verdict).toBe("unknown");
    expect(result.qualification).toMatchObject({ status: "passed", observedAt, kind: "credential-check", modelSupportVerified: false });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
  });
  it("preserves all accounts and explains simultaneous blockers without leaking errors", () => {
    const c = { ...allowed(), isActive: false, modelLock___all: resetAt,
      [`modelLock_${model}`]: "2026-09-06T17:00:00Z", [`modelFailure___all`]: { until: resetAt, message: "SYNTHETIC_SECRET" } };
    const result = project([c, { id: "other", provider: "codex", isActive: true }], {
      drains: { configured: { isDraining: true, requestedAt: observedAt } },
    });
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0].reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["account-disabled", "account-draining", "model-cooldown"]));
    expect(result.accounts[0].cooldownUntil).toBe(resetAt);
    expect(result.accounts[1].reasons[0].code).toBe("provider-mismatch");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
  });
  it("distinguishes enforced model disables from a provider flag not enforced on authenticated accounts", () => {
    const result = project([allowed()], { settings: { disabledProviders: { claude: true } }, disabledModels: { cc: [model], claude: [model] } }).accounts[0];
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["provider-disable-not-enforced", "model-disabled"]));
    expect(result.reasons.find((r) => r.code === "provider-disable-not-enforced").effect).toBe("context");
  });
  it("does not widen exact-prefix disables across aliases or account listing settings", () => {
    const result = project([allowed()], { disabledModels: { cc: [model], "cc::configured": [model] } }).accounts[0];
    expect(result.verdict).toBe("admissible");
    expect(result.reasons.some((r) => r.code === "model-disabled")).toBe(false);
    const aliasRequest = project([allowed()], { provider: "cc", disabledModels: { cc: [model] } });
    expect(aliasRequest.requested.routePrefix).toBe("cc");
    expect(aliasRequest.accounts[0].verdict).toBe("blocked");
  });
  it("uses the real scoped quota rule and keeps unknown windows fail-open", () => {
    const conns = [allowed("empty"), allowed("bad"), allowed("exhausted"), allowed("other-family")];
    const windowsByConnection = new Map([
      ["bad", [{ scope: "weekly (7d)", remaining: null, limit: null }]],
      ["exhausted", [{ scope: "weekly (7d)", remaining: 0, limit: 100, resetAt, observedAt }]],
      ["other-family", [{ scope: "weekly Sonnet (7d)", remaining: 0, limit: 100, resetAt, observedAt }]],
    ]);
    const result = project(conns, { windowsByConnection });
    expect(result.accounts.map((a) => a.verdict)).toEqual(["admissible", "admissible", "blocked", "admissible"]);
    expect(result.accounts[1].quotaEvidence.windows[0].remaining).toBeNull();
  });
  it("reports pause thresholds and recorded model exhaustion as stored gates", () => {
    const c = { ...allowed(), authType: "oauth", quotaPauseThresholds: { "weekly (7d)": 15 },
      lastQuotaSnapshot: { fetchedAt: observedAt, windows: [{ key: "weekly (7d)", remainingPercentage: 10, resetAt }] } };
    expect(project([c]).accounts[0].reasons.some((r) => r.code === "quota-threshold")).toBe(true);
    const ag = { ...allowed(), provider: "antigravity", lastQuotaSnapshot: { fetchedAt: observedAt, windows: [{ key: model, remainingPercentage: 0, resetAt }] } };
    expect(project([ag], { provider: "antigravity" }).accounts[0].reasons.some((r) => r.code === "model-quota-gate")).toBe(true);
  });
  it("never advances an expired reported deadline in displayed evidence", () => {
    const expired = "2026-09-05T18:00:00.000Z";
    const result = project([allowed()], { windowsByConnection: new Map([["configured", [{ scope: "session (5h)", remaining: 0, limit: 100, resetAt: expired, observedAt }]]]) }).accounts[0];
    expect(result.quotaEvidence.windows[0].resetAt).toBe(expired);
    expect(result.quotaEvidence.windows[0].resetState).toBe("passed");
  });
  it("does not mutate inputs or publish arbitrary stored fields", () => {
    const c = allowed();
    c.providerSpecificData.baseUrl = "https://user:SYNTHETIC_SECRET@example.invalid";
    c.lastError = "SYNTHETIC_SECRET";
    const before = JSON.stringify(c);
    const result = project([c]);
    expect(JSON.stringify(c)).toBe(before);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
    expect(result.capabilities.source).toBe("routing-capability-resolver");
    expect(result.capabilities.upstreamVerified).toBe(false);
  });
});
