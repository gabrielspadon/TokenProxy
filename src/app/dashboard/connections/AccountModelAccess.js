'use client';
import { useState } from 'react';
import { usePoll } from '@/shared/hooks/usePoll';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { Confirm } from '@/shared/components/Confirm';
import { Notice } from '@/shared/components/Notice';

export function AccountModelAccess({ connection }) {
  const query = new URLSearchParams({ providerAlias: connection.provider, connectionId: connection.id });
  const endpoint = `/api/models/disabled?${query}`;
  const policy = usePoll(endpoint, 30000);
  const [model, setModel] = useState('');
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const ids = policy.data?.ids || [];
  async function apply() {
    setBusy(true);
    setError(null);
    const response = pending.kind === 'disable'
      ? await call('/api/models/disabled', { method: 'POST', body: { providerAlias: connection.provider, connectionId: connection.id, ids: [pending.model] } })
      : await call(`${endpoint}&id=${encodeURIComponent(pending.model)}`, { method: 'DELETE' });
    if (!response.ok) {
      setBusy(false);
      if (!response.status) {
        setPending(null); setUncertain(true);
        setReceipt({ tone: 'warn', title: 'The model policy outcome is unknown.', next: 'Refresh the policy before taking another action. Do not repeat the interrupted mutation.' });
      } else setError(refusal(response.status, response.body));
      return;
    }
    const readback = await call(endpoint);
    const normalizedModel = pending.model.startsWith(`${connection.provider}/`) ? pending.model.slice(connection.provider.length + 1) : pending.model;
    const verified = readback.ok && Array.isArray(readback.body?.ids) && readback.body.ids.includes(normalizedModel) === (pending.kind === 'disable');
    setBusy(false);
    setPending(null);
    setModel('');
    setUncertain(!verified);
    setReceipt(verified ? { tone: 'ok', title: 'Account model policy saved and verified.', next: 'The next routing selection uses this exclusion list. Upstream model entitlement remains unknown.' }
      : { tone: 'warn', title: 'The change was accepted; refreshed policy was not verified.', next: 'Refresh the policy before applying another change. Do not repeat the mutation.' });
    policy.refresh();
  }
  async function refresh() {
    const response = await call(endpoint);
    if (response.ok && Array.isArray(response.body?.ids)) setUncertain(false);
    policy.refresh();
  }
  return <section className="account-model-access" aria-labelledby="account-model-access-title">
    <h2 id="account-model-access-title">Model access</h2>
    <p className="caption">Local exclusions for this account. A model absent from this list may still be unavailable upstream. The account inherits the provider list until its first edit, then keeps its own list.</p>
    {policy.error ? <Notice {...refusal(policy.status, policy.error)} /> : null}
    {receipt ? <Notice {...receipt} /> : null}
    <dl className="facts"><dt>Upstream entitlement</dt><dd>Unknown. This local policy check does not contact the provider.</dd><dt>Locally excluded</dt><dd>{policy.data ? ids.length ? ids.join(', ') : 'No local exclusions' : 'Not reported'}</dd></dl>
    <details className="fold"><summary>Edit model access</summary>
      <div className="connections-form">
        <label className="field"><span>Model ID to exclude</span><input className="input" value={model} onChange={event => setModel(event.target.value)} /></label>
        <button type="button" className="button quiet" disabled={!model.trim() || !!policy.error || !policy.data || busy || uncertain} onClick={() => { setError(null); setPending({ kind: 'disable', model: model.trim() }); }}>Exclude from this account</button>
        {ids.map(id => <div className="verb-row" key={id}><bdi data-i18n-skip>{id}</bdi><button type="button" className="button quiet" disabled={busy || uncertain || !!policy.error} onClick={() => { setError(null); setPending({ kind: 'enable', model: id }); }}>Allow {id}</button></div>)}
      </div>
    </details>
    {uncertain || policy.error ? <button type="button" className="button quiet" onClick={refresh}>Refresh model policy</button> : null}
    <Confirm open={!!pending} busy={busy} refusal={error} title={pending?.kind === 'disable' ? 'Exclude model from this account' : 'Remove account model exclusion'} verb="Apply model policy"
      requires="An operator session. The account and model IDs are shown below."
      changes="Changes this account's exclusion list for subsequent routing selections. Its first edit copies the inherited list into an account-specific policy. Other accounts and in-flight responses are unchanged."
      undo="Apply the opposite action for this model. Removing the final exclusion leaves an explicitly empty account policy; it does not restore provider inheritance."
      onConfirm={apply} onClose={() => { if (!busy) setPending(null); }}>
      <p><bdi data-i18n-skip>{connection.name || connection.id}</bdi> · <bdi data-i18n-skip>{connection.provider}/{pending?.model}</bdi></p>
    </Confirm>
  </section>;
}
