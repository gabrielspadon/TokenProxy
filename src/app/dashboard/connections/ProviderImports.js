'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Group, Modal, NativeSelect, Stack, Textarea, TextInput } from '@mantine/core';
import { call } from '@/shared/api';
import { Notice } from '@/shared/components/Notice';

export const IMPORT_METHODS = [
  { id: 'mixed', label: 'Mixed provider account documents', path: '/api/providers/import', fields: [['document', 'Account JSON', 'json']], note: 'Accepts a single account, an array, an accounts wrapper or a database providerConnections export. Each account must identify its provider and credential mode.' },
  { id: 'codex-token', label: 'Codex access token', path: '/api/oauth/codex/import-token', fields: [['accessToken', 'Access token', 'password'], ['name', 'Account name']], note: 'Stores an access token without a refresh token. Import does not prove upstream authentication.' },
  { id: 'codex-bulk', label: 'Codex account documents', path: '/api/oauth/codex/bulk-import', fields: [['document', 'Account JSON', 'json']] },
  { id: 'grok-bulk', label: 'Grok CLI account documents', path: '/api/oauth/grok-cli/bulk-import', fields: [['document', 'Account JSON', 'json']] },
  { id: 'cursor', label: 'Cursor token and machine identity', path: '/api/oauth/cursor/import', discovery: '/api/oauth/cursor/auto-import', fields: [['accessToken', 'Access token', 'password'], ['machineId', 'Machine ID']], note: 'Import validates the provider credential. Reading a local installation fills this draft only; a separate submit stores it.' },
  { id: 'kiro-refresh', label: 'Kiro refresh credential', path: '/api/oauth/kiro/import', discovery: '/api/oauth/kiro/auto-import', fields: [['refreshToken', 'Refresh token', 'password'], ['clientId', 'Registered client ID'], ['clientSecret', 'Registered client secret', 'password'], ['region', 'AWS region'], ['authMethod', 'Authentication method', ['builder-id', 'idc']], ['profileArn', 'Profile ARN']], note: 'Refreshes the credential with Kiro before storing the connection. Identity Center needs its registered client ID and secret.' },
  { id: 'kiro-api-key', label: 'Kiro API key', path: '/api/oauth/kiro/api-key', fields: [['apiKey', 'API key', 'password'], ['region', 'AWS region']], note: 'Uses Kiro API-key authentication rather than its OAuth endpoint.' },
  { id: 'kiro-external', label: 'Kiro CLIProxyAPI document', path: '/api/oauth/kiro/import-cli-proxy', fields: [['document', 'CLIProxyAPI auth JSON', 'json']], note: 'Imports the supported Microsoft external identity-provider credential document.' },
  { id: 'gitlab', label: 'GitLab personal access token', path: '/api/oauth/gitlab/pat', fields: [['token', 'Personal access token', 'password'], ['baseUrl', 'GitLab instance URL', 'url']], note: 'Checks the token against the selected GitLab instance before saving.' },
  { id: 'iflow', label: 'iFlow browser cookie', path: '/api/oauth/iflow/cookie', fields: [['cookie', 'Browser cookie', 'password']], note: 'Exchanges the browser cookie with iFlow before storing the account.' },
];

export function buildProviderImport(method, values) {
  if (method.fields.some(([key]) => key === 'document')) {
    let parsed;
    try { parsed = JSON.parse(values.document || ''); } catch { throw new Error('Enter valid account JSON.'); }
    if (!parsed || typeof parsed !== 'object') throw new Error('Account JSON must be an object or array.');
    return parsed;
  }
  return Object.fromEntries(method.fields.filter(([key]) => values[key]?.trim()).map(([key]) => [key, values[key].trim()]));
}

export function providerImportReceipt(body) {
  if (Array.isArray(body?.results)) return { ids: body.results.filter(item => item.ok && item.id).map(item => item.id), failed: body.results.filter(item => !item.ok).map(item => Number(item.index) + 1) };
  return { ids: body?.connection?.id ? [body.connection.id] : [], failed: [] };
}

