import { CLIENT_REFERENCE_FIELDS, ECONOMICS_LINK_FIELDS, economicsLedgerSource, costComponents } from './economicsLinks.mjs';
import { ECONOMICS_GROUP_VALUES, economicsGroupFields } from './economicsDimensions.mjs';
import { attachCounterfactualEvidence } from './counterfactualEvidence.mjs';
import { ECONOMICS_FLAGS, economicsProjectionReady } from '../economicsProjectionSchema.js';
import { telemetryFilterSql } from './telemetryFilter.mjs';
const MAX_POINTS = 720;
const MINUTE = 60000;
const GROUPS = new Set(ECONOMICS_GROUP_VALUES);
const IDENTITY_FILTERS = ['clientKeyId',...CLIENT_REFERENCE_FIELDS];
const MISSING_FILTERS = ['provider','model','connectionId','sessionId','logicalRequestId',...IDENTITY_FILTERS];
const SORTS = new Set(['timestamp','inputTokens','uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','recordedCostUsd','latencyMs','ttftMs']);
const POPULATION_SORT = {inputTokens:'prompt',uncachedInputTokens:'uncachedInput',cacheReadTokens:'cacheRead',cacheWriteTokens:'cacheWrite',
  outputTokens:'output',recordedCostUsd:'recordedCost'};
const GROUP_SORTS = new Set(['records','recordedCostUsd','estimatedCostUsd','reportedCostUsd','averageLatencyMs','inputTokens','uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens']);
const FACETS = ['summary','groups','series','items'];
const FACET_SET = new Set(FACETS);
const FIELDS = new Set(['operation', 'view', 'groupBy', 'facets', 'seriesProfile', 'start', 'end', 'provider', 'model', 'connectionId', 'bucketMs', 'page', 'pageSize','sortBy','sortDirection','status','requestId','logicalRequestId','sessionId','projectId','recordId',...IDENTITY_FILTERS,'missing','requestLink','costSource','attemptKind','groupPage','groupPageSize','groupSortBy','groupSortDirection']);

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

const DAY = 86400000;
// A chart scale in whole minutes, at most a year. The series never goes finer
// than the point cap allows, so a small request is raised rather than refused.
function bucket(value) {
  if (value == null) return null;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < MINUTE || parsed % MINUTE !== 0 || parsed > 366 * DAY) throw new ActivityQueryError('Invalid bucket size.');
  return parsed;
}

function integer(value, fallback, max, field) {
  if (value == null) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new ActivityQueryError(`Invalid ${field}.`);
  return parsed;
}

function facets(value) {
  if (value == null) return [...FACETS];
  const requested = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(requested) || !requested.length || requested.some(name => typeof name !== 'string' || !FACET_SET.has(name)) || new Set(requested).size !== requested.length) {
    throw new ActivityQueryError('Invalid analytics facets.');
  }
  return FACETS.filter(name => requested.includes(name));
}

export function validateActivityQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new ActivityQueryError('Invalid analytics query.');
  for (const key of Object.keys(query)) if (!FIELDS.has(key)) throw new ActivityQueryError('Unknown analytics field.');
  if (query.operation !== 'activity') throw new ActivityQueryError('Invalid analytics operation.');
  const view = query.view ?? 'activity', groupBy = query.groupBy ?? 'provider';
  if (!['activity', 'economics'].includes(view) || !GROUPS.has(groupBy)) throw new ActivityQueryError('Invalid analytics view or grouping.');
  const result = { operation: 'activity', view, groupBy, facets: facets(query.facets), start: date(query.start, 'start'), end: date(query.end, 'end') };
  result.seriesProfile=query.seriesProfile ?? 'full';
  if (!['full','economics-chart'].includes(result.seriesProfile) || (result.seriesProfile==='economics-chart' && view!=='economics')) {
    throw new ActivityQueryError('Invalid analytics series profile.');
  }
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
  result.recordId = query.recordId == null ? null : integer(query.recordId, null, Number.MAX_SAFE_INTEGER, 'ledger record');
  if (result.recordId !== null && view !== 'economics') throw new ActivityQueryError('recordId is a completion-ledger identity.');
  result.sessionId = query.sessionId == null ? null : integer(query.sessionId, null, Number.MAX_SAFE_INTEGER, 'session');
  for (const field of IDENTITY_FILTERS) {
    const value=query[field];
    if (value==null || value==='') {result[field]=null;continue;}
    if (typeof value!=='string' || (field==='clientKeyId' ? !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) : !/^ctx1_[a-f0-9]{64}$/.test(value))) throw new ActivityQueryError('Invalid explicit identity filter.');
    result[field]=value;
  }
  for (const [field,choices] of [['missing',MISSING_FILTERS],['requestLink',['linked','unattributed','unavailable','conflict']],['costSource',['application-estimate','provider-reported','unknown']],['attemptKind',['initial','additional','unknown']]]) {
    result[field]=query[field] ?? null;
    if (result[field]!==null && !choices.includes(result[field])) throw new ActivityQueryError('Invalid economics evidence filter.');
  }
  if (result.missing && result[result.missing]!=null) throw new ActivityQueryError('An identity cannot be both specified and missing.');
  if (view!=='economics' && ([...IDENTITY_FILTERS,'requestLink','costSource','attemptKind'].some(field=>result[field]!==null) || !['provider','model','account'].includes(groupBy) || (result.missing && IDENTITY_FILTERS.includes(result.missing)))) throw new ActivityQueryError('Explicit cost evidence requires the economics view.');
  result.groupPage=integer(query.groupPage,1,100000,'cohort page');
  result.groupPageSize=integer(query.groupPageSize,100,100,'cohort page size');
  result.groupSortBy=query.groupSortBy ?? 'records';
  result.groupSortDirection=query.groupSortDirection ?? 'desc';
  if (!GROUP_SORTS.has(result.groupSortBy) || !['asc','desc'].includes(result.groupSortDirection)) throw new ActivityQueryError('Invalid cohort sort.');
  result.page = integer(query.page, 1, 100000, 'page');
  result.bucketMs = bucket(query.bucketMs);
  result.pageSize = integer(query.pageSize, 50, 100, 'page size');
  result.sortBy = query.sortBy ?? 'timestamp';
  result.sortDirection = query.sortDirection ?? 'desc';
  result.status = query.status ?? null;
  if (!SORTS.has(result.sortBy) || !['asc','desc'].includes(result.sortDirection)) throw new ActivityQueryError('Invalid analytics sort.');
  if (result.status !== null && !['succeeded','failed','pending'].includes(result.status)) throw new ActivityQueryError('Invalid analytics status.');
  return result;
}

