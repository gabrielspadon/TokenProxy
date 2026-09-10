'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Group, NativeSelect, NumberInput, Stack, TextInput } from '@mantine/core';
import { useOptionalWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { readJson } from './economicsToolsModel';
import styles from './EconomicsTools.module.css';

const BASE = '/api/admin/projects';
const EMPTY = { name: '', maxPromptTokens: null, maxCompletionTokens: null, maxCostUsd: null, budgetPolicy: 'strict', budgetMode: 'enforce', alertPercent: null, alertCooldownSeconds: 3600, archived: false };
const quantity = value => value == null ? 'Unknown' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
const brief = value => value ? `${value.slice(0, 13)}…${value.slice(-6)}` : 'Unknown';
const policyDraft = project => Object.fromEntries(Object.keys(EMPTY).map(field => [field, project[field]]));
const bindKey = row => `${row.clientRef}/${row.projectRef}`;
const notificationLabel = row => ({ 'authorization-unknown': 'Delivery authorization unavailable', 'not-subscribed': 'No subscribed destination at event time', 'delivery-prepared': 'Delivery prepared; see Notifications for its outcome', 'preparation-retrying': 'Delivery preparation retry pending', 'preparation-pending': 'Delivery preparation pending' })[row.notificationStatus] || 'Delivery preparation unknown';

export default function ProjectBudgets({ onAnalyze }) {
  const workspace = useOptionalWorkspace();
  const [projects, setProjects] = useState({ items: [], nextCursor: null }), [keys, setKeys] = useState([]);
  const [selected, setSelected] = useState(''), [data, setData] = useState(null), [drafts, setDrafts] = useState({});
  const [keyId, setKeyId] = useState(''), [candidates, setCandidates] = useState({ items: [], nextCursor: null }), [candidate, setCandidate] = useState('');
  const [versions, setVersions] = useState(null), [alerts, setAlerts] = useState(null);
  const [pending, setPending] = useState(true), [error, setError] = useState(null), [notice, setNotice] = useState(null), [review, setReview] = useState(null);
  const [readbackUnverified, setReadbackUnverified] = useState(false);
  const generation = useRef(0), reviewPanel = useRef(null);
  const reviewedIdentity = review?.identity || (review?.body?.clientRef ? review.body : null);
  const draft = drafts[selected] || (data?.project.id === selected ? policyDraft(data.project) : EMPTY);
  const change = patch => { setDrafts(previous => ({ ...previous, [selected]: { ...draft, ...patch } })); setReview(null); };
  useEffect(() => { if (review) { reviewPanel.current?.scrollIntoView?.({ block: 'nearest' }); reviewPanel.current?.focus(); } }, [review]);
  useEffect(() => {
    let active = true;
    const requests = generation;
    Promise.all([readJson(`${BASE}?limit=50`), readJson('/api/keys')]).then(([list, result]) => { if (active) { setProjects(list); setKeys(result.keys || []); } }).catch(failure => { if (active) setError(failure.message); }).finally(() => { if (active) setPending(false); });
    return () => { active = false; requests.current++; };
  }, []);
  async function readProject(id = selected, cursor = null) {
    const version = ++generation.current; setPending(true); setError(null); setNotice(null);
    try {
      const next = await readJson(`${BASE}/${encodeURIComponent(id)}?${new URLSearchParams({ limit: '25', ...(cursor ? { before: cursor } : {}) })}`);
      if (next.project.id !== id) throw new Error('Project identity did not match. Read again before changing it.');
      if (version === generation.current) { setData(next); setReview(null); setReadbackUnverified(false); }
    } catch (failure) { if (version === generation.current) setError(failure.message); }
    finally { if (version === generation.current) setPending(false); }
  }
  function choose(id) {
    generation.current++; setSelected(id); setData(null); setReview(null); setVersions(null); setAlerts(null); setCandidate(''); setKeyId(''); setCandidates({ items: [], nextCursor: null }); setError(null); setNotice(null); setReadbackUnverified(false);
    if (id) return readProject(id);
  }
  async function pageList() {
    setPending(true); setError(null);
    try { const next = await readJson(`${BASE}?${new URLSearchParams({ limit: '50', before: projects.nextCursor })}`); setProjects(previous => ({ ...next, items: [...previous.items, ...next.items] })); }
    catch (failure) { setError(failure.message); } finally { setPending(false); }
  }
  async function readCandidates(cursor = null, requestedKey = keyId) {
    const version = ++generation.current; setPending(true); setError(null);
    try {
      const next = await readJson(`${BASE}/candidates?${new URLSearchParams({ apiKeyId: requestedKey, limit: '50', ...(cursor ? { before: cursor } : {}) })}`);
      if (version === generation.current) setCandidates(previous => ({ ...next, items: cursor ? [...previous.items, ...next.items] : next.items }));
    } catch (failure) { if (version === generation.current) setError(failure.message); }
    finally { if (version === generation.current) setPending(false); }
  }
  async function mutate() {
    setPending(true); setError(null); setNotice(null);
    let acknowledged;
    try {
      const result = await readJson(review.url, { method: review.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(review.body) });
      if (!result.project?.id || selected && result.project.id !== selected) throw new Error('The returned project does not match. Refresh before retrying.');
      acknowledged = result;
      const readback = await readJson(`${BASE}/${encodeURIComponent(result.project.id)}?limit=25`);
      if (JSON.stringify(readback.project) !== JSON.stringify(result.project) || JSON.stringify(readback.bindings) !== JSON.stringify(result.bindings)) throw new Error('The change returned, but its separate readback differs. Review current state before retrying.');
      setSelected(result.project.id); setData(readback); setReview(null); setVersions(null); setAlerts(null); setReadbackUnverified(false);
      setDrafts(previous => { const next = { ...previous }; delete next[selected]; delete next[result.project.id]; return next; });
      setProjects(previous => ({ ...previous, items: [...previous.items.filter(row => row.id !== result.project.id), result.project] }));
      setNotice(`Saved and read back ${result.project.name}, revision ${result.project.revision}. Subsequent requests use this configuration.`);
    } catch (failure) {
      setReview(null);
      if (acknowledged) {
        setReadbackUnverified(true);
        setSelected(acknowledged.project.id); setData(acknowledged);
        setProjects(previous => ({ ...previous, items: [...previous.items.filter(row => row.id !== acknowledged.project.id), acknowledged.project] }));
        setError(`Change acknowledged, but persistence readback was not verified. Read current project before another change. ${failure.message}`);
      } else setError(failure.message);
    } finally { setPending(false); }
  }
  function reviewPolicy() {
    setError(null);
    if (readbackUnverified) { setError('Read current project before another change.'); return; }
    if (!draft.name.trim()) { setError('Enter a project name.'); return; }
    setReview({ method: selected ? 'PATCH' : 'POST', url: selected ? `${BASE}/${selected}` : BASE,
      body: { ...draft, ...(selected ? { expectedRevision: data.project.revision } : {}) },
      label: `${selected ? 'Update' : 'Create'} ${draft.name}. Limits apply to this project’s explicitly bound clients and future dispatches. Existing work keeps its reservation. ${draft.archived ? 'Archiving refuses subsequent requests for every binding until restored or unbound.' : ''}` });
  }
  async function readHistory(kind, cursor = null) {
    setPending(true); setError(null);
    try {
      const next = await readJson(`${BASE}/${selected}/${kind}?${new URLSearchParams({ limit: '25', ...(cursor ? { before: cursor } : {}) })}`);
      const setter = kind === 'versions' ? setVersions : setAlerts;
      setter(previous => ({ ...next, items: cursor ? [...previous.items, ...next.items] : next.items }));
    } catch (failure) { setError(failure.message); } finally { setPending(false); }
  }
  const known = (value, unknown) => `${quantity(value)}${unknown ? ` + ${quantity(unknown)} unknown records` : ''}`;
  return <Stack className={styles.tool} gap="sm" component="section" aria-label="Project budgets">
    <div className={styles.toolHeading}><h2>Project budgets</h2><p>Allocate recorded usage to an explicit project and protect its allowance across client keys. Subscription quota and provider invoices remain separate.</p></div>
    <Group align="end"><NativeSelect label="Project" value={selected} onChange={event => choose(event.currentTarget.value)} disabled={pending} data={[{ value: '', label: 'Create a project' }, ...projects.items.map(row => ({ value: row.id, label: `${row.name}${row.archived ? ' · Archived' : ''}` }))]} style={{ flex: 1 }} />
      {projects.nextCursor && <Button size="xs" variant="default" disabled={pending} onClick={pageList}>More projects</Button>}
      {selected && <Button size="xs" variant="default" loading={pending} onClick={() => readProject()}>Read current project</Button>}</Group>
    {error && <Alert color="red" role="alert">{error}</Alert>}{notice && <Alert color="teal" role="status">{notice}</Alert>}
    {(!selected || data) && <>
      {data && <><dl className={styles.facts}><div><dt>Recorded input</dt><dd>{known(data.account?.recordedPromptTokens, data.account?.unknownPromptRows)} tokens</dd></div><div><dt>Recorded output</dt><dd>{known(data.account?.recordedCompletionTokens, data.account?.unknownCompletionRows)} tokens</dd></div><div><dt>Recorded USD basis</dt><dd>{known(data.account?.recordedCostUsd, data.account?.unknownCostRows)}</dd></div><div><dt>Outstanding requests</dt><dd>{quantity(data.outstanding.requests)}</dd></div><div><dt>Held output tokens</dt><dd>{known(data.outstanding.completionTokens, data.outstanding.unknownCompletionRows)}</dd></div><div><dt>Held USD estimate</dt><dd>{known(data.outstanding.costUsd, data.outstanding.unknownCostRows)}</dd></div></dl>
        <Group justify="space-between"><p>Lifetime ledger · read {new Date(data.asOf).toLocaleString('en-US')} · revision {data.project.revision}</p><Button size="xs" variant="light" disabled={pending || !workspace} onClick={() => { workspace.setScope({ projectId: data.project.id }); onAnalyze?.(data.project.id); }}>View contributing records</Button></Group>
        {!data.durableStorage && <Alert color="orange">Project enforcement needs a native SQLite driver. Bound requests are refused on this storage adapter.</Alert>}</>}
      <form onSubmit={event => { event.preventDefault(); reviewPolicy(); }} aria-label="Project budget policy">
        <div className={styles.fields}>
          <TextInput size="xs" label="Project name" maxLength={80} value={draft.name} onChange={event => change({ name: event.currentTarget.value })} disabled={pending} />
          <NativeSelect label="At the ceiling" value={draft.budgetMode} onChange={event => change({ budgetMode: event.currentTarget.value })} disabled={pending} data={[{ value: 'enforce', label: 'Prevent new dispatches' }, { value: 'alert', label: 'Observe and alert only' }]} />
          <NativeSelect label="Unknown request bounds" value={draft.budgetPolicy} onChange={event => change({ budgetPolicy: event.currentTarget.value })} disabled={pending} data={[{ value: 'strict', label: 'Require verified bounds' }, { value: 'reserve-remaining', label: 'Use remaining allowance' }]} />
          {[['maxPromptTokens','Input token ceiling'],['maxCompletionTokens','Output token ceiling'],['maxCostUsd','Recorded USD ceiling'],['alertPercent','Alert at percent'],['alertCooldownSeconds','Alert cooldown seconds']].map(([field, label]) => <NumberInput size="xs" key={field} label={label} description={field === 'alertCooldownSeconds' ? 'Minimum 60 seconds' : 'Blank leaves this unset'} value={draft[field] ?? ''} min={field === 'alertCooldownSeconds' ? 60 : 0} max={field === 'alertPercent' ? 100 : undefined} allowDecimal={['maxCostUsd','alertPercent'].includes(field)} disabled={pending} onChange={value => change({ [field]: value === '' ? null : value })} />)}
        </div>
        <p>{draft.budgetMode === 'alert' ? 'The project observes usage without enforcing its ceiling. Client-key limits still apply.' : draft.budgetPolicy === 'strict' ? 'Strict mode needs verified bounds for every ceiling. Input and USD bounds are unavailable on unsupported wire contracts, so those requests are refused before dispatch.' : 'An unknown-bound request holds the remaining allowance. Its actual usage can exceed it. This is best-effort protection, not a hard billing cap.'}</p>
        {selected && <Checkbox size="xs" mt="sm" label="Archive project and stop new work on its bindings" checked={draft.archived} disabled={pending} onChange={event => change({ archived: event.currentTarget.checked })} />}
        <Group className={styles.formActions}><Button size="xs" type="submit" disabled={pending || readbackUnverified}>Review project policy</Button>{drafts[selected] && <Button size="xs" variant="default" disabled={pending} onClick={() => { setDrafts(previous => { const next = { ...previous }; delete next[selected]; return next; }); setReview(null); }}>Discard project draft</Button>}</Group>
      </form>
      {data && <>
        <section className={styles.review} aria-label="Exact project bindings"><h3>Client bindings</h3><p>{data.project.bindingEffect}</p>
          <div className={styles.scroll}><table><thead><tr><th>Client key</th><th>Client / project fingerprints</th><th>Action</th></tr></thead><tbody>{data.bindings.map(row => <tr key={row.id}><td>{keys.find(key => key.id === row.apiKeyId)?.name || brief(row.apiKeyId)}</td><td title={`${row.clientRef}\n${row.projectRef}`}>{brief(row.clientRef)} / {brief(row.projectRef)}</td><td><Button variant="subtle" size="compact-xs" disabled={pending || readbackUnverified} onClick={() => setReview({ method: 'DELETE', url: `${BASE}/${selected}/bindings/${row.id}`, body: { expectedRevision: data.project.revision }, identity: row, label: `Remove this exact binding from ${data.project.name}. Future matching requests will be refused if this key retains other bindings. Removing its last binding restores ordinary key policy. Existing reservations remain attributed.` })}>Remove binding</Button></td></tr>)}</tbody></table></div>
          {!data.bindings.length && <p>No clients are assigned. Earlier usage will not be reassigned.</p>}
          <div className={styles.fields}><NativeSelect label="Binding client key" value={keyId} disabled={pending || data.project.archived} onChange={event => { const value = event.currentTarget.value; setKeyId(value); setCandidate(''); setCandidates({ items: [], nextCursor: null }); setReview(null); if (value) readCandidates(null, value); }} data={[{ value: '', label: 'Choose a client key' }, ...keys.map(key => ({ value: key.id, label: key.name || key.id }))]} style={{ flex: 1 }} />
            <NativeSelect label="Observed client project" value={candidate} disabled={pending || !keyId} onChange={event => { setCandidate(event.currentTarget.value); setReview(null); }} data={[{ value: '', label: 'Choose recorded identity' }, ...candidates.items.map(row => ({ value: bindKey(row), label: `${brief(row.clientRef)} / ${brief(row.projectRef)}` }))]} style={{ flex: 1 }} />
            {candidates.nextCursor && <Button size="xs" variant="default" disabled={pending} onClick={() => readCandidates(candidates.nextCursor)}>More identities</Button>}
            <Button size="xs" variant="default" style={{ alignSelf: 'end', justifySelf: 'start' }} disabled={pending || readbackUnverified || !candidate || data.project.archived} onClick={() => { const row = candidates.items.find(item => bindKey(item) === candidate); if (row) setReview({ method: 'POST', url: `${BASE}/${selected}/bindings`, body: { expectedRevision: data.project.revision, apiKeyId: keyId, clientRef: row.clientRef, projectRef: row.projectRef }, label: `Bind this authenticated client project to ${data.project.name}. ${data.project.bindingEffect}` }); }}>Review binding</Button></div>
          {keyId && !pending && !candidates.items.length && <p>No retained identity evidence for this key. Configure x-tokenproxy-client-id and x-tokenproxy-project-id in a compatible client. This page never sends a model request.</p>}
        </section>
        <section aria-label="Project spending forecast"><h3>Spending outlook</h3>{data.forecast.available ? <><p>At the recorded hourly mean, the next 24 hours would cost {quantity(data.forecast.forecast24HoursUsd)} USD. Observed hourly range {data.forecast.observedHourlyRangeUsd.map(quantity).join('–')} USD. {data.forecast.hoursToRecordedCostLimit == null ? (data.forecast.recordedCostLimitHorizonReason === 'lifetime-cost-coverage-incomplete' ? 'Lifetime cost coverage is incomplete; no exhaustion horizon is shown.' : 'No positive-rate exhaustion horizon is available.') : `${quantity(data.forecast.hoursToRecordedCostLimit)} hours to the recorded USD ceiling, excluding outstanding exposure.`}</p><p>{data.forecast.assumption} {data.forecast.uncertainty}</p></> : <p>{data.forecast.reason === 'incomplete-cost-coverage' ? 'Some contributing records have unknown cost. No spending forecast is shown.' : 'Forecast available after at least three complete hours and six records with complete cost coverage.'}</p>}<p>{data.forecast.completeHours} complete hours · {data.forecast.knownCostRecords}/{data.forecast.records} cost records · {data.forecast.timeRange.start || 'Unknown start'} to {data.forecast.timeRange.end}. Recorded estimates are not confirmed charges.</p></section>
        <Group><Button size="xs" variant="default" disabled={pending} onClick={() => readHistory('versions')}>Policy history</Button><Button size="xs" variant="default" disabled={pending} onClick={() => readHistory('alerts')}>Budget alerts</Button></Group>
        {versions && <section aria-label="Project policy history"><h3>Policy history</h3><div className={styles.scroll}><table><thead><tr><th>Revision</th><th>Time</th><th>Change</th><th>Policy / mode</th><th>Input / output / USD ceilings</th></tr></thead><tbody>{versions.items.map(row => <tr key={row.revision}><td>{row.revision}</td><td>{row.changedAt}</td><td>{row.change}</td><td>{row.document.project.budgetPolicy} / {row.document.project.budgetMode}</td><td>{['maxPromptTokens','maxCompletionTokens','maxCostUsd'].map(field => row.document.project[field] == null ? 'Unset' : quantity(row.document.project[field])).join(' / ')}</td></tr>)}</tbody></table></div>{versions.nextCursor && <Button size="xs" variant="default" disabled={pending} onClick={() => readHistory('versions', versions.nextCursor)}>Earlier policy versions</Button>}</section>}
        {alerts && <section aria-label="Project budget alert history"><h3>Budget alerts</h3>{!alerts.items.length && <p>No retained project threshold events.</p>}{alerts.items.map(row => <div key={row.id}><p>{row.firedAt} · policy {row.policyRevision} · {row.evidence.dimensions.map(item => `${item.dimension} ${quantity(item.used)} / ${quantity(item.limit)} (${quantity(item.percentage)}%)`).join('; ')} · through usage record {row.evidence.historyThroughId}</p><p>{notificationLabel(row)} · {quantity(row.notificationAttempts)} preparation attempts{row.notificationErrorCode ? ` · ${row.notificationErrorCode}` : ''}</p></div>)}{alerts.nextCursor && <Button size="xs" variant="default" disabled={pending} onClick={() => readHistory('alerts', alerts.nextCursor)}>More alerts</Button>}</section>}
        <section aria-label="Project dispatch accounting"><h3>Dispatch accounting</h3><p>Each row is one physical attempt. Uncertain exposure remains reserved until its outcome is reconciled in Budget reservations.</p><div className={styles.scroll}><table><thead><tr><th>Request</th><th>State</th><th>Policy revision</th><th>Reserved output</th><th>Recorded output</th><th>Usage record</th></tr></thead><tbody>{data.reservations.map(row => <tr key={row.requestId}><td className={styles.id}>{row.requestId}</td><td>{row.state}</td><td>{row.projectPolicyRevision}</td><td>{quantity(row.projectReservedCompletionTokens)}</td><td>{quantity(row.actualCompletionTokens)}</td><td>{row.usageRowId ?? 'Pending or unavailable'}</td></tr>)}</tbody></table></div>{data.nextCursor && <Button size="xs" variant="default" disabled={pending} onClick={() => readProject(selected, data.nextCursor)}>More dispatches</Button>}</section>
      </>}
      {review && <Stack className={styles.review} gap="sm" role="region" aria-label="Review project change" ref={reviewPanel} tabIndex={-1}><p>{review.label}</p>{reviewedIdentity && <dl className={styles.facts}><div><dt>Exact client key</dt><dd className={styles.id}>{reviewedIdentity.apiKeyId}</dd></div><div><dt>Client fingerprint</dt><dd className={styles.id}>{reviewedIdentity.clientRef}</dd></div><div><dt>Project fingerprint</dt><dd className={styles.id}>{reviewedIdentity.projectRef}</dd></div></dl>}<Group><Button size="xs" loading={pending} onClick={mutate}>Confirm project change</Button><Button size="xs" variant="default" disabled={pending} onClick={() => setReview(null)}>Cancel change</Button></Group></Stack>}
    </>}
  </Stack>;
}
