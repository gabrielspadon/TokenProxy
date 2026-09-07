export const CLIENT_REFERENCE_FIELDS = ['clientRef','clientSessionRef','taskRef','projectRef'];
export const ECONOMICS_LINK_FIELDS = ['requestLink','requestedModel','completionId','clientKeyId','clientIdentitySource',...CLIENT_REFERENCE_FIELDS];

// Only retained exact request identities enrich the durable completion ledger.
// No freeform metadata or key material is projected from either source.
export function economicsLedgerSource(db, columns) {
  const requestColumns = new Set(db.all('PRAGMA table_info(requestStats)', []).map(row=>row.name));
  const linked = columns.has('requestId') && requestColumns.has('id');
  const agreement = ['logicalRequestId','contextSessionId','attempt','provider','model','connectionId'].filter(field=>columns.has(field) && requestColumns.has(field))
    .map(field=>`(u.${field} IS NULL OR u.${field}=r.${field})`).join(' AND ') || '1';
  const exact = linked ? `r.id IS NOT NULL AND ${agreement}` : '0';
  const identity = requestColumns.has('clientIdentitySource') && requestColumns.has('clientKeyId')
    ? `(${exact}) AND r.clientIdentitySource='client-reported' AND r.clientKeyId IS NOT NULL` : '0';
  const fields = CLIENT_REFERENCE_FIELDS.map(field=>linked && requestColumns.has(field)
    ? `CASE WHEN ${identity} AND length(r.${field})=69 AND substr(r.${field},1,5)='ctx1_' AND substr(r.${field},6) NOT GLOB '*[^a-f0-9]*' THEN r.${field} END AS ${field}`
    : `NULL AS ${field}`);
  const meta = columns.has('meta') ? "CASE WHEN json_valid(u.meta) THEN CASE WHEN json_type(u.meta)='object' THEN u.meta ELSE '{}' END ELSE '{}' END" : "'{}'";
  return `ledger AS (SELECT u.*,
    ${linked ? `CASE WHEN u.requestId IS NULL THEN 'unattributed' WHEN r.id IS NULL THEN 'unavailable' WHEN ${agreement} THEN 'linked' ELSE 'conflict' END` : "'unattributed'"} AS requestLink,
    CASE WHEN json_type(${meta},'$.requestedModel')='text' AND length(json_extract(${meta},'$.requestedModel'))<=200 THEN json_extract(${meta},'$.requestedModel') END AS requestedModel,
    ${columns.has('completionId') ? '' : 'NULL AS completionId,'}
    ${linked && requestColumns.has('clientKeyId') ? `CASE WHEN ${exact} THEN r.clientKeyId END` : 'NULL'} AS clientKeyId,
    ${linked && requestColumns.has('clientIdentitySource') ? `CASE WHEN ${exact} THEN r.clientIdentitySource END` : 'NULL'} AS clientIdentitySource,
    ${fields.join(',')},
    ${linked && requestColumns.has('latencyTotal') ? `CASE WHEN ${exact} THEN r.latencyTotal END` : 'NULL'} AS linkedLatency,
    ${linked && requestColumns.has('latencyTtft') ? `CASE WHEN ${exact} THEN r.latencyTtft END` : 'NULL'} AS linkedTtft
    FROM usageHistory u ${linked ? 'LEFT JOIN requestStats r ON r.id=u.requestId' : ''})`;
}

const amount = n => typeof n==='number' && Number.isFinite(n) && n>=0 ? n : null;
// Explain the captured v2 calculation, including its signed reasoning delta.
// Incomplete cache quantities cannot establish a decomposition or a saving.
export function costComponents(row) {
  const snapshot=row.rateSnapshot, rates=snapshot?.rates;
  const unavailable = reason=>({available:false,reason,unit:'USD',source:'application-rate-card'});
  if (!snapshot || snapshot.calculatorVersion!=='cache-inclusive-usd-v2' || snapshot.currency!=='USD' || snapshot.unit!=='per-million-tokens') return unavailable('supported-rate-snapshot-unavailable');
  if (!rates || amount(rates.input)===null || amount(rates.output)===null || Object.values(rates).some(value=>amount(value)===null)) return unavailable('usable-rates-unavailable');
  if ([row.inputTokens,row.outputTokens,row.cacheReadTokens,row.cacheWriteTokens].some(value=>amount(value)===null) || row.inconsistentCache || row.invalidTokens) return unavailable('complete-consistent-token-detail-unavailable');
  if (row.reasoningTokens!=null && (amount(row.reasoningTokens)===null || row.reasoningTokens>row.outputTokens)) return unavailable('reasoning-detail-inconsistent');
  const reasoning=row.reasoningTokens ?? 0;
  const components={uncachedInputUsd:row.uncachedInputTokens*rates.input/1e6,
    cacheReadUsd:row.cacheReadTokens*(rates.cached ?? rates.input)/1e6,
    cacheWriteUsd:row.cacheWriteTokens*(rates.cache_creation ?? rates.input)/1e6,
    outputUsd:row.outputTokens*rates.output/1e6,
    reasoningAdjustmentUsd:reasoning*((rates.reasoning ?? rates.output)-rates.output)/1e6};
  const total=Object.values(components).reduce((sum,value)=>sum+value,0);
  const differential=(row.cacheReadTokens+row.cacheWriteTokens)*rates.input/1e6-components.cacheReadUsd-components.cacheWriteUsd;
  if (![...Object.values(components),total,differential].every(Number.isFinite)) return unavailable('numeric-range-exceeded');
  return {available:true,unit:'USD',source:'application-rate-card',calculatorVersion:snapshot.calculatorVersion,
    ...components,totalUsd:total,cacheRateDifferentialUsd:differential,
    estimateDifferenceUsd:amount(row.estimatedCostUsd)===null ? null : total-row.estimatedCostUsd,
    reconcilesToEstimate:amount(row.estimatedCostUsd)===null ? null : Math.abs(total-row.estimatedCostUsd)<=Math.max(1e-12,Math.abs(row.estimatedCostUsd)*1e-10),
    reasoningPresent:row.reasoningTokens!=null,
    fallbackRates:['cached','cache_creation','reasoning'].filter(field=>rates[field]==null),
    definition:'Captured rate-card arithmetic. Cache differential compares these cache tokens at the input rate; it is not verified monetary savings or a provider charge.'};
}