function filterFor(query, columns, alias = 'usageEconomicsProjection') {
  const clauses = [telemetryFilterSql(query.view === 'economics' ? 'usageHistory' : 'requestStats', alias)], params = [];
  if (query.recordId != null) { clauses.push('id=?'); params.push(query.recordId); }
  for (const column of ['provider', 'model', 'connectionId']) {
    if (query[column] !== null) { clauses.push(`${column}=?`); params.push(query[column]); }
  }
  for (const [key, column] of Object.entries({ requestId: query.view === 'activity' ? 'id' : 'requestId', logicalRequestId: 'logicalRequestId', sessionId: 'contextSessionId', projectId: 'projectId' })) {
    if (query[key] === null) continue;
    if (!columns.has(column)) { clauses.push('0'); continue; }
    clauses.push(`${column}=?`); params.push(query[key]);
  }
  for (const field of IDENTITY_FILTERS) if (query[field]!=null) {clauses.push(`${field}=?`);params.push(query[field]);}
  if (query.missing) {
    const column=query.missing==='sessionId' ? 'contextSessionId' : query.missing;
    clauses.push(columns.has(column) || IDENTITY_FILTERS.includes(column) ? `${column} IS NULL` : '1');
  }
  if (query.requestLink) {clauses.push('requestLink=?');params.push(query.requestLink);}
  if (query.costSource) {
    if (!columns.has('costSource')) clauses.push(query.costSource==='unknown' ? '1' : '0');
    else if (query.costSource==='unknown') clauses.push("(costSource IS NULL OR costSource='unknown')");
    else {clauses.push('costSource=?');params.push(query.costSource);}
  }
  if (query.attemptKind) {
    const known=columns.has('attempt') && columns.has('logicalRequestId') && columns.has('dispatchCoverage')
      ? "logicalRequestId IS NOT NULL AND dispatchCoverage='physical-dispatch' AND typeof(attempt)='integer' AND attempt>=1" : '0';
    clauses.push(query.attemptKind==='unknown' ? `NOT COALESCE((${known}),0)` : `(${known}) AND attempt${query.attemptKind==='initial'?'=1':'>1'}`);
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
// A recorded false presence flag means the provider never reported the field,
// so the stored 0 is a synthesized default rather than an observation. Older
// rows carry no flag at all and keep whatever they recorded, honestly.
const jsonQuantity = (field, presence) => presence
  ? `CASE WHEN json_extract(safeTokens,'$.${presence}')=0 THEN NULL ELSE ${quantity(`json_extract(safeTokens,'$.${field}')`)} END`
  : quantity(`json_extract(safeTokens,'$.${field}')`);

const ATTRIBUTION = ['dispatchCoverage','requestId','logicalRequestId','attempt','projectId','rateSnapshotId','pricingCapturedAt','costSource','costEvidence','usageSource','estimatedCostUsd','reportedCostUsd'];
// The shared population carries only fields consumed by aggregate facets or
// ordering. Full ledger evidence is hydrated for the bounded item page after
// the population has selected its exact durable identities.
const AGGREGATE_SOURCE_FIELDS = ['id','timestamp','status','dispatchCoverage','logicalRequestId','attempt','rateSnapshotId','costSource',
  'estimatedCostUsd','reportedCostUsd','contextSessionId','requestLink','projectRef','taskRef','clientRef'];
const aggregateSourceFields = query => [...new Set([...AGGREGATE_SOURCE_FIELDS,...economicsGroupFields(query.groupBy)])];
const computedPopulationFields = `MAX(0,prompt-cacheRead-cacheWrite) AS uncachedInput,
  CASE WHEN cacheRead+cacheWrite>prompt THEN 1 ELSE 0 END AS inconsistentCache`;
function baseQuery(db, query, { materialize = false, materializeNormalized = false, projection = null, selectedIds = null } = {}) {
  const table = query.view === 'economics' ? 'usageHistory' : 'requestStats';
  const columns = new Set(db.all(`PRAGMA table_info(${table})`, []).map((row) => row.name));
  if (query.view === 'economics' && materializeNormalized && economicsProjectionReady(db)) {
    const projectionColumns = new Set(db.all('PRAGMA table_info(usageEconomicsProjection)', []).map(row => row.name));
    const filtered = filterFor(query, projectionColumns), params = [...filtered.params];
    const sourceFields = [...new Set(['id', 'timestamp', 'logicalRequestId', ...economicsGroupFields(query.groupBy)])].join(',');
    return { params, sql: `WITH records AS NOT MATERIALIZED (
      SELECT ${sourceFields},timestampMs,prompt,output,cacheRead,cacheWrite,recordedCost,invalidTokens,missingTokenDetail,
        latencyMs,ttftMs,uncachedInput,inconsistentCache,economicsFlags,aggregateEstimatedCost,aggregateReportedCost
      FROM usageEconomicsProjection ${filtered.sql}
    )`, normalizedProjection: true };
  }
  const filtered = filterFor(query, columns, query.view === 'economics' ? 'ledger' : 'requestStats'), params=[...filtered.params];
  let filterSql=filtered.sql;
  if (selectedIds?.length) {
    filterSql += filterSql ? ` AND id IN (${selectedIds.map(()=>'?').join(',')})` : `WHERE id IN (${selectedIds.map(()=>'?').join(',')})`;
    params.push(...selectedIds);
  }
  const attributionFor = name => name === 'requestId' && query.view === 'activity' ? 'id AS requestId'
    : columns.has(name) ? name : `NULL AS ${name}`;
  const attribution = ATTRIBUTION.map(attributionFor).join(',');
  const contextId = columns.has('contextSessionId') ? 'contextSessionId' : 'NULL AS contextSessionId';
  if (query.view === 'economics') {
    const sourceFields=materializeNormalized ? aggregateSourceFields(query).join(',')
      : `id,timestamp,provider,model,connectionId,status,${ATTRIBUTION.join(',')},contextSessionId,${ECONOMICS_LINK_FIELDS.join(',')}`;
    return { params, sql: `WITH ${economicsLedgerSource(db,columns)}, filtered AS (
      SELECT id,timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cost,${attribution},${contextId},${ECONOMICS_LINK_FIELDS.join(',')},linkedLatency,linkedTtft,
        CASE WHEN json_valid(tokens) THEN CASE WHEN json_type(tokens)='object' THEN tokens ELSE '{}' END ELSE '{}' END AS safeTokens,
        CASE WHEN json_valid(tokens) THEN CASE WHEN json_type(tokens)='object' THEN 0 ELSE 1 END ELSE 1 END AS invalidTokenDetail
      FROM ledger ${filterSql}
    ), quantities AS ${materializeNormalized || !materialize ? 'MATERIALIZED ' : ''}(
      SELECT ${sourceFields},CAST(strftime('%s',timestamp) AS INTEGER)*1000 AS timestampMs,
        CASE WHEN json_extract(safeTokens,'$.input_tokens_present')=0 THEN NULL ELSE ${quantity('promptTokens')} END AS prompt,
        CASE WHEN json_extract(safeTokens,'$.output_tokens_present')=0 THEN NULL ELSE ${quantity('completionTokens')} END AS output,
        ${jsonQuantity('cached_tokens', 'cache_read_tokens_present')} AS cacheRead,${jsonQuantity('cache_creation_input_tokens', 'cache_write_tokens_present')} AS cacheWrite,
        ${jsonQuantity('reasoning_tokens')} AS reasoningTokens,
        CASE WHEN ${validNumber('cost')} THEN cost END AS recordedCost,
        CASE WHEN invalidTokenDetail=1 OR NOT ${validToken('promptTokens')} OR NOT ${validToken('completionTokens')}
          OR (json_type(safeTokens,'$.cached_tokens') IS NOT NULL AND NOT ${validToken("json_extract(safeTokens,'$.cached_tokens')")})
          OR (json_type(safeTokens,'$.cache_creation_input_tokens') IS NOT NULL AND NOT ${validToken("json_extract(safeTokens,'$.cache_creation_input_tokens')")})
          THEN 1 ELSE 0 END AS invalidTokens,
        CASE WHEN json_extract(safeTokens,'$.cache_read_tokens_present')=0 OR json_extract(safeTokens,'$.cache_write_tokens_present')=0
          OR NOT ${validToken("json_extract(safeTokens,'$.cached_tokens')")} OR NOT ${validToken("json_extract(safeTokens,'$.cache_creation_input_tokens')")}
          THEN 1 ELSE 0 END AS missingTokenDetail,
        CASE WHEN ${validNumber('linkedLatency')} AND linkedLatency>0 THEN linkedLatency END AS latencyMs,
        CASE WHEN ${validNumber('linkedTtft')} AND linkedTtft>0 THEN linkedTtft END AS ttftMs
      FROM filtered
    ), records AS ${materialize && !materializeNormalized ? 'MATERIALIZED ' : ''}(SELECT ${projection || `*,${computedPopulationFields}`} FROM quantities)` };
  }
  const sourceFields=materializeNormalized ? aggregateSourceFields(query).map(field=>ECONOMICS_LINK_FIELDS.includes(field) ? `NULL AS ${field}`
    : ATTRIBUTION.includes(field) ? attributionFor(field) : field==='contextSessionId' ? contextId : field).join(',')
    : `id,timestamp,provider,model,connectionId,status,${attribution},${ECONOMICS_LINK_FIELDS.map(field=>field === 'requestedModel' && columns.has(field) ? field : `NULL AS ${field}`).join(',')}`;
  const absentCacheRead = columns.has('cacheReadPresent') ? 'cacheReadPresent=0' : '0';
  const absentCacheWrite = columns.has('cacheWritePresent') ? 'cacheWritePresent=0' : '0';
  return { params, sql: `WITH quantities AS ${materializeNormalized ? 'MATERIALIZED ' : ''}(
    SELECT ${sourceFields},CAST(strftime('%s',timestamp) AS INTEGER)*1000 AS timestampMs,NULL AS reasoningTokens,
      ${quantity('promptTokens')} AS prompt,${quantity('completionTokens')} AS output,
      CASE WHEN ${absentCacheRead} THEN NULL ELSE ${quantity('cachedTokens')} END AS cacheRead,
      CASE WHEN ${absentCacheWrite} THEN NULL ELSE ${quantity('cacheCreationTokens')} END AS cacheWrite,
      NULL AS recordedCost,
      CASE WHEN NOT ${validToken('promptTokens')} OR NOT ${validToken('completionTokens')}
        OR NOT ${validToken('cachedTokens')} OR NOT ${validToken('cacheCreationTokens')} THEN 1 ELSE 0 END AS invalidTokens,
      CASE WHEN ${absentCacheRead} OR ${absentCacheWrite} THEN 1 ELSE 0 END AS missingTokenDetail,
      CASE WHEN ${validNumber('latencyTotal')} AND latencyTotal>0 THEN latencyTotal END AS latencyMs,
      CASE WHEN ${validNumber('latencyTtft')} AND latencyTtft>0 THEN latencyTtft END AS ttftMs${materializeNormalized ? '' : `,${contextId}`}
    FROM requestStats ${filterSql}
  ), records AS ${materialize && !materializeNormalized ? 'MATERIALIZED ' : ''}(SELECT ${projection || `*,${computedPopulationFields}`} FROM quantities)` };
}

function readProjectedTimestampItemIds(db, query) {
  const columns = new Set(db.all('PRAGMA table_info(usageEconomicsProjection)', []).map(row => row.name));
  const filtered = filterFor(query, columns);
  return db.all(`SELECT id FROM usageEconomicsProjection ${filtered.sql}
    ORDER BY timestamp ${query.sortDirection.toUpperCase()} NULLS LAST,timestamp DESC,id DESC
    LIMIT ${query.pageSize} OFFSET ${(query.page-1)*query.pageSize}`, filtered.params).map(row => row.id);
}

function readProjectedSeriesLogicalCounts(db, query, bucketMs) {
  if (!bucketMs) return new Map();
  const columns = new Set(db.all('PRAGMA table_info(usageEconomicsProjection)', []).map(row => row.name));
  const filtered = filterFor(query, columns);
  const where = `${filtered.sql}${filtered.sql ? ' AND' : ' WHERE'} timestampMs IS NOT NULL`;
  const rows = db.all(`SELECT CAST(timestampMs/${bucketMs} AS INTEGER)*${bucketMs} AS bucketStartMs,
      COUNT(DISTINCT logicalRequestId) AS logicalRequests
    FROM usageEconomicsProjection ${where} GROUP BY bucketStartMs`, filtered.params);
  return new Map(rows.map(row => [row.bucketStartMs, row.logicalRequests]));
}

function readProjectedSummaryLogicalCount(db, query) {
  const columns = new Set(db.all('PRAGMA table_info(usageEconomicsProjection)', []).map(row => row.name));
  const filtered = filterFor(query, columns);
  return db.get(`SELECT COUNT(DISTINCT logicalRequestId) AS logicalRequests
    FROM usageEconomicsProjection ${filtered.sql}`, filtered.params).logicalRequests;
}

function readProjectedLatencyPercentiles(db, query, samples) {
  if (!samples) return { p50LatencyMs: null, p95LatencyMs: null };
  const columns = new Set(db.all('PRAGMA table_info(usageEconomicsProjection)', []).map(row => row.name));
  const filtered = filterFor(query, columns);
  const where = `${filtered.sql}${filtered.sql ? ' AND' : ' WHERE'} latencyMs IS NOT NULL`;
  const valueAt = rank => db.get(`SELECT latencyMs FROM usageEconomicsProjection ${where}
    ORDER BY latencyMs LIMIT 1 OFFSET ?`, [...filtered.params,rank-1])?.latencyMs ?? null;
  return { p50LatencyMs: valueAt(Math.floor((samples+1)/2)), p95LatencyMs: valueAt(Math.ceil(samples*0.95)) };
}

const INDEXED_LOGICAL_GROUPS = new Set(['provider','model','account']);
const logicalGroupKey = (row, columns) => JSON.stringify(columns.map(column => row[column] ?? null));
function readProjectedGroupLogicalCounts(db, query, columns) {
  const projectionColumns = new Set(db.all('PRAGMA table_info(usageEconomicsProjection)', []).map(row => row.name));
  const filtered = filterFor(query, projectionColumns);
  const rows = db.all(`SELECT ${columns.join(',')},COUNT(DISTINCT logicalRequestId) AS logicalRequests
    FROM usageEconomicsProjection ${filtered.sql} GROUP BY ${columns.join(',')}`, filtered.params);
  return new Map(rows.map(row => [logicalGroupKey(row,columns),row.logicalRequests]));
}

const compactPredicate = (compact, raw, flagValue) => compact ? `(economicsFlags&${flagValue})!=0` : raw;
const numericTotalsFor = compact => ({
  additionalAttemptCostUsd: `SUM(CASE WHEN ${compactPredicate(compact, "logicalRequestId IS NOT NULL AND dispatchCoverage='physical-dispatch' AND typeof(attempt)='integer' AND attempt>1", ECONOMICS_FLAGS.additionalAttempt)} THEN recordedCost END)`,
  pairedCostUsd: 'SUM(CASE WHEN latencyMs IS NOT NULL AND recordedCost IS NOT NULL THEN recordedCost END)',
  pairedAverageLatencyMs: 'AVG(CASE WHEN recordedCost IS NOT NULL THEN latencyMs END)',
  estimatedCostUsd: `SUM(${compact ? 'aggregateEstimatedCost' : `CASE WHEN ${validNumber('estimatedCostUsd')} THEN estimatedCostUsd END`})`,
  reportedCostUsd: `SUM(${compact ? 'aggregateReportedCost' : `CASE WHEN ${validNumber('reportedCostUsd')} THEN reportedCostUsd END`})`,
  inputTokens: 'COALESCE(SUM(prompt),0)',
  uncachedInputTokens: 'SUM(uncachedInput)',
  cacheReadTokens: 'SUM(cacheRead)',
  cacheWriteTokens: 'SUM(cacheWrite)',
  outputTokens: 'COALESCE(SUM(output),0)',
  cacheEligibleInputTokens: 'SUM(CASE WHEN cacheRead IS NOT NULL THEN prompt END)',
  cacheEligibleReadTokens: 'SUM(CASE WHEN prompt IS NOT NULL THEN cacheRead END)',
  recordedCostUsd: 'SUM(recordedCost)',
  averageLatencyMs: 'AVG(latencyMs)',
  averageTtftMs: 'AVG(ttftMs)',
});
const totalsFor = (compact = false, { logicalRequests = true } = {}) => {
  const numeric = numericTotalsFor(compact);
  return `COUNT(*) AS records,COUNT(*) AS attempts,
  COALESCE(SUM(${compactPredicate(compact, "requestLink='linked'", ECONOMICS_FLAGS.linked)}),0) AS linkedRequestRows,
  COALESCE(SUM(${compactPredicate(compact, "requestLink='conflict'", ECONOMICS_FLAGS.conflict)}),0) AS conflictingRequestRows,
  COALESCE(SUM(${compactPredicate(compact, "requestLink='unavailable'", ECONOMICS_FLAGS.unavailable)}),0) AS unavailableRequestRows,
  COALESCE(SUM(${compactPredicate(compact, 'contextSessionId IS NOT NULL', ECONOMICS_FLAGS.explicitSession)}),0) AS explicitSessionRows,
  COALESCE(SUM(${compactPredicate(compact, 'projectRef IS NOT NULL', ECONOMICS_FLAGS.clientProject)}),0) AS clientProjectRows,
  COALESCE(SUM(${compactPredicate(compact, 'taskRef IS NOT NULL', ECONOMICS_FLAGS.task)}),0) AS taskRows,
  COALESCE(SUM(${compactPredicate(compact, 'clientRef IS NOT NULL', ECONOMICS_FLAGS.client)}),0) AS clientRows,
  COALESCE(SUM(${compactPredicate(compact, "logicalRequestId IS NOT NULL AND dispatchCoverage='physical-dispatch' AND typeof(attempt)='integer' AND attempt=1", ECONOMICS_FLAGS.initialAttempt)}),0) AS initialAttemptRows,
  COALESCE(SUM(${compactPredicate(compact, "logicalRequestId IS NOT NULL AND dispatchCoverage='physical-dispatch' AND typeof(attempt)='integer' AND attempt>1", ECONOMICS_FLAGS.additionalAttempt)}),0) AS additionalAttemptRows,
  ${numeric.additionalAttemptCostUsd} AS additionalAttemptCostUsd,
  ${numeric.pairedCostUsd} AS pairedCostUsd,
  ${numeric.pairedAverageLatencyMs} AS pairedAverageLatencyMs,
  COALESCE(SUM(latencyMs IS NOT NULL AND recordedCost IS NOT NULL),0) AS costLatencySamples,
  COALESCE(SUM(${compactPredicate(compact, "dispatchCoverage='physical-dispatch'", ECONOMICS_FLAGS.physicalDispatch)}),0) AS physicalDispatchRows,
  COALESCE(SUM(${compactPredicate(compact, "dispatchCoverage='executor-invocation'", ECONOMICS_FLAGS.executorInvocation)}),0) AS executorInvocationRows,
  COALESCE(SUM(${compactPredicate(compact, 'dispatchCoverage IS NULL', ECONOMICS_FLAGS.unknownDispatch)}),0) AS unknownDispatchRows,
  ${logicalRequests ? 'COUNT(DISTINCT logicalRequestId)' : '0'} AS logicalRequests,
  COALESCE(SUM(CASE WHEN logicalRequestId IS NULL THEN 1 ELSE 0 END),0) AS unattributedAttempts,
  ${numeric.estimatedCostUsd} AS estimatedCostUsd,
  ${numeric.reportedCostUsd} AS reportedCostUsd,
  COUNT(${compact ? 'aggregateEstimatedCost' : `CASE WHEN ${validNumber('estimatedCostUsd')} THEN estimatedCostUsd END`}) AS estimatedCostSamples,
  COUNT(${compact ? 'aggregateReportedCost' : `CASE WHEN ${validNumber('reportedCostUsd')} THEN reportedCostUsd END`}) AS reportedCostSamples,
  COALESCE(SUM(${compactPredicate(compact, "costSource='provider-confirmed'", ECONOMICS_FLAGS.confirmedCost)}),0) AS confirmedCostRows,
  COALESCE(SUM(${compactPredicate(compact, "costSource='provider-reported'", ECONOMICS_FLAGS.providerReportedCost)}),0) AS providerReportedCostRows,
  COALESCE(SUM(${compactPredicate(compact, "costSource IS NULL OR costSource='unknown'", ECONOMICS_FLAGS.unknownCostSource)}),0) AS unknownCostSourceRows,
  COALESCE(SUM(${compactPredicate(compact, 'rateSnapshotId IS NOT NULL', ECONOMICS_FLAGS.rateSnapshot)}),0) AS rateSnapshotRows,
  ${numeric.inputTokens} AS inputTokens,
  ${numeric.uncachedInputTokens} AS uncachedInputTokens,${numeric.cacheReadTokens} AS cacheReadTokens,
  ${numeric.cacheWriteTokens} AS cacheWriteTokens,${numeric.outputTokens} AS outputTokens,
  COUNT(prompt) AS inputSamples,COUNT(output) AS outputSamples,COUNT(cacheRead) AS cacheReadSamples,
  COUNT(cacheWrite) AS cacheWriteSamples,COUNT(uncachedInput) AS uncachedInputSamples,
  ${numeric.cacheEligibleInputTokens} AS cacheEligibleInputTokens,
  ${numeric.cacheEligibleReadTokens} AS cacheEligibleReadTokens,
  COALESCE(SUM(${compactPredicate(compact, "status IN ('success','ok')", ECONOMICS_FLAGS.succeeded)}),0) AS succeeded,
  COALESCE(SUM(${compactPredicate(compact, "status IN ('error','aborted','cancelled')", ECONOMICS_FLAGS.failed)}),0) AS failed,
  COALESCE(SUM(${compactPredicate(compact, "status='pending'", ECONOMICS_FLAGS.pending)}),0) AS recordedPending,
  COALESCE(SUM(invalidTokens),0) AS invalidTokenRows,COALESCE(SUM(inconsistentCache),0) AS inconsistentCacheRows,
  COALESCE(SUM(missingTokenDetail),0) AS missingTokenDetailRows,
  COALESCE(SUM(timestampMs IS NULL),0) AS invalidTimestampRows,
  ${numeric.recordedCostUsd} AS recordedCostUsd,COUNT(recordedCost) AS costSamples,
  COALESCE(SUM(CASE WHEN recordedCost=0 THEN 1 ELSE 0 END),0) AS zeroCostRows,
  ${numeric.averageLatencyMs} AS averageLatencyMs,MIN(latencyMs) AS minimumLatencyMs,MAX(latencyMs) AS maximumLatencyMs,
  COUNT(latencyMs) AS latencySamples,${numeric.averageTtftMs} AS averageTtftMs,COUNT(ttftMs) AS ttftSamples,
  MIN(CASE WHEN timestampMs IS NOT NULL THEN timestamp END) AS firstSeenAt,
  MAX(CASE WHEN timestampMs IS NOT NULL THEN timestamp END) AS lastSeenAt`;
};

const TOTAL_FIELDS = ['records','attempts','linkedRequestRows','conflictingRequestRows','unavailableRequestRows','explicitSessionRows',
  'clientProjectRows','taskRows','clientRows','initialAttemptRows','additionalAttemptRows','additionalAttemptCostUsd','pairedCostUsd',
  'pairedAverageLatencyMs','costLatencySamples','physicalDispatchRows','executorInvocationRows','unknownDispatchRows','logicalRequests',
  'unattributedAttempts','estimatedCostUsd','reportedCostUsd','estimatedCostSamples','reportedCostSamples','confirmedCostRows',
  'providerReportedCostRows','unknownCostSourceRows','rateSnapshotRows','inputTokens','uncachedInputTokens','cacheReadTokens',
  'cacheWriteTokens','outputTokens','inputSamples','outputSamples','cacheReadSamples','cacheWriteSamples','uncachedInputSamples',
  'cacheEligibleInputTokens','cacheEligibleReadTokens','succeeded','failed','recordedPending','invalidTokenRows','inconsistentCacheRows',
  'missingTokenDetailRows','invalidTimestampRows','recordedCostUsd','costSamples','zeroCostRows','averageLatencyMs','minimumLatencyMs',
  'maximumLatencyMs','latencySamples','averageTtftMs','ttftSamples','firstSeenAt','lastSeenAt'];
const SUMMARY_NUMERIC = numericTotalsFor(true);
const SUMMARY_MINIMUMS = new Set(['minimumLatencyMs','firstSeenAt']);
const SUMMARY_MAXIMUMS = new Set(['maximumLatencyMs','lastSeenAt']);
const SUMMARY_ZERO_SUMS = new Set(['records','attempts','unattributedAttempts','succeeded','failed','recordedPending','inputTokens','outputTokens']);
const groupedSummaryTotals = TOTAL_FIELDS.map(field => {
  const expression = Object.hasOwn(SUMMARY_NUMERIC,field) ? `(SELECT ${field} FROM summary_numeric)`
    : SUMMARY_MINIMUMS.has(field) ? `MIN(${field})`
      : SUMMARY_MAXIMUMS.has(field) ? `MAX(${field})`
        : field==='logicalRequests' ? '0'
          : SUMMARY_ZERO_SUMS.has(field)||field.endsWith('Rows')||field.endsWith('Samples') ? `COALESCE(SUM(${field}),0)`
            : `SUM(${field})`;
  return `${expression} AS ${field}`;
}).join(',');
const ECONOMICS_CHART_FIELDS = ['records','recordedCostUsd','costSamples','uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens',
  'uncachedInputSamples','cacheReadSamples','cacheWriteSamples','outputSamples','inconsistentCacheRows','firstSeenAt','lastSeenAt'];
const ECONOMICS_CHART_TOTALS = `COUNT(*) AS records,SUM(recordedCost) AS recordedCostUsd,COUNT(recordedCost) AS costSamples,
  SUM(uncachedInput) AS uncachedInputTokens,SUM(cacheRead) AS cacheReadTokens,SUM(cacheWrite) AS cacheWriteTokens,COALESCE(SUM(output),0) AS outputTokens,
  COUNT(uncachedInput) AS uncachedInputSamples,COUNT(cacheRead) AS cacheReadSamples,COUNT(cacheWrite) AS cacheWriteSamples,COUNT(output) AS outputSamples,
  COALESCE(SUM(inconsistentCache),0) AS inconsistentCacheRows,
  MIN(CASE WHEN timestampMs IS NOT NULL THEN timestamp END) AS firstSeenAt,MAX(CASE WHEN timestampMs IS NOT NULL THEN timestamp END) AS lastSeenAt`;
const jsonObject = fields => `json_object(${fields.map(field => `'${field}',${field}`).join(',')})`;
const projection = (kind, payload) => `SELECT '${kind}' AS kind,${payload} AS payload`;

function parseObject(value) {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

function enrich(row) {
  const overflowFields = Object.keys(row).filter((key) => typeof row[key] === 'number' && !Number.isFinite(row[key]));
  for (const key of overflowFields) row[key] = null;
  const statusFields=['records','succeeded','failed','recordedPending'];
  return { ...row, numericOverflowFields: overflowFields,
    cacheReadFraction: row.cacheEligibleInputTokens > 0 ? row.cacheEligibleReadTokens / row.cacheEligibleInputTokens : null,
    otherStatusRows: statusFields.every(field=>Number.isFinite(row[field])) ? row.records-row.succeeded-row.failed-row.recordedPending : null };
}

function groupColumns(groupBy) {
  return economicsGroupFields(groupBy);
}

export function readActivityAnalytics(db, input) {
  const query = validateActivityQuery(input);
  const requested = new Set(query.facets);
  const aggregatePopulation = ['summary','groups','series'].some(facet=>requested.has(facet));
  const sortColumn=POPULATION_SORT[query.sortBy] || query.sortBy;
  const itemProjection=sortColumn==='uncachedInput' ? `id,timestamp,MAX(0,prompt-cacheRead-cacheWrite) AS uncachedInput`
    : `id,timestamp${sortColumn==='timestamp' ? '' : `,${sortColumn}`}`;
  const base = baseQuery(db, query, { materialize: true,
    materializeNormalized: aggregatePopulation,
    projection: aggregatePopulation ? null : itemProjection });
  const projectedItemIds = requested.has('items') && base.normalizedProjection === true && query.sortBy === 'timestamp'
    ? readProjectedTimestampItemIds(db, query) : null;
  const splitSummaryLogical = base.normalizedProjection === true && requested.has('summary');
  const splitGroupLogical = base.normalizedProjection === true && requested.has('groups') && INDEXED_LOGICAL_GROUPS.has(query.groupBy);
  const summaryTotals = totalsFor(base.normalizedProjection === true, { logicalRequests: !splitSummaryLogical });
  const groupTotals = totalsFor(base.normalizedProjection === true, { logicalRequests: !splitGroupLogical });
  const compactSeries = base.normalizedProjection === true && query.seriesProfile==='full';
  const seriesTotals = query.seriesProfile==='economics-chart' ? ECONOMICS_CHART_TOTALS
    : compactSeries ? totalsFor(true, { logicalRequests: false }) : summaryTotals;
  const seriesFields = query.seriesProfile==='economics-chart' ? ECONOMICS_CHART_FIELDS : TOTAL_FIELDS;
  const columns = groupColumns(query.groupBy);
  const ctes = [], selects = [];
  const needsSummary = requested.has('summary') || requested.has('series');
  const reuseGroupedSummary = base.normalizedProjection===true && requested.has('summary') && requested.has('groups');
  if (reuseGroupedSummary) {
    // Reuse complete, unpaginated group counts. Aggregate numeric quantities
    // directly to preserve floating-point sums and avoid weighted-mean overflow.
    ctes.push(`summary_numeric AS MATERIALIZED (SELECT ${Object.entries(SUMMARY_NUMERIC).map(([field,sql])=>`${sql} AS ${field}`).join(',')} FROM records)`,
    `summary AS (SELECT ${groupedSummaryTotals} FROM grouped)`);
  } else if (needsSummary) ctes.push(requested.has('summary') ? `summary AS (SELECT ${summaryTotals} FROM records)`
      : `summary AS (SELECT COUNT(*) AS records,MIN(CASE WHEN timestampMs IS NOT NULL THEN timestamp END) AS firstSeenAt,
        MAX(CASE WHEN timestampMs IS NOT NULL THEN timestamp END) AS lastSeenAt FROM records)`);
  if (requested.has('summary')) {
    if (base.normalizedProjection === true) selects.push(`${projection('summary',jsonObject(TOTAL_FIELDS))} FROM summary`);
    else {
      ctes.push(`latencies AS (SELECT latencyMs,ROW_NUMBER() OVER (ORDER BY latencyMs) AS rank FROM records WHERE latencyMs IS NOT NULL)`,
        `percentiles AS (SELECT MAX(CASE WHEN rank=CAST((summary.latencySamples+1)/2 AS INTEGER) THEN latencyMs END) AS p50LatencyMs,
          MAX(CASE WHEN rank=CAST((summary.latencySamples*95+99)/100 AS INTEGER) THEN latencyMs END) AS p95LatencyMs FROM latencies,summary)`);
      selects.push(`${projection('summary',jsonObject([...TOTAL_FIELDS,'p50LatencyMs','p95LatencyMs']))} FROM summary,percentiles`);
    }
  }
  if (requested.has('groups')) {
    ctes.push(`grouped AS MATERIALIZED (SELECT ${columns.join(',')},${groupTotals} FROM records GROUP BY ${columns.join(',')})`,
      `group_rows AS (SELECT * FROM grouped ORDER BY ${query.groupSortBy} ${query.groupSortDirection.toUpperCase()} NULLS LAST,${columns.join(',')}
        LIMIT ${query.groupPageSize} OFFSET ${(query.groupPage-1)*query.groupPageSize})`);
    selects.push(`${projection('group-meta',"json_object('totalItems',COUNT(*))")} FROM grouped`,
      `${projection('group',jsonObject([...columns,...TOTAL_FIELDS]))} FROM group_rows`);
  }
  if (requested.has('series')) {
    const rangeStart = query.start ? Date.parse(query.start) : 'NULL';
    const rangeEnd = query.end ? Date.parse(query.end) : 'NULL';
    const denominator = (MAX_POINTS-1)*MINUTE;
    const span = `MAX(${MINUTE},COALESCE(${rangeEnd},CAST(strftime('%s',summary.lastSeenAt) AS INTEGER)*1000)-COALESCE(${rangeStart},CAST(strftime('%s',summary.firstSeenAt) AS INTEGER)*1000))`;
    const floor = `MAX(${MINUTE},CAST(((${span}+${MINUTE})+${denominator}-1)/${denominator} AS INTEGER)*${MINUTE})`;
    ctes.push(`series_settings AS (SELECT CASE WHEN records=0 OR firstSeenAt IS NULL OR lastSeenAt IS NULL THEN NULL ELSE MAX(${floor},${query.bucketMs || 0}) END AS bucketMs FROM summary)`,
      `series_rows AS (SELECT CAST(timestampMs/bucketMs AS INTEGER)*bucketMs AS bucketStartMs,${seriesTotals}
        FROM records,series_settings WHERE bucketMs IS NOT NULL AND timestampMs IS NOT NULL GROUP BY bucketStartMs ORDER BY bucketStartMs)`);
    selects.push(`${projection('series-meta',"json_object('bucketMs',bucketMs)")} FROM series_settings`,
      `${projection('series',jsonObject(['bucketStartMs',...seriesFields]))} FROM series_rows`);
  }
  if (requested.has('items')) {
    if (projectedItemIds) {
      selects.push(needsSummary
        ? `${projection('item-meta',"json_object('totalItems',records)")} FROM summary`
        : `${projection('item-meta',"json_object('totalItems',COUNT(*))")} FROM records`);
    } else {
      ctes.push(`item_rows AS MATERIALIZED (SELECT id FROM records ORDER BY ${POPULATION_SORT[query.sortBy] || query.sortBy} ${query.sortDirection.toUpperCase()} NULLS LAST,timestamp DESC,id DESC
        LIMIT ${query.pageSize} OFFSET ${(query.page-1)*query.pageSize})`);
      selects.push(`${projection('item-meta',"json_object('totalItems',COUNT(*))")} FROM records`,
        `${projection('item',jsonObject(['id']))} FROM item_rows`);
    }
  }
  const projected = db.all(`${base.sql}${ctes.length ? `,${ctes.join(',')}` : ''} ${selects.join(' UNION ALL ')}`, base.params);
  const result = {
    source: query.view === 'economics' ? 'usageHistory' : 'requestStats', filters: query,
    units: { tokens: 'tokens', cost: 'USD', latency: 'ms', time: 'UTC' },
    definitions: {
      inputTokens: 'Recorded cache-inclusive input. Historical token provenance was not retained; these are not invoice quantities.',
      recordedCostUsd: 'Recorded application estimate or explicitly USD-denominated provider report. Read costSource and both component amounts. It is not subscription spend or a confirmed charge. Historical price basis was not retained; zero is ambiguous.',
      dispatchCoverage: 'physical-dispatch means the generation transport invoked the dispatch hook. executor-invocation may contain uninstrumented wire retries. Null means historical or unavailable coverage.',
      attribution: 'requestId identifies one recorded attempt; dispatchCoverage distinguishes measured transport dispatches from executor invocations. logicalRequestId groups attempts from the same server request. Unattributed historical attempts are counted separately, never guessed. Distinct logical counts across groups or time buckets are not additive.',
      pricing: 'Immutable captured rates and calculator version support application estimates. Reported costs are upstream USD observations, not confirmed charges. Ledger contextSessionId records an explicit session link; projectRef is client-reported and scoped to installation/key/client, not an application project.',
      requestLink: 'Exact requestId with compatible logical/session/attempt identities permits retained request metrics. Unavailable can mean expired evidence. Conflicts remain unlinked. No timestamps are used for attribution.',
      retry: 'Additional attempt costs include only server logical IDs with physical dispatch coverage and attempt ordinal above one. They are not necessarily avoidable cost; missing attempts or charges remain unknown.',
      costLatency: 'Cost and latency comparisons use the same exactly linked rows with usable cost and positive latency. Samples are descriptive, not causal or task-success measures.',
      cacheReadFraction: 'Recorded cache reads divided by cache-inclusive input only where both quantities are usable. Historical zero defaults may still represent unreported upstream fields.',
      coverage: 'Token sums include only finite nonnegative quantities within the safe integer range. Per-quantity sample counts and invalid/missing detail rows expose incomplete decomposition.',
      recordedPending: 'Persisted pending statuses. They do not establish current in-flight requests.',
      latency: 'Positive recorded milliseconds, without silently deleting outliers. Inspect minimum, maximum and sample count before interpreting the mean.',
      percentiles: 'Nearest-rank p50 and p95 over positive recorded latency samples in the selected request population.',
      source: 'Usage records and request attempts have different coverage and identities. No timestamp-based join is made.',
      range: 'Start inclusive and end exclusive. Series buckets aggregate recorded events, not continuous utilization.',
    },
  };
  const byKind = kind => projected.filter(row => row.kind===kind).map(row => JSON.parse(row.payload));
  if (requested.has('summary')) {
    const summary=byKind('summary')[0];
    if (splitSummaryLogical) {
      summary.logicalRequests=readProjectedSummaryLogicalCount(db,query);
      Object.assign(summary,readProjectedLatencyPercentiles(db,query,summary.latencySamples));
    }
    result.summary=enrich(summary);
  }
  if (requested.has('groups')) {
    const totalItems=byKind('group-meta')[0].totalItems;
    const logicalCounts=splitGroupLogical ? readProjectedGroupLogicalCounts(db,query,columns) : null;
    result.groups=byKind('group').map(row=>enrich(logicalCounts ? {...row,logicalRequests:logicalCounts.get(logicalGroupKey(row,columns)) ?? 0} : row));
    result.groupsTruncated=totalItems>query.groupPageSize;
    result.groupPagination={page:query.groupPage,pageSize:query.groupPageSize,totalItems,totalPages:Math.ceil(totalItems/query.groupPageSize),hasNext:query.groupPage*query.groupPageSize<totalItems,hasPrev:query.groupPage>1};
  }
  if (requested.has('series')) {
    const bucketMs=byKind('series-meta')[0].bucketMs;
    const logicalCounts=compactSeries ? readProjectedSeriesLogicalCounts(db,query,bucketMs) : null;
    result.series={bucketMs,points:byKind('series').map(row=>({...enrich(logicalCounts ? {...row,logicalRequests:logicalCounts.get(row.bucketStartMs) ?? 0} : row),
      bucketStart:new Date(row.bucketStartMs).toISOString(),bucketEnd:new Date(row.bucketStartMs+bucketMs).toISOString()}))};
  }
  if (requested.has('items')) {
    const totalItems=byKind('item-meta')[0].totalItems;
    result.items=readActivityItemsByIds(db,query,projectedItemIds || byKind('item').map(row=>row.id));
    result.pagination={page:query.page,pageSize:query.pageSize,totalItems,totalPages:Math.ceil(totalItems/query.pageSize),hasNext:query.page*query.pageSize<totalItems,hasPrev:query.page>1};
  }
  return result;
}

function readActivityItemsByIds(db,query,ids) {
  if (!ids.length) return [];
  const base=baseQuery(db,query,{selectedIds:ids}), positions=new Map(ids.map((id,index)=>[id,index]));
  const rows=db.all(`${base.sql} SELECT id,timestamp,provider,model,connectionId,status,${ATTRIBUTION.join(',')},${ECONOMICS_LINK_FIELDS.join(',')},reasoningTokens,prompt AS inputTokens,
    uncachedInput AS uncachedInputTokens,cacheRead AS cacheReadTokens,cacheWrite AS cacheWriteTokens,output AS outputTokens,
    recordedCost AS recordedCostUsd,latencyMs,ttftMs,contextSessionId,invalidTokens,inconsistentCache,missingTokenDetail
    FROM records`,base.params);
  rows.sort((a,b)=>positions.get(a.id)-positions.get(b.id));
  return enrichActivityItems(db,query,rows);
}

function readActivityItems(db,query,base,limit,offset=0) {
  const rows = db.all(`${base.sql} SELECT id,timestamp,provider,model,connectionId,status,${ATTRIBUTION.join(',')},${ECONOMICS_LINK_FIELDS.join(',')},reasoningTokens,prompt AS inputTokens,
    uncachedInput AS uncachedInputTokens,cacheRead AS cacheReadTokens,cacheWrite AS cacheWriteTokens,output AS outputTokens,
    recordedCost AS recordedCostUsd,latencyMs,ttftMs,contextSessionId,invalidTokens,inconsistentCache,missingTokenDetail
    FROM records ORDER BY ${query.sortBy} ${query.sortDirection.toUpperCase()} NULLS LAST,timestamp DESC,id DESC LIMIT ? OFFSET ?`,
    [...base.params,limit,offset]);
  return enrichActivityItems(db,query,rows);
}

function enrichActivityItems(db,query,rows) {
  const snapshotIds = [...new Set(rows.map((row) => row.rateSnapshotId).filter(Boolean))];
  const snapshots = snapshotIds.length ? db.all(`SELECT * FROM usageRateSnapshots WHERE id IN (${snapshotIds.map(() => '?').join(',')})`, snapshotIds) : [];
  const snapshotMap = new Map(snapshots.map((r) => [r.id, { ...r, rates: parseObject(r.rates) }]));
  for (const row of rows) {
    row.costEvidence = parseObject(row.costEvidence);
    row.rateSnapshot = snapshotMap.get(row.rateSnapshotId) || null;
    if (query.view==='economics') row.costComponents=costComponents(row);
  }
  if (query.view === 'economics') attachCounterfactualEvidence(db, rows);
  return rows;
}

export function readActivityEvidence(db,input,maxRecords=5000) {
  const query = validateActivityQuery(input);
  const base = baseQuery(db,query);
  const coverage = enrich(db.get(`${base.sql} SELECT ${totalsFor(base.normalizedProjection === true)} FROM records`,base.params));
  if (coverage.records > maxRecords) return { exceeded: true, totalRecords: coverage.records, coverage };
  return { source: query.view === 'economics' ? 'usageHistory' : 'requestStats', filters: query, coverage, totalRecords: coverage.records, items: readActivityItems(db,query,base,maxRecords) };
}
