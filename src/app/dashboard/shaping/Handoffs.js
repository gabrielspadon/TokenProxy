'use client';
import { useCallback, useEffect, useState } from 'react';
import { call } from '@/shared/api';
import { Notice } from '@/shared/components/Notice';

const endpoint = '/api/admin/shaping';
const label = row => `${row.projectName} · ${row.clientTool || 'Client'} · ${(row.contextSessionId || row.id).slice(0, 12)} · ${row.requestedModel || 'Model unknown'}`;

export function Handoffs({ enabled }) {
  const [page, setPage] = useState(1), [receiptPage, setReceiptPage] = useState(1);
  const [targets, setTargets] = useState(null), [packets, setPackets] = useState(null);
  const [source, setSource] = useState(null), [target, setTarget] = useState(null);
  const [summary, setSummary] = useState(''), [hours, setHours] = useState(24), [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState(null), [busy, setBusy] = useState(false);
  const readRecords = useCallback(() => Promise.all([
    call(`${endpoint}/handoff-targets?page=${page}&pageSize=10`),
    call(`${endpoint}/handoffs?page=${receiptPage}&pageSize=10`),
  ]), [page, receiptPage]);
  const applyRecords = useCallback(([targetResult, packetResult]) => {
    if (targetResult.ok) setTargets(targetResult.body);
    if (packetResult.ok) setPackets(packetResult.body);
    if (!targetResult.ok || !packetResult.ok) setNotice({ tone: 'warn', title: 'Handoff records unavailable', children: 'Refresh to verify the retained state before making another change.' });
  }, []);
  useEffect(() => { let active = true; void readRecords().then(result => { if (active) applyRecords(result); }); return () => { active = false; }; }, [readRecords, applyRecords]);
  async function refresh() { applyRecords(await readRecords()); }
  async function mutate(path, body) {
    setBusy(true); setNotice(null);
    try {
      const response = await call(`${endpoint}/${path}`, { method: 'POST', body });
      if (!response.ok) { setNotice({ tone: 'warn', title: 'Handoff change refused', children: response.body?.code || 'The change could not be confirmed.' }); return; }
      setNotice(response.status === 207 ? { tone: 'warn', title: 'Persistence unconfirmed', children: response.body.recovery } : { tone: 'ok', title: path === 'handoffs' ? 'Approved handoff retained' : 'Handoff revoked', children: response.body.packet.effect });
      setConsent(false);
      await refresh();
    } finally { setBusy(false); }
  }
  const options = [...(targets?.rows || [])];
  for (const selected of [source, target]) if (selected && !options.some(row => row.id === selected.id)) options.push(selected);
  const sameProject = source && target && source.projectId === target.projectId;
  const bytes = new TextEncoder().encode(summary).length;
  return <section className="shaping-handoffs" aria-labelledby="shaping-handoffs-title">
    <div className="panel-head"><h3 id="shaping-handoffs-title">Approved session handoffs</h3><button className="button quiet" onClick={refresh} disabled={busy}>Refresh handoffs</button></div>
    <p className="caption">Add a reviewed summary to a different observed session in the same project. Original request content stays intact. Requests already in flight, account pins and model selection are unchanged.</p>
    <p className="caption">{enabled ? 'Handoff injection is enabled for eligible new requests.' : 'Handoff injection is off in the current global settings. Retained packets take effect only when the applicable request settings enable handoffs.'} An active packet repeats at a stable position until revoked or expired; removing it may change the cache prefix.</p>
    {notice ? <Notice {...notice} /> : null}
    {!targets?.rows?.length && !source ? <p>No eligible session records yet. <a href="/dashboard/projects">Bind explicit client identities to a project</a> and send a request from each session first.</p> : null}
    <div className="shaping-handoff-controls">
      <label>Source session<select value={source?.id || ''} disabled={busy} onChange={event => { setSource(options.find(row => row.id === event.target.value) || null); setConsent(false); }}><option value="">Select observed source</option>{options.map(row => <option key={row.id} value={row.id}>{label(row)}</option>)}</select></label>
      <label>Target session<select value={target?.id || ''} disabled={busy} onChange={event => { setTarget(options.find(row => row.id === event.target.value) || null); setConsent(false); }}><option value="">Select observed target</option>{options.map(row => <option key={row.id} value={row.id}>{label(row)}</option>)}</select></label>
      <div className="actions"><button className="button quiet" disabled={busy || page === 1} onClick={() => setPage(page - 1)}>Previous sessions</button><span>Page {page} of {targets?.pagination?.pages || 1}</span><button className="button quiet" disabled={busy || page >= (targets?.pagination?.pages || 1)} onClick={() => setPage(page + 1)}>Next sessions</button></div>
      {source && target && !sameProject ? <p role="status">Choose sessions bound to the same project.</p> : null}
      <label className="shaping-handoff-summary">Approved summary<textarea value={summary} maxLength={16384} rows={4} disabled={busy} onChange={event => { setSummary(event.target.value); setConsent(false); }} /></label>
      <span className="caption">{bytes.toLocaleString()} / 16,384 bytes. Retained locally until revocation or the first handoff access after expiry. Metadata and application receipts remain.</span>
      <label>Expires after<select value={hours} disabled={busy} onChange={event => { setHours(Number(event.target.value)); setConsent(false); }}>{[1, 6, 24, 72, 168].map(value => <option key={value} value={value}>{value} {value === 1 ? 'hour' : 'hours'}</option>)}</select></label>
      <label className="shaping-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />I approve retaining this summary and adding it to subsequent requests in the selected target session.</label>
      <button className="button" disabled={busy || !consent || !summary.trim() || bytes > 16384 || !sameProject || source?.id === target?.id} onClick={() => mutate('handoffs', { sourceRequestId: source.id, targetRequestId: target.id, summary, acknowledgeContent: true, expiresAt: new Date(Date.now() + hours * 3600000).toISOString() })}>Approve handoff</button>
    </div>
    <div className="shaping-table-scroll"><table><caption>Retained handoff receipts</caption><thead><tr><th>Source → target request</th><th>State</th><th>Expiry</th><th>Preparations</th><th>Action</th></tr></thead><tbody>{packets?.rows?.map(packet => <tr key={packet.id}><td><code title={packet.sourceRequestId}>{packet.sourceRequestId.slice(0, 8)}</code> → <code title={packet.targetRequestId}>{packet.targetRequestId.slice(0, 8)}</code></td><td>{packet.state}</td><td>{packet.expiresAt.replace('T', ' ').slice(0, 19)} UTC</td><td>{packet.preparations}</td><td>{packet.state === 'active' ? <button className="button quiet" disabled={busy} onClick={() => mutate('revoke-handoff', { id: packet.id, expectedContentHash: packet.contentHash })}>Revoke handoff</button> : 'No future injection'}</td></tr>)}</tbody></table></div>
    {!packets?.rows?.length ? <p className="caption">No retained handoffs. Preparation counts record actual application, including unsuccessful requests, and exclude copied retry preparation.</p> : null}
    <div className="actions"><button className="button quiet" disabled={busy || receiptPage === 1} onClick={() => setReceiptPage(receiptPage - 1)}>Previous handoffs</button><span>Page {receiptPage} of {packets?.pagination?.pages || 1}</span><button className="button quiet" disabled={busy || receiptPage >= (packets?.pagination?.pages || 1)} onClick={() => setReceiptPage(receiptPage + 1)}>Next handoffs</button></div>
  </section>;
}
