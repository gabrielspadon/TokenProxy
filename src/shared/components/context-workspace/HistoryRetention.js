'use client';
import { useState } from 'react';
import { Alert, Button, Checkbox, Group, Loader, Modal, NativeSelect, NumberInput, Stack, Text } from '@mantine/core';
import { useResource } from '@/shared/workspace/useResource';

function RetentionForm({ settings, onSaved, onBusy }) {
  const [mode, setMode] = useState(settings.statsRetentionMode);
  const [days, setDays] = useState(settings.statsRetentionDays);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const valid = ['preserve', 'window'].includes(mode) && Number.isInteger(days) && days >= 1 && days <= 365;
  async function save(event) {
    event.preventDefault();
    if (!valid || saving || (mode === 'window' && !acknowledged)) return;
    setSaving(true); onBusy(true); setError(null);
    try {
      const patch = { statsRetentionMode: mode, statsRetentionDays: days };
      const response = await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || 'History retention could not be saved.');
      const readback = await fetch('/api/settings', { cache: 'no-store' });
      const stored = await readback.json();
      if (!readback.ok || stored.statsRetentionMode !== mode || stored.statsRetentionDays !== days) {
        throw new Error('The save could not be verified. Your draft is retained; reopen this control to read the current policy before retrying.');
      }
      onSaved(mode === 'preserve' ? 'History preserved. Policy saved and verified.' : `${days}-day retention saved and verified.`);
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); onBusy(false); }
  }
  return <form onSubmit={save}><Stack gap="md">
    <NativeSelect label="History policy" value={mode} onChange={event => { setMode(event.currentTarget.value); setAcknowledged(false); }} disabled={saving} data={[{ value: 'preserve', label: 'Preserve all history' }, { value: 'window', label: 'Keep a limited number of days' }]} />
    {mode === 'window' ? <>
      <NumberInput label="Days to retain" description="1 to 365 days" value={days} onChange={value => { setDays(value); setAcknowledged(false); }} min={1} max={365} allowDecimal={false} disabled={saving} />
      <Alert color="orange" title="Older request and Context evidence will be permanently deleted">On subsequent recording, request attempts older than {Number.isInteger(days) ? days : 'the chosen number of'} days, including recorded Capacity activity and Context attempts, will be removed with their stage and structure evidence. Older client events and sessions with no remaining requests are also removed. Usage history and the Economics ledger remain. This applies to all recorded history, regardless of the current filters.</Alert>
      <Checkbox label="I understand that older request and Context evidence will be permanently deleted." checked={acknowledged} onChange={event => setAcknowledged(event.currentTarget.checked)} disabled={saving} />
    </> : <Text size="sm">Keep existing and future recorded request attempts, Context stage and structure evidence, sessions and client events without age-based deletion. Previously deleted records cannot be recovered by changing this setting.</Text>}
    {error && <Alert color="red" title="Retention save not verified">{error}</Alert>}
    <Group justify="flex-end"><Button type="submit" disabled={!valid || (mode === 'window' && !acknowledged)} loading={saving}>Save history policy</Button></Group>
  </Stack></form>;
}

export function HistoryRetention({ onSaved }) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const resource = useResource(opened ? '/api/settings' : null, { interval: 0 });
  return <>
    <Group gap={8}><Button variant="default" size="compact-sm" onClick={() => { setMessage(null); setOpened(true); }}>History retention</Button>{message && <Text size="sm" role="status">{message}</Text>}</Group>
    <Modal opened={opened} onClose={() => { if (!busy) setOpened(false); }} title="History retention" centered size="md" closeOnEscape={!busy} closeOnClickOutside={!busy} withCloseButton={!busy}>
      {resource.loading ? <Group><Loader size="sm" /><Text>Reading history policy…</Text></Group> : resource.error ? <Alert color="red" title="History policy unavailable">{resource.error}<Button variant="subtle" onClick={resource.refresh}>Try again</Button></Alert> : resource.data && <RetentionForm key={resource.receivedAt} settings={resource.data} onBusy={setBusy} onSaved={message => { setMessage(message); setOpened(false); onSaved(); }} />}
    </Modal>
  </>;
}
