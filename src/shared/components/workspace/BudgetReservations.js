'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Autocomplete, Button, Group, NumberInput, Select, Stack, TextInput } from '@mantine/core';
import { BUDGET_USAGE_FIELDS, budgetResolution, readJson } from './economicsToolsModel';
import styles from './EconomicsTools.module.css';

const quantity=value=>value==null?'Unknown':new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(value);
const measured=(value,unknown)=>`${quantity(value)}${unknown>0?` + ${quantity(unknown)} unknown records`:''}`;
export default function BudgetReservations() {
  const [keys,setKeys]=useState([]), [keyId,setKeyId]=useState(''), [data,setData]=useState(null), [selected,setSelected]=useState(null);
  const [drafts,setDrafts]=useState({}), [review,setReview]=useState(null);
  const identity=JSON.stringify([keyId,selected?.requestId]);
  const {kind='provider-usage',reference='',values:draft={}}=drafts[identity] || {};
  const changeDraft=patch=>setDrafts(previous=>({...previous,[identity]:{...previous[identity],...patch}}));
  const setKind=kind=>changeDraft({kind});
  const setReference=reference=>changeDraft({reference});
  const setDraft=update=>changeDraft({values:update(draft)});
  const [error,setError]=useState(null), [notice,setNotice]=useState(null), [pending,setPending]=useState(false), [before,setBefore]=useState(null);
  const generation=useRef(0), evidenceRef=useRef(null), referenceRef=useRef(null), reviewTrigger=useRef(null);
  useEffect(()=>{let active=true;readJson('/api/keys').then(value=>{if(active)setKeys(value.keys || []);}).catch(failure=>{if(active)setError(failure.message);});return()=>{active=false;};},[]);
  async function load(cursor=null,requestedKey=keyId) {
    const version=++generation.current;setPending(true);setError(null);setNotice(null);
    try {const next=await readJson(`/api/admin/budgets?${new URLSearchParams({apiKeyId:requestedKey,limit:'25',...(cursor?{before:cursor}:{})})}`);if(next.apiKeyId!==requestedKey)throw new Error('The budget read returned a different client key. No reservation was substituted.');if(version===generation.current){setData(next);setBefore(cursor);setSelected(previous=>next.reservations.find(row=>row.requestId===previous?.requestId) || null);setReview(null);}}
    catch(failure){if(version===generation.current)setError(failure.message);} finally{if(version===generation.current)setPending(false);}
  }
  function choose(value) {generation.current++;setKeyId(value);setData(null);setSelected(null);setReview(null);setNotice(null);setPending(false);}
  async function resolve() {
    setPending(true);setError(null);setNotice(null);
    try {
      const result=await readJson('/api/admin/budgets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(review)});
      if (result.reservation?.requestId!==review.requestId || result.reservation?.apiKeyId!==review.apiKeyId) throw new Error('The returned reservation does not match the selected identity. Reload before retrying.');
      const next=await readJson(`/api/admin/budgets?${new URLSearchParams({apiKeyId:keyId,limit:'25',...(before?{before}:{})})}`);
      const retained=next.apiKeyId===review.apiKeyId && next.reservations.find(row=>row.requestId===review.requestId && row.apiKeyId===review.apiKeyId);
      if (!retained || ['state','actualPromptTokens','actualCompletionTokens','actualCostUsd','resolutionEvidence','usageRowId'].some(key=>retained[key]!==result.reservation[key])) throw new Error('The resolution returned, but exact state readback differs or moved outside this page. Reload before retrying.');
      setData(next);setSelected(retained);setReview(null);setNotice(`Reservation ${retained.requestId} read back as ${retained.state}.`);evidenceRef.current?.focus();
    } catch(failure){setError(failure.message);} finally{setPending(false);}
  }
  const incompatibleEvidence=kind==='proven-no-dispatch' && selected?.state!=='reserved';
  const unresolved=selected && ['reserved','dispatched','uncertain'].includes(selected.state);
  return <Stack className={styles.tool} gap="sm" component="section" aria-label="Budget accounting controls">
    <div className={styles.toolHeading}><h2>Budget reservations</h2></div>
    <p>Outstanding reservations hold allowance for unresolved requests. They are separate from recorded usage and provider charges. Only reconcile from provider evidence or release with evidence of no dispatch or nonacceptance. Restarting does not release a reservation.</p>
    <Group align="end"><Autocomplete size="sm" label="Budget client key ID" description="Select a known key to read its local accounting, or enter a retained ID and choose Read budget." value={keyId} data={keys.map(key=>key.id)} renderOption={({option})=>`${keys.find(key=>key.id===option.value)?.name || option.value} · ${option.value}`} onChange={value=>{choose(value);if(keys.some(key=>key.id===value))return load(null,value);}} disabled={pending} style={{flex:1}}/><Button disabled={!/^[A-Za-z0-9._:-]{1,128}$/.test(keyId)} loading={pending} onClick={()=>load()}>Read budget</Button></Group>
    {error && <Alert color="red" role="alert">{error}</Alert>}{notice && <Alert color="teal" role="status">{notice}</Alert>}
    {data && <>
      <dl className={styles.facts}><div><dt>Policy</dt><dd>{data.policy || 'No current key policy'}</dd></div><div><dt>Accounting basis</dt><dd>{data.basis}</dd></div><div><dt>Recorded input tokens</dt><dd>{measured(data.account?.recordedPromptTokens,data.account?.unknownPromptRows)}</dd></div><div><dt>Recorded output tokens</dt><dd>{measured(data.account?.recordedCompletionTokens,data.account?.unknownCompletionRows)}</dd></div><div><dt>Recorded USD basis</dt><dd>{measured(data.account?.recordedCostUsd,data.account?.unknownCostRows)}</dd></div><div><dt>Unresolved requests</dt><dd>{quantity(data.outstanding?.requests)}</dd></div><div><dt>Known held input tokens</dt><dd>{measured(data.outstanding?.promptTokens,data.outstanding?.unknownPromptRows)}</dd></div><div><dt>Known held output tokens</dt><dd>{measured(data.outstanding?.completionTokens,data.outstanding?.unknownCompletionRows)}</dd></div><div><dt>Known held estimated USD</dt><dd>{measured(data.outstanding?.costUsd,data.outstanding?.unknownCostRows)}</dd></div></dl>
      {data.explanation && <p>{data.explanation}</p>}
      <p>Rows show the original reserved allowance. Settled and released rows no longer contribute to outstanding holds.</p>
      <div className={styles.scroll} tabIndex={0} role="region" aria-label="Budget reservations"><table><thead><tr><th>Request</th><th>State</th><th>Reserved input</th><th>Reserved output</th><th>Reserved USD</th></tr></thead><tbody>{data.reservations.map(row=><tr key={row.requestId} data-selected={selected?.requestId===row.requestId || undefined}><td><Button variant="subtle" size="compact-sm" disabled={pending} onClick={()=>{setSelected(row);setReview(null);setNotice(null);}}>{row.requestId}</Button></td><td>{row.state}</td><td>{quantity(row.reservedPromptTokens)}</td><td>{quantity(row.reservedCompletionTokens)}</td><td>{quantity(row.reservedCostUsd)}</td></tr>)}</tbody></table></div>
      {!data.reservations.length && <p>No retained reservations match this key and page.</p>}
      <Group><Button variant="default" disabled={!before || pending} onClick={()=>load()}>Newest reservations</Button><Button variant="default" disabled={data.reservations.length<25 || pending} onClick={()=>load(data.reservations.at(-1).requestId)}>Older reservations</Button></Group>
      {selected && <Stack className={styles.review} gap="md" component="section" aria-label="Reservation evidence and resolution" ref={evidenceRef} tabIndex={-1}><h3>Reservation evidence and resolution</h3><span className={styles.id}>{selected.requestId}</span><dl className={styles.facts}><div><dt>State</dt><dd>{selected.state}</dd></div><div><dt>Logical request</dt><dd>{selected.logicalRequestId || 'Unknown'}</dd></div><div><dt>Captured rate snapshot</dt><dd>{selected.rateSnapshotId || 'Unavailable'}</dd></div><div><dt>Actual input tokens</dt><dd>{quantity(selected.actualPromptTokens)}</dd></div><div><dt>Actual output tokens</dt><dd>{quantity(selected.actualCompletionTokens)}</dd></div><div><dt>Actual USD basis</dt><dd>{quantity(selected.actualCostUsd)}</dd></div></dl>
        {!unresolved ? <p>This reservation is resolved. Its recorded usage cannot be released through this action.</p> : <>
          <Select size="sm" label="Resolution evidence" disabled={pending} value={kind} data={[{value:'provider-usage',label:'Provider usage report'},...(selected.state==='reserved'?[{value:'proven-no-dispatch',label:'Proven no dispatch'}]:[]),{value:'provider-nonacceptance',label:'Provider confirmed nonacceptance'}]} onChange={value=>{setKind(value);setReview(null);}}/>
          <TextInput size="sm" label="Nonsecret evidence reference" ref={referenceRef} description="Use a report or incident reference. Do not paste credentials or request content." value={reference} disabled={pending} onChange={event=>{setReference(event.currentTarget.value);setReview(null);}}/>
          {incompatibleEvidence && <Alert color="orange">The recorded state changed. Select evidence valid for the current reservation state before reviewing a resolution.</Alert>}
          {kind==='provider-usage' && <><p>Enter only reported values. Reconciliation uses the reservation’s captured rates; blank fields remain unknown.</p><div className={styles.fields}>{Object.entries(BUDGET_USAGE_FIELDS).map(([key,label])=><NumberInput key={key} size="sm" label={label} min={0} allowDecimal={key==='cost_usd'} value={draft[key] ?? ''} disabled={pending} onChange={value=>{setDraft(previous=>({...previous,[key]:value}));setReview(null);}}/>)}</div></>}
          <Button variant="default" disabled={pending || incompatibleEvidence} onClick={event=>{reviewTrigger.current=event.currentTarget;try{setReview(budgetResolution(keyId,selected,kind,reference,draft));setError(null);}catch(failure){setError(failure.message);}}}>Review reservation resolution</Button>{drafts[identity] && <Button variant="default" disabled={pending} onClick={()=>{setDrafts(previous=>{const next={...previous};delete next[identity];return next;});setReview(null);setError(null);referenceRef.current?.focus();}}>Discard resolution draft</Button>}
          {review && <><p>{kind==='provider-usage'?'Record provider evidence and settle the exact reservation.':'Release the held allowance using the supplied evidence. This does not reverse recorded usage.'} This action is retained in budget accounting.</p><Group><Button loading={pending} onClick={resolve}>Confirm reservation resolution</Button><Button variant="default" disabled={pending} onClick={()=>{setReview(null);reviewTrigger.current?.focus();}}>Cancel</Button></Group></>}
        </>}
      </Stack>}
    </>}
  </Stack>;
}
