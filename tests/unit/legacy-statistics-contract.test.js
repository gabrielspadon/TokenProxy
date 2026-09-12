import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  filters: vi.fn(async () => ({ providers: [], models: [], accounts: [] })),
  summary: vi.fn(async () => ({ totalRequests: 0 })),
  oldSeries: vi.fn(async () => []),
  items: vi.fn(async ({ page, pageSize }) => ({ items: [], pagination: { page, pageSize } })),
  all: vi.fn(() => []),
}));

vi.mock("@/lib/db/repos/requestStatsRepo.js", () => ({
  getStatsFilters: mocks.filters,
  getStatsSummary: mocks.summary,
  getStatsSeries: mocks.oldSeries,
  getStatsItems: mocks.items,
  buildStatsWhere(filter) {
    return {
      where: "WHERE timestamp >= ? AND timestamp <= ?",
      params: [filter.startDate, filter.endDate],
    };
  },
}));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => ({ all: mocks.all }) }));

const { GET } = await import("../../src/app/api/usage/statistics/route.js");
const call = (query = "") => GET(new Request(`http://localhost/api/usage/statistics?${query}`));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
  vi.clearAllMocks();
  mocks.all.mockReturnValue([]);
});
afterEach(() => vi.useRealTimers());

describe("legacy statistics route bounds", () => {
  it.each([
    "startDate=not-a-date",
    "endDate=not-a-date",
    "startDate=2026-09-12T12%3A00%3A00Z&endDate=2026-09-11T12%3A00%3A00Z",
    "startDate=2025-01-01T00%3A00%3A00Z&endDate=2026-09-12T00%3A00%3A00Z",
    "page=10001",
  ])("rejects invalid or operationally unbounded query %s", async (query) => {
    const response = await call(query);
    expect(response.status).toBe(400);
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.all).not.toHaveBeenCalled();
  });

  it("bounds an omitted range to the last 45 days", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(mocks.summary).toHaveBeenCalledWith(expect.objectContaining({
      startDate: "2026-07-29T12:00:00.000Z",
      endDate: "2026-09-12T11:59:59.999Z",
    }));
  });

  it("defines the API interval as start-inclusive and end-exclusive", async () => {
    await call("startDate=2026-09-10T00%3A00%3A00Z&endDate=2026-09-11T00%3A00%3A00Z");
    expect(mocks.filters).toHaveBeenCalledWith({
      startDate: "2026-09-10T00:00:00.000Z",
      endDate: "2026-09-10T23:59:59.999Z",
    });
    expect(mocks.items).toHaveBeenCalledWith(expect.objectContaining({
      startDate: "2026-09-10T00:00:00.000Z",
      endDate: "2026-09-10T23:59:59.999Z",
    }));
  });

  it("aggregates the bounded time series in SQL instead of loading every request row", async () => {
    mocks.all.mockReturnValue([{ bucket: 1789084800, requests: 2, totalTokens: 15, inputTokens: 9, outputTokens: 3, cacheReadTokens: 2, cacheCreationTokens: 1 }]);
    const body = await (await call("startDate=2026-09-11T00%3A00%3A00Z&endDate=2026-09-12T00%3A00%3A00Z")).json();
    expect(mocks.oldSeries).not.toHaveBeenCalled();
    expect(mocks.all).toHaveBeenCalledOnce();
    expect(mocks.all.mock.calls[0][0]).toMatch(/GROUP BY bucket/);
    expect(body.series).toEqual([expect.objectContaining({ requests: 2, totalTokens: 15, inputTokens: 9 })]);
  });

  it("does not disclose an internal database error", async () => {
    mocks.summary.mockRejectedValueOnce(new Error("sqlite path /secret/operator/data.sqlite"));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Statistics unavailable" });
  });
});
