'use client';
import { useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, TextInput } from '@mantine/core';
import { ECONOMICS_IDENTITY_FIELDS, ECONOMICS_MISSING_FIELDS, validateEconomicsFilters } from '@/lib/db/analytics/investigationModel.mjs';

const labels = {requestId:'Exact request ID',logicalRequestId:'Logical request ID',sessionId:'Context session ID',clientKeyId:'Client key ID',clientRef:'Client reference',clientSessionRef:'Client session reference',projectRef:'Project reference',taskRef:'Task reference',provider:'Provider',model:'Model',connectionId:'Account'};
export default function EconomicsFilters({ value = {}, onChange }) {
  const [opened,setOpened]=useState(false), [draft,setDraft]=useState(value), [error,setError]=useState(null);
  const count=Object.keys(value).length;
  const field=(key,next)=>setDraft(previous=>({...previous,[key]:next}));
  return <>
    <Button variant="default" size="sm" onClick={()=>{setDraft(value);setError(null);setOpened(true);}}>Identity filters{count ? ` (${count})` : ''}</Button>
    <Modal opened={opened} onClose={()=>setOpened(false)} title="Filter exact attribution" size="lg">
      <form onSubmit={event=>{event.preventDefault();try {onChange(validateEconomicsFilters(draft));setOpened(false);} catch(failure){setError(failure.message);}}}>
        <Stack gap="md">
          <p>These filters apply to the cost summary, cohort, completion ledger and population export. References must come from retained evidence. An absent reference does not identify a client or project.</p>
          {ECONOMICS_IDENTITY_FIELDS.map(key=><TextInput key={key} size="sm" label={labels[key]} value={draft[key] ?? ''} onChange={event=>field(key,event.currentTarget.value)} description={key.endsWith('Ref') ? 'Exact ctx1_ reference from a recorded completion' : undefined} />)}
          <Select size="sm" label="Request linkage" clearable value={draft.requestLink || null} onChange={value=>field('requestLink',value)} data={['linked','unattributed','unavailable','conflict'].map(value=>({value,label:value}))} />
          <Select size="sm" label="Missing recorded identity" clearable value={draft.missing || null} onChange={value=>field('missing',value)} data={ECONOMICS_MISSING_FIELDS.map(value=>({value,label:labels[value]}))} />
          {error && <Alert color="red" role="alert">{error}</Alert>}
          <Group><Button type="submit" size="sm">Apply filters</Button><Button variant="default" size="sm" onClick={()=>{onChange({});setOpened(false);}}>Clear identity filters</Button></Group>
        </Stack>
      </form>
    </Modal>
  </>;
}
