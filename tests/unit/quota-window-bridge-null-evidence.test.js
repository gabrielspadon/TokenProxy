import { describe, expect, it } from "vitest";
import { toRankerWindow, toRankerWindows } from "../../src/shared/utils/quotaWindowBridge.js";
import { rankAccounts, windowHorizonMs } from "../../src/shared/utils/quotaRanking.js";

const now = Date.parse("2026-09-06T18:00:00Z");
const observedAt = "2026-09-06T17:59:00.000Z";
const resetAt = "2026-09-06T20:00:00.000Z";
const snapshot = { key: "session (5h)", remainingPercentage: 90, resetAt };
const convert = (raw, partial = {}) => toRankerWindow({ ...snapshot, ...partial }, raw, { observedAt, now });

describe("quota source absence cannot become measured capacity", () => {
  it.each([null, undefined, "", "   ", false, true, [], {}, NaN, Infinity, -Infinity])("ignores missing/invalid remaining %j and uses real usage", (remaining) => {
    expect(convert({ total: 100, remaining, used: 10 })).toMatchObject({ remaining: 90, limit: 100, confidence: "fresh" });
  });
  it.each([null, undefined, "", "   ", false, true, [], {}, NaN, Infinity, -Infinity])("does not manufacture full measured capacity from usage %j", (used) => {
    expect(convert({ total: 100, used })).toMatchObject({ remaining: 90, limit: 100, confidence: "unknown" });
  });
  it.each([null, undefined, "", "   ", false, true, [], {}, NaN, Infinity, -Infinity])("does not manufacture zero from missing percentage %j", (remainingPercentage) => {
    expect(convert({ total: 100, used: null }, { remainingPercentage })).toBeNull();
  });
  it("preserves genuine zero measurements and finite numeric strings accepted by usage adapters", () => {
    expect(convert({ total: 100, remaining: 0, used: 10 })).toMatchObject({ remaining: 0, confidence: "fresh" });
    expect(convert({ total: "100", remaining: "0", used: "10" })).toMatchObject({ remaining: 0, limit: 100, confidence: "fresh" });
    expect(convert({ total: "100", remaining: null, used: " 10 " })).toMatchObject({ remaining: 90, confidence: "fresh" });
    expect(convert({ total: 100, used: 0 })).toMatchObject({ remaining: 100, confidence: "fresh" });
  });
  it("never promotes a boolean or blank total into a measured scale", () => {
    for (const total of [true, false, "", " ", null, undefined, NaN, Infinity]) {
      expect(convert({ total, remaining: 0 })).toMatchObject({ remaining: 90, confidence: "unknown" });
    }
  });
  it("preserves scope, observed time, reset deadline and the ranker's horizon", () => {
    const row = convert({ total: 100, remaining: null, used: 10 });
    expect(row).toMatchObject({ scope: snapshot.key, observedAt, resetAt });
    expect(windowHorizonMs(row.scope)).toBe(18_000_000);
    expect(convert({ total: 100, remaining: null, used: 10 }, { resetAt: null })).toBeNull();
  });
  it("keeps ranker admission valid for a measured 90 instead of falsely exhausting the account", () => {
    const corrected = convert({ total: 100, remaining: null, used: 10 });
    const result = rankAccounts([{ id: "actual-remaining", windows: [corrected] }], { now });
    expect(result.eligible.map((r) => r.id)).toEqual(["actual-remaining"]);
    const noAbsolute = convert({ total: 100, used: null });
    const cohort = rankAccounts([{ id: "uncertain", windows: [noAbsolute] }, { id: "measured", windows: [corrected] }], { now });
    expect(cohort.winner.id).toBe("measured");
  });
  it("keeps batch raw-key alignment and caller state intact", () => {
    const raw = { quotas: { "session (5h)": { total: 100, remaining: null, used: 10 }, "weekly (7d)": { total: 200, used: null } } };
    const evidence = { fetchedAt: observedAt, windows: [snapshot, { key: "weekly (7d)", remainingPercentage: 45, resetAt }] };
    const before = JSON.stringify({ raw, evidence });
    const rows = toRankerWindows(evidence, raw, { now });
    expect(rows.map((r) => [r.scope, r.remaining, r.confidence])).toEqual([["session (5h)", 90, "fresh"], ["weekly (7d)", 45, "unknown"]]);
    expect(JSON.stringify({ raw, evidence })).toBe(before);
  });
});
