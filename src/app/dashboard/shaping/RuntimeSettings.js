'use client';
import { useState } from 'react';
import { Button, Checkbox, NativeSelect, TextInput } from '@mantine/core';
import { usePoll } from '@/shared/hooks/usePoll';
import { call } from '@/shared/api';
import { Notice } from '@/shared/components/Notice';

const fields = [
  { key: 'headroomUrl', label: 'Headroom service URL', description: 'Eligible request content is sent to this configured service when rewriting is enabled and permitted.' },
  { key: 'embedReorderUrl', label: 'Embedding service URL', description: 'History scoring sends request-derived content to this endpoint. Use an HTTP or HTTPS URL without credentials, query or fragment.' },
  { key: 'embedReorderModel', label: 'Embedding model', description: 'Exact model identifier sent to the configured embedding service.' },
  { key: 'pxpipeAutoInstall', label: 'Allow automatic PXPIPE installation', description: 'When PXPIPE is missing, Start can install its package. Saving this setting does not install or load anything.', boolean: true },
  { key: 'contextStructureEnabled', label: 'Record sanitized request structure', description: 'New requests retain structural boundaries and measurements. Raw request content is not stored by this capture. Existing records remain.', boolean: true },
];
const display = value => typeof value === 'boolean' ? value ? 'On' : 'Off' : value || 'Unknown';
export function RuntimeSettings() {
  const resource = usePoll('/api/admin/shaping/runtime', 30000);
  const [page, setPage] = useState(1);
  const history = usePoll(`/api/admin/shaping/runtime-receipts?page=${page}&pageSize=20`, 30000);
  const [draft, setDraft] = useState(null), [reviewing, setReviewing] = useState(false), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [notice, setNotice] = useState(null), [receipt, setReceipt] = useState(null);
  const [probe, setProbe] = useState(null), [probing, setProbing] = useState(false);
  const values = { ...resource.data?.settings, ...draft?.patch };
  function change(key, value) { setDraft(previous => ({ before: previous?.before || resource.data, patch: { ...previous?.patch, [key]: value } })); setConsent(false); }
  function discard() { setDraft(null); setReviewing(false); setConsent(false); setUncertain(false); }
  async function save() {
    if (!consent || busy || uncertain || !draft) return;
    setBusy(true); setNotice(null);
    const result = await call('/api/admin/shaping/runtime', { method: 'POST', body: { patch: draft.patch, expectedCurrent: draft.before.currentHash, acknowledgeRequestData: consent } });
    if (!result.ok) {
      setUncertain(result.status === 0 || result.status >= 500);
      setNotice({ tone: 'warn', title: result.status === 409 ? 'Runtime settings changed. Refresh and review the retained draft again.' : result.status === 0 || result.status >= 500 ? 'Save outcome unknown. Read current settings before another change.' : 'Runtime settings were refused.', detail: result.body?.code || result.body?.error });
      setBusy(false); return;
    }
    const current = await call('/api/admin/shaping/runtime');
    const retained = result.body?.receipt ? await call(`/api/admin/shaping/runtime-receipts/${result.body.receipt.id}`) : null;
    const confirmed = result.status !== 207 && result.body?.persistence === 'confirmed' && current.ok && current.body.currentHash === result.body.afterHash && (!result.body.receipt || retained?.ok && retained.body.afterHash === result.body.afterHash);
    setReceipt(retained?.ok ? retained.body : result.body?.receipt || null);
    setNotice({ tone: confirmed ? 'ok' : 'warn', title: confirmed ? 'Runtime settings saved and verified. No service was contacted.' : 'Accepted settings could not be fully verified. Inspect the current state before another change.' });
    if (confirmed) discard(); else setUncertain(true);
    resource.refresh(); history.refresh(); setBusy(false);
  }
  async function inspect(id) {
    if (!id) { setReceipt(null); return; }
    const result = await call(`/api/admin/shaping/runtime-receipts/${id}`);
    if (result.ok) setReceipt(result.body); else setNotice({ tone: 'warn', title: 'Retained settings receipt could not be read.', detail: result.body?.code || result.body?.error });
  }
  async function checkHeadroom() {
    setProbing(true);
    const result = await call('/api/headroom/status');
    setProbe(result); setProbing(false);
  }
  return <section className="shaping-runtime-settings" aria-labelledby="shaping-runtime-title">
    <div className="shaping-section-head"><h2 id="shaping-runtime-title">Services and recording</h2><Button variant="default" disabled={busy} onClick={resource.refresh}>Refresh settings</Button></div>
    <p>These global settings take effect on new requests or the next explicit service action. They do not establish service reachability, installation or provider support.</p>
    {resource.error ? <Notice tone="warn" title="Runtime settings could not be read." detail={resource.error} /> : null}
    {notice ? <div role="status"><Notice {...notice} /></div> : null}
    <div className="shaping-setting-grid">{fields.map(field => <div key={field.key}>{field.boolean ? <Checkbox label={field.label} description={field.description} checked={values[field.key] === true} disabled={!resource.data || busy || reviewing} onChange={event => change(field.key, event.currentTarget.checked)} /> : <TextInput label={field.label} description={field.description} value={values[field.key] || ''} disabled={!resource.data || busy || reviewing} onChange={event => change(field.key, event.currentTarget.value)} />}{resource.data?.redactedFields?.includes(field.key) ? <p className="shaping-caption">Stored credentials or an unsupported URL are withheld. Editing replaces this entire field; leaving it untouched preserves the stored value.</p> : null}</div>)}</div>
    {draft && !reviewing ? <Button mt="md" onClick={() => setReviewing(true)}>Review service settings</Button> : null}
    {reviewing ? <div className="shaping-plan-review"><h3>Review service and recording changes</h3><dl>{Object.entries(draft.patch).map(([key, value]) => <div key={key}><dt>{fields.find(field => field.key === key).label}</dt><dd>{display(draft.before.settings[key])} → {display(value)}</dd></div>)}</dl><p>Restore previous values here to reverse future behavior. This scope is outside shaping-profile and routing-policy rollback. Credentials withheld from display cannot be recovered from a receipt.</p><Checkbox label="I reviewed request-data destinations, installation permission and structural recording effects." checked={consent} disabled={busy || uncertain} onChange={event => setConsent(event.currentTarget.checked)} /><Button mt="md" onClick={save} loading={busy} disabled={!consent || uncertain}>Save service settings</Button></div> : null}
    {draft ? <Button mt="md" ml="sm" variant="subtle" disabled={busy} onClick={discard}>Discard service draft and use latest read</Button> : null}
    <details className="shaping-technical"><summary>Selective prose service setup</summary><p>Lingua reads the host environment variable <code>TOKENPROXY_LINGUA_ENDPOINT</code>. The runtime accepts a loopback HTTP endpoint or a Unix socket. No dashboard service installer or environment editor exists. A missing or unavailable endpoint leaves this stage unchanged.</p></details>
    <details className="shaping-technical"><summary>Headroom service diagnostics</summary><p>Checking health contacts the configured Headroom service. Opening its dashboard forwards requests to that service, whose settings and history are outside TokenProxy rollback.</p><div className="actions"><Button variant="default" loading={probing} onClick={checkHeadroom}>Contact Headroom health endpoint</Button><Button component="a" href="/api/headroom/proxy/dashboard" target="_blank" rel="noreferrer" variant="subtle">Open Headroom dashboard</Button></div>{probe ? probe.ok ? <dl className="shaping-control-facts"><div><dt>Health endpoint responded</dt><dd>{display(probe.body?.running)}</dd></div><div><dt>Global shaping switch</dt><dd>{display(probe.body?.enabled)}</dd></div><div><dt>Reachable and enabled</dt><dd>{display(probe.body?.active)}</dd></div></dl> : <Notice tone="warn" title="Headroom status could not be read." detail={probe.body?.code || probe.body?.error} /> : <p>No health check has run in this view.</p>}</details>
    <NativeSelect mt="lg" label="Retained service settings change" value={receipt?.id || ''} onChange={event => inspect(event.currentTarget.value)} data={[{ value: '', label: 'Choose a retained change' }, ...(history.data?.rows || []).map(row => ({ value: row.id, label: `${row.createdAt} · ${row.id.slice(0,8)}` }))]} />
    {history.error ? <Notice tone="warn" title="Service settings history could not be read." detail={history.error} /> : null}
    {history.data ? <div className="actions"><span>Page {page} · {history.data.pagination.total} retained changes</span><Button variant="subtle" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous settings changes</Button><Button variant="subtle" disabled={page >= history.data.pagination.pages} onClick={() => setPage(value => value + 1)}>Next settings changes</Button></div> : null}
    {receipt ? <details open className="shaping-technical"><summary>Retained service settings receipt</summary><p><code>{receipt.id}</code> · {receipt.createdAt}</p><p>{receipt.scope}</p><dl className="shaping-control-facts">{receipt.changedKeys.map(key => <div key={key}><dt>{fields.find(field => field.key === key)?.label || key}</dt><dd>{display(receipt.before.settings[key])} → {display(receipt.after.settings[key])}</dd></div>)}</dl></details> : null}
  </section>;
}
