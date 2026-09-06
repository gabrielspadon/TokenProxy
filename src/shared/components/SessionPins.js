'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '@/shared/api';

const ROOT = '/api/admin/session-pins';
const date = value => value ? new Date(value).toLocaleString() : 'No deadline recorded';

export default function SessionPins({ onChanged } = {}) {
  const [page, setPage] = useState(null), [selected, setSelected] = useState(null);
  const [action, setAction] = useState('clear'), [target, setTarget] = useState(''), [deadline, setDeadline] = useState('');
  const [preview, setPreview] = useState(null), [receipt, setReceipt] = useState(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(true), [history, setHistory] = useState([]);
  const generation = useRef(0);
  const refresh = useCallback(async (cursor = '') => {
    const seq = ++generation.current;
    setBusy(true); setPreview(null); setError('');
    const response = await call(`${ROOT}${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`);
    if (seq !== generation.current) return;
    if (response.ok) { setPage({ ...response.body, currentCursor: cursor }); setSelected(null); }
    else setError(response.body?.code || 'Pins could not be read');
    setBusy(false);
  }, []);
  useEffect(() => {
    let active = true;
    const seq = ++generation.current;
    void call(ROOT).then(response => {
      if (!active || seq !== generation.current) return;
      if (response.ok) setPage({ ...response.body, currentCursor: '' });
      else setError(response.body?.code || 'Pins could not be read');
      setBusy(false);
    });
    return () => { active = false; };
  }, []);
  function edit(update) { setPreview(null); setError(''); update(); }
  async function inspect(event) {
    event.preventDefault(); if (!selected) return;
    if (action === 'expire' && !Number.isFinite(Date.parse(deadline))) { setError('Choose a valid expiry'); return; }
    const seq = ++generation.current;
    setBusy(true); setError(''); setPreview(null);
    const response = await call(`${ROOT}/preview`, { method: 'POST', body: {
      id: crypto.randomUUID(), pinId: selected.id, expectedRevision: selected.revision, action,
      ...(action === 'reassign' ? { targetConnectionId: target } : {}),
      ...(action === 'expire' ? { deadline: new Date(deadline).toISOString() } : {}),
    } });
    if (seq !== generation.current) return;
    if (response.ok) setPreview(response.body); else setError(response.body?.code || 'Preview was refused');
    setBusy(false);
  }
  async function apply() {
    if (!preview) return;
    const seq = ++generation.current;
    setBusy(true); setError('');
    const response = await call(`${ROOT}/apply`, { method: 'POST', body: { id: preview.id, expectedRevision: preview.expectedRevision } });
    if (seq !== generation.current) return;
    setPreview(null);
    if (response.body?.id) setReceipt(response.body);
    if (!response.ok) setError(response.body?.reason || response.body?.code || 'Change was refused');
    else { onChanged?.(response.body); await refresh(); }
    setBusy(false);
  }
  async function readReceipt(id) {
    const seq = ++generation.current;
    setBusy(true); const response = await call(`${ROOT}/actions/${id}`);
    if (seq !== generation.current) return;
    if (response.ok) setReceipt(response.body); else setError(response.body?.code || 'Receipt could not be read');
    setBusy(false);
  }
  return <section className="panel" aria-labelledby="session-pins-title">
    <div className="row spread"><h2 id="session-pins-title">Account pins</h2>
      <button type="button" className="button quiet" disabled={busy} onClick={() => { setHistory([]); void refresh(); }}>Refresh pins</button></div>
    <p className="caption">A pin keeps one routing identity and physical model on an account. These controls apply to later requests. Work already admitted stays on its current account.</p>
    {error ? <p role="alert">{error.replaceAll('_', ' ')}. Refresh and preview again before applying.</p> : null}
    {page ? <p className="caption">Observed {date(page.observedAt)}. Latest 8 requests, switches and control receipts per pin. Opaque pin identifiers are linkable routing hashes, not raw client identities.</p> : <p role="status">Reading pins…</p>}
    {page?.pins.length === 0 ? <p>No retained pins in this page.</p> : null}
    <div className="rows">
      {page?.pins.map(pin => <div key={pin.id} className="panel">
        <button type="button" className="button quiet" disabled={busy} aria-pressed={selected?.id === pin.id}
          onClick={() => edit(() => { setSelected(pin); setTarget(''); })}>Inspect {pin.model} · {pin.connectionId.slice(0, 8)}</button>
        <p>{pin.state === 'active' ? 'Active binding' : 'Expired binding'} · {pin.provider || 'Provider not retained'} · expires {date(pin.expiresAt)}</p>
        <p className="caption">{pin.session ? `Session ${pin.session.id} · ${pin.session.identitySource} routing identity · exact stored join` : 'No exact retained session join'} · pinned {date(pin.pinnedAt)} · last seen {date(pin.lastSeenAt)}</p>
      </div>)}
    </div>
    <div className="row">
      {history.length ? <button type="button" className="button quiet" disabled={busy} onClick={() => {
        const previous = history.at(-1); setHistory(history.slice(0, -1)); void refresh(previous);
      }}>Previous pins</button> : null}
      {page?.next ? <button type="button" className="button quiet" disabled={busy} onClick={() => { setHistory([...history, history.length ? page.currentCursor || '' : '']); void refresh(page.next); }}>More pins</button> : null}
    </div>
    {selected ? <div>
      <h3>Selected binding</h3><p>{selected.model} · account {selected.connectionId}</p>
      <p className="caption">Operator deadline {selected.operatorExpiresAt ? date(selected.operatorExpiresAt) : 'not set'}. Normal activity extends idle expiry by 24 hours, capped by an operator deadline.</p>
      {selected.requests.length ? <ul>{selected.requests.map(r => <li key={r.id}>Requested {r.requestedModel || 'not recorded'} · served {r.servedModel || 'not confirmed'} · {r.status} · request {r.id}</li>)}</ul> : <p>No exact retained requests for this binding identity and model.</p>}
      {selected.switches.length ? <ul>{selected.switches.map(s => <li key={s.id}>{date(s.switchedAt)} · {s.fromConnectionId || 'First binding'} → {s.toConnectionId} · {s.trigger}</li>)}</ul> : null}
      {selected.actions.length ? <ul>{selected.actions.map(a => <li key={a.id}><button type="button" className="button quiet" disabled={busy} onClick={() => readReceipt(a.id)}>Receipt {a.id.slice(0, 8)} · {a.action} · {a.status}</button></li>)}</ul> : null}
      <form onSubmit={inspect} className="sessions-filters">
        <label className="field"><span>Change</span><select className="input" disabled={busy} value={action} onChange={e => edit(() => setAction(e.target.value))}>
          <option value="clear">Clear affinity</option><option value="expire">Set expiry deadline</option><option value="reassign">Reassign on a later request</option></select></label>
        {action === 'reassign' ? <label className="field"><span>Target account</span><select className="input" required value={target} disabled={busy} onChange={e => edit(() => setTarget(e.target.value))}>
          <option value="">Choose an account</option>{selected.targets.filter(t => t.id !== selected.connectionId).map(t => <option key={t.id} value={t.id}>{t.name || t.id} · {t.enabled ? 'Enabled' : 'Disabled'}</option>)}</select></label> : null}
        {action === 'expire' ? <label className="field"><span>Expiry in your local time</span><input className="input" required type="datetime-local" value={deadline} disabled={busy} onChange={e => edit(() => setDeadline(e.target.value))} /></label> : null}
        <button type="submit" className="button" disabled={busy}>Preview change</button>
      </form>
    </div> : null}
    {preview ? <div role="region" aria-label="Pin change preview" className="panel">
      <h3>Preview before applying</h3><p>{preview.preview.consequence}</p>
      <p>One pin affected. Model remains {preview.model}. Upstream readiness remains unknown.</p>
      {preview.preview.localTarget ? <p>Captured account decision {preview.preview.localTarget.status} · {preview.preview.localTarget.reason}</p> : null}
      {preview.preview.conflicts?.length ? <ul>{preview.preview.conflicts.map((c, i) => <li key={i}>{c.reason}</li>)}</ul> : null}
      {preview.preview.unknownEvidence?.length ? <p className="caption">Not verified here · {preview.preview.unknownEvidence.join(', ')}</p> : null}
      <p className="caption">Preview valid until {date(preview.previewExpiresAt)}. Pending reassignment waits if its account is unavailable or a request explicitly names a different account. Clear affinity cancels a pending reassignment.</p>
      <button type="button" className="button" disabled={busy} onClick={apply}>Apply this change</button>
    </div> : null}
    {receipt ? <div role="status" className="panel"><p>Control receipt {receipt.id} · {receipt.status} · {receipt.reason}</p>
      <p>{receipt.status === 'queued' ? 'Waiting for a subsequent request. No request has been moved.' : 'This receipt describes affinity control, not provider acceptance or a billing result.'}</p>
      <button type="button" className="button quiet" disabled={busy} onClick={() => readReceipt(receipt.id)}>Refresh receipt</button></div> : null}
  </section>;
}
