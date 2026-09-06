const MAX_POINTS = 720;
const MINUTE = 60000;
const GROUPS = new Set(['provider', 'model', 'account']);
const FIELDS = new Set(['operation', 'view', 'groupBy', 'start', 'end', 'provider', 'model', 'connectionId', 'page', 'pageSize']);

export class ActivityQueryError extends Error {}

function date(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ActivityQueryError(`Invalid ${field} timestamp.`);
  }
  const [year, month, day] = value.slice(0,10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year,month,0)).getUTCDate()) {
    throw new ActivityQueryError(`Invalid ${field} timestamp.`);
  }
  return new Date(value).toISOString();
}

function integer(value, fallback, max, field) {
  if (value == null) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new ActivityQueryError(`Invalid ${field}.`);
  return parsed;
}

export function validateActivityQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new ActivityQueryError('Invalid analytics query.');
  for (const key of Object.keys(query)) if (!FIELDS.has(key)) throw new ActivityQueryError('Unknown analytics field.');
  if (query.operation !== 'activity') throw new ActivityQueryError('Invalid analytics operation.');
  const view = query.view ?? 'activity', groupBy = query.groupBy ?? 'provider';
  if (!['activity', 'economics'].includes(view) || !GROUPS.has(groupBy)) throw new ActivityQueryError('Invalid analytics view or grouping.');
  const result = { operation: 'activity', view, groupBy, start: date(query.start, 'start'), end: date(query.end, 'end') };
  if (result.start && result.end && result.start >= result.end) throw new ActivityQueryError('The end must be after the start.');
  for (const key of ['provider', 'model', 'connectionId']) {
    const value = query[key];
    if (value == null || value === '') { result[key] = null; continue; }
    if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new ActivityQueryError('Invalid analytics filter.');
    result[key] = value;
  }
  result.page = integer(query.page, 1, 100000, 'page');
  result.pageSize = integer(query.pageSize, 50, 100, 'page size');
  return result;
}

