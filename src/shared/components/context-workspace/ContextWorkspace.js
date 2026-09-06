'use client';
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Group, Loader, Select, TextInput, UnstyledButton } from '@mantine/core';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { useResource } from '@/shared/workspace/useResource';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import { ActivityBand } from '@/shared/workspace/ActivityBand';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import shared from '@/shared/workspace/workspace.module.css';
import { ContextInspector } from './ContextInspector';
import { ContextClientEvents } from '@/shared/workspace/ContextEvidence';
import { ContextTracks } from './ContextTracks';
import { ContextTable } from './ContextTable';
import { IDENTITY, IDENTITY_NOTE, contextUrl, finite, quantity, signedBytes, utc } from './contextModel';
import styles from './context.module.css';

const EMPTY = [];
function ReadState({ resource, children, empty }) {
  if (resource.loading && !resource.data) return <div className={styles.readState} role="status"><Loader size="sm" />Reading recorded context…</div>;
  if (!resource.data && resource.error) return <div className={styles.readState}><Alert color="red" title="Context unavailable">{resource.error}</Alert><Button variant="default" onClick={resource.refresh}>Try again</Button></div>;
  return <>{resource.error && <Alert color="orange" title="Showing the last successful read">{resource.error}<Button variant="subtle" onClick={resource.refresh}>Try again</Button></Alert>}{resource.data ? children : empty}</>;
}
export function RecordingCoverage({ recording }) {
  const segments = [['attributedAttempts', 'With context evidence', '#6f83cd'], ['unattributedAttempts', 'Unattributed', '#c8d0dd'], ['rejectedAttempts', 'Telemetry rejected', '#bd6370']];
  const total = recording?.totalRetainedAttempts;
  const complete = finite(total) && total > 0 && segments.every(([key]) => finite(recording?.[key]))
    && segments.reduce((sum, [key]) => sum + recording[key], 0) === total;
  return <section className={styles.coverage} aria-label="Context recording coverage">
    <div className={styles.coverageIntro}><h2>Recording coverage</h2><span>{recording?.scope || 'Filtered retained attempts'}</span></div>
    <div className={styles.coverageTotal}><strong>{quantity(total)}</strong><span>Retained attempts</span></div>
    {segments.map(([key, label, color]) => <div className={styles.coverageMetric} key={key}><strong>{quantity(recording?.[key])}</strong><span><i style={{ background: color }} />{label}</span></div>)}
    <div className={styles.coverageBar} aria-hidden="true">{complete && segments.map(([key, , color]) => <span key={key} style={{ width: `${recording[key] / total * 100}%`, background: color }} />)}</div>
  </section>;
}
function Pager({ pagination, onPage, label }) {
  return <nav className={styles.pager} aria-label={`${label} pagination`}><span>{quantity(pagination?.totalItems)} {label.toLowerCase()} · page {quantity(pagination?.page)} of {quantity(pagination?.totalPages)}</span><Group gap={4}><Button variant="default" size="compact-xs" aria-label={`Previous ${label.toLowerCase()} page`} disabled={!pagination?.hasPrev} onClick={() => onPage(pagination.page - 1)}>Previous</Button><Button variant="default" size="compact-xs" aria-label={`Next ${label.toLowerCase()} page`} disabled={!pagination?.hasNext} onClick={() => onPage(pagination.page + 1)}>Next</Button></Group></nav>;
}
function SummaryMeasures({ summary }) {
  const measures = [['Provider input', summary?.providerInputTokens], ['Cache read', summary?.cacheReadTokens], ['Cache write', summary?.cacheWriteTokens], ['Provider output', summary?.providerOutputTokens]];
  return <div className={styles.sessionMeasures}>{measures.map(([label, value]) => <div key={label} className={styles.tokenMeasure}><span>{label}</span><strong title={quantity(value)}>{quantity(value, true)}</strong><small>tokens</small></div>)}<div><span>Cache read share</span><strong>{finite(summary?.cacheHitRate) ? `${quantity(summary.cacheHitRate * 100)}%` : 'Unknown'}</strong><small>paired observations only</small></div><div><span>Usage samples</span><strong>{quantity(summary?.providerUsageSamples)}<small> / {quantity(summary?.attempts)}</small></strong><small>provider / attempts</small></div></div>;
}
function ProjectEditor({ session, refresh, overviewRefresh }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false), [error, setError] = useState(null);
  async function save(event) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const response = await fetch(`/api/context/sessions/${session.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectLabel: draft.trim() || null }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message || body?.error || 'The label could not be saved.');
      setEditing(false); refresh(); overviewRefresh();
    } catch (failure) { setError(failure.message); } finally { setSaving(false); }
  }
  return <div className={styles.projectEdit}>{!editing ? <Button variant="subtle" size="compact-sm" onClick={() => { setDraft(session.projectLabel || ''); setError(null); setEditing(true); }}>Edit project label</Button> : <form onSubmit={save}><TextInput label="Operator-assigned project label" value={draft} maxLength={80} disabled={saving} onChange={(event) => setDraft(event.currentTarget.value)} description="Leave blank to remove the label. No project is inferred from prompts or paths." autoFocus /><Group gap={6} mt={8}><Button size="compact-sm" type="submit" loading={saving}>Save label</Button><Button size="compact-sm" variant="default" disabled={saving} onClick={() => setEditing(false)}>Cancel</Button></Group>{error && <Alert color="red" mt={8} title="Project label not saved">{error}</Alert>}</form>}</div>;
}
function NoContext({ data, snapshot }) {
  if (data.summary?.sessions > 0) return <div className={styles.readState}><p>No sessions on this page. The selection still contains {quantity(data.summary.sessions)} recorded identities.</p><p>Use the session pager to return to retained evidence.</p></div>;
  return <div className={styles.noContext}>
    <div className={styles.emptyStatement}><span className={styles.emptyIndex}>∅</span><div><h2>No context evidence in this selection</h2><p>{quantity(data.recording?.totalRetainedAttempts)} retained attempts match these filters. Their usage history cannot reconstruct session identities, prompt estimates or shaping stages.</p><p>{snapshot ? 'This isolated snapshot contains no matching context records. It will not generate requests to populate this view.' : 'Context measurements appear only when they are recorded with gateway requests. Nothing is reconstructed from historical usage.'}</p><Group mt={16} gap={10}><Button component={Link} href="/dashboard/usage" variant="default">Explore recorded usage</Button><Button component={Link} href="/dashboard/shaping" variant="subtle">Review shaping controls</Button></Group></div></div>
    <div className={styles.emptyEvidence}><h3>What a recorded session can explain</h3><dl><div><dt>Context evolution</dt><dd>Request estimates and provider token measurements in their actual time buckets.</dd></div><div><dt>Shaping sequence</dt><dd>Ordered before/after byte boundaries, outcomes, risk and recorded controls.</dd></div><div><dt>Routing continuity</dt><dd>Explicit or inferred identity, account pins and switch receipts with their provenance.</dd></div></dl><p>Raw prompts, secrets and working paths are not stored in Context telemetry.</p></div>
  </div>;
}
export function ContextWorkspace() {
  const workspace = useWorkspace();
  const [baseline,setBaseline] = useState(null);
  return <ContextScope key={contextUrl(workspace.scope)} workspace={workspace} baseline={baseline} setBaseline={setBaseline} />;
}
function ContextScope({ workspace, baseline, setBaseline }) {
  const { scope, setScope, accounts, snapshot, observeSnapshot, contextView, setContextView, selectedRecord, setSelectedRecord } = workspace;
  const [page, setPage] = useState(1);
  const [showReports,setShowReports] = useState(false);
  const {sessionId, page:turnPage, projectLabel, clientTool} = contextView;
  const turnId = selectedRecord?.kind === 'context-attempt' ? selectedRecord.id : null;
  const setSessionId = useCallback((id) => setContextView({sessionId:id}),[setContextView]);
  const setTurnPage = (next) => setContextView({page:next});
  const setProjectLabel = (next) => setContextView({projectLabel:next});
  const setClientTool = (next) => setContextView({clientTool:next || null});
  const [clientDraft, setClientDraft] = useState(clientTool || '');
  const filters = { projectLabel, clientTool };
  const overview = useResource(contextUrl(scope, { ...filters, page }), { onSnapshot: observeSnapshot });
  const data = overview.data;
  const sessions = data?.sessions || EMPTY;
  const selectedSessionId = sessionId;
  const detail = useResource(selectedSessionId ? contextUrl(scope, { ...filters, page: turnPage, sessionId: selectedSessionId }) : null, { onSnapshot: observeSnapshot });
  const turns = detail.data?.turns || EMPTY;
  const selectedTurn = turns.find((turn) => String(turn.id) === String(turnId));
  const setTurnId = useCallback((id) => {
    const turn=turns.find((item)=>String(item.id)===String(id));
    setSelectedRecord(turn ? {kind:'context-attempt',id:String(turn.id),sessionId:selectedSessionId,provider:turn.provider,model:turn.model,connectionId:turn.connectionId,timestamp:turn.timestamp} : null);
  },[turns,selectedSessionId,setSelectedRecord]);
  const session = detail.data?.session;
  const accountName = (id) => accounts.find((account) => account.connectionId === id)?.displayName || id || 'Unknown account';
  const selectSession = (id) => { setContextView({sessionId:id,page:1}); setSelectedRecord({kind:'context-session',id:String(id),sessionId:id}); };
  const changePage = (next) => { setPage(next); };
  const filterByProject = (value) => { setProjectLabel(value); changePage(1); };
  const columns = useMemo(() => [
    { id: 'request', header: 'Attempt · UTC', cell: ({ row }) => <UnstyledButton className={styles.attemptButton} aria-label={`Inspect attempt ${row.original.id}`} onClick={() => { setSessionId(selectedSessionId); setTurnId(row.original.id); }}><strong title={`${utc(row.original.timestamp)} UTC`}>{utc(row.original.timestamp).slice(5)}</strong><small title={String(row.original.id)}>#{String(row.original.id).slice(0,14)}{String(row.original.id).length > 14 ? '…' : ''} · try {row.original.attempt ?? 'Unknown'}</small></UnstyledButton> },
    { id: 'route', header: 'Served provider / model', cell: ({ row }) => <div className={styles.routeCell}><span>{row.original.provider || 'Unknown'}</span><small title={row.original.model}>{row.original.model || 'Unknown model'}</small>{row.original.requestedModel !== row.original.model && <small title={row.original.requestedModel}>Requested · {row.original.requestedModel || 'Unknown'}</small>}</div> },
    { id: 'state', header: 'Recorded state', cell: ({ row }) => <span className={styles.status} data-state={row.original.status}>{row.original.status === 'pending' ? 'Incomplete' : row.original.status || 'Unknown'}<small>{row.original.usageSource === 'provider' ? 'Provider usage' : row.original.usageSource === 'estimated' ? 'Estimated usage' : 'Usage missing'}</small></span> },
    ...[['contextEstimate', 'Context est.'], ['providerInputTokens', 'Input'], ['cacheReadTokens', 'Cache read'], ['cacheWriteTokens', 'Cache write'], ['providerOutputTokens', 'Output']].map(([key, header]) => ({ id: key, header, cell: ({ row }) => <span className={styles.numeric} title={quantity(row.original[key])}>{quantity(row.original[key], true)}</span> })),
    { id: 'bytes', header: 'Body change', cell: ({ row }) => <span className={styles.numeric} data-expansion={row.original.savedBytes < 0 || undefined}>{signedBytes(finite(row.original.savedBytes) ? -row.original.savedBytes : null)}</span> },
  ], [selectedSessionId, setSessionId, setTurnId]);
  const refreshOverview = () => { if (selectedSessionId) setSessionId(selectedSessionId); overview.refresh(); };
  const refresh = () => { refreshOverview(); detail.refresh(); };
  const focusInterval = (next) => { if (selectedSessionId) setSessionId(selectedSessionId); setScope(next); };
  return <>
    <div className={shared.lensHeading}><div className={shared.lensTitle}><h1>Context trace</h1><p>Session continuity, cache evidence and request shaping</p></div><Group gap={8}><Button variant="default" size="compact-sm" aria-pressed={showReports} onClick={()=>setShowReports(!showReports)}>{showReports ? 'Return to session tracks' : 'Browse client reports'}</Button><Button variant="default" size="compact-sm" onClick={refresh}>Refresh context</Button><Button component={Link} href="/dashboard/shaping" variant="subtle" size="compact-sm">Shaping controls</Button></Group></div>
    <ScopeBar /><ActivityBand title="Retained request activity" />
    <div className={styles.workspace}>
      <RecordingCoverage recording={data?.recording} />
      {data?.recording?.rejectedAttempts > 0 && <Alert color="orange" className={styles.rejection} title={`${quantity(data.recording.rejectedAttempts)} context ${data.recording.rejectedAttempts === 1 ? 'record' : 'records'} rejected`}>Usage may remain available; context and stage evidence is absent. Counts follow the current filters.</Alert>}
      {showReports ? <ContextClientEvents key={contextUrl(scope,filters)} scope={scope} filters={filters} onSnapshot={observeSnapshot} /> : <ReadState resource={overview}>
        <div className={styles.toolbar}><div><h2>Session cohort</h2><span>{quantity(data?.summary?.sessions)} identities · latest observation first</span></div><Group gap={8}><Select aria-label="Project label filter" placeholder="All project labels" value={projectLabel} onChange={filterByProject} data={(data?.projects || []).filter((project) => project.projectLabel).map((project) => project.projectLabel)} clearable searchable w={180} /><form className={styles.clientFilter} onSubmit={(event) => { event.preventDefault(); setClientTool(clientDraft.trim()); changePage(1); }}><TextInput aria-label="Exact client filter" placeholder="Exact client name" value={clientDraft} onChange={(event) => setClientDraft(event.currentTarget.value)} w={150} /><Button type="submit" variant="default">Apply</Button></form>{clientTool && <Button variant="subtle" onClick={() => { setClientDraft(''); setClientTool(''); changePage(1); }}>Clear client</Button>}</Group></div>
        {!sessions.length && !selectedSessionId ? <NoContext data={data || {}} snapshot={snapshot} /> : <SelectionDock open={Boolean(selectedTurn)} title={selectedTurn ? `Request #${selectedTurn.id} · attempt ${selectedTurn.attempt ?? 'unknown'}` : ''} subtitle={selectedTurn ? `${selectedTurn.provider || 'Unknown'} · ${selectedTurn.model || 'Unknown model'} · ${accountName(selectedTurn.connectionId)}` : ''} onClose={() => setTurnId(null)} height="calc(100dvh - 412px)" detail={selectedTurn && <ContextInspector key={selectedTurn.id} turn={selectedTurn} detail={detail.data} accounts={accounts} baseline={baseline} onBaseline={(turn)=>setBaseline({turn:structuredClone(turn),receivedAt:detail.data.freshness?.snapshotCompletedAt || detail.receivedAt})} onClearBaseline={()=>setBaseline(null)} onSnapshot={observeSnapshot} />}>
          <div className={styles.cohortGrid}>
            <aside className={styles.sessions} aria-label="Recorded session cohort"><div className={styles.sessionList}>{sessions.map((item) => <UnstyledButton key={item.id} className={styles.sessionButton} data-selected={item.id === selectedSessionId || undefined} aria-pressed={item.id === selectedSessionId} onClick={() => selectSession(item.id)}><div className={styles.sessionName}><strong>{item.projectLabel || 'Unlabeled session'}</strong><span>#{item.id}</span></div><div className={styles.sessionClient}>{item.clientTool || 'Unknown client'}<Badge size="xs" color="gray" variant="light">{IDENTITY[item.identitySource] || 'Unknown identity'}</Badge></div><div className={styles.sessionNumbers}><span>{quantity(item.requests)} requests <small>· {quantity(item.attempts)} attempts</small></span><span>{quantity(item.providerInputTokens, true)} input</span></div><time className={styles.sessionTime} dateTime={item.lastSeenAt}>{utc(item.lastSeenAt)} UTC</time></UnstyledButton>)}</div><Pager pagination={data?.pagination} onPage={changePage} label="Sessions" /><p className={styles.identityFoot}>Identity is not a count of agents. Inferred locality may combine separate callers. Project labels are operator assigned.</p></aside>
            <div className={styles.sessionDetail}>{!selectedSessionId && <p className={styles.emptyInline}>Choose a recorded session to inspect its evidence.</p>}<ReadState resource={detail}>{session && <>
              <div className={styles.sessionHeading}><div><h2>{session.projectLabel || `Session #${session.id}`}<span>{IDENTITY[session.identitySource] || 'Identity source unknown'}</span></h2><p>{IDENTITY_NOTE[session.identitySource] || 'The identity source is not recorded.'}</p></div><ProjectEditor key={session.id} session={session} refresh={detail.refresh} overviewRefresh={refreshOverview} /></div>
              <SummaryMeasures summary={detail.data.summary} />
              {detail.data.summary?.attempts === 0 && <p className={styles.emptyInline}>Selected session #{session.id} has no attempts in this scope. The session selection is preserved.</p>}
              {turnId !== null && !selectedTurn && <p className={styles.emptyInline}>Selected request #{turnId} is outside this page or scope. Choose another request or return to its interval.</p>}
              <ContextTracks trend={detail.data.trend} scope={scope} onScope={focusInterval} />
              <div className={styles.ledgerHead}><h3>Attempt ledger</h3><span>Chronological · token quantities except body change</span></div>
              {turns.length ? <ContextTable rows={turns} columns={columns} selectedId={turnId} label="Session request attempts" minWidth={1000} /> : <p className={styles.emptyInline}>No attempts on this page match the selected scope.</p>}
              <Pager pagination={detail.data.pagination} onPage={(next) => setTurnPage(next)} label="Attempts" />
              <p className={styles.footnote}>Provider input is cache-inclusive. Cache read and write are reported separately, never added to it. Incomplete means a retained pending receipt, not a confirmed active generation.</p>
            </>}</ReadState></div>
          </div>
        </SelectionDock>}
      </ReadState>}
      {data?.summary?.sessions > 0 && !sessions.length && !selectedSessionId && <Pager pagination={data?.pagination} onPage={changePage} label="Sessions" />}
      <footer className={styles.footer}><span>{quantity(data?.retentionDays)} days retained · recording began {utc(data?.recordingStartedAt)} UTC</span><span>{data?.freshness?.source === 'last-persisted-snapshot' ? 'Persisted snapshot' : 'Committed data'} · {utc(data?.freshness?.persistedAt || data?.freshness?.snapshotCompletedAt)} UTC</span></footer>
    </div>
  </>;
}
