import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// P-F2: a quota cache miss used to await a live provider fetch (3s timeout)
// INSIDE the serialized selection queue, stalling every admission of the
// provider. Now a TTL-expired snapshot is served immediately (stale-while-
// revalidate) and the refresh runs deduped in the background; concurrent
// misses share one fetch. Fail-open is preserved: a rejecting refresh never
// throws into the caller.

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/localDb", () => ({
  updateProviderConnection: vi.fn().mockResolvedValue(undefined),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn().mockResolvedValue(undefined),
}));

import { evaluateQuota, _clearQuotaCache } from "@/sse/services/quotaGuard.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { updateProviderConnection } from '@/lib/localDb';
import { withRequestLifetime } from 'open-sse/utils/requestLifetime.js';

const okConn = (over = {}) => ({
  id: "c-pf2",
  provider: "claude",
  authType: "oauth",
  quotaPauseThresholds: {},
  ...over,
});

const staleSnapshot = () => ({
  windows: [{ key: "session (5h)", remainingPercentage: 20, resetAt: null, unlimited: false }],
  fetchedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // TTL is 2min
});

beforeEach(() => {
  vi.clearAllMocks();
  _clearQuotaCache();
});
afterEach(() => { _clearQuotaCache(); vi.useRealTimers(); });

describe("quota evidence stale-while-revalidate (P-F2)", () => {
  it("serves a stale snapshot synchronously and refreshes in the background", async () => {
    let resolveFetch;
    getUsageForProvider.mockImplementation(
      () => new Promise((r) => { resolveFetch = r; })
    );
    const r1 = await evaluateQuota(okConn({ lastQuotaSnapshot: staleSnapshot() }));
    // Returned without waiting for the provider fetch to resolve.
    expect(r1.snapshot?.windows?.[0]).toMatchObject({ key: "session (5h)", remainingPercentage: 20 });
    // rawUsage is never paired with evidence the live fetch did not produce.
    expect(r1.rawUsage).toBeNull();
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);

    resolveFetch({ quotas: { "session (5h)": { used: 1, total: 100, remainingPercentage: 99 } } });
    await new Promise((r) => setTimeout(r, 20)); // let the background refresh land

    const r2 = await evaluateQuota(okConn({ lastQuotaSnapshot: staleSnapshot() }));
    expect(r2.snapshot?.windows?.[0]?.remainingPercentage).toBe(99);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1); // refresh did not refetch
  });

  it("dedupes concurrent TTL-expired misses to one in-flight refresh", async () => {
    let resolveFetch;
    getUsageForProvider.mockImplementation(
      () => new Promise((r) => { resolveFetch = r; })
    );
    const conn = () => okConn({ lastQuotaSnapshot: staleSnapshot() });
    const [a, b] = await Promise.all([evaluateQuota(conn()), evaluateQuota(conn())]);
    expect(a.snapshot?.windows?.[0]?.remainingPercentage).toBe(20);
    expect(b.snapshot?.windows?.[0]?.remainingPercentage).toBe(20);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
    resolveFetch({ quotas: { "session (5h)": { used: 1, total: 100, remainingPercentage: 99 } } });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("dedupes a cold-start (no snapshot at all) fetch across concurrent misses", async () => {
    getUsageForProvider.mockResolvedValue({
      quotas: { "session (5h)": { used: 10, total: 100, remainingPercentage: 90 } },
    });
    const conn = okConn({ quotaPauseThresholds: { "session (5h)": 15 } });
    const [a, b] = await Promise.all([evaluateQuota(conn), evaluateQuota(conn)]);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
    expect(a.snapshot?.windows?.[0]?.remainingPercentage).toBe(90);
    expect(b.snapshot?.windows?.[0]?.remainingPercentage).toBe(90);
    expect(a.paused).toBe(false);
  });

  it("fail-open: a rejecting background refresh never reaches the caller", async () => {
    getUsageForProvider.mockRejectedValue(new Error("provider down"));
    const r = await evaluateQuota(okConn({ lastQuotaSnapshot: staleSnapshot() }));
    expect(r.snapshot?.windows?.[0]?.remainingPercentage).toBe(20);
    await new Promise((res) => setTimeout(res, 20)); // let the rejection land
  });

  it("fail-open: a rejecting cold-start fetch still never pauses", async () => {
    getUsageForProvider.mockRejectedValue(new Error("provider down"));
    const r = await evaluateQuota(okConn({ quotaPauseThresholds: { "session (5h)": 15 } }));
    expect(r.paused).toBe(false);
    expect(r.reason).toBe("no-data");
  });

  it.each(['empty', 'fetch-error'])('briefly caches a classified %s response without inventing quota', async failureClass => {
    vi.useFakeTimers();
    if (failureClass === 'empty') getUsageForProvider.mockResolvedValue({ quotas: {} });
    else getUsageForProvider.mockRejectedValue(new Error('provider unavailable'));
    const conn = okConn();
    for (let i = 0; i < 20; i++) {
      expect(await evaluateQuota(conn)).toMatchObject({ paused: false, reason: 'no-data', failureClass, snapshot: null, rawUsage: null });
    }
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await evaluateQuota(conn);
    expect(getUsageForProvider).toHaveBeenCalledTimes(2);
  });

  it('invalidates a negative read when credentials or route configuration change', async () => {
    getUsageForProvider.mockResolvedValue({ quotas: {} });
    await evaluateQuota(okConn({ accessToken: 'test-token-a' }));
    await evaluateQuota(okConn({ accessToken: 'test-token-b' }));
    await evaluateQuota(okConn({ accessToken: 'test-token-b', providerSpecificData: { proxyPoolId: 'other-pool' } }));
    expect(getUsageForProvider).toHaveBeenCalledTimes(3);
  });

  it('does not reuse an older successful snapshot after credential rotation', async () => {
    const snapshot = { ...staleSnapshot(), fetchedAt: new Date().toISOString() };
    getUsageForProvider.mockResolvedValue({ quotas: {} });
    await evaluateQuota(okConn({ accessToken: 'test-token-a', lastQuotaSnapshot: snapshot }));
    expect(getUsageForProvider).not.toHaveBeenCalled();
    const result = await evaluateQuota(okConn({ accessToken: 'test-token-b', lastQuotaSnapshot: snapshot }));
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ reason: 'no-data', snapshot: null });
  });

  it('releases one cancelled waiter without cancelling the shared read', async () => {
    const started = Promise.withResolvers(), fetched = Promise.withResolvers();
    getUsageForProvider.mockImplementation(() => { started.resolve(); return fetched.promise; });
    const cancelled = new AbortController();
    const first = withRequestLifetime(cancelled.signal, () => evaluateQuota(okConn())).catch(error => error);
    await started.promise;
    const second = evaluateQuota(okConn());
    cancelled.abort(new DOMException('fixture cancelled', 'AbortError'));
    expect((await first).name).toBe('AbortError');
    expect(getUsageForProvider.mock.calls[0][2].signal.aborted).toBe(false);
    fetched.resolve({ quotas: { weekly: { remainingPercentage: 90, total: 100 } } });
    expect((await second).snapshot.windows[0].remainingPercentage).toBe(90);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
  });

  it('times out once, clears its timer, and ignores a late provider completion', async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers(), fetched = Promise.withResolvers();
    getUsageForProvider.mockImplementation(() => { started.resolve(); return fetched.promise; });
    const result = evaluateQuota(okConn());
    await started.promise;
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toMatchObject({ reason: 'no-data', failureClass: 'timeout', snapshot: null });
    expect(getUsageForProvider.mock.calls[0][2].signal.aborted).toBe(true);
    const timers = vi.getTimerCount();
    fetched.resolve({ quotas: { weekly: { remainingPercentage: 90, total: 100 } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updateProviderConnection).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timers);
    expect(await evaluateQuota(okConn())).toMatchObject({ failureClass: 'timeout' });
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
  });
});
