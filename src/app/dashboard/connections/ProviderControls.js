'use client';
import { useState } from 'react';
import { Button, Group, Modal, NativeSelect, Stack, TextInput } from '@mantine/core';
import { call } from '@/shared/api';
import { Notice } from '@/shared/components/Notice';
import { AI_PROVIDERS } from '@/shared/constants/providers';

export default function ProviderControls({ nodes = [], onSaved }) {
  const [opened, setOpened] = useState(false), [providerId, setProviderId] = useState('');
  const [timeout, setTimeoutValue] = useState(''), [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(null), [uncertain, setUncertain] = useState(false);
  const entries = [...Object.values(AI_PROVIDERS), ...nodes];
  async function choose(id) {
    setProviderId(id); setSnapshot(null); setNotice(null); setBusy(true);
    const read = await call('/api/settings');
    setBusy(false);
    if (!read.ok) { setNotice({ tone: 'bad', title: 'Provider settings could not be read.' }); return; }
    setSnapshot(read.body); setTimeoutValue(read.body.providerStrategies?.[id]?.connectTimeoutMs ?? '');
  }
  async function save(kind) {
    const disabled = snapshot.disabledProviders?.[providerId] === true;
    const value = timeout === '' ? null : Number(timeout);
    if (kind === 'timeout' && value !== null && (!Number.isInteger(value) || value < 1000 || value > 120000)) { setNotice({ tone: 'bad', title: 'Timeout must be 1000 through 120000 milliseconds, or empty to inherit.' }); return; }
    setBusy(true); setNotice(null);
    const fresh = await call('/api/settings');
    if (!fresh.ok) { setBusy(false); setNotice({ tone: 'bad', title: 'Current settings could not be read. Nothing was saved.' }); return; }
    const body = kind === 'timeout'
      ? { providerStrategyPatch: { providerId, values: { connectTimeoutMs: value } } }
      : { disabledProviders: { ...fresh.body.disabledProviders, [providerId]: !disabled } };
    const write = await call('/api/settings', { method: 'PATCH', body });
    if (!write.ok) { setBusy(false); setNotice({ tone: 'bad', title: `Provider setting was refused (HTTP ${write.status}).`, next: 'Your nonsecret draft is retained.' }); return; }
    const read = await call('/api/settings');
    const verified = read.ok && (kind === 'timeout' ? (read.body.providerStrategies?.[providerId]?.connectTimeoutMs ?? null) === value : read.body.disabledProviders?.[providerId] === !disabled);
    setBusy(false); setUncertain(!verified); if (verified) setSnapshot(read.body); onSaved?.();
    setNotice({ tone: verified ? 'ok' : 'warn', title: verified ? 'Provider setting saved and read back.' : 'Accepted, but saved provider state could not be confirmed.', next: verified ? 'This affects subsequent requests. No provider was contacted.' : 'Close and refresh before another change.' });
  }
  const close = () => { if (!busy) { setOpened(false); setSnapshot(null); setProviderId(''); setNotice(null); setUncertain(false); } };
  return <><Button variant="default" onClick={() => setOpened(true)}>Provider controls</Button>
    <Modal opened={opened} onClose={close} title="Provider controls" closeOnClickOutside={!busy} closeOnEscape={!busy}>
      <Stack gap="md">
        <NativeSelect label="Provider" value={providerId} disabled={busy || uncertain} onChange={event => choose(event.currentTarget.value)} data={[{ value: '', label: 'Choose a provider' }, ...entries.map(item => ({ value: item.id, label: item.name || item.id }))]} />
        {notice ? <Notice {...notice} /> : null}
        {providerId === 'ddgs' ? <p>DDGS search options are request-owned. Send <code>providerOptions.safesearch</code> and <code>providerOptions.backend</code> in a search request. A virtual DDGS account does not persist account-specific search fields.</p> : null}
        {snapshot && providerId ? <>
          <p>{snapshot.disabledProviders?.[providerId] ? 'Disabled for routing.' : 'Enabled for routing.'} Credentialless providers use a virtual account and do not need an empty credential record. Restoring a provider does not establish availability.</p>
          <Button variant="default" disabled={busy || uncertain} onClick={() => save('enabled')}>{snapshot.disabledProviders?.[providerId] ? 'Restore provider' : 'Disable provider'}</Button>
          <TextInput label="Provider connection timeout in milliseconds" description="Applies to this provider. Empty restores inheritance from the global timeout." type="number" min={1000} max={120000} value={timeout} disabled={busy || uncertain} onChange={event => setTimeoutValue(event.currentTarget.value)} />
          <Button disabled={busy || uncertain} onClick={() => save('timeout')}>Save provider timeout</Button>
        </> : null}
        <Group justify="flex-end"><Button variant="default" disabled={busy} onClick={close}>Close</Button></Group>
      </Stack>
    </Modal></>;
}
