import { describe, it, expect } from "vitest";
import { toWindowRecord, toQuotaSnapshot } from "../../src/lib/admin/project.js";

const now = Date.parse("2026-09-06T18:00:00Z");
const observedAt = "2026-09-06T17:59:00.000Z";
const resetAt = "2026-09-06T20:00:00.000Z";

describe("passive quota evidence projection", () => {
  it.each([undefined, null, "", "   ", false, {}, "broken", Infinity])("does not turn %j into measured zero", (value) => {
    const row = toWindowRecord({ remaining: value, limit: value }, { now });
    expect(row.remaining).toBeNull(); expect(row.limit).toBeNull();
    expect(row.resetAt).toBeNull(); expect(row.observedAt).toBeNull();
  });
  it("preserves real zeros and does not reclassify an old measurement as an estimate", () => {
    const row = toWindowRecord({ scope: "weekly (7d)", remaining: 0, limit: 1000, observedAt: "2026-09-06T12:00:00Z", resetAt, confidence: "stale" }, { now });
    expect(row.remaining).toBe(0); expect(row.confidence).toBe("measured");
    expect(row.freshness).toMatchObject({ state: "stale", ageMs: 21_600_000 });
    expect(row.unit).toBeNull(); expect(row.scale).toBe("absolute");
  });
  it("derives only explicitly named durations and keeps passed deadlines unchanged", () => {
    const row = toWindowRecord({ scope: "session (5h)", remaining: 1, limit: 100, observedAt, resetAt: "2026-09-06T17:00:00Z", confidence: "fresh" }, { now });
    expect(row.durationMs).toBe(18_000_000); expect(row.durationSource).toBe("scope-label");
    expect(row.resetAt).toBe("2026-09-06T17:00:00.000Z"); expect(row.resetState).toBe("passed");
    expect(row.freshness.state).toBe("stale");
    expect(toWindowRecord({ scope: "monthly" }, { now }).durationMs).toBeNull();
    expect(toWindowRecord({ scope: "monthly (1mo)" }, { now }).durationMs).toBeNull();
    expect(toWindowRecord({ scope: "annual (1year)" }, { now }).durationMs).toBeNull();
  });
  it("does not identify an unknown synthetic denominator as actual entitlement", () => {
    const row = toWindowRecord({ scope: "weekly (7d)", remaining: 48, limit: 100, observedAt, resetAt, confidence: "unknown" }, { now });
    expect(row.scale).toBe("unknown"); expect(row.unit).toBeNull();
    expect(row.freshness.state).toBe("fresh"); expect(row.confidence).toBe("unknown");
  });
  it("keeps separately sourced percentages and excludes credential-bearing extras", () => {
    const conn = { id: "c1", provider: "claude", accessToken: "SECRET", lastQuotaSnapshot: { fetchedAt: observedAt, windows: [{ key: "weekly (7d)", remainingPercentage: 48, resetAt, secret: "SECRET" }] } };
    const result = toQuotaSnapshot(conn, [{ scope: "weekly (7d)", remaining: 480, limit: 1000, resetAt, observedAt, confidence: "fresh", extra: "SECRET" }], { now });
    expect(result.windows[0].percentage).toMatchObject({ value: 48, observedAt, source: "connection.lastQuotaSnapshot" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(toQuotaSnapshot({ id: "unobserved", provider: "claude" }, [], { now }).windows).toEqual([]);
  });
  it("does not label a future observation as fresh evidence", () => {
    const row = toWindowRecord({ observedAt: resetAt, resetAt }, { now });
    expect(row.freshness).toMatchObject({ state: "unknown", ageMs: null });
  });
});
