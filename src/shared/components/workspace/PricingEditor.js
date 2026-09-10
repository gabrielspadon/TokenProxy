'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Autocomplete, Button, Group, NumberInput, Select, Stack } from '@mantine/core';
import { PRICING_FIELDS, pricingPatch, readJson } from './economicsToolsModel';
import styles from './EconomicsTools.module.css';

export default function PricingEditor() {
  const [pricing,setPricing]=useState(null), [provider,setProvider]=useState(''), [model,setModel]=useState('');
  const [drafts,setDrafts]=useState({}), [error,setError]=useState(null), [notice,setNotice]=useState(null), [pending,setPending]=useState(false), [review,setReview]=useState(null), [resetScope,setResetScope]=useState('model');
  const toolRef=useRef(null), reviewTrigger=useRef(null);
  async function load() {setPending(true);setError(null);setReview(null);try {const data=await readJson('/api/pricing');setPricing(data);return data;} catch(failure){setError(failure.message);return null;} finally {setPending(false);}}
  useEffect(()=>{let active=true;readJson('/api/pricing').then(data=>{if(active)setPricing(data);}).catch(failure=>{if(active)setError(failure.message);});return()=>{active=false;};},[]);
  const identity=JSON.stringify([provider,model]);
  const draft=drafts[identity] || pricing?.[provider]?.[model] || {};
  const setDraft=update=>setDrafts(previous=>({...previous,[identity]:update(previous[identity] || pricing?.[provider]?.[model] || {})}));
  const choose=(nextProvider,nextModel)=>{setProvider(nextProvider);setModel(nextModel);setReview(null);setNotice(null);};
  async function apply() {
    setPending(true);setError(null);setNotice(null);
    try {
      const params=new URLSearchParams(resetScope==='all'?{}:resetScope==='provider'?{provider}:{provider,model});
      await readJson(review.kind==='save'?'/api/pricing':`/api/pricing?${params}`,review.kind==='save'?{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(review.body)}:{method:'DELETE'});
      const current=await readJson('/api/pricing');
      if (review.kind==='save' && Object.entries(review.body[provider][model]).some(([key,value])=>current[provider]?.[model]?.[key]!==value)) throw new Error('The pricing write returned, but readback differs. Reload the stored rates before retrying.');
      setPricing(current);setDrafts(previous=>{const next={...previous};delete next[identity];return next;});setReview(null);setNotice('Stored pricing read back successfully. Existing captured completion rates remain unchanged.');toolRef.current?.focus();
    } catch(failure){setError(failure.message);} finally {setPending(false);}
  }
  return <Stack className={styles.tool} gap="sm" component="section" aria-label="Pricing controls" ref={toolRef} tabIndex={-1}>
    <div className={styles.toolHeading}><h2>Captured pricing</h2></div>
    <p>Rates are USD per million tokens. Changes affect future rate capture and budget estimates. Existing completion snapshots retain their original rates. These estimates do not establish subscription spend.</p>
    {error && <Alert color="red" role="alert">{error}</Alert>}{notice && <Alert color="teal" role="status">{notice}</Alert>}
    {!pricing ? <Button size="xs" variant="default" onClick={load}>Reload pricing</Button> : <>
      <div className={styles.fields}><Autocomplete size="xs" label="Pricing provider" value={provider} data={Object.keys(pricing).sort()} onChange={value=>choose(value,'')} disabled={pending}/><Autocomplete size="xs" label="Pricing model" value={model} data={Object.keys(pricing[provider] || {}).sort()} onChange={value=>choose(provider,value)} disabled={pending}/></div>
      <p>Choose a catalog entry or enter an exact provider and model. Blank rate fields are unspecified; built-in defaults still apply where available. Zero is an explicit rate.</p>
      <div className={styles.fields}>{Object.entries(PRICING_FIELDS).map(([key,label])=><NumberInput key={key} size="xs" label={`${label} USD / million tokens`} min={0} value={draft[key] ?? ''} disabled={pending} onChange={value=>{setDraft(previous=>({...previous,[key]:value}));setReview(null);}} />)}</div>
      <Group><Button size="xs" disabled={pending} onClick={event=>{reviewTrigger.current=event.currentTarget;try {setReview({kind:'save',body:pricingPatch(provider,model,draft)});setError(null);} catch(failure){setError(failure.message);}}}>Review pricing change</Button>{drafts[identity] && <Button size="xs" variant="default" disabled={pending} onClick={()=>{setDrafts(previous=>{const next={...previous};delete next[identity];return next;});setReview(null);setError(null);toolRef.current?.querySelector('input')?.focus();}}>Discard pricing draft</Button>}<Button size="xs" variant="default" disabled={pending} onClick={load}>Read current pricing</Button></Group>
      <Group align="end"><Select size="xs" label="Reset overrides" value={resetScope} disabled={pending} data={[{value:'model',label:'Selected model'},{value:'provider',label:'Selected provider'},{value:'all',label:'All providers'}]} onChange={value=>{setResetScope(value);setReview(null);}}/><Button size="xs" variant="default" disabled={pending || (resetScope!=='all'&&!provider) || (resetScope==='model'&&!model)} onClick={event=>{reviewTrigger.current=event.currentTarget;setReview({kind:'reset'});}}>Review reset</Button></Group>
      {review && <Stack className={styles.review} gap="sm"><p>{review.kind==='save'?`Replace the model override for ${provider}/${model} with the entered known rates.`:`Remove ${resetScope==='all'?'all pricing overrides':resetScope==='provider'?`all overrides for ${provider}`:`the override for ${provider}/${model}`} and restore available built-in defaults. Custom entries without defaults disappear.`}</p><Group><Button size="xs" loading={pending} onClick={apply}>Confirm {review.kind==='save'?'pricing change':'reset'}</Button><Button size="xs" variant="default" disabled={pending} onClick={()=>{setReview(null);reviewTrigger.current?.focus();}}>Cancel</Button></Group></Stack>}
    </>}
  </Stack>;
}
