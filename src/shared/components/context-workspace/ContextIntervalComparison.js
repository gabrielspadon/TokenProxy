'use client';
import { useState } from 'react';
import { Alert, Button, Group, Table, TextInput } from '@mantine/core';
import { useResource } from '@/shared/workspace/useResource';
import { contextUrl, finite, quantity, utc } from './contextModel';
import styles from './context.module.css';

const MEASURES = [
  ['attempts','Attempts','attempts'],['requests','Logical requests','requests'],['sessions','Sessions','sessions'],
  ['providerInputTokens','Provider input','tokens','providerInputSamples'],['providerOutputTokens','Provider output','tokens','providerOutputSamples'],
  ['cacheReadTokens','Cache read','tokens','cacheReadSamples'],['cacheWriteTokens','Cache write','tokens','cacheWriteSamples'],
  ['savedBytes','Body reduction','signed UTF-8 bytes','bodySamples'],
];
const delta = (a,b) => finite(a) && finite(b) ? `${a-b>0?'+':''}${quantity(a-b)}` : 'Unknown';

export function ContextIntervalComparison({ workspace }) {
  const {scope,contextView,setContextView,observeSnapshot} = workspace;
  const comparison = contextView.intervalComparison;
  const empty = {start:'',end:''};
  const [draft,setDraft] = useState(()=>comparison || {baseline:{...empty},selected:{start:scope.start || '',end:scope.end || ''}});
  const [error,setError] = useState(null);
  const query = new URLSearchParams(contextUrl({...scope,start:comparison?.selected.start,end:comparison?.selected.end},contextView).split('?')[1]);
  query.set('view','interval-comparison');
  if (comparison) { query.set('baselineFrom',comparison.baseline.start);query.set('baselineUntil',comparison.baseline.end); }
  const resource = useResource(comparison ? `/api/context?${query}` : null,{onSnapshot:observeSnapshot,interval:0});
  const data = resource.data;
  function compare(event) {
    event.preventDefault();
    const value = {};
    for (const side of ['baseline','selected']) {
      const start = draft[side].start?.replace(/Z$/,''), end = draft[side].end?.replace(/Z$/,'');
      if (!start || !end || !Number.isFinite(Date.parse(`${start}Z`)) || !Number.isFinite(Date.parse(`${end}Z`)) || Date.parse(`${start}Z`)>=Date.parse(`${end}Z`)) {
        setError('Enter two complete UTC periods with each start before its end.');return;
      }
      value[side] = {start:new Date(`${start}Z`).toISOString(),end:new Date(`${end}Z`).toISOString()};
    }
    setError(null);setContextView({intervalComparison:value});
  }
  // Native datetime-local fields display UTC deliberately; they never use the
  // workstation timezone to reinterpret an investigation's stored boundaries.
  const inputValue = value => value?.replace(/Z$/,'').slice(0,19) || '';
  return <section className={styles.intervalComparison} aria-label="Context interval comparison">
    <h2>Compare periods</h2>
    <p>All matching Context sessions, using the same provider, account, model, project and client filters. The two periods stay fixed when the shared time range changes.</p>
    <form onSubmit={compare}>
      <div className={styles.intervalFields}>{['baseline','selected'].map(side=><fieldset key={side}><legend>{side==='baseline' ? 'Baseline period' : 'Selected period'}</legend>
        {['start','end'].map(boundary=><TextInput key={boundary} type="datetime-local" step={1} label={`${side==='baseline'?'Baseline':'Selected'} ${boundary} · UTC`} value={inputValue(draft[side][boundary])}
          onChange={event=>setDraft({...draft,[side]:{...draft[side],[boundary]:event.currentTarget.value}})} />)}
      </fieldset>)}</div>
      <Group mt="sm"><Button type="submit">Compare periods</Button><Button variant="default" type="button" onClick={()=>setDraft({...draft,selected:{start:scope.start || '',end:scope.end || ''}})}>Use shared period</Button>
        {comparison && <Button variant="subtle" type="button" onClick={()=>setContextView({intervalComparison:null})}>Clear period comparison</Button>}</Group>
    </form>
    {error && <Alert color="red" mt="sm">{error}</Alert>}
    {resource.loading && <p role="status">Reading both periods in one snapshot…</p>}
    {resource.error && <Alert color="orange" title="Period comparison unavailable">{resource.error}<Button variant="subtle" onClick={resource.refresh}>Retry comparison</Button></Alert>}
    {data && <>
      <p>{data.scope}</p>
      <Group gap="xl">{['baseline','selected'].map(side=><p key={side}><strong>{side==='baseline'?'Baseline':'Selected'}</strong><br />{utc(data[side].period.start)} to {utc(data[side].period.end)} UTC<br />{quantity(data[side].period.durationMs/1000)} seconds · {quantity(data[side].summary.attempts)} attempts</p>)}</Group>
      {data.overlapMs>0 && <Alert color="blue">The periods overlap by {quantity(data.overlapMs/1000)} seconds. Attempts in that overlap contribute to both totals.</Alert>}
      <div className={styles.tableScroll} role="region" aria-label="Period measurements scrollable table" tabIndex={0}>
        <Table className={styles.table} aria-label="Context period measurements"><Table.Caption>Selected minus baseline, full matching populations; sample counts are measured attempts / all attempts</Table.Caption><Table.Thead><Table.Tr><Table.Th>Measurement</Table.Th><Table.Th>Baseline</Table.Th><Table.Th>Selected</Table.Th><Table.Th>Change</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{MEASURES.map(([key,label,unit,samples])=><Table.Tr key={key}><Table.Th scope="row">{label}<small>{unit}</small></Table.Th>{['baseline','selected'].map(side=><Table.Td key={side}>{quantity(data[side].summary[key])}{samples && <small>{quantity(data[side].coverage[samples])} / {quantity(data[side].summary.attempts)} samples</small>}</Table.Td>)}<Table.Td>{delta(data.selected.summary[key],data.baseline.summary[key])}</Table.Td></Table.Tr>)}</Table.Tbody>
        </Table>
      </div>
      <p className={styles.footnote}>Missing measurements remain unknown. Provider input includes cached input; cache reads and writes are not additive to it. Body reduction is not token or monetary savings. Snapshot {utc(data.freshness?.snapshotCompletedAt)} UTC.</p>
    </>}
  </section>;
}
