'use client';
import { useState } from 'react';
import { Alert, Button, Group, Loader, Table } from '@mantine/core';
import { useResource } from './useResource';
import { finite, orderedStages, quantity, signedBytes, STAGES, utc } from '../components/context-workspace/contextModel';
import styles from './ContextEvidence.module.css';

const BOUNDARIES = [['client-received','Client received'],['gateway-shaped','Gateway shaped'],['physical-dispatch','Physical dispatch']];
const ROLES = ['system','developer','user','assistant','tool','other'];
const PARTS = [['instructionBytes','Top-level instructions'],['toolSchemaBytes','Tool schemas'],['messageBytes','Messages'],['envelopeBytes','Other envelope fields']];
const SUBSETS = [['toolCalls','Tool calls'],['toolResults','Tool results'],['attachments','Attachments']];
const STAGE_NAMES = Object.fromEntries(STAGES);
const bytes = (value) => finite(value) ? `${quantity(value)} B` : 'Unavailable';
const cost = (value) => finite(value) ? `$${value.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:8})}` : 'Unavailable';
const delta = (after,before) => finite(after) && finite(before) ? after-before : null;
function BoundaryTable({ caption, structures, rows }) {
  const values = BOUNDARIES.map(([boundary]) => structures.find((item)=>item.boundary===boundary));
  return <div className={styles.tableScroll} role="region" aria-label={`${caption} · scrollable table`} tabIndex={0}><Table className={styles.table} aria-label={caption}>
    <Table.Caption>{caption}</Table.Caption><Table.Thead><Table.Tr><Table.Th scope="col">Measurement</Table.Th>{BOUNDARIES.map(([key,label])=><Table.Th scope="col" key={key}>{label}</Table.Th>)}</Table.Tr></Table.Thead>
    <Table.Tbody>{rows.map(([label,read])=><Table.Tr key={label}><Table.Th scope="row">{label}</Table.Th>{values.map((value,index)=><Table.Td key={index}>{value ? read(value) : 'Unavailable'}</Table.Td>)}</Table.Tr>)}</Table.Tbody>
  </Table></div>;
}
export function ContextStructureEvidence({ turn }) {
  const structures = turn.structures || [];
  return <div className={styles.evidence}>
    <div className={styles.intro}><h3>Three measured request boundaries</h3><p>Serialized JSON, measured in UTF-8 bytes. No prompt content is retained. Missing boundaries are unavailable, never zero.</p></div>
    <BoundaryTable caption="Body partition · UTF-8 JSON bytes" structures={structures} rows={[
      ['Whole body', (value)=>bytes(value.bodyBytes)], ...PARTS.map(([key,label])=>[label,(value)=>bytes(value[key])]),
      ['History prefix object', (value)=>bytes(value.historyPrefixBytes)],
    ]} />
    <p className={styles.note}>Instructions + tool schemas + messages + other envelope fields = whole body. The history prefix is a separate structured object, not an additional body component.</p>
    <div className={styles.twoColumns}>
      <section><BoundaryTable caption="Message roles · count / bytes" structures={structures} rows={[
        ...ROLES.map((role)=>[role[0].toUpperCase()+role.slice(1),(value)=>`${quantity(value.roles?.[role]?.count)} / ${bytes(value.roles?.[role]?.bytes)}`]),
        ['Message container',(value)=>bytes(value.messageContainerBytes)],
      ]} /><p className={styles.note}>Role bytes + message container bytes = messages. A role count counts protocol messages, not people or agents.</p></section>
      <section><BoundaryTable caption="Overlapping subsets · count / bytes" structures={structures} rows={SUBSETS.map(([key,label])=>[label,(value)=>`${quantity(value.subsets?.[key]?.count)} / ${bytes(value.subsets?.[key]?.bytes)}`])} /><p className={styles.note}>Tool and attachment subsets overlap roles and may overlap one another. Do not add these values. Attachment bytes describe serialized references or encoded content, not decoded media.</p></section>
    </div>
    <details className={styles.disclosure}><summary>Fingerprint evidence and scope</summary><p>Installation-keyed HMAC-SHA256. Compare only within the same installation key. History prefix covers instructions, tools and history before the latest syntactic user message. A changed digest does not prove compaction, cache eligibility or a provider action.</p>
      <div className={styles.fingerprints}>{BOUNDARIES.map(([key,label])=>{const value=structures.find((item)=>item.boundary===key);return <section key={key}><h4>{label}</h4>{value ? <dl>{Object.entries(value.fingerprints || {}).map(([name,digest])=><div key={name}><dt>{name}</dt><dd>{digest}</dd></div>)}</dl> : <p>Unavailable</p>}</section>;})}</div>
    </details>
  </div>;
}
export function ContextClientEvents({ turn, sessionId, scope, filters = {}, onSnapshot }) {
  const [page,setPage]=useState(1);
  const query=new URLSearchParams({...(turn ? {requestId:String(turn.id),sessionId:String(sessionId)} : {}),page:String(page),pageSize:'20'});
  if (!turn) {
    for (const key of ['provider','model','connectionId']) if (scope?.[key]) query.set(key,scope[key]);
    if (scope?.start) query.set('from',scope.start);
    if (scope?.end) query.set('until',scope.end);
    for (const key of ['projectLabel','clientTool']) if (filters[key]) query.set(key,filters[key]);
  }
  const resource=useResource(`/api/context/events?${query}`,{onSnapshot});
  const data=resource.data;
  return <section className={styles.evidence} aria-label="Explicit client reports">
    <div className={styles.intro}><h3>Explicit client reports</h3><p>{turn ? 'Authenticated client reports linked to this exact request and session. All retained report times are included, independently of the request-time filter.' : 'The shared time filter applies to client-reported event time. Provider, model, account and project-label filters include only exact request-linked reports; unlinked reports have unknown routing.'} These reports do not verify a provider action.</p></div>
    {turn?.compactHint && <Alert color="orange" title="Separate gateway observation">A prefix discontinuity was observed. This is not proof of client compaction.</Alert>}
    {resource.loading && !data && <div role="status"><Loader size="sm" />Reading client reports…</div>}
    {resource.error && <Alert color="red" title="Client reports unavailable">{resource.error}<Button variant="subtle" onClick={resource.refresh}>Try again</Button></Alert>}
    {data?.events?.length ? <div className={styles.events}>{data.events.map((event)=><article key={event.id} className={styles.event}>
      <div className={styles.eventHead}><h4>{event.type.replaceAll('_',' ')}</h4><span>Client reported · provider unverified</span><span>{event.requestId ? 'Exact request link' : 'Unlinked report'}</span>{event.outcome && <strong>{event.outcome}</strong>}</div>
      <dl className={styles.facts}><div><dt>Reported · UTC</dt><dd>{utc(event.occurredAt)}</dd></div><div><dt>Received · UTC</dt><dd>{utc(event.recordedAt)}</dd></div>
        {event.type==='compaction' && <><div><dt>Before / after</dt><dd>{quantity(event.beforeTokens)} / {quantity(event.afterTokens)} client tokens</dd></div><div><dt>Measurement method</dt><dd>{event.tokenMeasurementMethod || 'Unavailable'}</dd></div></>}
      </dl>
      <details className={styles.disclosure}><summary>Exact report links</summary><dl className={styles.identities}>{['id','clientEventId','requestId','logicalRequestId','contextSessionId','clientKeyId','clientRef','clientSessionRef','taskRef','projectRef','targetClientRef','targetTaskRef'].map((key)=><div key={key}><dt>{key}</dt><dd>{event[key] ?? 'Unavailable'}</dd></div>)}</dl></details>
    </article>)}</div> : data && <p className={styles.empty}>No explicit client reports are retained {turn ? 'for this request' : 'in this scope'}. Absence of a report does not establish that no compaction or handoff occurred.</p>}
    {data?.pagination && <nav className={styles.pager} aria-label="Client reports pagination"><span>{quantity(data.pagination.totalItems)} reports · page {quantity(page)} of {quantity(data.pagination.totalPages)}</span><Group gap={6}><Button size="compact-sm" variant="default" disabled={!data.pagination.hasPrev} onClick={()=>setPage(page-1)}>Previous reports</Button><Button size="compact-sm" variant="default" disabled={!data.pagination.hasNext} onClick={()=>setPage(page+1)}>Next reports</Button></Group></nav>}
    {turn && <details className={styles.disclosure}><summary>Explicit identity provenance</summary><p>References are reported by the client and scoped to the installation and authenticated API key. They do not establish a verified person, agent hierarchy or application project.</p><dl className={styles.identities}>{Object.entries(turn.explicitIdentity || {}).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value ?? 'Unavailable'}</dd></div>)}</dl>{!turn.explicitIdentity?.clientRef && <p>Explicit client identity is unavailable for this attempt.</p>}</details>}
  </section>;
}
export function ContextCostEvidence({ records=[] }) {
  return <section className={styles.costs}><h4>Exact linked cost evidence</h4>{records.length ? records.map((row)=><dl className={styles.facts} key={row.ledgerId}><div><dt>Ledger record</dt><dd>#{row.ledgerId}</dd></div><div><dt>Recorded amount</dt><dd>{cost(row.recordedCostUsd)}</dd></div><div><dt>Rate estimate · USD</dt><dd>{cost(row.estimatedCostUsd)}</dd></div><div><dt>Reported amount · USD</dt><dd>{cost(row.reportedCostUsd)}</dd></div><div><dt>Cost source</dt><dd>{row.costSource || 'Unavailable'}</dd></div><div><dt>Rate snapshot</dt><dd>{row.rateSnapshotId || 'Unavailable'}</dd></div></dl>) : <p>No exact request-linked ledger cost is available.</p>}<p className={styles.note}>Amounts are retained estimates or separately labeled reports, not subscription spend or confirmed charges. Historical zero is ambiguous. Bytes removed do not establish monetary savings.</p></section>;
}
export function ContextAttemptComparison({ turn, baseline, onBaseline, onClear }) {
  const old = baseline?.turn;
  const same = old && String(old.id)===String(turn.id);
  return <section className={styles.evidence} aria-label="Attempt comparison">
    <div className={styles.intro}><h3>Compare exact attempts</h3><p>Choose a baseline explicitly, then inspect another attempt. Its exact identity is retained across lenses and saved investigations; values are read again when the investigation is restored.</p><Group gap={8}><Button variant="default" size="compact-sm" onClick={()=>onBaseline(turn)}>Use this attempt as baseline</Button>{baseline && <Button variant="subtle" size="compact-sm" onClick={onClear}>Clear baseline</Button>}</Group></div>
    {!baseline ? <p className={styles.empty}>No comparison baseline selected.</p> : baseline.loading ? <p role="status">Reading exact baseline #{baseline.identity.id}…</p> : baseline.error ? <Alert color="red" title="Baseline unavailable">{baseline.error}<Button variant="subtle" onClick={baseline.refresh}>Retry baseline</Button></Alert> : !old ? <p className={styles.empty}>Baseline #{baseline.identity.id} in session #{baseline.identity.sessionId} is no longer retained. No substitute attempt is selected.</p> : <>
      <div className={styles.comparisonHead}><div><span>Retained baseline</span><strong>#{old.id}</strong><time>{utc(old.timestamp)} UTC</time><small>Snapshot read {utc(baseline.receivedAt)} UTC</small></div><div><span>Selected attempt</span><strong>#{turn.id}</strong><time>{utc(turn.timestamp)} UTC</time><small>{same ? 'Same attempt selected' : old.logicalRequestId && old.logicalRequestId===turn.logicalRequestId ? 'Same exact logical request' : 'Different logical requests; no causal relationship asserted'}</small></div></div>
      <div className={styles.tableScroll} role="region" aria-label="Attempt measurements · scrollable table" tabIndex={0}><Table className={styles.table} aria-label="Attempt measurement comparison"><Table.Caption>Selected minus baseline, each quantity retains its unit</Table.Caption><Table.Thead><Table.Tr><Table.Th>Measurement</Table.Th><Table.Th>Baseline</Table.Th><Table.Th>Selected</Table.Th><Table.Th>Change</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
        {[['Context estimate','contextEstimate','estimated tokens'],['Provider input','providerInputTokens','tokens'],['Cache read','cacheReadTokens','tokens'],['Cache write','cacheWriteTokens','tokens'],['Provider output','providerOutputTokens','tokens']].map(([label,key,unit])=><Table.Tr key={key}><Table.Th scope="row">{label} · {unit}</Table.Th><Table.Td>{quantity(old[key])}</Table.Td><Table.Td>{quantity(turn[key])}</Table.Td><Table.Td>{finite(delta(turn[key],old[key])) ? `${delta(turn[key],old[key])>0?'+':''}${quantity(delta(turn[key],old[key]))}` : 'Unavailable'}</Table.Td></Table.Tr>)}
        {BOUNDARIES.map(([key,label])=>{const a=old.structures?.find((item)=>item.boundary===key),b=turn.structures?.find((item)=>item.boundary===key);return <Table.Tr key={key}><Table.Th scope="row">{label} · body bytes</Table.Th><Table.Td>{bytes(a?.bodyBytes)}</Table.Td><Table.Td>{bytes(b?.bodyBytes)}</Table.Td><Table.Td>{signedBytes(delta(b?.bodyBytes,a?.bodyBytes))}</Table.Td></Table.Tr>;})}
      </Table.Tbody></Table></div>
      <div className={styles.tableScroll} role="region" aria-label="Signed shaping changes · scrollable table" tabIndex={0}><Table className={styles.table} aria-label="Signed shaping comparison"><Table.Caption>Shaping changes in each attempt, after − before · UTF-8 bytes</Table.Caption><Table.Thead><Table.Tr><Table.Th>Stage</Table.Th><Table.Th>Baseline change</Table.Th><Table.Th>Selected change</Table.Th><Table.Th>Difference</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{orderedStages(turn.stages).map((stage)=>{const prior=old.stages?.find((item)=>item.ordinal===stage.ordinal&&item.stage===stage.stage);return <Table.Tr key={stage.ordinal}><Table.Th scope="row">{String(stage.ordinal+1).padStart(2,'0')} {STAGE_NAMES[stage.stage] || stage.stage}</Table.Th><Table.Td>{signedBytes(prior?.deltaBytes)}</Table.Td><Table.Td>{signedBytes(stage.deltaBytes)}</Table.Td><Table.Td>{signedBytes(delta(stage.deltaBytes,prior?.deltaBytes))}</Table.Td></Table.Tr>;})}</Table.Tbody></Table></div>
      <p className={styles.note}>Provider quantities remain separate from estimates and bytes. Differences do not establish optimization savings or prove compaction. Baseline values are the labeled read, not a live refresh. Exporting both attempts reads their exact identities together in one committed snapshot.</p>
    </>}
  </section>;
}
