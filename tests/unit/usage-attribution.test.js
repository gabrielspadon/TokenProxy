import { beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "../../src/lib/db/driver.js";
import { captureUsagePricing } from "../../src/lib/db/repos/usagePricing.js";
import { saveRequestUsage } from "../../src/lib/db/repos/usageRepo.js";
import { updatePricing } from "../../src/lib/db/repos/pricingRepo.js";
import { createContextTelemetry, recordContextAttempt } from "../../open-sse/handlers/chatCore/contextTelemetry.js";

import { readActivityAnalytics } from "../../src/lib/db/analytics/activityQueries.mjs";
const db = await getAdapter();
const getUsageHistoryPage = async (filter = {}) => {
  const result = readActivityAnalytics(db, { operation: "activity", view: "economics", ...filter });
  return { ...result, rows: result.items.map(r => ({ ...r, sessionId: r.contextSessionId, cost: r.recordedCostUsd })) };
};
const fields = { provider: "fixture", model: "fixture-model", connectionId: "account" };
beforeEach(() => {
  db.run("DELETE FROM usageHistory");
  db.run("DELETE FROM requestStats");
  db.run("DELETE FROM contextSessions");
});
async function attempt(extra = {}) {
  const c = createContextTelemetry({ timestamp: new Date().toISOString(), logicalRequestId: "logical", attempt: 1, ...extra });
  await recordContextAttempt(c, fields);
  return c;
}
const usage = (c, extra = {}) => ({ ...fields, contextTelemetry: c, tokens: { prompt_tokens: 100, completion_tokens: 10 }, ...extra });

describe("exact usage attribution and rate provenance", () => {
  it("retains the pre-dispatch rate after an operator update and links one exact attempt", async () => {
    await updatePricing({ fixture: { "fixture-model": { input: 2, output: 4 } } });
    const c = await attempt({ sessionHash: "a".repeat(64), sessionIdentitySource: "explicit" });
    await updatePricing({ fixture: { "fixture-model": { input: 20, output: 40 } } });
    await saveRequestUsage(usage(c));
    const { rows } = await getUsageHistoryPage({ requestId: c.requestId });
    expect(rows).toHaveLength(1);
    expect(rows[0].estimatedCostUsd).toBeCloseTo(0.00024, 12);
    expect(rows[0]).toMatchObject({ requestId: c.requestId, logicalRequestId: "logical", attempt: 1, reportedCostUsd: null, costSource: "application-estimate", projectId: null });
    const stats = db.get("SELECT * FROM requestStats WHERE id=?", [c.requestId]);
    expect(rows[0].sessionId).toBe(stats.contextSessionId);
    expect(rows[0].rateSnapshotId).toBe(stats.rateSnapshotId);
    expect(rows[0].pricingCapturedAt).toBe(stats.pricingCapturedAt);
    expect(rows[0].rateSnapshot.rates).toMatchObject({ input: 2, output: 4 });
    const next = await captureUsagePricing(fields.provider, fields.model);
    expect(next.id).not.toBe(rows[0].rateSnapshotId);
  });
  it("deduplicates only the exact attempt and counts two actual attempts as one logical request", async () => {
    const c = await attempt();
    const entry = usage(c);
    await Promise.all([saveRequestUsage(entry), saveRequestUsage(entry)]);
    const c2 = await attempt({ attempt: 2 });
    await saveRequestUsage(usage(c2));
    const first = await getUsageHistoryPage({ logicalRequestId: "logical", pageSize: 1 });
    expect(first.summary).toMatchObject({ attempts: 2, logicalRequests: 1, unattributedAttempts: 0 });
    expect(first.rows).toHaveLength(1);
    const second = await getUsageHistoryPage({ logicalRequestId: "logical", pageSize: 1, page: 2 });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].requestId).not.toBe(first.rows[0].requestId);
    expect(second.pagination.hasNext).toBe(false);
    expect(db.get("SELECT SUM(promptTokens) AS n FROM usageHistory").n).toBe(200);
  });
  it("keeps provider-reported USD separate from its estimate, including a real zero", async () => {
    await updatePricing({ fixture: { "fixture-model": { input: 2, output: 4 } } });
    const c = await attempt();
    await saveRequestUsage(usage(c, { tokens: { prompt_tokens: 100, completion_tokens: 10, cost_usd: 0 } }));
    const { rows } = await getUsageHistoryPage();
    expect(rows[0]).toMatchObject({ reportedCostUsd: 0, costSource: "provider-reported", cost: 0 });
    expect(rows[0].estimatedCostUsd).toBeCloseTo(0.00024, 12);
    expect(rows[0].costEvidence).toMatchObject({ field: "cost_usd", currency: "USD", source: "upstream-usage" });
  });
  it("does not invent a currency, a price, an explicit session or historical identities", async () => {
    const c = createContextTelemetry({ logicalRequestId: "unknown", sessionHash: "b".repeat(64), sessionIdentitySource: "inferred", timestamp: new Date().toISOString() });
    await recordContextAttempt(c, { provider: "no-rates", model: "no-rates" });
    await saveRequestUsage({ provider: "no-rates", model: "no-rates", contextTelemetry: c, tokens: { prompt_tokens: 2, completion_tokens: 1, cost: 10 } });
    db.run("INSERT INTO usageHistory(timestamp,provider) VALUES(?,?)", [new Date().toISOString(), "legacy"]);
    const { rows } = await getUsageHistoryPage();
    const current = rows.find(r => r.requestId === c.requestId);
    expect(current).toMatchObject({ estimatedCostUsd: null, reportedCostUsd: null, cost: null, costSource: "unknown", sessionId: null, projectId: null });
    expect(rows.find(r => r.provider === "legacy")).toMatchObject({ requestId: null, logicalRequestId: null, attempt: null, costSource: null, rateSnapshotId: null });
  });
  it("keeps explicit free cache/reasoning rates and merges a partial operator override with defaults", async () => {
    await updatePricing({ fixture: { "fixture-model": { input: 2, output: 4, cached: 0, cache_creation: 0, reasoning: 0 } } });
    const c = await attempt();
    await saveRequestUsage(usage(c, { tokens: { prompt_tokens: 100, cached_tokens: 60, cache_creation_input_tokens: 20, completion_tokens: 10, reasoning_tokens: 5 } }));
    const { rows } = await getUsageHistoryPage();
    expect(rows[0].estimatedCostUsd).toBeCloseTo(0.00006, 12);
    await updatePricing({ openai: { "gpt-4o": { cached: 0 } } });
    const snapshot = await captureUsagePricing("openai", "gpt-4o");
    expect(snapshot.rates.cached).toBe(0); expect(snapshot.rates.input).toBeGreaterThan(0); expect(snapshot.rates.output).toBeGreaterThan(0);
  });
  it("does not convert an undocumented tick scale into provider-reported dollars", async () => {
    const c = createContextTelemetry({ timestamp: new Date().toISOString() });
    await recordContextAttempt(c, { provider: "no-rates", model: "no-rates" });
    await saveRequestUsage({ provider: "no-rates", model: "no-rates", contextTelemetry: c, tokens: { prompt_tokens: 1, completion_tokens: 1, cost_in_usd_ticks: 2500000000 } });
    const { rows } = await getUsageHistoryPage();
    expect(rows[0]).toMatchObject({ reportedCostUsd: null, costSource: "unknown", cost: null, costEvidence: { field: "cost_in_usd_ticks", unit: "unverified-ticks", rawValue: 2500000000 } });
  });
  it("preserves a reported amount when the response omits token quantities", async () => {
    const { saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
    const c = await attempt();
    await saveUsageStats({ ...fields, contextTelemetry: c, tokens: { cost_usd: 0.003 }, silent: true });
    const { rows } = await getUsageHistoryPage();
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ reportedCostUsd: 0.003, estimatedCostUsd: null, inputTokens: null, outputTokens: null, usageSource: "missing" });
  });
  it("rejects malformed pages, limits and attribution dimensions", async () => {
    for (const filter of [{ cursor: "garbage" }, { limit: 0 }, { pageSize: 1001 }, { sessionId: "1 OR 1=1" }, { requestId: "x".repeat(129) }]) {
      await expect(getUsageHistoryPage(filter)).rejects.toThrow();
    }
  });
});
