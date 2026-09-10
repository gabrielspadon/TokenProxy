'use client';
import { useEffect, useState } from 'react';
import { Button, Checkbox, Group, NativeSelect, TextInput, Textarea } from '@mantine/core';
import { call } from '@/shared/api';
import { Notice } from '@/shared/components/Notice';
import { refusal } from '@/shared/refusal';
import { useSavedDraft } from './useSavedDraft';

const FIELDS = {
  azure: [['azureEndpoint', 'Azure endpoint', 'url'], ['deployment', 'Deployment'], ['apiVersion', 'API version'], ['organization', 'Organization']],
  vertex: [['projectId', 'Google Cloud project'], ['location', 'Location']],
  'vertex-partner': [['projectId', 'Google Cloud project']],
  'cloudflare-ai': [['accountId', 'Cloudflare account ID']],
  'xiaomi-tokenplan': [['region', 'Region', ['sgp', 'cn', 'ams']]],
  'google-pse': [['cx', 'Search engine ID']],
  linkup: [['depth', 'Search depth', ['fast', 'standard', 'deep']]],
  ddgs: [['safesearch', 'Safe search'], ['backend', 'Search backend']],
  xquik: [['queryType', 'Query type'], ['cursor', 'Result cursor']],
  cursor: [['machineId', 'Machine ID'], ['ghostMode', 'Ghost mode', 'boolean']],
  kilocode: [['orgId', 'Organization ID']],
  commandcode: [['zdrEnabled', 'Zero data retention', 'boolean']],
  codex: [['workspaceId', 'Workspace ID'], ['chatgptAccountId', 'ChatGPT account ID']],
  tokenrouter: [['managementKey', 'Management key for usage evidence', 'password']],
};

export function accountOptionFields(provider) {
  return [...(FIELDS[provider] || []), ['refreshLeadMs', 'Refresh lead time in milliseconds', 'number'], ['customHeaders', 'Upstream headers (JSON object)', 'json']];
}

export function buildAccountOptions(values, fields) {
  const body = { name: values.name.trim(), defaultModel: values.defaultModel.trim() || null,
    globalPriority: values.globalPriority === '' ? null : Number(values.globalPriority),
    maxConcurrent: values.maxConcurrent === '' ? null : Number(values.maxConcurrent) };
  if (!body.name) throw new Error('Account name is required.');
  for (const field of ['globalPriority', 'maxConcurrent']) {
    if (body[field] !== null && (!Number.isInteger(body[field]) || body[field] < 1)) throw new Error(`${field === 'globalPriority' ? 'Global priority' : 'Account concurrency'} must be a positive integer.`);
  }
  const data = {};
  for (const [key, label, type] of fields) {
    const value = values[key];
    if (value === '' || value === undefined) continue;
    if (type === 'number') {
      if (!Number.isFinite(Number(value)) || Number(value) < 0) throw new Error(`${label} must be a non-negative number.`);
      data[key] = Number(value);
    } else if (type === 'boolean') data[key] = value === 'true';
    else if (type === 'json') {
      try { data[key] = JSON.parse(value); } catch { throw new Error(`${label} must contain valid JSON.`); }
      if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) throw new Error(`${label} must be an object.`);
    } else data[key] = value.trim();
  }
  if (values.clearHeaders) data.customHeaders = {};
  if (Object.keys(data).length) body.providerSpecificData = data;
  return body;
}

export function ProviderOptionInputs({ provider, values, onChange, disabled = false }) {
  return accountOptionFields(provider).map(([key, label, type]) => {
    const common = { size: 'xs', className: 'account-option-field', label, value: values[key] ?? '', disabled, onChange: event => onChange(key, event.currentTarget.value) };
    if (Array.isArray(type)) return <NativeSelect key={key} {...common} data={[{ value: '', label: 'Provider default / keep current' }, ...type]} />;
    if (type === 'boolean') return <NativeSelect key={key} {...common} data={[{ value: '', label: 'Provider default / keep current' }, { value: 'true', label: 'On' }, { value: 'false', label: 'Off' }]} />;
    if (type === 'json') return <Textarea key={key} {...common} minRows={3} description="Write-only. Header values can contain credentials; leave empty to preserve them." autoComplete="off" />;
    return <TextInput key={key} {...common} type={type || 'text'} autoComplete={type === 'password' ? 'off' : undefined} />;
  });
}

