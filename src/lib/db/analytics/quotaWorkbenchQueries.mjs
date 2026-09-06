import { createHash } from 'node:crypto';
import { parseQuotaHistoryQuery } from './quotaHistoryQueries.mjs';
import { analyzeQuotaSeries } from './quotaTrend.mjs';

export const QUOTA_WORKBENCH_MAX_OBSERVATIONS = 5_000;
const FILTERS = ['connectionId', 'provider', 'scope'];
const numeric = (value) => typeof value === 'number' && Number.isFinite(value);

export function parseQuotaWorkbenchQuery(params, { now = Date.now() } = {}) {
  const allowed = new Set(['start', 'end', ...FILTERS]),
    seen = new Set();
  for (const [key] of params) {
    if (!allowed.has(key) || seen.has(key))
      throw new TypeError('Invalid quota workbench parameter');
    seen.add(key);
  }
  if (!params.get('connectionId')) throw new TypeError('Quota workbench requires an account');
  const normalized = new URLSearchParams(params);
  if (!normalized.has('start')) normalized.set('start', '1970-01-01T00:00:00.000Z');
  if (!normalized.has('end')) normalized.set('end', new Date(now).toISOString());
  const query = parseQuotaHistoryQuery(normalized, { now });
  return { start: query.start, end: query.end, filters: query.filters };
}

export function validateQuotaWorkbenchQuery(input) {
  if (
    input?.operation !== 'quota-workbench' ||
    Object.keys(input).some((key) => !['operation', 'start', 'end', 'filters'].includes(key)) ||
    !input.filters ||
    typeof input.filters !== 'object' ||
    Array.isArray(input.filters) ||
    Object.keys(input.filters).some((key) => !FILTERS.includes(key)) ||
    Object.values(input.filters).some((value) => typeof value !== 'string') ||
    typeof input.start !== 'string' ||
    typeof input.end !== 'string'
  )
    throw new TypeError('Invalid quota workbench operation');
  return {
    operation: 'quota-workbench',
    ...parseQuotaWorkbenchQuery(
      new URLSearchParams({ ...input.filters, start: input.start, end: input.end })
    ),
  };
}

export function readQuotaWorkbench(db, query) {
  const clauses = ['capturedAt >= ?', 'capturedAt < ?'];
  const values = [query.start, query.end];
  for (const key of FILTERS) {
    if (query.filters[key] !== undefined) {
      clauses.push(`${key} = ?`);
      values.push(query.filters[key]);
    }
  }
  const where = clauses.join(' AND ');
  const total = db.get(
    `SELECT COUNT(*) AS total FROM quotaObservations WHERE ${where}`,
    values
  ).total;
  const base = {
    total,
    limit: QUOTA_WORKBENCH_MAX_OBSERVATIONS,
    filters: query.filters,
    timeRange: { field: 'capturedAt', start: query.start, end: query.end, endExclusive: true },
    mode: 'passive',
    modelAttribution: 'unavailable',
    series: [],
    complete: total <= QUOTA_WORKBENCH_MAX_OBSERVATIONS,
  };
  if (!base.complete)
    return {
      ...base,
      reason: 'observation_limit',
      instruction: 'Narrow the time range before calculating a forecast.',
    };
  const rows = db.all(
    `SELECT id, connectionId, provider, scope, source, observationKind, resourceType, unit,
    remaining, "limit", percentage, resetAt, observedAt, capturedAt, confidence, windowDurationMs, windowType
    FROM quotaObservations WHERE ${where} ORDER BY observedAt ASC, capturedAt ASC, id ASC LIMIT ?`,
    [...values, QUOTA_WORKBENCH_MAX_OBSERVATIONS]
  );
  const grouped = new Map();
  for (const row of rows) {
    // Never let an unknown absolute amount join a known percentage scale.
    const measurement =
      row.unit && (numeric(row.remaining) || !numeric(row.percentage)) ? 'absolute' : 'percentage';
    const dimensions = {
      connectionId: row.connectionId,
      provider: row.provider,
      scope: row.scope,
      source: row.source,
      observationKind: row.observationKind,
      resourceType: row.resourceType,
      unit: row.unit,
      windowDurationMs: row.windowDurationMs,
      windowType: row.windowType,
      measurement,
    };
    const key = JSON.stringify(dimensions);
    if (!grouped.has(key))
      grouped.set(key, {
        id: createHash('sha256').update(key).digest('hex'),
        ...dimensions,
        rows: [],
      });
    grouped.get(key).rows.push(row);
  }
  if (grouped.size > 64)
    return {
      ...base,
      complete: false,
      reason: 'series_limit',
      instruction: 'Select one quota scope before calculating a forecast.',
    };
  base.series = [...grouped.values()]
    .map(({ rows: observations, ...series }) => ({
      ...series,
      analysis: {
        ...analyzeQuotaSeries(observations, { asOf: query.end, measurement: series.measurement }),
        ...(series.observationKind !== 'observed' ? { state: 'not_observed' } : {}),
      },
      points: observations.map((row) => ({
        id: row.id,
        observedAt: row.observedAt,
        capturedAt: row.capturedAt,
        value: series.measurement === 'percentage' ? row.percentage : row.remaining,
        limit: series.measurement === 'percentage' ? null : row.limit,
        percentage: row.percentage,
        resetAt: row.resetAt,
        confidence: row.confidence,
      })),
      coverage: {
        records: observations.length,
        timed: observations.filter((row) => row.observedAt !== null).length,
        measured: observations.filter((row) =>
          numeric(series.measurement === 'percentage' ? row.percentage : row.remaining)
        ).length,
      },
    }))
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));
  if (Buffer.byteLength(JSON.stringify(base)) > 8 * 1024 * 1024)
    return {
      ...base,
      series: [],
      complete: false,
      reason: 'response_limit',
      instruction: 'Narrow the time range before displaying this evidence.',
    };
  return base;
}
