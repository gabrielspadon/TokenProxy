'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, NativeSelect, TextInput } from '@mantine/core';
import Link from 'next/link';
import { Confirm } from '@/shared/components/Confirm';
import { Notice } from '@/shared/components/Notice';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { overrideCandidates, parseWindow, resolveWindowOverride } from './contextModel';
import { BulkOverrides } from './BulkOverrides';
import './styles.css';

const ENDPOINT = '/api/model-context';
const PAGE_SIZE = 20;
const tokens = value => Number.isFinite(value) && value > 0 ? value.toLocaleString('en-US') : 'Unknown';
const identity = row => `${row.provider}/${row.model}`;

function ExactKey({ children }) {
  return <code className="model-context-key" dir="ltr"><bdi dir="ltr">{children}</bdi></code>;
}

function TokenValue({ value }) {
  return Number.isFinite(value) && value > 0 ? <bdi className="model-context-number" dir="ltr">{tokens(value)}</bdi> : <>Unknown</>;
}

export default function ModelContextPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [view, setView] = useState('models');
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState(null);
  const [editKey, setEditKey] = useState('');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const [notice, setNotice] = useState(null);
  const controller = useRef(null);

  const read = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    try {
      const response = await fetch(ENDPOINT, { cache: 'no-store', signal: next.signal });
      const body = await response.json();
      if (!response.ok) return { error: refusal(response.status, body) };
      if (!Array.isArray(body.models) || !body.overrides || typeof body.overrides !== 'object' || Array.isArray(body.overrides)) {
        return { error: { tone: 'bad', title: 'Context configuration could not be read.', detail: 'The response did not contain a model list and override map.' } };
      }
      return next.signal.aborted ? null : { data: body };
    } catch (cause) {
      return next.signal.aborted ? null : { error: { tone: 'bad', title: 'Context configuration could not be read.', detail: cause.message } };
    }
  }, []);

  const receive = useCallback(result => {
    if (!result) return;
    if (result.data) setData(result.data);
    setError(result.error || null);
    setLoading(false);
  }, []);

  useEffect(() => {
    read().then(receive).catch(cause => receive({ error: { tone: 'bad', title: 'Context configuration could not be read.', detail: cause.message } }));
    return () => controller.current?.abort();
  }, [read, receive]);

  const overrides = data?.overrides || {};
  const model = selection?.kind === 'model' ? data?.models.find(row => identity(row) === selection.key) : null;
  const source = model ? resolveWindowOverride(overrides, model.provider, model.model) : null;
  const candidates = model ? overrideCandidates(model.provider, model.model) : [];
  const options = [...new Map(candidates.map(candidate => [candidate.key, candidate])).values()];
  const savedKeys = Object.keys(overrides);
  const needle = query.trim().toLowerCase();
  const rows = view === 'models'
    ? (data?.models || []).filter(row => `${row.providerName} ${identity(row)} ${row.name}`.toLowerCase().includes(needle))
    : savedKeys.filter(key => key.toLowerCase().includes(needle));
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const value = parseWindow(draft);
  const saved = Object.hasOwn(overrides, editKey);
  const selectedExists = selection?.kind === 'model' ? Boolean(model) : Boolean(selection && Object.hasOwn(overrides, selection.key));
  const canEdit = Boolean(data && !error && !loading && selectedExists && !busy);

  function select(kind, key, row) {
    setSelection({ kind, key });
    setEditKey(key);
    setDraft(String(overrides[key] ?? row?.contextWindow ?? ''));
    setNotice(null);
  }

  function review(remove = false) {
    setFailed(null);
    setPending({ key: editKey, remove, value, previous: overrides[editKey], existed: saved });
  }

  async function apply() {
    if (busy || !pending) return;
    setBusy(true);
    setFailed(null);
    const action = pending;
    const result = await call(action.remove ? `${ENDPOINT}?key=${encodeURIComponent(action.key)}` : ENDPOINT, action.remove
      ? { method: 'DELETE' }
      : { method: 'PUT', body: { key: action.key, contextWindow: action.value } });
    if (!result.ok || result.body?.success !== true) {
      setFailed(result.ok ? { tone: 'bad', title: 'The gateway did not confirm this change.' } : refusal(result.status, result.body));
      setBusy(false);
      return;
    }
    setLoading(true);
    const readback = await read();
    receive(readback);
    const fresh = readback?.data;
    const verified = fresh && (action.remove ? !Object.hasOwn(fresh.overrides, action.key) : fresh.overrides[action.key] === action.value);
    setPending(null);
    setNotice(verified
      ? { tone: 'info', title: `${action.remove ? 'Override removed' : 'Override saved'} and verified after refresh.`, detail: action.key }
      : { tone: 'warn', title: 'The request succeeded, but readback did not verify the change.', next: 'Refresh configuration before making another change.', detail: action.key });
    if (fresh && !verified) setError({ tone: 'warn', title: 'Configuration differs from the requested change. Refresh before editing.' });
    setBusy(false);
  }

  const inspector = <div className="model-context-inspector" id="model-context-inspector">
    {notice ? <Notice {...notice} detail={undefined}><p className="caption"><ExactKey>{notice.detail}</ExactKey></p></Notice> : null}
    {!selectedExists ? <p>The selected record is no longer in the returned configuration.</p> : <>
      <div className="model-context-facts">
        <dl><dt>Catalog window</dt><dd>{model ? <><TokenValue value={model.staticContextWindow} /> tokens</> : 'Not a catalog model'}</dd></dl>
        <dl><dt>Effective window</dt><dd>{model ? <><TokenValue value={model.contextWindow} /> tokens</> : 'Depends on matching models'}</dd></dl>
        <dl><dt>Winning override key</dt><dd>{model ? source ? <ExactKey>{source.key}</ExactKey> : 'None' : <ExactKey>{selection.key}</ExactKey>}</dd></dl>
        <dl><dt>Source</dt><dd>{model ? source?.scope || 'Registered or capability default' : selection.key.includes('*') ? 'Saved wildcard rule' : 'Saved exact key'}</dd></dl>
      </div>
      <div className="model-context-edit">
        {model ? <NativeSelect label="Override scope and saved key" dir="ltr" attributes={{ input: { dir: 'ltr' } }} data-context-key-scope value={editKey} onChange={event => { setEditKey(event.currentTarget.value); setDraft(String(overrides[event.currentTarget.value] ?? model.contextWindow ?? '')); }} data={options.map(option => ({ value: option.key, label: `${option.scope} · \u2066${option.key}\u2069` }))} disabled={!canEdit} /> : <p>Exact saved key <ExactKey>{editKey}</ExactKey></p>}
        <TextInput label="Context window in tokens" description="Positive whole tokens. Unknown limits stay blank." dir="ltr" attributes={{ input: { dir: 'ltr' } }} data-context-token-input inputMode="numeric" value={draft} onChange={event => setDraft(event.currentTarget.value)} error={value === null ? 'Enter a positive whole number of tokens.' : null} disabled={!canEdit} />
        <div className="model-context-buttons"><Button disabled={!canEdit || value === null || (saved && overrides[editKey] === value)} onClick={() => review()}>Review override</Button><Button variant="light" color="red" disabled={!canEdit || !saved} onClick={() => review(true)}>Remove this override</Button></div>
      </div>
      <p className="model-context-caution">Provider-scoped keys affect that provider identity. Bare keys and wildcard rules can affect multiple providers. Overrides do not establish provider entitlement or capacity, and cannot by themselves force a client’s auto-compaction threshold to 100%.</p>
      <details><summary>Matching precedence and scope</summary><ol>{candidates.length ? candidates.map((candidate, index) => <li key={`${candidate.key}-${index}`}>{candidate.scope} <ExactKey>{candidate.key}</ExactKey>{Object.hasOwn(overrides, candidate.key) ? <> · <TokenValue value={overrides[candidate.key]} /> tokens saved</> : ' · not saved'}</li>) : <li>Provider / raw model, provider / basename, basename, then raw model exact keys.</li>}<li>Wildcard keys follow exact keys. The first matching saved wildcard wins, case-insensitively, in saved map order.</li></ol><p>Saving replaces this exact key and reloads the gateway override map. Removing it exposes the next matching rule or registered default. Requests already being processed may retain earlier values.</p></details>
    </>}
  </div>;

  return <div className="model-context-page">
    <header className="model-context-heading"><div><Link href="/dashboard/shaping">Optimization</Link><h1>Context windows</h1><p>Inspect registered limits and the local overrides used by the gateway.</p></div><Button variant="default" disabled={busy || loading} onClick={() => { setNotice(null); setLoading(true); read().then(receive).catch(cause => receive({ error: { tone: 'bad', title: 'Context configuration could not be read.', detail: cause.message } })); }}>Refresh configuration</Button></header>
    <p className="model-context-caution">Configuration is global to this gateway, independent of analytical time and account filters. Catalog visibility and configured connections are not evidence of model access.</p>
    {error ? <Notice {...error} /> : null}
    {loading ? <p role="status">Reading context configuration…</p> : null}
    <BulkOverrides overrides={overrides} disabled={!data || loading || busy || !!error} onReadback={fresh => receive({ data: fresh })} />
    <div className="model-context-tools"><TextInput type="search" label="Find a model or saved key" placeholder="Provider, model identity or wildcard" value={query} onChange={event => { setQuery(event.currentTarget.value); setPage(0); }} /><NativeSelect label="Inventory" value={view} onChange={event => { setView(event.currentTarget.value); setPage(0); }} data={[{ value: 'models', label: 'Registered models' }, { value: 'overrides', label: 'Saved override keys' }]} /><span>{data ? <><bdi dir="ltr">{rows.length.toLocaleString('en-US')}</bdi> {view === 'models' ? 'models' : 'saved keys'}</> : 'Inventory unknown'}</span></div>
    <div className="model-context-dock"><SelectionDock open={Boolean(selection)} title={model ? <bdi dir="auto">{model.name || model.model}</bdi> : selection ? <bdi dir="ltr">{selection.key}</bdi> : 'Context override'} subtitle={model ? <ExactKey>{identity(model)}</ExactKey> : 'Saved configuration key'} mark={model ? <ProviderMark provider={model.provider} /> : null} onClose={() => { setSelection(null); setNotice(null); }} detail={inspector} height="100%">
      <div className="model-context-inventory">
        <div className="model-context-table-scroll" role="region" aria-label="Context-window inventory, scroll horizontally for all columns" tabIndex={0}><table><caption>{view === 'models' ? 'Registered and effective context windows, in tokens' : 'Persisted overrides in matching order, including rules without a catalog model'}</caption><thead><tr>{view === 'models' ? <><th>Configured identity</th><th>Catalog tokens</th><th>Effective tokens</th><th>Override source</th></> : <><th>Exact saved key</th><th>Tokens</th><th>Scope</th></>}</tr></thead><tbody>{visible.map(row => {
          if (view === 'overrides') return <tr key={row} data-selected={selection?.kind === 'override' && selection.key === row || undefined}><th><button type="button" aria-controls={selection ? "model-context-inspector" : undefined} aria-current={selection?.kind === 'override' && selection.key === row || undefined} onClick={() => select('override', row)}><ExactKey>{row}</ExactKey></button></th><td><TokenValue value={overrides[row]} /></td><td>{row.includes('*') ? 'Wildcard rule' : 'Exact key'}</td></tr>;
          const key = identity(row);
          const winner = resolveWindowOverride(overrides, row.provider, row.model);
          return <tr key={key} data-selected={selection?.kind === 'model' && selection.key === key || undefined}><th><button type="button" aria-controls={selection ? "model-context-inspector" : undefined} aria-current={selection?.kind === 'model' && selection.key === key || undefined} onClick={() => select('model', key, row)}><ProviderMark provider={row.provider} /><span><bdi dir="auto">{row.name || row.model}</bdi><ExactKey>{key}</ExactKey><small><bdi dir="auto">{row.providerName || row.provider}</bdi> · {Number.isFinite(row.providerConnections) ? <><bdi dir="ltr">{row.providerConnections}</bdi> configured connections</> : 'Connections unknown'}</small></span></button></th><td><TokenValue value={row.staticContextWindow} /></td><td><TokenValue value={row.contextWindow} /></td><td>{winner ? <ExactKey>{winner.key}</ExactKey> : 'No context override'}</td></tr>;
        })}</tbody></table>{data && !rows.length ? <p>No matching {view === 'models' ? 'models' : 'saved keys'}. Clear the search to inspect the full inventory.</p> : null}</div>
        <nav className="model-context-pagination" aria-label="Context inventory pages"><Button variant="default" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</Button><span>Page <bdi dir="ltr">{currentPage + 1}</bdi> of <bdi dir="ltr">{pageCount}</bdi> · <bdi dir="ltr">{PAGE_SIZE}</bdi> rows per page</span><Button variant="default" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next</Button></nav>
      </div>
    </SelectionDock></div>
    <Confirm open={Boolean(pending)} title={pending?.remove ? 'Remove context override' : 'Save context override'} verb={pending?.remove ? 'Remove override' : 'Save override'} requires="Permission to edit the gateway configuration." changes={<>{pending?.remove ? 'Remove' : <>Set <TokenValue value={pending?.value} /> tokens for</>} <ExactKey>{pending?.key}</ExactKey>. The gateway reloads its override map after saving. This does not change provider limits or client compaction policy.</>} undo={pending?.existed ? <>Restore the exact key <ExactKey>{pending.key}</ExactKey> to <TokenValue value={pending.previous} /> tokens.</> : 'Remove this exact override to restore the next matching rule or default.'} busy={busy} refusal={failed} onConfirm={apply} onClose={() => { if (!busy) { setPending(null); setFailed(null); } }} />
  </div>;
}