export default function AccountOptions({ connection, onSaved }) {
  const fields = accountOptionFields(connection.provider);
  const draft = () => {
    const values = { name: connection.name || connection.displayName || '', defaultModel: connection.defaultModel || '',
      globalPriority: connection.globalPriority ?? '', maxConcurrent: connection.maxConcurrent ?? '' };
    for (const [key, , type] of fields) {
      const value = connection.providerSpecificData?.[key];
      values[key] = type === 'password' || key === 'customHeaders' || value == null ? '' : String(value);
    }
    return values;
  };
  const { values, set, reset, forget, conflicts } = useSavedDraft(draft());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    const clear = () => { if (document.hidden) forget(['customHeaders', 'managementKey']); };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, [forget]);
  async function save(event) {
    event.preventDefault();
    if (busy || uncertain || conflicts.length) return;
    let body;
    try { body = buildAccountOptions(values, fields); }
    catch (error) { setNotice({ tone: 'bad', title: error.message }); return; }
    setBusy(true); setNotice(null);
    const result = await call(`/api/providers/${encodeURIComponent(connection.id)}`, { method: 'PUT', body });
    forget(['customHeaders', 'managementKey']);
    if (!result.ok) { if (!result.status) setUncertain(true); setNotice(refusal(result.status, result.body)); setBusy(false); return; }
    const read = await call(`/api/providers/${encodeURIComponent(connection.id)}`);
    const saved = read.body?.connection;
    const visibleData = Object.entries(body.providerSpecificData || {}).filter(([key]) => !['customHeaders', 'managementKey'].includes(key));
    const matches = read.ok && saved?.id === connection.id && ['name', 'defaultModel', 'globalPriority', 'maxConcurrent'].every(key => (saved[key] ?? null) === (body[key] ?? null)) && visibleData.every(([key, value]) => saved.providerSpecificData?.[key] === value);
    if (matches) forget(['clearHeaders']);
    setUncertain(!matches); setBusy(false);
    setNotice(matches ? { tone: 'ok', title: 'Account options saved and read back.', next: 'Secret values remain write-only. This does not test upstream authentication.' }
      : { tone: 'warn', title: 'The write was accepted, but its saved state could not be confirmed.', next: 'Close and refresh this account before another change.' });
    onSaved?.();
  }
  return <section className="connections-panel" aria-label="Account options">
      <h2>Account options</h2>
      <form onSubmit={save}><div className="account-options-grid">
        <p>Changes apply to subsequent selections of <bdi>{connection.name || connection.id}</bdi>. Other accounts keep their settings. Provider-specific blank fields preserve their current values.</p>
        {notice ? <Notice {...notice} /> : null}
        {conflicts.length ? <Notice tone="warn" title="Saved account fields changed while you were editing." next={`Your draft is retained. Reset the draft to load current values before saving. Changed fields: ${conflicts.join(', ')}.`} /> : null}
        <TextInput size="xs" className="account-option-field" label="Account name" value={values.name || ''} onChange={event => set('name', event.currentTarget.value)} required disabled={busy || uncertain} />
        <TextInput size="xs" className="account-option-field" label="Default model" description="Used when this connection supplies a model fallback. Empty clears it." value={values.defaultModel || ''} onChange={event => set('defaultModel', event.currentTarget.value)} disabled={busy || uncertain} />
        <TextInput size="xs" className="account-option-field" type="number" min="1" label="Global display priority" description="Orders the client account listing. This does not replace the routing strategy." value={values.globalPriority ?? ''} onChange={event => set('globalPriority', event.currentTarget.value)} disabled={busy || uncertain} />
        <TextInput size="xs" className="account-option-field" type="number" min="1" label="Account concurrency ceiling" description="Independent of the shared provider ceiling. Empty clears this account override." value={values.maxConcurrent ?? ''} onChange={event => set('maxConcurrent', event.currentTarget.value)} disabled={busy || uncertain} />
        <ProviderOptionInputs provider={connection.provider} values={values} onChange={set} disabled={busy || uncertain} />
        <Checkbox size="xs" label="Clear all custom upstream headers" checked={Boolean(values.clearHeaders)} onChange={event => set('clearHeaders', event.currentTarget.checked)} disabled={busy || uncertain} />
        <Group justify="flex-start" gap="xs"><Button size="xs" variant="default" onClick={() => { reset(); setNotice(null); }} disabled={busy || uncertain}>Reset draft</Button><Button size="xs" type="submit" loading={busy} disabled={uncertain || conflicts.length > 0}>Save account options</Button></Group>
      </div></form>
  </section>;
}
