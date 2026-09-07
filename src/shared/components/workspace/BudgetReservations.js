'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Autocomplete, Button, Group, NumberInput, Select, Stack, TextInput } from '@mantine/core';
import { BUDGET_USAGE_FIELDS, budgetResolution, readJson } from './economicsToolsModel';
import styles from './EconomicsTools.module.css';

const quantity=value=>value==null?'Unknown':new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(value);
const measured=(value,unknown)=>`${quantity(value)}${unknown>0?` + ${quantity(unknown)} unknown records`:''}`;
export default function BudgetReservations() {
  const [keys,setKeys]=useState([]), [keyId,setKeyId]=useState(''), [data,setData]=useState(null), [selected,setSelected]=useState(null);
  const [kind,setKind]=useState('provider-usage'), [reference,setReference]=useState(''), [draft,setDraft]=useState({}), [review,setReview]=useState(null);
  const [error,setError]=useState(null), [notice,setNotice]=useState(null), [pending,setPending]=useState(false), [before,setBefore]=useState(null);
  const generation=useRef(0);
  useEffect(()=>{let active=true;readJson('/api/keys').then(value=>{if(active)setKeys(value.keys || []);}).catch(failure=>{if(active)setError(failure.message);});return()=>{active=false;};},[]);
  async function load(cursor=null) {
    const version=++generation.current;setPending(true);setError(null);setNotice(null);
    try {const next=await readJson(`/api/admin/budgets?${new URLSearchParams({apiKeyId:keyId,limit:'25',...(cursor?{before:cursor}:{})})}`);if(version===generation.current){setData(next);setBefore(cursor);setSelected(null);setReview(null);}}
    catch(failure){if(version===generation.current)setError(failure.message);} finally{if(version===generation.current)setPending(false);}
  }
  function choose(value) {generation.current++;setKeyId(value);setData(null);setSelected(null);setReview(null);setNotice(null);setPending(false);}
  async function resolve() {
    setPending(true);setError(null);setNotice(null);
    try {
      const result=await readJson('/api/admin/budgets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(review)});
      if (result.reservation?.requestId!==review.requestId || result.reservation?.apiKeyId!==review.apiKeyId) throw new Error('The returned reservation does not match the selected identity. Reload before retrying.');
      const next=await readJson(`/api/admin/budgets?${new URLSearchParams({apiKeyId:keyId,limit:'25',...(before?{before}:{})})}`);
      const retained=next.reservations.find(row=>row.requestId===review.requestId);
      if (!retained || ['state','actualPromptTokens','actualCompletionTokens','actualCostUsd','resolutionEvidence','usageRowId'].some(key=>retained[key]!==result.reservation[key])) throw new Error('The resolution returned, but exact state readback differs or moved outside this page. Reload before retrying.');
      setData(next);setSelected(retained);setReview(null);setNotice(`Reservation ${retained.requestId} read back as ${retained.state}.`);
    } catch(failure){setError(failure.message);} finally{setPending(false);}
  }
  const unresolved=selected && ['reserved','dispatched','uncertain'].includes(selected.state);
  return <Stack className={styles.tool} gap="md">
    <p>Outstanding reservations hold allowance for unresolved requests. They are separate from recorded usage and provider charges. Only reconcile from provider evidence or release with evidence of no dispatch or nonacceptance. Restarting does not release a reservation.</p>
    <Group align="end"><Autocomplete size="sm" label="Budget client key ID" description="A retained ID also works after a key is revoked or removed." value={keyId} data={keys.map(key=>({value:key.id,label:`${key.name || key.id} · ${key.id}`}))} onChange={choose} disabled={pending} style={{flex:1}}/><Button disabled={!/^[A-Za-z0-9._:-]{1,128}$/.test(keyId)} loading={pending} onClick={()=>load()}>Read budget</Button></Group>
    {error && <Alert color="red" role="alert">{error}</Alert>}{notice && <Alert color="teal" role="status">{notice}</Alert>}
    {data && <>
      <dl className={styles.facts}><dt>Policy</dt><dd>{data.policy || 'No current key policy'}</dd><dt>Accounting basis</dt><dd>{data.basis}</dd><dt>Recorded input tokens</dt><dd>{measured(data.account?.recordedPromptTokens,data.account?.unknownPromptRows)}</dd><dt>Recorded output tokens</dt><dd>{measured(data.account?.recordedCompletionTokens,data.account?.unknownCompletionRows)}</dd><dt>Recorded USD basis</dt><dd>{measured(data.account?.recordedCostUsd,data.account?.unknownCostRows)}</dd><dt>Unresolved requests</dt><dd>{quantity(data.outstanding?.requests)}</dd><dt>Known held input tokens</dt><dd>{measured(data.outstanding?.promptTokens,data.outstanding?.unknownPromptRows)}</dd><dt>Known held output tokens</dt><dd>{measured(data.outstanding?.completionTokens,data.outstanding?.unknownCompletionRows)}</dd><dt>Known held estimated USD</dt><dd>{measured(data.outstanding?.costUsd,data.outstanding?.unknownCostRows)}</dd></dl>
      {data.explanation && <p>{data.explanation}</p>}
      <p>Rows show the original reserved allowance. Settled and released rows no longer contribute to outstanding holds.</p>
      <div className={styles.scroll} tabIndex={0} role="region" aria-label="Budget reservations"><table><thead><tr><th>Request</th><th>State</th><th>Reserved input</th><th>Reserved output</th><th>Reserved USD</th></tr></thead><tbody>{data.reservations.map(row=><tr key={row.requestId} data-selected={selected?.requestId===row.requestId || undefined}><td><Button variant="subtle" size="compact-sm" disabled={pending} onClick={()=>{setSelected(row);setKind('provider-usage');setReference('');setDraft({});setReview(null);setNotice(null);}}>{row.requestId}</Button></td><td>{row.state}</td><td>{quantity(row.reservedPromptTokens)}</td><td>{quantity(row.reservedCompletionTokens)}</td><td>{quantity(row.reservedCostUsd)}</td></tr>)}</tbody></table></div>
      {!data.reservations.length && <p>No retained reservations match this key and page.</p>}
      <Group><Button variant="default" disabled={!before || pending} onClick={()=>load()}>Newest reservations</Button><Button variant="default" disabled={data.reservations.length<25 || pending} onClick={()=>load(data.reservations.at(-1).requestId)}>Older reservations</Button></Group>
      {selected && <Stack className={styles.review} gap="md"><h3>Reservation evidence</h3><span className={styles.id}>{selected.requestId}</span><dl className={styles.facts}><dt>State</dt><dd>{selected.state}</dd><dt>Logical request</dt><dd>{selected.logicalRequestId || 'Unknown'}</dd><dt>Captured rate snapshot</dt><dd>{selected.rateSnapshotId || 'Unavailable'}</dd><dt>Actual input tokens</dt><dd>{quantity(selected.actualPromptTokens)}</dd><dt>Actual output tokens</dt><dd>{quantity(selected.actualCompletionTokens)}</dd><dt>Actual USD basis</dt><dd>{quantity(selected.actualCostUsd)}</dd></dl>
        {!unresolved ? <p>This reservation is resolved. Its recorded usage cannot be released through this action.</p> : <>
          <Select size="sm" label="Resolution evidence" disabled={pending} value={kind} data={[{value:'provider-usage',label:'Provider usage report'},...(selected.state==='reserved'?[{value:'proven-no-dispatch',label:'Proven no dispatch'}]:[]),{value:'provider-nonacceptance',label:'Provider confirmed nonacceptance'}]} onChange={value=>{setKind(value);setReview(null);}}/>
          <TextInput size="sm" label="Nonsecret evidence reference" description="Use a report or incident reference. Do not paste credentials or request content." value={reference} disabled={pending} onChange={event=>{setReference(event.currentTarget.value);setReview(null);}}/>
          {kind==='provider-usage' && <><p>Enter only reported values. Reconciliation uses the reservation’s captured rates; blank fields remain unknown.</p><div className={styles.fields}>{Object.entries(BUDGET_USAGE_FIELDS).map(([key,label])=><NumberInput key={key} size="sm" label={label} min={0} allowDecimal={key==='cost_usd'} value={draft[key] ?? ''} disabled={pending} onChange={value=>{setDraft(previous=>({...previous,[key]:value}));setReview(null);}}/>)}</div></>}
          <Button variant="default" disabled={pending} onClick={()=>{try{setReview(budgetResolution(keyId,selected,kind,reference,draft));setError(null);}catch(failure){setError(failure.message);}}}>Review reservation resolution</Button>
          {review && <><p>{kind==='provider-usage'?'Record provider evidence and settle the exact reservation.':'Release the held allowance using the supplied evidence. This does not reverse recorded usage.'} This action is retained in budget accounting.</p><Group><Button loading={pending} onClick={resolve}>Confirm reservation resolution</Button><Button variant="default" disabled={pending} onClick={()=>setReview(null)}>Cancel</Button></Group></>}
        </>}
      </Stack>}
    </>}
  </Stack>;
}
