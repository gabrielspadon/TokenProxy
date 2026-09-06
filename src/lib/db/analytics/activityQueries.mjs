const MAX_POINTS = 720;
const MINUTE = 60000;
const GROUPS = new Set(['provider', 'model', 'account']);
const SORTS = new Set(['timestamp','inputTokens','uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','recordedCostUsd','latencyMs','ttftMs']);
const FIELDS = new Set(['operation', 'view', 'groupBy', 'start', 'end', 'provider', 'model', 'connectionId', 'page', 'pageSize','sortBy','sortDirection','status','requestId','logicalRequestId','sessionId','projectId']);

export class ActivityQueryError extends Error {}

function date(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
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
  for (const key of ['requestId', 'logicalRequestId', 'projectId']) {
    const value = query[key];
    if (value == null || value === '') { result[key] = null; continue; }
    if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f]/.test(value)) throw new ActivityQueryError('Invalid attribution filter.');
    result[key] = value;
  }
  result.sessionId = query.sessionId == null ? null : integer(query.sessionId, null, Number.MAX_SAFE_INTEGER, 'session');
  result.page = integer(query.page, 1, 100000, 'page');
  result.pageSize = integer(query.pageSize, 50, 100, 'page size');
  result.sortBy = query.sortBy ?? 'timestamp';
  result.sortDirection = query.sortDirection ?? 'desc';
  result.status = query.status ?? null;
  if (!SORTS.has(result.sortBy) || !['asc','desc'].includes(result.sortDirection)) throw new ActivityQueryError('Invalid analytics sort.');
  if (result.status !== null && !['succeeded','failed','pending'].includes(result.status)) throw new ActivityQueryError('Invalid analytics status.');
  return result;
}

