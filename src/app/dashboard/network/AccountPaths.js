'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import { useOptionalWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { accountPath } from './accountPath';
import { call } from '@/shared/api';
import { Confirm } from '@/shared/components/Confirm';
import { Notice } from '@/shared/components/Notice';
import { refusal } from '@/shared/refusal';

export function AccountPaths({ connections, pools, onSaved }) {
  const workspace = useOptionalWorkspace();
  const [localSelectedId, setLocalSelectedId] = useState(null);
  const selectedId = workspace ? workspace.selectedRecord?.kind === 'account' ? workspace.selectedRecord.id : null : localSelectedId;
  const select = (id) => {
    const connection = connections.find(account => account.id === id);
    if (workspace) workspace.setSelectedRecord(id ? { kind: 'account', id, connectionId: id, ...(connection?.provider ? { provider: connection.provider } : {}) } : null);
    else setLocalSelectedId(id);
  };
  const selected = connections.find(connection => connection.id === selectedId);
  const path = selected ? accountPath(selected, pools) : null;
  return <section className="network-paths" aria-labelledby="network-paths-title">
    <h2 id="network-paths-title">Account paths</h2>
    <p className="caption">Stored account → proxy pool → provider policy. Opening this comparison does not test a route or change eligibility.</p>
    <SelectionDock open={Boolean(selected)} title={selected?.name || selected?.id || 'Account path'} subtitle={selected?.id} mark={selected ? <ProviderMark provider={selected.provider} /> : null} onClose={() => select(null)} height="min(620px, calc(100dvh - 240px))" closedMaxHeight="420px" detail={selected ? <div aria-label="Network path inspector" className="network-path-inspector">
      <dl className="facts"><dt>Provider</dt><dd><bdi>{selected.provider}</bdi></dd><dt>Account path</dt><dd><bdi>{path.label}</bdi></dd><dt>Failure policy</dt><dd>{path.policy}</dd><dt>Reachability</dt><dd>Not established by this configuration read.</dd><dt>Upstream model access</dt><dd>Unknown until supported evidence is recorded.</dd></dl>
      <AccountPathBinding key={selected.id} connection={selected} pools={pools} onSaved={onSaved} />
      <Link href={`/dashboard/connections/${encodeURIComponent(selected.id)}`} prefetch={false}>Account policy and credentials</Link>
    </div> : null}>
      <div className="network-path-list">
        {connections.map(connection => {
          const policy = accountPath(connection, pools);
          return <button type="button" className="network-path-row" key={connection.id} aria-pressed={selectedId === connection.id} onClick={() => select(connection.id)}>
            <span className="connection-name"><ProviderMark provider={connection.provider} />{connection.name || connection.id}</span>
            <span>{policy.label}</span><span>{connection.isActive === false ? 'Account disabled' : 'Account enabled'}</span>
          </button>;
        })}
        {!connections.length ? <p className="empty">No credentialed accounts are configured. Provider strategies below also cover virtual accounts without credentials.</p> : null}
      </div>
    </SelectionDock>
  </section>;
}

export function accountBindingBody(mode, proxyUrl, noProxy) {
  if (mode === '__legacy__') return { connectionProxyEnabled: true, connectionProxyUrl: proxyUrl, connectionNoProxy: noProxy || '' };
  return { proxyPoolId: mode === '__clear__' ? null : mode || '__none__' };
}

export function AccountPathBinding({ connection, pools, onSaved }) {
  const data = connection.providerSpecificData || {};
  const [mode, setMode] = useState(data.proxyPoolId || (data.connectionProxyMode === 'direct' ? '__none__' : data.connectionProxyMode === 'proxy' || data.connectionProxyEnabled ? '__legacy__' : '__clear__'));
  const [proxyUrl, setProxyUrl] = useState('');
  const [noProxy, setNoProxy] = useState(data.connectionNoProxy || '');
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    const clear = () => { if (document.hidden) { setProxyUrl(''); setReview(null); } };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);
  async function save() {
    setBusy(true); setNotice(null);
    const response = await call(`/api/providers/${encodeURIComponent(connection.id)}`, { method: 'PUT', body: review });
    setProxyUrl('');
    if (!response.ok) {
      setBusy(false);
      if (!response.status) { setUncertain(true); setReview(null); setNotice({ tone: 'warn', title: 'The account path outcome is unknown.', next: 'Refresh this account before another change. Do not repeat the interrupted write.' }); }
      else setNotice(refusal(response.status, response.body));
      return;
    }
    const read = await call(`/api/providers/${encodeURIComponent(connection.id)}`);
    const saved = read.body?.connection;
    const expected = response.body?.connection;
    const fields = ['proxyPoolId', 'strictProxy', 'connectionProxyMode', 'connectionProxyEnabled', 'connectionNoProxy'];
    const matches = read.ok && saved?.id === connection.id && saved.provider === connection.provider && expected?.id === connection.id
      && fields.every(field => (saved.providerSpecificData?.[field] ?? null) === (expected.providerSpecificData?.[field] ?? null));
    setBusy(false); setReview(null); setUncertain(!matches); onSaved?.();
    setNotice(matches ? { tone: 'ok', title: 'Account path saved and read back.', next: 'The saved path applies to subsequent routing. Reachability and provider authentication remain untested.' }
      : { tone: 'warn', title: 'Accepted, but the saved account path was not confirmed.', next: 'Refresh the account before another change. Do not repeat the mutation.' });
  }
  return <section aria-label="Account path binding"><h3>Change account path</h3>
    {notice ? <Notice {...notice} /> : null}
    <form onSubmit={event => { event.preventDefault(); setNotice(null); setReview(accountBindingBody(mode, proxyUrl, noProxy)); }}><fieldset disabled={busy || uncertain || Boolean(review)}>
      <label className="field"><span>Account path</span><select className="select" value={mode} onChange={event => setMode(event.currentTarget.value)}>
        <option value="__none__">Explicit direct connection</option><option value="__clear__">Clear pool; restore retained account/global path</option><option value="__legacy__">Custom proxy for this account</option>
        {pools.filter(pool => pool.isActive === true).map(pool => <option value={pool.id} key={pool.id}>{pool.name}{pool.strictProxy ? ' · Strict' : ' · Direct fallback allowed'}</option>)}
      </select></label>
      <p className="caption">A pool takes precedence over retained account proxy settings and supplies its strictness. Clearing a pool restores those settings. Explicit direct bypasses account, global and environment proxies.</p>
      {mode === '__legacy__' ? <><label className="field"><span>Account proxy URL</span><input className="input" type="password" autoComplete="off" required value={proxyUrl} onChange={event => setProxyUrl(event.target.value)} /></label><label className="field"><span>Bypass hosts</span><input className="input" value={noProxy} onChange={event => setNoProxy(event.target.value)} /></label></> : null}
      <button type="submit" className="button">Review account path</button>
    </fieldset></form>
    <Confirm open={Boolean(review)} busy={busy} refusal={notice} title="Change account path" verb="Apply account path" requires="An operator session and an active pool when selecting a pool."
      changes={mode === '__none__' ? 'Subsequent requests use an explicit direct connection.' : mode === '__clear__' ? 'The pool binding is cleared and the retained account/global path applies.' : mode === '__legacy__' ? 'Subsequent requests use the supplied account proxy.' : 'Subsequent requests use the selected pool and its strictness. A strict binding refuses direct fallback.'}
      undo="Choose another path. This does not move existing responses or test connectivity." onConfirm={save} onClose={() => { if (!busy) { setReview(null); setProxyUrl(''); } }}>
      <p>{connection.name || connection.id}</p>
    </Confirm>
  </section>;
}
