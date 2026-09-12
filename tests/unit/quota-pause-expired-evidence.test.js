import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPausedWindow, getQuotaPauseInfo, isQuotaPaused, deriveQuotaSnapshot } from "../../src/shared/utils/quotaPause.js";
import { rankAccounts } from "../../src/shared/utils/quotaRanking.js";
import { toRankerWindows } from "../../src/shared/utils/quotaWindowBridge.js";
import { projectEligibility } from "../../src/lib/admin/eligibility.js";

const mocks = vi.hoisted(() => ({ usage: vi.fn(), update: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.usage }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
vi.mock("@/lib/localDb", () => ({ updateProviderConnection: mocks.update }));
import { evaluateQuota, _clearQuotaCache } from "../../src/sse/services/quotaGuard.js";
import { bindQuotaSnapshot } from '@/sse/services/quotaEvidenceIdentity.js';

const now = Date.parse("2026-09-06T18:00:00Z");
const future = "2026-09-07T18:00:00.000Z";
const expired = "2026-09-01T18:00:00.000Z";
const account = (remainingPercentage, resetAt = future) => ({ id: "quota-test", provider: "claude", authType: "oauth",
  quotaPauseThresholds: { "weekly (7d)": 5 }, lastQuotaSnapshot: { fetchedAt: expired,
    windows: [{ key: "weekly (7d)", remainingPercentage, resetAt }] } });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); _clearQuotaCache(); mocks.usage.mockResolvedValue({}); });
afterEach(() => { _clearQuotaCache(); vi.useRealTimers(); });

describe("expired and missing quota observations cannot pause selection", () => {
  it("releases an expired zero balance without changing the historical evidence", () => {
    const conn = account(0, expired); const before = JSON.stringify(conn);
    expect(getPausedWindow(conn, now)).toBeNull(); expect(isQuotaPaused(conn, now)).toBe(false);
    const info = getQuotaPauseInfo(conn, now);
    expect(info.paused).toBe(false); expect(info.windows[0]).toMatchObject({ remainingPercentage: 0, paused: false });
    expect(JSON.stringify(conn)).toBe(before);
    expect(rankAccounts([{ id: conn.id, windows: toRankerWindows(conn.lastQuotaSnapshot, null, { now }) }], { now }).eligible).toHaveLength(1);
  });
  it("uses the same inclusive reset boundary in the routing helper and display", () => {
    const conn = account(0, new Date(now).toISOString());
    expect(isQuotaPaused(conn, now)).toBe(false); expect(getQuotaPauseInfo(conn, now).windows[0].paused).toBe(false);
    expect(isQuotaPaused(conn, now - 1)).toBe(true);
  });
  it.each([null, undefined, "", "   ", false, true, [], {}, NaN, Infinity, -1, 101])("does not turn %j into usable percentage evidence", (value) => {
    const conn = account(value);
    expect(getPausedWindow(conn, now)).toBeNull();
    expect(getQuotaPauseInfo(conn, now).windows[0]).toMatchObject({ remainingPercentage: null, paused: false });
  });
  it("retains an actual zero and an adapter-compatible numeric string before reset", () => {
    expect(isQuotaPaused(account(0), now)).toBe(true);
    expect(isQuotaPaused(account("0"), now)).toBe(true);
    expect(isQuotaPaused(account(0, null), now)).toBe(true);
  });
  it("can still pause on an unexpired sibling after the expired window releases", () => {
    const conn = account(0, expired); conn.quotaPauseThresholds["session (5h)"] = 5;
    conn.lastQuotaSnapshot.windows.push({ key: "session (5h)", remainingPercentage: 1, resetAt: future });
    expect(getPausedWindow(conn, now)?.key).toBe("session (5h)");
  });
  it("does not derive a full percentage balance from missing used values", () => {
    for (const used of [null, undefined, "", false, [], {}, NaN, Infinity]) {
      expect(deriveQuotaSnapshot("claude", { quotas: { weekly: { total: 100, used } } })).toBeNull();
    }
    expect(deriveQuotaSnapshot("claude", { quotas: { weekly: { total: 100, used: 0 } } }).windows[0].remainingPercentage).toBe(100);
  });
  it("the actual stale-while-refresh quota gate does not bench an expired account", async () => {
    const conn = account(0, expired);
    conn.lastQuotaSnapshot = bindQuotaSnapshot(conn, { strictProxy: false }, conn.lastQuotaSnapshot);
    const before = JSON.stringify(conn);
    const result = await evaluateQuota(conn);
    expect(result.paused).toBe(false); expect(result.reason).toBe("ok");
    expect(result.snapshot.windows[0].remainingPercentage).toBe(0);
    expect(result.snapshot.windows[0].resetAt).toBe(expired);
    expect(mocks.usage).toHaveBeenCalledOnce(); expect(JSON.stringify(conn)).toBe(before);
  });
  it("uses the projection's injected observation time for expiry", () => {
    const conn = { ...account(0), isActive: true, providerSpecificData: { enabledModels: ["model"] } };
    const result = projectEligibility({ connections: [conn], windowsByConnection: new Map(), provider: "claude", model: "model", now: Date.parse(future) + 1 });
    expect(result.accounts[0].verdict).toBe("admissible");
    expect(result.accounts[0].reasons.some((r) => r.code === "quota-threshold")).toBe(false);
  });
});