function filterFor(query, columns) {
  const clauses = [], params = [];
  for (const column of ['provider', 'model', 'connectionId']) {
    if (query[column] !== null) { clauses.push(`${column}=?`); params.push(query[column]); }
  }
  for (const [key, column] of Object.entries({ requestId: query.view === 'activity' ? 'id' : 'requestId', logicalRequestId: 'logicalRequestId', sessionId: 'contextSessionId', projectId: 'projectId' })) {
    if (query[key] === null) continue;
    if (!columns.has(column)) { clauses.push('0'); continue; }
    clauses.push(`${column}=?`); params.push(query[key]);
  }
  if (query.start) { clauses.push('timestamp>=?'); params.push(query.start); }
  if (query.end) { clauses.push('timestamp<?'); params.push(query.end); }
  if (query.status === 'succeeded') clauses.push("status IN ('success','ok')");
  if (query.status === 'failed') clauses.push("status IN ('error','aborted','cancelled')");
  if (query.status === 'pending') clauses.push("status='pending'");
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const validNumber = (field) => `(typeof(${field}) IN ('integer','real') AND ${field}>=0 AND ${field}<=1.7976931348623157e308)`;
const validToken = (field) => `(${validNumber(field)} AND ${field}<=9007199254740991)`;
const quantity = (field) => `CASE WHEN ${validToken(field)} THEN ${field} END`;
const jsonQuantity = (field) => quantity(`json_extract(safeTokens,'$.${field}')`);

const ATTRIBUTION = ['dispatchCoverage','requestId','logicalRequestId','attempt','projectId','rateSnapshotId','pricingCapturedAt','costSource','costEvidence','usageSource','estimatedCostUsd','reportedCostUsd'];
function baseQuery(db, query) {
  const table = query.view === 'economics' ? 'usageHistory' : 'requestStats';
  const columns = new Set(db.all(`PRAGMA table_info(${table})`, []).map((row) => row.name));
  const { sql, params } = filterFor(query, columns);
  const attribution = ATTRIBUTION.map((name) => name === 'requestId' && query.view === 'activity' ? 'id AS requestId'
    : columns.has(name) ? name : `NULL AS ${name}`).join(',');
  const contextId = columns.has('contextSessionId') ? 'contextSessionId' : 'NULL AS contextSessionId';
  if (query.view === 'economics') {
    return { params, sql: `WITH filtered AS (
      SELECT id,timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cost,${attribution},${contextId},
        CASE WHEN json_valid(tokens) THEN CASE WHEN json_type(tokens)='object' THEN tokens ELSE '{}' END ELSE '{}' END AS safeTokens,
        CASE WHEN json_valid(tokens) THEN CASE WHEN json_type(tokens)='object' THEN 0 ELSE 1 END ELSE 1 END AS invalidTokenDetail
      FROM usageHistory ${sql}
    ), quantities AS MATERIALIZED (
      SELECT id,timestamp,provider,model,connectionId,status,${ATTRIBUTION.join(',')},contextSessionId,
        CASE WHEN json_extract(safeTokens,'$.input_tokens_present')=0 THEN NULL ELSE ${quantity('promptTokens')} END AS prompt,
        CASE WHEN json_extract(safeTokens,'$.output_tokens_present')=0 THEN NULL ELSE ${quantity('completionTokens')} END AS output,
        ${jsonQuantity('cached_tokens')} AS cacheRead,${jsonQuantity('cache_creation_input_tokens')} AS cacheWrite,
        CASE WHEN ${validNumber('cost')} THEN cost END AS recordedCost,
        CASE WHEN invalidTokenDetail=1 OR NOT ${validToken('promptTokens')} OR NOT ${validToken('completionTokens')}
          OR (json_type(safeTokens,'$.cached_tokens') IS NOT NULL AND NOT ${validToken("json_extract(safeTokens,'$.cached_tokens')")})
          OR (json_type(safeTokens,'$.cache_creation_input_tokens') IS NOT NULL AND NOT ${validToken("json_extract(safeTokens,'$.cache_creation_input_tokens')")})
          THEN 1 ELSE 0 END AS invalidTokens,
        CASE WHEN NOT ${validToken("json_extract(safeTokens,'$.cached_tokens')")} OR NOT ${validToken("json_extract(safeTokens,'$.cache_creation_input_tokens')")}
          THEN 1 ELSE 0 END AS missingTokenDetail,NULL AS latencyMs,NULL AS ttftMs
      FROM filtered
    ), records AS (SELECT *,MAX(0,prompt-cacheRead-cacheWrite) AS uncachedInput,
      CASE WHEN cacheRead+cacheWrite>prompt THEN 1 ELSE 0 END AS inconsistentCache FROM quantities)` };
  }
  return { params, sql: `WITH quantities AS (
    SELECT id,timestamp,provider,model,connectionId,status,${attribution},
      ${quantity('promptTokens')} AS prompt,${quantity('completionTokens')} AS output,
      ${quantity('cachedTokens')} AS cacheRead,${quantity('cacheCreationTokens')} AS cacheWrite,
      NULL AS recordedCost,
      CASE WHEN NOT ${validToken('promptTokens')} OR NOT ${validToken('completionTokens')}
        OR NOT ${validToken('cachedTokens')} OR NOT ${validToken('cacheCreationTokens')} THEN 1 ELSE 0 END AS invalidTokens,
      0 AS missingTokenDetail,CASE WHEN ${validNumber('latencyTotal')} AND latencyTotal>0 THEN latencyTotal END AS latencyMs,
      CASE WHEN ${validNumber('latencyTtft')} AND latencyTtft>0 THEN latencyTtft END AS ttftMs,${contextId}
    FROM requestStats ${sql}
  ), records AS (SELECT *,MAX(0,prompt-cacheRead-cacheWrite) AS uncachedInput,
    CASE WHEN cacheRead+cacheWrite>prompt THEN 1 ELSE 0 END AS inconsistentCache FROM quantities)` };
}

const TOTALS = `COUNT(*) AS records,COUNT(*) AS attempts,
  COALESCE(SUM(CASE WHEN dispatchCoverage='physical-dispatch' THEN 1 ELSE 0 END),0) AS physicalDispatchRows,
  COALESCE(SUM(CASE WHEN dispatchCoverage='executor-invocation' THEN 1 ELSE 0 END),0) AS executorInvocationRows,
  COALESCE(SUM(CASE WHEN dispatchCoverage IS NULL THEN 1 ELSE 0 END),0) AS unknownDispatchRows,
  COUNT(DISTINCT logicalRequestId) AS logicalRequests,
  COALESCE(SUM(CASE WHEN logicalRequestId IS NULL THEN 1 ELSE 0 END),0) AS unattributedAttempts,
  SUM(CASE WHEN ${validNumber('estimatedCostUsd')} THEN estimatedCostUsd END) AS estimatedCostUsd,
  SUM(CASE WHEN ${validNumber('reportedCostUsd')} THEN reportedCostUsd END) AS reportedCostUsd,
  COALESCE(SUM(CASE WHEN ${validNumber('estimatedCostUsd')} THEN 1 ELSE 0 END),0) AS estimatedCostSamples,
  COALESCE(SUM(CASE WHEN ${validNumber('reportedCostUsd')} THEN 1 ELSE 0 END),0) AS reportedCostSamples,
  COALESCE(SUM(CASE WHEN costSource='provider-confirmed' THEN 1 ELSE 0 END),0) AS confirmedCostRows,
  COALESCE(SUM(CASE WHEN costSource IS NULL OR costSource='unknown' THEN 1 ELSE 0 END),0) AS unknownCostSourceRows,
  COALESCE(SUM(CASE WHEN rateSnapshotId IS NOT NULL THEN 1 ELSE 0 END),0) AS rateSnapshotRows,
COALESCE(SUM(prompt),0) AS inputTokens,
  SUM(uncachedInput) AS uncachedInputTokens,SUM(cacheRead) AS cacheReadTokens,
  SUM(cacheWrite) AS cacheWriteTokens,COALESCE(SUM(output),0) AS outputTokens,
  COUNT(prompt) AS inputSamples,COUNT(output) AS outputSamples,COUNT(cacheRead) AS cacheReadSamples,
  COUNT(cacheWrite) AS cacheWriteSamples,COUNT(uncachedInput) AS uncachedInputSamples,
  SUM(CASE WHEN cacheRead IS NOT NULL THEN prompt END) AS cacheEligibleInputTokens,
  SUM(CASE WHEN prompt IS NOT NULL THEN cacheRead END) AS cacheEligibleReadTokens,
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

function parseObject(value) {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

function enrich(row) {
  const overflowFields = Object.keys(row).filter((key) => typeof row[key] === 'number' && !Number.isFinite(row[key]));
  for (const key of overflowFields) row[key] = null;
  return { ...row, numericOverflowFields: overflowFields,
    cacheReadFraction: row.cacheEligibleInputTokens > 0 ? row.cacheEligibleReadTokens / row.cacheEligibleInputTokens : null,
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
  const rows = db.all(`${base.sql} SELECT id,timestamp,provider,model,connectionId,status,${ATTRIBUTION.join(',')},prompt AS inputTokens,
    uncachedInput AS uncachedInputTokens,cacheRead AS cacheReadTokens,cacheWrite AS cacheWriteTokens,output AS outputTokens,
    recordedCost AS recordedCostUsd,latencyMs,ttftMs,contextSessionId,invalidTokens,inconsistentCache,missingTokenDetail
    FROM records ORDER BY ${query.sortBy} ${query.sortDirection.toUpperCase()} NULLS LAST,timestamp DESC,id DESC LIMIT ? OFFSET ?`,
    [...base.params,query.pageSize,(query.page-1)*query.pageSize]);
  const snapshotIds = [...new Set(rows.map((row) => row.rateSnapshotId).filter(Boolean))];
  const snapshots = snapshotIds.length ? db.all(`SELECT * FROM usageRateSnapshots WHERE id IN (${snapshotIds.map(() => '?').join(',')})`, snapshotIds) : [];
  const snapshotMap = new Map(snapshots.map((r) => [r.id, { ...r, rates: parseObject(r.rates) }]));
  for (const row of rows) {
    row.costEvidence = parseObject(row.costEvidence);
    row.rateSnapshot = snapshotMap.get(row.rateSnapshotId) || null;
  }
  return {
    source: query.view === 'economics' ? 'usageHistory' : 'requestStats', filters: query,
    summary, series: series(db,base,query,summary), groups: groups.slice(0,100).map(enrich), groupsTruncated: groups.length > 100,
    items: rows, pagination: { page: query.page, pageSize: query.pageSize, totalItems: summary.records,
      totalPages: Math.ceil(summary.records/query.pageSize), hasNext: query.page*query.pageSize < summary.records, hasPrev: query.page > 1 },
    units: { tokens: 'tokens', cost: 'USD', latency: 'ms', time: 'UTC' },
    definitions: {
      inputTokens: 'Recorded cache-inclusive input. Historical token provenance was not retained; these are not invoice quantities.',
      recordedCostUsd: 'Recorded application estimate or explicitly USD-denominated provider report. Read costSource and both component amounts. It is not subscription spend or a confirmed charge. Historical price basis was not retained; zero is ambiguous.',
      dispatchCoverage: 'physical-dispatch means the generation transport invoked the dispatch hook. executor-invocation may contain uninstrumented wire retries. Null means historical or unavailable coverage.',
      attribution: 'requestId identifies one recorded attempt; dispatchCoverage distinguishes measured transport dispatches from executor invocations. logicalRequestId groups attempts from the same server request. Unattributed historical attempts are counted separately, never guessed. Distinct logical counts across groups or time buckets are not additive.',
      pricing: 'Immutable captured rates and calculator version support application estimates. Only explicit context identities link sessions. Project IDs remain null until an actual project identity source exists.',
      cacheReadFraction: 'Recorded cache reads divided by cache-inclusive input only where both quantities are usable. Historical zero defaults may still represent unreported upstream fields.',
      coverage: 'Token sums include only finite nonnegative quantities within the safe integer range. Per-quantity sample counts and invalid/missing detail rows expose incomplete decomposition.',
      recordedPending: 'Persisted pending statuses. They do not establish current in-flight requests.',
      latency: 'Positive recorded milliseconds, without silently deleting outliers. Inspect minimum, maximum and sample count before interpreting the mean.',
      percentiles: 'Nearest-rank p50 and p95 over positive recorded latency samples in the selected request population.',
      source: 'Usage records and request attempts have different coverage and identities. No timestamp-based join is made.',
      range: 'Start inclusive and end exclusive. Series buckets aggregate recorded events, not continuous utilization.',
    },
  };
}
