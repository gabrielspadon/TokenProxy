'use client';
import { useState } from 'react';
import { Button, NumberInput, Select, SimpleGrid } from '@mantine/core';
import { usePoll } from '@/shared/hooks/usePoll';

export default function AdmissionControls() {
  const read = usePoll('/api/system/admission', 5000);
  const [edited, setDraft] = useState(null), [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const data = read.data;
  const draft = edited ?? data?.policy;
  const change = (key, value) => { setDirty(true); setDraft(current => ({ ...(current ?? data.policy), [key]: value })); setMessage(''); };
  async function save(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/system/admission', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify(draft) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Admission policy could not be saved');
      setDirty(false); setDraft(result.policy); setMessage('Admission policy saved.'); read.refresh();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  return <section aria-labelledby="admission-heading" style={{ marginTop: 24 }}>
    <h3 id="admission-heading">Request capacity</h3>
    {read.error ? <p role="alert">Capacity could not be refreshed. <Button variant="subtle" onClick={read.refresh}>Retry capacity</Button></p> : null}
    {data ? <>
      <div className="measures" aria-label="Admission observations">
        <div className="measure"><span className="label">Active streams</span><span className="value">{data.activeStreams} / {data.effectiveStreams}</span></div>
        <div className="measure"><span className="label">Handlers</span><span className="value">{data.activeHandlers} / {data.policy.maxHandlers}</span></div>
        <div className="measure"><span className="label">Waiting</span><span className="value">{data.queued}</span></div>
        <div className="measure"><span className="label">Oldest wait</span><span className="value">{Math.round(data.oldestQueueMs)} ms</span></div>
      </div>
      <p>{data.decision.replaceAll('-', ' ')}. Limits apply to this process. Existing streams finish when a limit decreases.</p>
    </> : <p>Reading request capacity…</p>}
    {draft ? <form onSubmit={save}>
      <SimpleGrid cols={{base:1, sm:2, lg:4}} spacing="sm">
        <Select label="Capacity mode" data={[{value:'adaptive',label:'Adaptive'},{value:'fixed',label:'Fixed maximum'},{value:'override',label:'Temporary override'}]}
          value={draft.overrideStreams !== null ? 'override' : draft.adaptive ? 'adaptive' : 'fixed'}
          onChange={mode=>{setDirty(true);setDraft({...draft,adaptive:mode !== 'fixed',overrideStreams:mode === 'override' ? draft.minStreams : null});}} />
        {['minStreams','maxStreams','clientStreams'].map(key=><NumberInput key={key} label={{minStreams:'Minimum streams',maxStreams:'Maximum streams',clientStreams:'Streams per client'}[key]} min={1} max={65536} allowDecimal={false} value={draft[key]} onChange={value=>change(key,value)} />)}
        {draft.overrideStreams !== null ? <NumberInput label="Override streams" min={draft.minStreams} max={draft.maxStreams} allowDecimal={false} value={draft.overrideStreams} onChange={value=>change('overrideStreams',value)} /> : null}
      </SimpleGrid>
      <details style={{marginTop:12}}><summary>Handler, provider and pressure limits</summary>
        <SimpleGrid cols={{base:1, sm:2, lg:4}} spacing="sm" mt="sm">
          {Object.entries({maxHandlers:'Maximum handlers',clientHandlers:'Handlers per client',providerStreams:'Streams per provider',queueDepth:'Queue capacity',clientQueueDepth:'Queue per client',maxWaitMs:'Maximum wait (ms)',memoryBudgetMb:'Memory budget (MiB)',eventLoopBudgetMs:'Event loop budget (ms)',minSamples:'Minimum samples',cooldownMs:'Adjustment cooldown (ms)'}).map(([key,label])=><NumberInput key={key} label={label} min={1} allowDecimal={false} value={draft[key]} onChange={value=>change(key,value)} />)}
        </SimpleGrid>
        <p>Each client can use at most half the effective stream capacity so another client can enter. Account capacity and quota eligibility still apply. Connection pool pressure is unavailable.</p>
      </details>
      <Button type="submit" mt="sm" disabled={!dirty || busy} loading={busy}>Save request capacity</Button>
      {message ? <p role="status">{message}</p> : null}
    </form> : null}
  </section>;
}
