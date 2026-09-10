'use client';
import { useEffect, useState } from 'react';
import { Button, Checkbox, Group, Stack, Textarea, TextInput } from '@mantine/core';
import { call } from '@/shared/api';
import { Notice } from '@/shared/components/Notice';
import { boardStyles as board } from '@/shared/workspace/Board';

export const NETWORK_ACTIONS = [
  { id: 'export', title: 'Download declarative adapters', path: '/api/providers/custom', method: 'GET', fields: [], effect: 'Downloads all adapter definitions. Static headers can contain credentials; keep the file private. This does not export attached account credentials.' },
  { id: 'adapter', title: 'Import declarative adapter', path: '/api/providers/custom', fields: [['document', 'Adapter JSON', 'json']], effect: 'Creates an endpoint definition with formats, static headers and custom authentication. Attach account credentials separately. Executable transformers are refused.', read: '/api/provider-nodes', collection: 'nodes', result: 'node' },
  { id: 'cloudflare', title: 'Deploy Cloudflare outbound relay', path: '/api/proxy-pools/cloudflare-deploy', fields: [['accountId', 'Cloudflare account ID'], ['apiToken', 'Deployment API token', 'password'], ['projectName', 'Project name']], effect: 'Creates a remote Cloudflare relay and a gateway proxy pool. Remote resources can be billable. Removing the pool does not delete the deployment.', read: '/api/proxy-pools', collection: 'proxyPools', result: 'proxyPool' },
  { id: 'vercel', title: 'Deploy Vercel outbound relay', path: '/api/proxy-pools/vercel-deploy', fields: [['vercelToken', 'Vercel deployment token', 'password'], ['projectName', 'Project name']], effect: 'Creates a remote Vercel relay and a gateway proxy pool. Remote resources can be billable. Removing the pool does not delete the deployment.', read: '/api/proxy-pools', collection: 'proxyPools', result: 'proxyPool' },
  { id: 'test', title: 'Test an outbound proxy candidate', path: '/api/settings/proxy-test', fields: [['proxyUrl', 'Proxy URL', 'password'], ['testUrl', 'Test target URL', 'url'], ['timeoutMs', 'Test timeout in milliseconds', 'number']], effect: 'Contacts the selected test target through the candidate proxy. This does not save a network policy or establish provider authentication.' },
  { id: 'timeout', title: 'Set global connection timeout', path: '/api/settings', method: 'PATCH', fields: [['connectTimeoutMs', 'Connection timeout in milliseconds', 'number']], effect: 'Changes the global timeout for subsequent requests. Provider or adapter-specific overrides may take precedence.', read: '/api/settings' },
  { id: 'delete', title: 'Remove selected proxy pools', path: '/api/proxy-pools', method: 'DELETE', fields: [], effect: 'Deletes the selected pools. Bound strict accounts can become unavailable. Remote deployments are retained.', read: '/api/proxy-pools' },
];
export function buildNetworkOptions(action, values, selected = []) {
  if (action.id === 'delete') { if (!selected.length) throw new Error('Select at least one pool.'); return { ids: selected }; }
  if (action.id === 'adapter') {
    let body; try { body = JSON.parse(values.document || ''); } catch { throw new Error('Enter valid adapter JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Adapter JSON must be an object.');
    return body;
  }
  const body = Object.fromEntries(action.fields.filter(([key]) => String(values[key] ?? '').trim()).map(([key, label, type]) => {
    const value = String(values[key]).trim();
    if (type === 'number' && (!Number.isInteger(Number(value)) || Number(value) < 1)) throw new Error(`${label} must be a positive integer.`);
    return [key, type === 'number' ? Number(value) : value];
  }));
  if (action.id === 'test' && (!body.proxyUrl || !body.testUrl)) throw new Error('Enter a proxy URL and an explicit test target URL.');
  if (action.id === 'timeout' && body.connectTimeoutMs === undefined) throw new Error('Enter a connection timeout.');
  return body;
}
const stripSecrets = values => Object.fromEntries(Object.entries(values).filter(([key]) => !['document', 'apiToken', 'vercelToken', 'proxyUrl'].includes(key)));

export default function NetworkOptions({ pools = [], onSaved, actionId = 'adapter' }) {
  const [reviewing, setReviewing] = useState(false);
  const [values, setValues] = useState({}), [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false), [notice, setNotice] = useState(null);
  const action = NETWORK_ACTIONS.find(item => item.id === actionId);
  useEffect(() => { const clear = () => { if (document.hidden) setValues(stripSecrets); }; document.addEventListener('visibilitychange', clear); return () => document.removeEventListener('visibilitychange', clear); }, []);
  const close = () => { if (!busy) { setReviewing(false); setValues({}); setSelected([]); setSubmitted(false); setNotice(null); } };
  async function submit() {
    let body;
    try { body = buildNetworkOptions(action, values, selected); } catch (error) { setNotice({ tone: 'bad', title: error.message }); return; }
    setBusy(true); setNotice(null);
    const response = await call(action.path, { method: action.method || 'POST', ...(action.method === 'GET' ? {} : { body }) });
    setValues(stripSecrets);
    if (!response.ok || response.body?.ok === false) { setBusy(false); if (!response.status) { setSubmitted(true); setReviewing(false); setNotice({ tone: 'warn', title: 'The operation outcome is unknown.', next: 'Refresh the saved inventory before another action. Do not repeat the interrupted operation.' }); return; } setNotice({ tone: 'bad', title: `Operation refused${response.status ? ` (HTTP ${response.status})` : ''}.`, next: 'Check the fields, session permission and service prerequisites. Secret fields were cleared.' }); return; }
    if (action.id === 'export') {
      const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(response.body, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = objectUrl; link.download = 'provider-adapters.json'; link.click(); URL.revokeObjectURL(objectUrl);
      setBusy(false); setSubmitted(true); setReviewing(false); setNotice({ tone: 'info', title: 'Private adapter download requested.', next: 'The browser controls file delivery. Credential-bearing headers are not displayed here.' }); return;
    }
    let verified = true;
    if (action.read) {
      const read = await call(action.read);
      if (action.id === 'timeout') verified = read.ok && read.body?.connectTimeoutMs === body.connectTimeoutMs;
      else if (action.id === 'delete') verified = read.ok && selected.every(id => !(read.body?.proxyPools || []).some(pool => pool.id === id));
      else verified = read.ok && Boolean(response.body?.[action.result]?.id) && (read.body?.[action.collection] || []).some(item => item.id === response.body[action.result].id);
    }
    setBusy(false); setSubmitted(true); setReviewing(false); onSaved?.();
    setNotice({ tone: verified ? 'ok' : 'warn', title: action.id === 'test' ? 'The proxy candidate test completed.' : verified ? 'Saved state read back.' : 'Saved state could not be fully confirmed.', next: action.id === 'test' ? `HTTP ${response.body?.status ?? 'not recorded'}. No routing policy was saved.` : 'Close and refresh before another change. Configuration does not establish upstream account readiness.' });
  }
  const undo = ['cloudflare', 'vercel'].includes(action.id)
    ? 'Remote resources remain until removed at the host. Removing the gateway pool does not remove the deployment.'
    : 'Review the saved state before another change. Provider authentication is separate.';
  return <section className="panel" aria-label={action.title}><h3>{action.title}</h3>
      <form onSubmit={event => { event.preventDefault(); try { buildNetworkOptions(action, values, selected); setNotice(null); setReviewing(true); } catch (error) { setNotice({ tone: 'bad', title: error.message }); } }}><Stack gap="md">

        <p>{action.effect}</p>{notice ? <Notice {...notice} /> : null}
        {!submitted ? action.fields.map(([key, label, type]) => type === 'json'
          ? <Textarea size="xs" key={key} label={label} value={values[key] || ''} onChange={event => { const value = event.currentTarget.value; setValues(current => ({ ...current, [key]: value })); }} minRows={7} disabled={busy || reviewing} autoComplete="off" description="Supports name, prefix, baseUrl, endpoints, headers and auth. Headers can contain credentials." />
          : <TextInput size="xs" key={key} label={label} type={type || 'text'} value={values[key] || ''} onChange={event => { const value = event.currentTarget.value; setValues(current => ({ ...current, [key]: value })); }} disabled={busy || reviewing} autoComplete={type === 'password' ? 'off' : undefined} />) : null}
        {action.id === 'delete' && !submitted ? pools.map(pool => <Checkbox size="xs" key={pool.id} label={pool.name || pool.id} checked={selected.includes(pool.id)} disabled={busy || reviewing} onChange={event => { const checked = event.currentTarget.checked; setSelected(current => checked ? [...current, pool.id] : current.filter(id => id !== pool.id)); }} />) : null}
        <Group justify="flex-end"><Button size="xs" variant="default" onClick={close} disabled={busy || reviewing}>Reset task</Button>{!submitted ? <Button size="xs" type="submit" color={action.id === 'delete' ? 'red' : undefined} loading={busy}>Review action</Button> : null}</Group>
      </Stack></form>
    {reviewing ? <div className={board.notice} role="alertdialog" aria-label={`Review ${action.title}`}>
      <p className={board.muted}>{action.effect} Requires an authorized operator session and the stated service prerequisites. {undo}</p>
      <Group gap="xs" mt="xs">
        <Button size="compact-xs" color={action.id === 'delete' ? 'red' : undefined} loading={busy} onClick={submit}>{action.title}</Button>
        <Button size="compact-xs" variant="default" disabled={busy} onClick={() => { if (!busy) setReviewing(false); }}>Cancel</Button>
      </Group>
    </div> : null}
    </section>;
}
