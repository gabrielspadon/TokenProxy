import { publicTurn } from './contextQueries.mjs';
import { publicContextEvent } from './contextEvents.mjs';
import { CONTEXT_STRUCTURE_DEFINITIONS, OWNED_EVENT_LINK, readContextRelated } from './contextRelated.mjs';
import { telemetryFilterSql } from './telemetryFilter.mjs';

const CONTROL_KEYS = ['rtk','rtkAllowLossy','schema','schemaAllowLossy','headroom','headroomAllowLossy','pxpipe','pxpipeAllowLossy','thinking','privacy','memory','qac','pairs','reorder','midinject','diet','lingua','epochMicro','epochAuto','handoff','adaptiveCacheTtl','caveman','ponytail','clientOptOut','contextStructure'];
export function readContextEvidenceExport(db, definition, mode, limit) {
  const selection = mode === 'selected' ? definition.selection : null;
  const scope = definition.scope, clauses = ['r.contextSessionId IS NOT NULL', telemetryFilterSql('requestStats', 'r')], args = [];
  const requestedAttempts = mode==='attempt-comparison' ? [{role:'selected',id:definition.selection.id,sessionId:definition.selection.sessionId},{role:'baseline',...definition.context.baseline}] : null;
  if (requestedAttempts) {
    clauses.push('((r.id=? AND r.contextSessionId=?) OR (r.id=? AND r.contextSessionId=?))');
    for (const item of requestedAttempts) args.push(item.id,item.sessionId);
  } else if (selection) {
    clauses.push('r.contextSessionId=?'); args.push(selection.sessionId);
    if (selection.kind === 'context-attempt') { clauses.push('r.id=?'); args.push(selection.id); }
  } else {
    for (const key of ['provider','model','connectionId']) if (scope[key]) { clauses.push(`r.${key}=?`); args.push(scope[key]); }
    if (mode === 'comparison') { clauses.push(`r.connectionId IN (${definition.comparisonIds.map(() => '?').join(',')})`); args.push(...definition.comparisonIds); }
    if (scope.start) { clauses.push('r.timestamp>=?'); args.push(scope.start); }
    if (scope.end) { clauses.push('r.timestamp<?'); args.push(scope.end); }
    if (definition.context.clientTool) { clauses.push('r.clientTool=?'); args.push(definition.context.clientTool); }
    if (definition.context.projectLabel) { clauses.push('r.contextSessionId IN (SELECT id FROM contextSessions WHERE projectLabel=?)'); args.push(definition.context.projectLabel); }
  }
  const where = clauses.join(' AND ');
  const totalRecords = db.get(`SELECT COUNT(*) AS n FROM requestStats r WHERE ${where}`, args).n;
  const eventJoin = `FROM contextClientEvents e JOIN requestStats r ON r.id=e.requestId AND ${OWNED_EVENT_LINK} WHERE ${where}`;
  const eventCount = db.get(`SELECT COUNT(*) AS n ${eventJoin}`, args).n;
  if (totalRecords > limit || eventCount > limit) return { exceeded:true,totalRecords,relatedEventRecords:eventCount };
  const rows = db.all(`SELECT r.* FROM requestStats r WHERE ${where} ORDER BY r.timestamp,r.id`, args);
  const related = readContextRelated(db, rows.map((row) => row.id)), stages = new Map();
  for (let offset=0;offset<rows.length;offset+=100) {
    const ids=rows.slice(offset,offset+100).map((row)=>row.id);
    for (const {requestId,...stage} of db.all(`SELECT requestId,ordinal,stage,beforeBytes,afterBytes,deltaBytes,outcome,risk,outcomeSource,errorCode,executionRequestId,durationMs,durationSource FROM contextStages WHERE requestId IN (${ids.map(()=>'?').join(',')}) ORDER BY requestId,ordinal`,ids)) {
      if (!stages.has(requestId)) stages.set(requestId,[]);
      stages.get(requestId).push(stage);
    }
  }
  const items = rows.map((row) => {
    const turn = publicTurn(row);
    return {...turn,controls:Object.fromEntries(Object.entries(turn.controls).filter(([key,value])=>CONTROL_KEYS.includes(key)&&typeof value==='boolean')),
      stages:stages.get(row.id)||[],structures:related.structures.get(row.id)||[],costRecords:related.costs.get(row.id)||[],handoffs:related.handoffs.get(row.id)||[]};
  });
  return { items,totalRecords,requestedAttempts,missingAttempts:requestedAttempts?.filter(item=>!rows.some(row=>row.id===item.id&&row.contextSessionId===item.sessionId)) || [],clientEvents:db.all(`SELECT e.* ${eventJoin} ORDER BY e.occurredAt,e.id`,args).map(publicContextEvent),
    coverage:{attributedAttempts:totalRecords,contextOnly:true,reconstruction:false,
      attemptsWithStructure:related.structures.size,rejectedStructures:related.rejectedStructures,relatedClientEvents:eventCount,
      attemptsWithLinkedCost:related.costs.size,requestedAccounts:mode==='comparison'?definition.comparisonIds:null,
      accountsWithoutMatchingAttempts:mode==='comparison'?definition.comparisonIds.filter(id=>!rows.some(row=>row.connectionId===id)):[],
      eventScope:'All retained events with an exact owned link to exported attempts; event times are client reported and may lie outside request-time bounds. Unlinked events are excluded.',
      structureDefinitions:CONTEXT_STRUCTURE_DEFINITIONS,
      cost:'Exact request-linked ledger records only. Recorded estimates and explicit USD reports remain separate; historical zero is ambiguous and no amount establishes subscription spend.'} };
}