export default function ProviderImports({ onSaved }) {
  const [opened, setOpened] = useState(false);
  const [methodId, setMethodId] = useState('mixed');
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [ids, setIds] = useState([]);
  const [submitted, setSubmitted] = useState(false);
  const method = IMPORT_METHODS.find(item => item.id === methodId);
  const clearSecrets = useCallback(current => Object.fromEntries(Object.entries(current).filter(([key]) => !method.fields.some(([field, , type]) => field === key && ['password', 'json'].includes(type)))), [method]);
  useEffect(() => {
    const clear = () => { if (document.hidden) setValues(current => clearSecrets(current)); };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, [clearSecrets]);
  const close = () => { if (!busy) { setOpened(false); setValues({}); setNotice(null); setIds([]); setSubmitted(false); } };
  async function discover() {
    setBusy(true); setNotice(null);
    const response = await call(method.discovery);
    setBusy(false);
    if (!response.ok || response.body?.found !== true) {
      setNotice({ tone: 'warn', title: 'Local credentials were not available.', next: 'This action requires a local authorized session and an installed, signed-in application. You can paste its credential instead.' }); return;
    }
    setValues(current => ({ ...current, ...Object.fromEntries(method.fields.map(([key]) => [key, response.body[key] ?? current[key] ?? ''])) }));
    setNotice({ tone: 'info', title: 'Local credentials filled the draft.', next: 'Nothing has been imported. Review the nonsecret fields and submit explicitly.' });
  }
  async function submit(event) {
    event.preventDefault();
    let body;
    try { body = buildProviderImport(method, values); }
    catch (error) { setNotice({ tone: 'bad', title: error.message }); return; }
    setBusy(true); setNotice(null);
    const response = await call(method.path, { method: 'POST', body });
    setValues(current => clearSecrets(current));
    if (!response.ok || response.body?.success === false) {
      setBusy(false); setNotice({ tone: 'bad', title: `Import was refused${response.status ? ` (HTTP ${response.status})` : ''}.`, next: 'Check the credential format, provider prerequisites and your session permission. Secret fields were cleared.' }); return;
    }
    const result = providerImportReceipt(response.body);
    const read = await call('/api/providers');
    const found = new Set((read.body?.connections || []).map(item => item.id));
    const verified = read.ok && result.ids.length > 0 && result.ids.every(id => found.has(id));
    setIds(result.ids); setSubmitted(true); setBusy(false); onSaved?.();
    setNotice({ tone: verified && !result.failed.length ? 'ok' : 'warn', title: verified ? `${result.ids.length} imported account${result.ids.length === 1 ? '' : 's'} read back.` : 'Import returned, but saved accounts could not be fully confirmed.',
      next: result.failed.length ? `Entries ${result.failed.join(', ')} were refused. Successful entries remain stored. Import only corrected entries to avoid duplicates.` : 'Stored credentials do not establish model access or successful generation. Open an account to inspect it.' });
  }
  return <>
    <Button variant="default" onClick={() => setOpened(true)}>Import accounts</Button>
    <Modal opened={opened} onClose={close} title="Import provider accounts" size="lg" closeOnClickOutside={!busy} closeOnEscape={!busy}>
      <form onSubmit={submit}><Stack gap="md">
        <NativeSelect label="Import mechanism" data={IMPORT_METHODS.map(item => ({ value: item.id, label: item.label }))} value={methodId} disabled={busy || submitted} onChange={event => { setMethodId(event.currentTarget.value); setValues({}); setNotice(null); }} />
        <p>{method.note || 'Imports saved provider credentials. Successful entries are retained even if another entry is refused.'} This requires an authorized dashboard session. New active accounts may receive subsequent requests.</p>
        {notice ? <Notice {...notice} /> : null}
        {!submitted ? method.fields.map(([key, label, type]) => {
          const common = { label, value: values[key] || '', disabled: busy, onChange: event => { const value = event.currentTarget.value; setValues(current => ({ ...current, [key]: value })); } };
          if (type === 'json') return <Textarea key={key} {...common} minRows={6} autoComplete="off" description="Sensitive credential document. Cleared when this dialog closes or the tab is hidden." />;
          if (Array.isArray(type)) return <NativeSelect key={key} {...common} data={[{ value: '', label: 'Provider default' }, ...type]} />;
          return <TextInput key={key} {...common} type={type || 'text'} autoComplete={type === 'password' ? 'off' : undefined} />;
        }) : null}
        {ids.map(id => <Link key={id} href={`/dashboard/connections/${encodeURIComponent(id)}`}>Open imported account {id}</Link>)}
        <Group justify="space-between">
          {method.discovery && !submitted ? <Button variant="default" onClick={discover} disabled={busy}>Read local installation</Button> : <span />}
          <Group><Button variant="default" onClick={close} disabled={busy}>Close</Button>{!submitted ? <Button type="submit" loading={busy}>Import accounts</Button> : null}</Group>
        </Group>
      </Stack></form>
    </Modal>
  </>;
}
