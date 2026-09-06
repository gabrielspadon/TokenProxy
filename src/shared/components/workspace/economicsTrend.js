export const TREND_METRICS = [
  {
    key: 'recordedCostUsd',
    samples: 'costSamples',
    name: 'Recorded estimate',
    unit: 'USD',
    color: 'selected',
    axis: 0,
  },
  {
    key: 'uncachedInputTokens',
    samples: 'uncachedInputSamples',
    name: 'Uncached input',
    unit: 'tokens',
    color: 'input',
    axis: 1,
  },
  {
    key: 'cacheReadTokens',
    samples: 'cacheReadSamples',
    name: 'Cache reads',
    unit: 'tokens',
    color: 'cacheRead',
    axis: 1,
  },
  {
    key: 'cacheWriteTokens',
    samples: 'cacheWriteSamples',
    name: 'Cache writes',
    unit: 'tokens',
    color: 'cacheWrite',
    axis: 1,
  },
  {
    key: 'outputTokens',
    samples: 'outputSamples',
    name: 'Output',
    unit: 'tokens',
    color: 'output',
    axis: 1,
  },
];

// A missing observation and an observed zero must remain different on a chart.
export function economicTrendRows(points, bucketMs) {
  const rows = [];
  for (const point of points || []) {
    if (!Number.isFinite(point.bucketStartMs)) continue;
    const previous = rows.at(-1);
    if (previous && bucketMs > 0 && point.bucketStartMs - previous.bucketStartMs > bucketMs) {
      rows.push({ bucketStartMs: previous.bucketStartMs + bucketMs, gap: true });
    }
    rows.push(point);
  }
  return rows.map((row) => ({
    ...row,
    values: TREND_METRICS.map((metric) =>
      !row.gap && row[metric.samples] > 0 && Number.isFinite(row[metric.key])
        ? row[metric.key]
        : null
    ),
  }));
}

export function economicRange(start, end, filters = {}) {
  const lower = filters.start ? Date.parse(filters.start) : -Infinity;
  const upper = filters.end ? Date.parse(filters.end) : Infinity;
  const first = Math.max(start, lower),
    last = Math.min(end, upper);
  return Number.isFinite(first) && Number.isFinite(last) && first < last
    ? [new Date(first).toISOString(), new Date(last).toISOString()]
    : null;
}

export function economicTimeDomain(points = []) {
  const starts = points
    .map((point) => Date.parse(point.firstSeenAt || point.bucketStart))
    .filter(Number.isFinite);
  const ends = points
    .map((point) => Date.parse(point.lastSeenAt || point.bucketEnd || point.bucketStart))
    .filter(Number.isFinite);
  if (!starts.length || !ends.length) return null;
  const start = Math.min(...starts),
    end = Math.max(...ends);
  return { start, end, separated: end - start > 30 * 86400000 };
}

export function economicTick(value, span) {
  return new Date(value).toLocaleString('en-GB', {
    timeZone: 'UTC',
    month: 'short',
    ...(span > 180 * 86400000
      ? { year: 'numeric' }
      : { day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  });
}
