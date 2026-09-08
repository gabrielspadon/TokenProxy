'use client';
import { useRef, useState } from 'react';
import { Alert, Button, Group, Select, TextInput } from '@mantine/core';
import { ECONOMICS_IDENTITY_FIELDS, ECONOMICS_MISSING_FIELDS, validateEconomicsFilters } from '@/lib/db/analytics/investigationModel.mjs';
import styles from './EconomicsTools.module.css';

const labels = {requestId:'Exact request ID',logicalRequestId:'Logical request ID',sessionId:'Context session ID',clientKeyId:'Client key ID',clientRef:'Client reference',clientSessionRef:'Client session reference',projectRef:'Project reference',taskRef:'Task reference',provider:'Provider',model:'Model',connectionId:'Account'};
export default function EconomicsFilters({ value = {}, onChange }) {
  const [draft, setDraft] = useState(null), [error, setError] = useState(null), [notice, setNotice] = useState(null);
  const form = useRef(null);
  const fields = draft || value;
  const field = (key, next) => { setDraft(previous => ({...(previous || value), [key]:next})); setNotice(null); };
  return <form className={styles.tool} aria-label="Exact attribution filters" ref={form} onSubmit={event => {
    event.preventDefault();
    try { onChange(validateEconomicsFilters(fields)); setDraft(null); setError(null); setNotice('Identity filters applied to the recorded cost analysis.'); }
    catch (failure) { setError(failure.message); }
  }}>
    <div className={styles.toolHeading}><h2>Exact attribution</h2><p>Filter the summary, cohort, completion ledger and export using retained identities. An absent reference does not identify a client or project.</p></div>
    <div className={styles.fields}>
      {ECONOMICS_IDENTITY_FIELDS.map(key => <TextInput key={key} size="sm" label={labels[key]} value={fields[key] ?? ''} onChange={event => field(key, event.currentTarget.value)} description={key.endsWith('Ref') ? 'Exact ctx1_ reference from a recorded completion' : undefined} />)}
      <Select size="sm" label="Request linkage" clearable value={fields.requestLink || null} onChange={value => field('requestLink',value)} data={['linked','unattributed','unavailable','conflict'].map(value=>({value,label:value}))} />
      <Select size="sm" label="Missing recorded identity" clearable value={fields.missing || null} onChange={value => field('missing',value)} data={ECONOMICS_MISSING_FIELDS.map(value=>({value,label:labels[value]}))} />
    </div>
    {error && <Alert color="red" role="alert">{error}</Alert>}{notice && <p role="status">{notice}</p>}
    <Group className={styles.formActions}><Button type="submit" size="sm">Apply filters</Button>{draft && <Button variant="default" size="sm" onClick={() => { setDraft(null); setError(null); setNotice(null); form.current?.querySelector('input')?.focus(); }}>Discard filter draft</Button>}<Button variant="default" size="sm" onClick={() => { onChange({}); setDraft(null); setError(null); setNotice('Identity filters cleared. Shared scope is unchanged.'); }}>Clear identity filters</Button></Group>
  </form>;
}
