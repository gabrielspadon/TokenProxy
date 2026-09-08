'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Group, Loader, NativeSelect, NumberInput, Stack, Text } from '@mantine/core';
import styles from './context.module.css';

function policy(body) {
  if (!['preserve', 'window'].includes(body?.statsRetentionMode) || !Number.isInteger(body.statsRetentionDays) || body.statsRetentionDays < 1 || body.statsRetentionDays > 365) throw new Error('The current history policy is unavailable. No default policy was substituted.');
  return { statsRetentionMode: body.statsRetentionMode, statsRetentionDays: body.statsRetentionDays };
}
async function readPolicy(options) {
  const response = await fetch('/api/settings', { cache: 'no-store', ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || 'History policy could not be read.');
  return policy(body);
}
function RetentionForm({ settings, onSaved }) {
  const [stored, setStored] = useState(settings), [mode, setMode] = useState(settings.statsRetentionMode), [days, setDays] = useState(settings.statsRetentionDays);
  const [acknowledged, setAcknowledged] = useState(false), [saving, setSaving] = useState(false), [reading, setReading] = useState(false);
  const [error, setError] = useState(null), [message, setMessage] = useState(null);
  const form = useRef(null);
  const dirty = mode !== stored.statsRetentionMode || days !== stored.statsRetentionDays;
  const valid = ['preserve', 'window'].includes(mode) && Number.isInteger(days) && days >= 1 && days <= 365;
  async function readCurrent() {
    setReading(true); setError(null); setMessage(null); setAcknowledged(false);
    try { setStored(await readPolicy()); setMessage('Current history policy read. Your draft is retained; Discard restores the stored policy.'); }
    catch (failure) { setError(failure.message); } finally { setReading(false); }
  }
  async function save(event) {
    event.preventDefault();
    if (!valid || !dirty || saving || reading || (mode === 'window' && !acknowledged)) return;
    setSaving(true); setError(null); setMessage(null);
    try {
      const patch = { statsRetentionMode: mode, statsRetentionDays: days };
      const response = await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || 'History retention could not be saved.');
      const current = await readPolicy();
      if (current.statsRetentionMode !== mode || current.statsRetentionDays !== days) throw new Error('The save could not be verified. Your draft is retained. Read current policy before retrying.');
      setStored(current); setAcknowledged(false);
      setMessage(mode === 'preserve' ? 'History preserved. Policy saved and verified.' : `${days}-day retention saved and verified.`);
      form.current?.focus(); onSaved?.();
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }
  return <form ref={form} tabIndex={-1} aria-label="History retention settings" onSubmit={save} className={styles.retention}><Stack gap="sm">
    <div className={styles.retentionFields}>
      <NativeSelect label="History policy" value={mode} onChange={event => { setMode(event.currentTarget.value); setAcknowledged(false); setMessage(null); }} disabled={saving || reading} data={[{ value: 'preserve', label: 'Preserve all history' }, { value: 'window', label: 'Keep a limited number of days' }]} />
      <NumberInput label="Days to retain" description="1 to 365 days; used by a limited policy" value={days} onChange={value => { setDays(value); setAcknowledged(false); setMessage(null); }} min={1} max={365} allowDecimal={false} disabled={saving || reading || mode !== 'window'} />
      <Group gap={8} className={styles.retentionActions}>{dirty && <><Button type="submit" disabled={!valid || reading || (mode === 'window' && !acknowledged)} loading={saving}>Save history policy</Button><Button variant="default" disabled={saving || reading} onClick={() => { setMode(stored.statsRetentionMode); setDays(stored.statsRetentionDays); setAcknowledged(false); setError(null); setMessage(null); form.current?.querySelector('select')?.focus(); }}>Discard</Button></>}<Button variant="default" disabled={saving} loading={reading} onClick={readCurrent}>Read current policy</Button></Group>
    </div>
    {mode === 'window' ? <>
      <Alert color="orange" title="Older request and Context evidence will be permanently deleted">On subsequent recording, request attempts older than {Number.isInteger(days) ? days : 'the chosen number of'} days, including recorded Capacity activity and Context attempts, will be removed with their stage and structure evidence. Older client events and sessions with no remaining requests are also removed. Usage history and the Economics ledger remain. This applies to all recorded history, regardless of the current filters.</Alert>
      {dirty && <Checkbox label="I understand that older request and Context evidence will be permanently deleted." checked={acknowledged} onChange={event => setAcknowledged(event.currentTarget.checked)} disabled={saving || reading} />}
    </> : <Text size="sm">Keep existing and future recorded request attempts, Context stage and structure evidence, sessions and client events without age-based deletion. Previously deleted records cannot be recovered by changing this setting.</Text>}
    {error && <Alert color="red" title="Retention save not verified">{error}</Alert>}{message && <Text size="sm" role="status">{message}</Text>}
  </Stack></form>;
}

export function HistoryRetention({ onSaved }) {
  const [settings, setSettings] = useState(null), [error, setError] = useState(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    readPolicy({ signal: controller.signal }).then(value => { if (!controller.signal.aborted) setSettings(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [revision]);
  return <section aria-label="History policy controls"><h2 className={styles.retentionTitle}>History retention</h2>{settings ? <RetentionForm settings={settings} onSaved={onSaved} /> : error ? <Alert color="red" title="History policy unavailable">{error}<Button variant="subtle" onClick={() => { setError(null); setRevision(value => value + 1); }}>Try again</Button></Alert> : <Group><Loader size="sm" /><Text>Reading history policy…</Text></Group>}</section>;
}
