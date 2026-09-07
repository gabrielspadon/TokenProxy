import { InvestigationError, OWNER_SCOPE, object, validateDefinition, mergeEconomicsFilters } from './investigationModel.mjs';
import { readActivityEvidence } from './activityQueries.mjs';
import { readContextEvidenceExport } from './contextEvidenceExport.mjs';
import { economicsGroupFilters } from './economicsDimensions.mjs';
import { EXPORT_LIMITS } from './evidenceFormat.mjs';
import { parseQuotaWorkbenchQuery, readQuotaWorkbench } from './quotaWorkbenchQueries.mjs';

export { EXPORT_LIMITS } from './evidenceFormat.mjs';
export function validateEvidenceQuery(query) {
  object(query,['operation','mode','definition']);
  if (query.operation !== 'evidence' || !['selected','population','comparison','attempt-comparison'].includes(query.mode)) throw new InvestigationError('Invalid evidence export.');
  const definition = validateDefinition(query.definition);
  if (query.mode === 'attempt-comparison') {
    const selected=definition.selection, baseline=definition.context.baseline;
    if (definition.lens!=='context' || selected?.kind!=='context-attempt' || !baseline) throw new InvestigationError('Choose an exact Context attempt and baseline first.');
    if (selected.id===baseline.id) throw new InvestigationError('Choose two distinct attempt IDs.');
  }
  if (query.mode === 'selected' && !definition.selection) throw new InvestigationError('Select a record first.');
  if (query.mode === 'comparison' && !definition.comparisonIds.length) throw new InvestigationError('Select comparison accounts first.');
  if(query.mode==='population' && definition.lens==='capacity')throw new InvestigationError('Capacity exports exact selected or comparison accounts. Use Economics or Context for a time-filtered population.');
  if(query.mode==='selected' && definition.selection?.kind==='economics-group' && !economicsGroupFilters(definition.selection,definition.selection.groupBy))throw new InvestigationError('This cohort cannot be isolated by the supported exact filters. Select exact records or a supported filtered population.');
  return { operation: 'evidence', mode: query.mode, definition };
}
function selectFields(row,keys) { return Object.fromEntries(keys.map((key) => [key,row[key] ?? null])); }
const ACTIVITY_FIELDS = ['id','timestamp','provider','model','requestedModel','connectionId','status','requestId','requestLink','logicalRequestId','attempt','contextSessionId','projectId','clientKeyId','clientIdentitySource','clientRef','clientSessionRef','projectRef','taskRef','dispatchCoverage','usageSource','inputTokens','uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','reasoningTokens','recordedCostUsd','estimatedCostUsd','reportedCostUsd','costSource','rateSnapshotId','pricingCapturedAt','rateSnapshot','costComponents','completionId','counterfactual','latencyMs','ttftMs','invalidTokens','inconsistentCache','missingTokenDetail'];
function limited(db,sql,args) {
  const total = db.get(`SELECT COUNT(*) AS n FROM (${sql})`,args).n;
  if (total > EXPORT_LIMITS.records) return { exceeded: true, totalRecords: total };
  return { items: db.all(sql,args), totalRecords: total };
}
export function readEvidence(db,input) {
  const query = validateEvidenceQuery(input), { definition: d, mode } = query;
  const selection = ['selected','attempt-comparison'].includes(mode) ? d.selection : null;
  const selectedCohort=selection?.kind==='economics-group';
  const scope = selection && !selectedCohort ? {} : d.scope;
  const kind = selection?.kind || (mode === 'comparison' ? (d.lens === 'context' ? 'context-session' : 'account') : ({ capacity:'account',context:'context-session',economics:'economics-group',routing:'routing-switch' }[d.lens]));
  let result, source, coverage;
  if (kind.startsWith('economics')) {
    let filters = { ...scope };
    delete filters.period;
    if (selection?.kind === 'economics-record') filters.recordId = selection.id;
    const cohort=selectedCohort ? economicsGroupFilters(selection,selection.groupBy) : !selection ? d.economics.cohort : null;
    if (!selection || selectedCohort) filters=mergeEconomicsFilters(scope,d.economics,cohort);
    result = readActivityEvidence(db,{operation:'activity',view:'economics',...filters,groupBy:d.economics.groupBy});
    if (result.items) result.items = result.items.map((row) => selectFields(row,ACTIVITY_FIELDS));
    source = 'usageHistory'; coverage = result.coverage;
  } else if (kind.startsWith('context')) {
    result = readContextEvidenceExport(db,d,mode,EXPORT_LIMITS.records);
    source = 'requestStats + contextStages + contextStructures + contextClientEvents + exact linked usageHistory';
    coverage = result.coverage;
  } else if (kind === 'account') {
    const clauses = [], args = [];
    const ids = selection ? [selection.id] : mode === 'comparison' ? d.comparisonIds : null;
    if (ids) { clauses.push(`id IN (${ids.map(()=>'?').join(',')})`); args.push(...ids); }
    else for (const [key,column] of [['provider','provider'],['connectionId','id']]) if (scope[key]) { clauses.push(`${column}=?`); args.push(scope[key]); }
    result = limited(db,`SELECT id,provider,name,isActive FROM providerConnections ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY provider,id`,args);
    if (result.items) result.items = result.items.map((row) => ({...row,windows:db.all('SELECT scope,remaining,"limit" AS capacity,resetAt,observedAt,confidence FROM quotaWindows WHERE connectionId=? ORDER BY scope',[row.id])}));
    source = 'providerConnections + quotaWindows'; coverage = { currentPersistedConfiguration: true, quotaHistory: false, quotaUnits: 'unknown', unsupportedScopeFields: ['start','end','model'].filter((key)=>scope[key]), requestedAccounts: ids, missingAccounts: ids?.filter((id)=>!result.items?.some((row)=>row.id===id)) || [] };
    if (selection?.windowId) {
      const params = new URLSearchParams({ connectionId: selection.id,
        ...(selection.windowScope ? { scope: selection.windowScope } : {}),
        ...(d.scope.start ? { start: d.scope.start } : {}), ...(d.scope.end ? { end: d.scope.end } : {}) });
      const history = readQuotaWorkbench(db, parseQuotaWorkbenchQuery(params));
      if (!history.complete) return { refused: true, code: 'quota_history_incomplete', message: history.instruction, totalRecords: history.total, limits: EXPORT_LIMITS };
      const selectedSeries = history.series.find(series => series.id === selection.windowId);
      result.quotaHistory = selectedSeries ? [selectedSeries] : [];
      coverage.quotaHistory = Boolean(selectedSeries);
      coverage.selectedQuotaHistory = { windowId: selection.windowId, available: Boolean(selectedSeries),
        timeRange: history.timeRange, source: 'quotaObservations', modelAttribution: 'unavailable',
        reason: selectedSeries ? null : 'Exact selected series is not retained in the shared capture period. No other series was substituted.' };
      source += ' + exact selected quotaObservations series';
    }
  } else {
    const clauses = [], args = [];
    if (selection) { clauses.push('id=?'); args.push(selection.id); }
    else {
      if (scope.connectionId) { clauses.push('(fromConnectionId=? OR toConnectionId=?)'); args.push(scope.connectionId,scope.connectionId); }
      if (scope.model) { clauses.push('model=?'); args.push(scope.model); }
      if (scope.provider) { clauses.push('toConnectionId IN (SELECT id FROM providerConnections WHERE provider=?)'); args.push(scope.provider); }
      if (scope.start) { clauses.push('switchedAt>=?'); args.push(scope.start); }
      if (scope.end) { clauses.push('switchedAt<?'); args.push(scope.end); }
    }
    result = limited(db,`SELECT id,model,fromConnectionId,toConnectionId,trigger,switchedAt FROM accountSwitches ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY switchedAt,id`,args);
    source = 'accountSwitches'; coverage = { freeformReasonsExcluded: true, sessionIdentityExcluded: true, providerAttribution:'Current configured provider of the recorded destination account; deleted destinations are unknown.' };
  }
  if (result.exceeded) return { refused: true, code: 'export_too_large', totalRecords: result.totalRecords, relatedEventRecords: result.relatedEventRecords, limits: EXPORT_LIMITS,
    message: `The selection exceeds the ${EXPORT_LIMITS.records}-record limit for attempts or related events. Narrow the filters; no partial export was produced.` };
  const timestamps = result.items.map((row)=>row.timestamp || row.switchedAt).filter(Boolean).sort();
  const payload = { manifest: { format: 'tokenproxy-evidence', version: 1, mode, source, ownerScope:OWNER_SCOPE, definition: d,
    scopeSemantics: mode==='attempt-comparison' ? 'Exact selected and baseline request/session pairs; shared filters do not restrict either identity.' : selectedCohort ? 'Selected cohort dimensions within the fixed shared scope.' : selection ? 'Exact selected identity; shared filters do not restrict this evidence.' : 'Complete matching population in one committed read snapshot.',
    timeBounds: { startInclusive: scope.start || null, endExclusive: scope.end || null, firstReturned: timestamps[0] || null,lastReturned: timestamps.at(-1) || null },
    totalRecords: result.totalRecords, returnedRecords: result.items.length, complete: true, missingSelection: Boolean(selection && (mode==='attempt-comparison' ? !result.items.some(row=>String(row.id)===selection.id) : !result.items.length)),
    ...(mode==='attempt-comparison' ? {requestedAttempts:result.requestedAttempts,missingAttempts:result.missingAttempts,comparisonComplete:result.missingAttempts.length===0} : {}),
    limits: EXPORT_LIMITS, coverage, omissions: ['credentials','request/response content','raw client identifiers and private session affinity hashes','freeform error/reason content','unverified cost linkage'],
    units: { tokens:'tokens',bytes:'bytes',latency:'ms',cost:'USD estimate or separately labeled report',quota:'unknown' },
    caveat: 'Historical pending is not active work. Cost estimates are not subscription spend. Records from different sources are never joined by timestamp.' }, items: result.items, ...(result.clientEvents ? {clientEvents:result.clientEvents} : {}), ...(result.quotaHistory ? {quotaHistory:result.quotaHistory} : {}) };
  if (Buffer.byteLength(JSON.stringify(payload)) > EXPORT_LIMITS.bytes) return { refused:true,code:'export_too_large',limits:EXPORT_LIMITS,message:'This evidence exceeds the 8 MiB export limit. Narrow the scope; no partial export was produced.' };
  return payload;
}
