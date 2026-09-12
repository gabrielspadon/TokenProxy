import { NextResponse } from "next/server";
import {
  getStatsFilters,
  getStatsSummary,
  getStatsItems,
  buildStatsWhere,
} from "@/lib/db/repos/requestStatsRepo.js";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DAY_MS = 86400000;
const DEFAULT_WINDOW_MS = 45 * DAY_MS;
const MAX_WINDOW_MS = 366 * DAY_MS;

class StatisticsQueryError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function toDateParam(value, name) {
  if (!value) return null;
  if (value.length > 64) throw new StatisticsQueryError(`${name} is invalid`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new StatisticsQueryError(`${name} is invalid`);
  return d;
}

function positiveInteger(value, fallback, name, max) {
  if (value == null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new StatisticsQueryError(`${name} is invalid`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new StatisticsQueryError(`${name} is outside the supported range`);
  }
  return number;
}

function dimensions(searchParams, name) {
  const raw = searchParams.get(name);
  if (!raw) return undefined;
  const values = raw.split(",").filter(Boolean);
  if (values.length > 50 || values.some((value) => value.length > 200)) {
    throw new StatisticsQueryError(`${name} filter is too large`);
  }
  return values.length ? values : undefined;
}

function boundedRange(searchParams, now = Date.now()) {
  const suppliedStart = toDateParam(searchParams.get("startDate"), "startDate");
  const suppliedEnd = toDateParam(searchParams.get("endDate"), "endDate");
  const endExclusive = suppliedEnd || new Date(now);
  const start = suppliedStart || new Date(endExclusive.getTime() - DEFAULT_WINDOW_MS);
  const span = endExclusive.getTime() - start.getTime();
  if (span <= 0) throw new StatisticsQueryError("startDate must be before endDate");
  if (span > MAX_WINDOW_MS) throw new StatisticsQueryError("Statistics range cannot exceed 366 days");
  return {
    startDate: start.toISOString(),
    // Repository filters are inclusive. Subtracting one millisecond preserves
    // this endpoint's documented half-open [start,end) interval.
    endDate: new Date(endExclusive.getTime() - 1).toISOString(),
    span,
  };
}

export async function getBoundedLegacySeries(filter, span) {
  const db = await getAdapter();
  const bucketSeconds = span <= 2 * DAY_MS ? 300 : span <= 31 * DAY_MS ? 3600 : 86400;
  const { where, params } = buildStatsWhere(filter);
  const rows = db.all(
    `SELECT CAST(CAST(strftime('%s', timestamp) AS INTEGER) / ${bucketSeconds} AS INTEGER) * ${bucketSeconds} AS bucket,
            COUNT(*) AS requests,
            COALESCE(SUM(promptTokens + completionTokens), 0) AS totalTokens,
            COALESCE(SUM(MAX(0, promptTokens - cachedTokens - cacheCreationTokens)), 0) AS inputTokens,
            COALESCE(SUM(completionTokens), 0) AS outputTokens,
            COALESCE(SUM(cachedTokens), 0) AS cacheReadTokens,
            COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens
       FROM requestStats ${where}
      GROUP BY bucket ORDER BY bucket`,
    params,
  );
  return rows.map((row) => {
    const inputTokens = Number(row.inputTokens || 0);
    const cacheReadTokens = Number(row.cacheReadTokens || 0);
    const denominator = inputTokens + cacheReadTokens;
    return {
      label: new Date(Number(row.bucket) * 1000).toISOString(),
      requests: Number(row.requests || 0),
      totalTokens: Number(row.totalTokens || 0),
      inputTokens,
      outputTokens: Number(row.outputTokens || 0),
      cacheReadTokens,
      cacheCreationTokens: Number(row.cacheCreationTokens || 0),
      cacheHitRate: denominator > 0 ? cacheReadTokens / denominator : null,
    };
  });
}

// GET /api/usage/statistics?provider=&connectionId=&model=&startDate=&endDate=&page=&pageSize=
// All aggregation (filters, summary, series, detail items) comes from the
// requestStats table — the 45-day full-history stats source.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = dimensions(searchParams, "provider");
    const connectionId = dimensions(searchParams, "connectionId");
    const model = dimensions(searchParams, "model");
    const { startDate, endDate, span } = boundedRange(searchParams);

    const page = positiveInteger(searchParams.get("page"), 1, "page", 10000);
    const pageSize = positiveInteger(searchParams.get("pageSize"), 50, "pageSize", 100);

    const filter = {
      provider,
      connectionId,
      model,
      startDate,
      endDate,
    };

    const [filters, summary, series, itemsResult] = await Promise.all([
      getStatsFilters({ startDate, endDate }),
      getStatsSummary(filter),
      getBoundedLegacySeries(filter, span),
      getStatsItems({ ...filter, page, pageSize }),
    ]);

    return NextResponse.json(
      {
        filters,
        summary,
        series,
        items: itemsResult.items,
        pagination: itemsResult.pagination,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof StatisticsQueryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.warn("[usage.statistics] unavailable", { name: error?.name || "Error", code: error?.code || null });
    return NextResponse.json({ error: "Statistics unavailable" }, { status: 500 });
  }
}
