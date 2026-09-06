import { InvestigationError, OWNER_SCOPE, object, validateDefinition } from './investigationModel.mjs';
import { readActivityEvidence } from './activityQueries.mjs';
import { publicTurn } from './contextQueries.mjs';

export const EXPORT_LIMITS = { records: 5000, bytes: 8 * 1024 * 1024 };
export function validateEvidenceQuery(query) {
  object(query,['operation','mode','definition']);
  if (query.operation !== 'evidence' || !['selected','population','comparison'].includes(query.mode)) throw new InvestigationError('Invalid evidence export.');
  const definition = validateDefinition(query.definition);
  if (query.mode === 'selected' && !definition.selection) throw new InvestigationError('Select a record first.');
  if (query.mode === 'comparison' && !definition.comparisonIds.length) throw new InvestigationError('Select comparison accounts first.');
  if(query.mode==='population' && definition.lens==='capacity')throw new InvestigationError('Capacity exports exact selected or comparison accounts. Use Economics or Context for a time-filtered population.');
  if(query.mode==='selected' && definition.selection?.kind==='economics-group' && (!definition.selection.provider || (definition.selection.groupBy==='model'&&!definition.selection.model) || (definition.selection.groupBy==='account'&&!definition.selection.connectionId)))throw new InvestigationError('This cohort has an unspecified dimension. Select exact records or a supported filtered population.');
  return { operation: 'evidence', mode: query.mode, definition };
}
function selectFields(row,keys) { return Object.fromEntries(keys.map((key) => [key,row[key] ?? null])); }
const ACTIVITY_FIELDS = ['id','timestamp','provider','model','connectionId','status','requestId','logicalRequestId','attempt','contextSessionId','projectId','dispatchCoverage','usageSource','inputTokens','uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','recordedCostUsd','estimatedCostUsd','reportedCostUsd','costSource','rateSnapshotId','pricingCapturedAt','latencyMs','ttftMs','invalidTokens','inconsistentCache','missingTokenDetail'];
function limited(db,sql,args) {
  const total = db.get(`SELECT COUNT(*) AS n FROM (${sql})`,args).n;
  if (total > EXPORT_LIMITS.records) return { exceeded: true, totalRecords: total };
  return { items: db.all(sql,args), totalRecords: total };
}
export function readEvidence(db,input) {
  const query = validateEvidenceQuery(input), { definition: d, mode } = query;
  const selection = mode === 'selected' ? d.selection : null;
  const selectedCohort=selection?.kind==='economics-group';
  const scope = selection && !selectedCohort ? {} : d.scope;
  const kind = selection?.kind || (mode === 'comparison' ? 'account' : ({ capacity:'account',context:'context-session',economics:'economics-group',routing:'routing-switch' }[d.lens]));
  let result, source, coverage;
  if (kind.startsWith('economics')) {
    const filters = { ...scope };
    delete filters.period;
    if (selection?.kind === 'economics-record') filters.recordId = selection.id;
    const cohort=selectedCohort ? selection : !selection ? d.economics.cohort : null;
    if (cohort) for (const key of ['provider','model','connectionId']) if (cohort[key]) {
      if (filters[key] && filters[key]!==cohort[key]) throw new InvestigationError('The retained cohort conflicts with the shared scope. Clear the cohort or restore its matching scope before exporting.');
      filters[key]=cohort[key];
    }
    result = readActivityEvidence(db,{operation:'activity',view:'economics',...filters,groupBy:d.economics.groupBy,
      ...(!selection && d.economics.status !== 'all' ? {status:d.economics.status} : {})});
    if (result.items) result.items = result.items.map((row) => selectFields(row,ACTIVITY_FIELDS));
    source = 'usageHistory'; coverage = result.coverage;
  } else if (kind.startsWith('context')) {
    const clauses = ['contextSessionId IS NOT NULL'], args = [];
    if (selection) { clauses.push(selection.kind === 'context-attempt' ? 'id=? AND contextSessionId=?' : 'contextSessionId=?'); args.push(...(selection.kind === 'context-attempt' ? [selection.id,selection.sessionId] : [selection.sessionId])); }
    else {
      for (const key of ['provider','model','connectionId']) if (scope[key]) { clauses.push(`${key}=?`); args.push(scope[key]); }
      if (scope.start) { clauses.push('timestamp>=?'); args.push(scope.start); }
      if (scope.end) { clauses.push('timestamp<?'); args.push(scope.end); }
      if (d.context.clientTool) { clauses.push('clientTool=?'); args.push(d.context.clientTool); }
      if (d.context.projectLabel) { clauses.push('contextSessionId IN (SELECT id FROM contextSessions WHERE projectLabel=?)'); args.push(d.context.projectLabel); }
    }
    result = limited(db,`SELECT * FROM requestStats WHERE ${clauses.join(' AND ')} ORDER BY timestamp,id`,args);
    if (result.items) {
      const ids = result.items.map((row) => row.id), stages = [];
      for (let offset=0;offset<ids.length;offset+=100) { const page = ids.slice(offset,offset+100); stages.push(...db.all(`SELECT requestId,ordinal,stage,beforeBytes,afterBytes,deltaBytes,outcome,risk FROM contextStages WHERE requestId IN (${page.map(()=>'?').join(',')}) ORDER BY requestId,ordinal`,page)); }
      const byRequest=new Map();for(const stage of stages){if(!byRequest.has(stage.requestId))byRequest.set(stage.requestId,[]);byRequest.get(stage.requestId).push(selectFields(stage,['ordinal','stage','beforeBytes','afterBytes','deltaBytes','outcome','risk']));}
      const controlKeys=['rtk','rtkAllowLossy','schema','schemaAllowLossy','headroom','headroomAllowLossy','pxpipe','pxpipeAllowLossy','thinking','privacy','memory','qac','pairs','reorder','midinject','caveman','ponytail','clientOptOut'];
      result.items = result.items.map((row) => {const turn=publicTurn(row);return {...turn,controls:Object.fromEntries(Object.entries(turn.controls).filter(([key,value])=>controlKeys.includes(key)&&typeof value==='boolean')),stages:byRequest.get(row.id)||[]};});
    }
    source = 'requestStats + contextStages';
    coverage = { attributedAttempts: result.totalRecords, reconstruction: false, contextOnly: true, includedCollections:['requestStats','contextStages'], excludedCollections:['contextStructures','clientEvents'] };
  } else if (kind === 'account') {
    const clauses = [], args = [];
    const ids = selection ? [selection.id] : mode === 'comparison' ? d.comparisonIds : null;
    if (ids) { clauses.push(`id IN (${ids.map(()=>'?').join(',')})`); args.push(...ids); }
    else for (const [key,column] of [['provider','provider'],['connectionId','id']]) if (scope[key]) { clauses.push(`${column}=?`); args.push(scope[key]); }
    result = limited(db,`SELECT id,provider,name,isActive FROM providerConnections ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY provider,id`,args);
    if (result.items) result.items = result.items.map((row) => ({...row,windows:db.all('SELECT scope,remaining,"limit" AS capacity,resetAt,observedAt,confidence FROM quotaWindows WHERE connectionId=? ORDER BY scope',[row.id])}));
    source = 'providerConnections + quotaWindows'; coverage = { currentPersistedConfiguration: true, quotaHistory: false, quotaUnits: 'unknown', unsupportedScopeFields: ['start','end','model'].filter((key)=>scope[key]), requestedAccounts: ids, missingAccounts: ids?.filter((id)=>!result.items?.some((row)=>row.id===id)) || [] };
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
    source = 'accountSwitches'; coverage = { freeformReasonsExcluded: true, sessionIdentityExcluded: true };
  }
  if (result.exceeded) return { refused: true, code: 'export_too_large', totalRecords: result.totalRecords, limits: EXPORT_LIMITS,
    message: `The selected population contains ${result.totalRecords} records. Narrow the shared filters to at most ${EXPORT_LIMITS.records}; no partial export was produced.` };
  const timestamps = result.items.map((row)=>row.timestamp || row.switchedAt).filter(Boolean).sort();
  const payload = { manifest: { format: 'tokenproxy-evidence', version: 1, mode, source, ownerScope:OWNER_SCOPE, definition: d,
    scopeSemantics: selectedCohort ? 'Selected cohort dimensions within the fixed shared scope.' : selection ? 'Exact selected identity; shared filters do not restrict this evidence.' : 'Complete matching population in one committed read snapshot.',
    timeBounds: { startInclusive: scope.start || null, endExclusive: scope.end || null, firstReturned: timestamps[0] || null,lastReturned: timestamps.at(-1) || null },
    totalRecords: result.totalRecords, returnedRecords: result.items.length, complete: true, missingSelection: Boolean(selection && !result.items.length),
    limits: EXPORT_LIMITS, coverage, omissions: ['credentials','request/response content','private session identity','freeform error/reason content','unverified cost linkage'],
    units: { tokens:'tokens',bytes:'bytes',latency:'ms',cost:'USD estimate or separately labeled report',quota:'unknown' },
    caveat: 'Historical pending is not active work. Cost estimates are not subscription spend. Records from different sources are never joined by timestamp.' }, items: result.items };
  if (Buffer.byteLength(JSON.stringify(payload)) > EXPORT_LIMITS.bytes) return { refused:true,code:'export_too_large',limits:EXPORT_LIMITS,message:'This evidence exceeds the 8 MiB export limit. Narrow the scope; no partial export was produced.' };
  return payload;
}
