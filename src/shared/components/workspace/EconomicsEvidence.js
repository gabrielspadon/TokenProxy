'use client';
import { Button, Group, Tabs } from '@mantine/core';
import { formatCount, formatEstimate, recordTime, qualityNotes, TOKEN_COLUMNS } from './economics';
import styles from './EconomicsEvidence.module.css';

const money=value=>Number.isFinite(value) ? new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:9}).format(value) : 'Unavailable';
function Facts({items}) {return <dl className={styles.facts}>{items.map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value ?? 'Unavailable'}</dd></div>)}</dl>;}
function CostArithmetic({row}) {
  const value=row.costComponents, snapshot=row.rateSnapshot;
  return <section className={styles.section} aria-label="Captured rate calculation">
    <h3>Captured rate calculation</h3>
    {!value?.available ? <p>Rate decomposition unavailable. {value?.reason?.replaceAll('-',' ')}. Missing quantities are not priced as zero here.</p> : <>
      <div className={styles.scroll} tabIndex={0} role="region" aria-label="Cost components, scrollable table"><table><thead><tr><th>Component</th><th>Calculated USD</th></tr></thead><tbody>
        {[['Uncached input','uncachedInputUsd'],['Cache read','cacheReadUsd'],['Cache write','cacheWriteUsd'],['Output, including reasoning','outputUsd'],['Reasoning rate adjustment','reasoningAdjustmentUsd'],['Component total','totalUsd']].map(([name,key])=><tr key={key}><th scope="row">{name}</th><td>{money(value[key])}</td></tr>)}
      </tbody></table></div>
      <p>{value.reconcilesToEstimate===true ? 'Components reconcile to the stored application estimate.' : value.reconcilesToEstimate===false ? 'Components do not reconcile to the stored estimate. Keep the discrepancy visible.' : 'No stored application estimate is available for reconciliation.'}</p>
      <Facts items={[["Difference from stored estimate (USD)",money(value.estimateDifferenceUsd)],["Cache rate differential (USD)",money(value.cacheRateDifferentialUsd)]]}/>
      <p>The cache differential compares these recorded cache tokens at the captured input rate. It can be negative because cache writes can cost more. It does not establish avoided calls, provider charges or monetary savings.</p>
      {!value.reasoningPresent && <p>The recorded calculator treats absent reasoning detail as zero adjustment. It does not prove that no reasoning occurred.</p>}
    </>}
    {snapshot && <details><summary>Immutable rate snapshot and denominator</summary><Facts items={[["Snapshot",snapshot.id],["Captured",row.pricingCapturedAt ? recordTime(row.pricingCapturedAt,true) : null],["Calculator",snapshot.calculatorVersion],["Source",snapshot.source],["Unit",`${snapshot.currency} / ${snapshot.unit}`]]}/><div className={styles.scroll} tabIndex={0} role="region" aria-label="Captured rates, scrollable table"><table><thead><tr><th>Rate</th><th>USD / million tokens</th></tr></thead><tbody>{['input','cached','cache_creation','output','reasoning'].map(field=><tr key={field}><th scope="row">{field.replaceAll('_',' ')}</th><td>{money(snapshot.rates?.[field])}</td></tr>)}</tbody></table></div>{value?.fallbackRates?.length>0 && <p>Recorded calculator fallback rates apply to {value.fallbackRates.join(', ')}.</p>}</details>}
  </section>;
}
export function CounterfactualEvidence({ value }) {
  return <section className={styles.section} aria-label="Counterfactual cost evidence">
    <h3>Modeled request difference</h3>
    {!value?.available ? <p>Counterfactual evidence unavailable. {value?.state?.replaceAll('-', ' ') || 'No exact ledger link was retained'}. A similar timestamp or cost does not establish a join.</p> : <>
      <Facts items={[["Counterfactual record", value.id], ["Recorded (UTC)", recordTime(value.recordedAt, true)], ["Identity basis", value.identityBasis], ["Estimated uncached baseline (USD)", money(value.baselineUsd)], ["Reported usage priced by this model (USD)", money(value.usageModelUsd)], ["Baseline minus usage model (USD)", money(value.modeledDifferenceUsd)]]}/>
      <p>{value.modeledDifferenceUsd < 0 ? 'The usage model exceeds the estimated baseline. The negative difference is retained.' : 'A positive modeled difference does not establish an avoided charge.'}</p>
      <Facts items={[["Input-estimate difference (USD)", money(value.inputEstimateDifferenceUsd)], ["Cache-pricing difference (USD)", money(value.cachePricingDifferenceUsd)]]}/>
      {!value.splitAvailable && <p>The attribution split is unavailable. Historical zero/zero split columns do not establish that either component was zero.</p>}
      <p>{value.baselineMethod}</p><p>{value.limitation}</p>
      <p>These modeled dollars are separate from recorded completion cost, reported tokens and measured body bytes. They must not be summed with the completion ledger or labeled task-success cost.</p>
    </>}
  </section>;
}
export function EconomicsEvidence({row,onDrilldown,onContext}) {
  if (!row) return null;
  const physical=row.dispatchCoverage==='physical-dispatch' && row.logicalRequestId && Number.isInteger(row.attempt) && row.attempt>0;
  const completed = row.status === 'success' || row.status === 'ok';
  const modelLabel = completed ? 'Served' : 'Recorded attempt';
  return <div className={styles.evidence}>
    <div className={styles.models}><strong>Requested · {row.requestedModel || 'Unavailable'}</strong><span>{modelLabel} · {row.provider || 'Unknown'} / {row.model || 'Unknown'}</span></div>
    {!completed && <p>The recorded attempt does not establish successful service of this model.</p>}
    <Group gap="xs" wrap="wrap" className={styles.actions}>
      {row.logicalRequestId && <Button size="compact-sm" variant="light" onClick={()=>onDrilldown?.('logical-request',{logicalRequestId:row.logicalRequestId})}>Scoped logical attempts</Button>}
      {row.contextSessionId && <Button size="compact-sm" variant="light" onClick={()=>onDrilldown?.('session',{contextSessionId:row.contextSessionId})}>Scoped session costs</Button>}
      {row.projectRef && <Button size="compact-sm" variant="light" onClick={()=>onDrilldown?.('client-project',{projectRef:row.projectRef})}>Scoped project reference</Button>}
      {row.requestLink==='linked' && row.contextSessionId && onContext && <Button size="compact-sm" variant="default" onClick={()=>onContext(row)}>Open exact Context attempt</Button>}
    </Group>
    <Tabs defaultValue="cost" keepMounted={false}>
      <Tabs.List aria-label="Economics evidence"><Tabs.Tab value="cost">Cost basis</Tabs.Tab><Tabs.Tab value="rates">Rate calculation</Tabs.Tab><Tabs.Tab value="counterfactual">Modeled difference</Tabs.Tab><Tabs.Tab value="identity">Exact links</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="cost" pt="sm"><div className={styles.columns}><section className={styles.section}><h3>Recorded cost evidence</h3><Facts items={[["Chosen ledger amount (USD)",money(row.recordedCostUsd)],["Cost source",row.costSource || 'Historical source unavailable'],["Application estimate (USD)",money(row.estimatedCostUsd)],["Upstream-reported USD",money(row.reportedCostUsd)],["Confirmed invoice charge",'Unavailable']]}/><p>The ledger chooses the upstream USD report when present, otherwise the application estimate. These two amounts must not be added. Historical zero does not establish free usage.</p></section><section className={styles.section}><h3>Linked performance</h3><Facts items={[["Exact request link",row.requestLink],["Latency (ms)",Number.isFinite(row.latencyMs)?formatCount(row.latencyMs):null],["First token (ms)",Number.isFinite(row.ttftMs)?formatCount(row.ttftMs):null],["Physical attempt",physical?`${row.attempt} · ${row.attempt===1?'initial':'additional'}`:'Unavailable'],["Dispatch coverage",row.dispatchCoverage],["Usage source",row.usageSource]]}/><p>Latency comes only from the compatible exact request identity. Additional attempts are not automatically avoidable cost. Task-success cost requires an explicit meaningful outcome and is not established by a successful HTTP response. Context attempts are not linked by timestamp.</p></section></div><div className={styles.tokenFacts}><Facts items={TOKEN_COLUMNS.map(column=>[`${column.label} tokens`,formatCount(row[column.id])])}/></div>{qualityNotes(row,true).length>0 && <ul className={styles.quality}>{qualityNotes(row,true).map(note=><li key={note}>{note}</li>)}</ul>}</Tabs.Panel>
      <Tabs.Panel value="rates" pt="sm"><CostArithmetic row={row}/></Tabs.Panel>
      <Tabs.Panel value="counterfactual" pt="sm"><CounterfactualEvidence value={row.counterfactual}/></Tabs.Panel>
      <Tabs.Panel value="identity" pt="sm"><section className={styles.section}><h3>Exact identity and model evidence</h3><Facts items={[["Ledger record",row.id],["Physical request",row.requestId],["Logical request",row.logicalRequestId],["Explicit session",row.contextSessionId],["Requested model",row.requestedModel],[`${modelLabel} provider / model`,`${row.provider || 'Unknown'} / ${row.model || 'Unknown'}`],["Client identity source",row.clientIdentitySource],["Client reference",row.clientRef],["Client session reference",row.clientSessionRef],["Task reference",row.taskRef],["Client project reference",row.projectRef],["Application project",row.projectId]]}/><p>Client references are installation-keyed hashes scoped to the authenticated key and client. They do not establish a person, cross-client project, or task outcome. New usage records retain validated references after request history expires; request-side metrics can become unavailable. No timestamp-based attribution is used.</p></section></Tabs.Panel>
    </Tabs>
  </div>;
}
export function EconomicsCoverage({summary}) {
  return <details className={styles.coverage}><summary>{formatCount(summary.linkedRequestRows)} / {formatCount(summary.records)} exact request links · {formatCount(summary.explicitSessionRows)} session rows · {formatCount(summary.clientProjectRows)} client-project rows</summary><div className={styles.columns}><Facts items={[["Application estimates / records",`${formatCount(summary.estimatedCostSamples)} / ${formatCount(summary.records)}`],["Upstream USD reports / records",`${formatCount(summary.reportedCostSamples)} / ${formatCount(summary.records)}`],["Immutable rate snapshots",formatCount(summary.rateSnapshotRows)],["Unknown cost source",formatCount(summary.unknownCostSourceRows)],["Conflicting / unavailable request links",`${formatCount(summary.conflictingRequestRows)} / ${formatCount(summary.unavailableRequestRows)}`]]}/><Facts items={[["Physical additional attempts",formatCount(summary.additionalAttemptRows)],["Additional attempt recorded USD",formatEstimate(summary.additionalAttemptCostUsd)],["Usable cost + latency pairs",formatCount(summary.costLatencySamples)],["Mean latency over these pairs (ms)",formatCount(summary.pairedAverageLatencyMs)],["Recorded USD over these pairs",formatEstimate(summary.pairedCostUsd)]]}/></div><p>Coverage and additional-attempt cost use this complete filtered population. References are client-reported; costs are estimates or separate USD reports, never inferred confirmed charges.</p></details>;
}