function filterFor(query) {
  const clauses = [], params = [];
  for (const column of ['provider', 'model', 'connectionId']) {
    if (query[column] !== null) { clauses.push(`${column}=?`); params.push(query[column]); }
  }
  if (query.start) { clauses.push('timestamp>=?'); params.push(query.start); }
  if (query.end) { clauses.push('timestamp<?'); params.push(query.end); }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const validNumber = (field) => `(typeof(${field}) IN ('integer','real') AND ${field}>=0)`;
const quantity = (field) => `CASE WHEN ${validNumber(field)} THEN ${field} ELSE 0 END`;
const jsonQuantity = (field) => quantity(`json_extract(safeTokens,'$.${field}')`);

function baseQuery(db, query) {
  const { sql, params } = filterFor(query);
  if (query.view === 'economics') {
    return { params, sql: `WITH filtered AS (
      SELECT id,timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cost,
        CASE WHEN json_valid(tokens) THEN tokens ELSE '{}' END AS safeTokens,
        CASE WHEN tokens IS NULL OR NOT json_valid(tokens) THEN 1 ELSE 0 END AS missingTokenDetail
      FROM usageHistory ${sql}
    ), quantities AS MATERIALIZED (
      SELECT id,timestamp,provider,model,connectionId,status,
        ${quantity('promptTokens')} AS prompt,${quantity('completionTokens')} AS output,
        ${jsonQuantity('cached_tokens')} AS cacheRead,${jsonQuantity('cache_creation_input_tokens')} AS cacheWrite,
        CASE WHEN ${validNumber('cost')} THEN cost END AS recordedCost,
        CASE WHEN NOT ${validNumber('promptTokens')} OR NOT ${validNumber('completionTokens')} THEN 1 ELSE 0 END AS invalidTokens,
        missingTokenDetail,NULL AS latencyMs,NULL AS ttftMs,NULL AS contextSessionId
      FROM filtered
    ), records AS (SELECT *,MAX(0,prompt-cacheRead-cacheWrite) AS uncachedInput,
      CASE WHEN cacheRead+cacheWrite>prompt THEN 1 ELSE 0 END AS inconsistentCache FROM quantities)` };
  }
  const columns = new Set(db.all('PRAGMA table_info(requestStats)', []).map((row) => row.name));
  const contextId = columns.has('contextSessionId') ? 'contextSessionId' : 'NULL AS contextSessionId';
  return { params, sql: `WITH quantities AS (
    SELECT id,timestamp,provider,model,connectionId,status,
      ${quantity('promptTokens')} AS prompt,${quantity('completionTokens')} AS output,
      ${quantity('cachedTokens')} AS cacheRead,${quantity('cacheCreationTokens')} AS cacheWrite,
      NULL AS recordedCost,
      CASE WHEN NOT ${validNumber('promptTokens')} OR NOT ${validNumber('completionTokens')}
        OR NOT ${validNumber('cachedTokens')} OR NOT ${validNumber('cacheCreationTokens')} THEN 1 ELSE 0 END AS invalidTokens,
      0 AS missingTokenDetail,CASE WHEN ${validNumber('latencyTotal')} AND latencyTotal>0 THEN latencyTotal END AS latencyMs,
      CASE WHEN ${validNumber('latencyTtft')} AND latencyTtft>0 THEN latencyTtft END AS ttftMs,${contextId}
    FROM requestStats ${sql}
  ), records AS (SELECT *,MAX(0,prompt-cacheRead-cacheWrite) AS uncachedInput,
    CASE WHEN cacheRead+cacheWrite>prompt THEN 1 ELSE 0 END AS inconsistentCache FROM quantities)` };
}

const TOTALS = `COUNT(*) AS records,COALESCE(SUM(prompt),0) AS inputTokens,
  COALESCE(SUM(uncachedInput),0) AS uncachedInputTokens,COALESCE(SUM(cacheRead),0) AS cacheReadTokens,
  COALESCE(SUM(cacheWrite),0) AS cacheWriteTokens,COALESCE(SUM(output),0) AS outputTokens,
  COALESCE(SUM(CASE WHEN status IN ('success','ok') THEN 1 ELSE 0 END),0) AS succeeded,
  COALESCE(SUM(CASE WHEN status IN ('error','aborted','cancelled') THEN 1 ELSE 0 END),0) AS failed,
  COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS recordedPending,
  COALESCE(SUM(invalidTokens),0) AS invalidTokenRows,COALESCE(SUM(inconsistentCache),0) AS inconsistentCacheRows,
  COALESCE(SUM(missingTokenDetail),0) AS missingTokenDetailRows,
  COALESCE(SUM(CASE WHEN strftime('%s',timestamp) IS NULL THEN 1 ELSE 0 END),0) AS invalidTimestampRows,
  SUM(recordedCost) AS recordedCostUsd,COUNT(recordedCost) AS costSamples,
  COALESCE(SUM(CASE WHEN recordedCost=0 THEN 1 ELSE 0 END),0) AS zeroCostRows,
  AVG(latencyMs) AS averageLatencyMs,MIN(latencyMs) AS minimumLatencyMs,MAX(latencyMs) AS maximumLatencyMs,
  COUNT(latencyMs) AS latencySamples,AVG(ttftMs) AS averageTtftMs,COUNT(ttftMs) AS ttftSamples,
  MIN(CASE WHEN strftime('%s',timestamp) IS NOT NULL THEN timestamp END) AS firstSeenAt,
  MAX(CASE WHEN strftime('%s',timestamp) IS NOT NULL THEN timestamp END) AS lastSeenAt`;

function enrich(row) {
  return { ...row, cacheReadFraction: row.inputTokens > 0 ? row.cacheReadTokens / row.inputTokens : null,
    otherStatusRows: row.records - row.succeeded - row.failed - row.recordedPending };
}

function groupColumns(groupBy) {
  if (groupBy === 'model') return ['provider', 'model'];
  if (groupBy === 'account') return ['provider', 'connectionId'];
  return ['provider'];
}

function series(db, base, query, summary) {
  if (!summary.records || !Number.isFinite(Date.parse(summary.firstSeenAt)) || !Number.isFinite(Date.parse(summary.lastSeenAt))) {
    return { bucketMs: null, points: [] };
  }
  const first = Date.parse(query.start || summary.firstSeenAt), last = Date.parse(query.end || summary.lastSeenAt);
  const bucketMs = Math.max(MINUTE, Math.ceil((Math.max(MINUTE, last-first) + MINUTE) / (MAX_POINTS-1) / MINUTE) * MINUTE);
  const bucket = `CAST((CAST(strftime('%s',timestamp) AS INTEGER)*1000)/${bucketMs} AS INTEGER)*${bucketMs}`;
  const rows = db.all(`${base.sql} SELECT ${bucket} AS bucketStartMs,${TOTALS} FROM records
    WHERE strftime('%s',timestamp) IS NOT NULL GROUP BY bucketStartMs ORDER BY bucketStartMs`, base.params);
  return { bucketMs, points: rows.map((row) => ({ ...enrich(row), bucketStart: new Date(row.bucketStartMs).toISOString(),
    bucketEnd: new Date(row.bucketStartMs+bucketMs).toISOString() })) };
}

export function readActivityAnalytics(db, input) {
  const query = validateActivityQuery(input);
  const base = baseQuery(db, query);
  const summary = enrich(db.get(`${base.sql} SELECT ${TOTALS} FROM records`, base.params));
  summary.p50LatencyMs = null;
  summary.p95LatencyMs = null;
  if (summary.latencySamples) {
    const ranks = db.get(`${base.sql}, latencies AS (
      SELECT latencyMs,ROW_NUMBER() OVER (ORDER BY latencyMs) AS rank FROM records WHERE latencyMs IS NOT NULL)
      SELECT MAX(CASE WHEN rank=? THEN latencyMs END) AS p50,MAX(CASE WHEN rank=? THEN latencyMs END) AS p95 FROM latencies`,
      [...base.params,Math.ceil(summary.latencySamples*0.5),Math.ceil(summary.latencySamples*0.95)]);
    summary.p50LatencyMs = ranks.p50; summary.p95LatencyMs = ranks.p95;
  }
  const columns = groupColumns(query.groupBy);
  const groups = db.all(`${base.sql} SELECT ${columns.join(',')},${TOTALS} FROM records
    GROUP BY ${columns.join(',')} ORDER BY records DESC,${columns.join(',')} LIMIT 101`, base.params);
  const rows = db.all(`${base.sql} SELECT id,timestamp,provider,model,connectionId,status,prompt AS inputTokens,
    uncachedInput AS uncachedInputTokens,cacheRead AS cacheReadTokens,cacheWrite AS cacheWriteTokens,output AS outputTokens,
    recordedCost AS recordedCostUsd,latencyMs,ttftMs,contextSessionId,invalidTokens,inconsistentCache,missingTokenDetail
    FROM records ORDER BY timestamp DESC,id DESC LIMIT ? OFFSET ?`,
    [...base.params,query.pageSize,(query.page-1)*query.pageSize]);
  return {
    source: query.view === 'economics' ? 'usageHistory' : 'requestStats', filters: query,
    summary, series: series(db,base,query,summary), groups: groups.slice(0,100).map(enrich), groupsTruncated: groups.length > 100,
    items: rows, pagination: { page: query.page, pageSize: query.pageSize, totalItems: summary.records,
      totalPages: Math.ceil(summary.records/query.pageSize), hasNext: query.page*query.pageSize < summary.records, hasPrev: query.page > 1 },
    units: { tokens: 'tokens', cost: 'USD', latency: 'ms', time: 'UTC' },
    definitions: {
      inputTokens: 'Recorded cache-inclusive input. Historical token provenance was not retained; these are not invoice quantities.',
      recordedCostUsd: 'Model-rate estimate recorded by the application. It is not subscription spend or an invoice. Historical price basis was not retained; zero is ambiguous.',
      cacheReadFraction: 'Recorded cache reads divided by cache-inclusive input. Missing historical cache detail cannot be distinguished from zero.',
      recordedPending: 'Persisted pending statuses. They do not establish current in-flight requests.',
      latency: 'Positive recorded milliseconds, without silently deleting outliers. Inspect minimum, maximum and sample count before interpreting the mean.',
      percentiles: 'Nearest-rank p50 and p95 over positive recorded latency samples in the selected request population.',
      source: 'Usage records and request attempts have different coverage and identities. No timestamp-based join is made.',
      range: 'Start inclusive and end exclusive. Series buckets aggregate recorded events, not continuous utilization.',
    },
  };
}
