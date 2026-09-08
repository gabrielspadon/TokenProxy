'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, NativeSelect, NumberInput, SegmentedControl, Text, TextInput } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { Icon } from '@/shared/components/Icon';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { useResource } from '@/shared/workspace/useResource';
import { accountControlBaseline, accountControlEvidence, accountControlId, accountControlState, accountDraftState, accountWindows, accountWindowTime, makeAccountDraft, mergeAccountControls, readAccountControls, rebaseAccountDraft, sameAccountControls, saveAccountControls, sortAccountControls } from './accountControlPanelModel';
import { groupQuotaProducts } from './quotaProductGroups';
import { QuotaProduct } from './QuotaProduct';
import styles from './accountControlPanel.module.css';

const EMPTY = [];
const STATES = [{ value: 'all', label: 'All' }, { value: 'Enabled', label: 'Configured on' }, { value: 'Paused', label: 'Manually paused' }, { value: 'Quota pause', label: 'Quota pause' }, { value: 'Needs attention', label: 'Needs attention' }, { value: 'Draining', label: 'Draining' }, { value: 'Cooldown', label: 'Cooldown' }, { value: 'Not checked', label: 'Not checked' }, { value: 'Unknown', label: 'Unknown' }];
const number = value => new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value);
const windowId = (id, key) => JSON.stringify([id, key]);


export function AccountControlPanel({ rows = EMPTY, scope = {}, selectedAccountId, onSelect, onChanged, anchor, comparisonIds = EMPTY, onComparisonChange, onCompare }) {
  const customizeOrigin = useRef(null);
  const resource = useResource('/api/providers');
  const [clock, setClock] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [view, setView] = useState('cards');
  const [mode, setMode] = useState('remaining');
  const [detailLevel, setDetailLevel] = useState('everyday');
  const [sort, setSort] = useState('name');
  const [sortAt, setSortAt] = useState(() => Number.isFinite(anchor) && anchor > 0 ? anchor : Date.now());
  const [orderRevision, setOrderRevision] = useState(0);
  const [customize, setCustomize] = useState(false);
  const [preferences, setPreferences] = useLocalStorage({ key: 'tokenproxy.account-control-panel', defaultValue: { hiddenAccounts: [], hiddenWindows: [], density: 'comfortable' } });
  const [verified, setVerified] = useState({});
  const [busy, setBusy] = useState({});
  const [notices, setNotices] = useState({});
  const [drafts, setDrafts] = useState({});
  const connections = resource.data?.connections;
  const [rankingReceipt, setRankingReceipt] = useState(() => ({ connections, rows, verified, receivedAt: resource.receivedAt, at: Date.now() }));
  if (rankingReceipt.connections !== connections || rankingReceipt.rows !== rows || rankingReceipt.verified !== verified || rankingReceipt.receivedAt !== resource.receivedAt) {
    setRankingReceipt(() => ({ connections, rows, verified, receivedAt: resource.receivedAt, at: Date.now() }));
  }
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const now = Number.isFinite(anchor) && anchor > 0 ? anchor : Math.max(clock, rankingReceipt.at);
  const rankingAt = Number.isFinite(anchor) && anchor > 0 ? anchor : Math.max(sortAt, rankingReceipt.at);
  const accounts = mergeAccountControls(resource.data?.connections, rows).map(account => {
    const saved = verified[accountControlId(account)];
    return saved && !(Date.parse(resource.receivedAt) > saved.at) ? { ...account, ...saved.connection } : account;
  });
  const policies = new Map((connections || EMPTY).map(connection => [connection.id, connection]));
  for (const [id, saved] of Object.entries(verified)) if (!(Date.parse(resource.receivedAt) > saved.at)) policies.set(id, saved.connection);
  const hiddenAccounts = Array.isArray(preferences?.hiddenAccounts) ? preferences.hiddenAccounts : [];
  const hiddenWindows = Array.isArray(preferences?.hiddenWindows) ? preferences.hiddenWindows : [];
  const scoped = accounts.filter(account => (!scope.provider || account.provider === scope.provider) && (!scope.connectionId || accountControlId(account) === scope.connectionId));
  const matchesState = (account, value) => value === 'all' || (value === 'Enabled' ? account.isActive === true : accountControlState(account, now) === value);
  const proposedOrder = sortAccountControls(scoped.filter(account => (!hiddenAccounts.includes(accountControlId(account))) && matchesState(account, status) && `${account.displayName || account.name || ''} ${account.provider} ${accountControlId(account)}`.toLowerCase().includes(query.trim().toLowerCase())), sort, rankingAt);
  const orderKey = JSON.stringify([query, status, sort, scope, preferences, sortAt, orderRevision]);
  const orderIds = proposedOrder.map(accountControlId);
  const orderSequence = JSON.stringify(orderIds);
  const orderLocked = Boolean(selectedAccountId || comparisonIds.length || Object.keys(drafts).length);
  const [retainedOrder, setRetainedOrder] = useState({ key: orderKey, sequence: orderSequence, ids: orderIds });
  const addedIds = orderIds.filter(id => !retainedOrder.ids.includes(id));
  if (retainedOrder.key !== orderKey || !orderLocked && retainedOrder.sequence !== orderSequence) {
    setRetainedOrder({ key: orderKey, sequence: orderSequence, ids: orderIds });
  } else if (addedIds.length) {
    const ids = [...retainedOrder.ids, ...addedIds];
    setRetainedOrder({ key: orderKey, sequence: JSON.stringify(ids), ids });
  }
  const positions = new Map(retainedOrder.ids.map((id, index) => [id, index]));
  const matching = orderLocked && retainedOrder.key === orderKey ? [...proposedOrder].sort((a, b) => (positions.get(accountControlId(a)) ?? Infinity) - (positions.get(accountControlId(b)) ?? Infinity)) : proposedOrder;
  const selected = [...new Set(comparisonIds)];
  const selectedElsewhere = selected.filter(id => !matching.some(account => accountControlId(account) === id)).length;
  function compareSelection(id, checked) {
    if (!checked) onComparisonChange?.(selected.filter(value => value !== id));
    else if (selected.length < 4 && !selected.includes(id)) onComparisonChange?.([...selected, id]);
  }
  function preference(key, id, hide) { setPreferences(previous => { const entries = Array.isArray(previous?.[key]) ? previous[key] : []; return { ...previous, [key]: hide ? [...new Set([...entries, id])] : entries.filter(value => value !== id) }; }); }
  function refresh() { setVerified({}); setSortAt(now); setOrderRevision(previous => previous + 1); resource.refresh(); onChanged?.(); }
  function accountNotice(id, message) { setNotices(previous => ({ ...previous, [id]: message })); }
  function finish(id) { setBusy(previous => { const next = { ...previous }; delete next[id]; return next; }); }
  function discard(id, form) {
    setDrafts(previous => { const next = { ...previous }; delete next[id]; return next; });
    const input = form?.querySelector('[aria-label="Fallback priority"]');
    const target = input && !input.disabled && !input.closest('[hidden]') ? input
      : form?.querySelector('input[aria-label^="Auto-pause threshold"]:not(:disabled)');
    if (target) target.focus(); else form?.focus();
  }
  function edit(account, baseline, field, value, key) {
    const id = accountControlId(account);
    if (busy[id] || !baseline && !drafts[id]) return;
    setDrafts(previous => {
      const draft = previous[id] || makeAccountDraft(baseline, accountWindows(account));
      const edited = field === 'priority' ? { ...draft, priority: value } : { ...draft, thresholds: { ...draft.thresholds, [key]: value } };
      const next = { ...previous, [id]: edited };
      if (!accountDraftState(edited).dirty) delete next[id];
      return next;
    });
  }
  async function inspectCurrent(account) {
    const id = accountControlId(account);
    if (busy[id]) return;
    setBusy(previous => ({ ...previous, [id]: 'read' }));
    try {
      const current = await readAccountControls(id);
      const before = accountControlBaseline(current, id);
      if (!before) throw new Error('Current settings are incomplete. Editing remains unavailable until a complete policy can be read.');
      setVerified(previous => ({ ...previous, [id]: { connection: current, at: Date.now() } }));
      setDrafts(previous => {
        if (!previous[id]) return previous;
        const draft = rebaseAccountDraft(previous[id], before, accountWindows({ ...account, ...current }));
        const next = { ...previous, [id]: draft };
        if (!accountDraftState(draft).dirty) delete next[id];
        return next;
      });
      accountNotice(id, { color: 'teal', text: 'Current settings read. Your edits are retained when they differ; review before saving.' });
    } catch (error) { accountNotice(id, { color: 'orange', text: error.message, blocked: true }); }
    finally { finish(id); }
  }
  async function pause(account) {
    const id = accountControlId(account), target = account.isActive === false;
    if (busy[id] || notices[id]?.blocked) return;
    setBusy(previous => ({ ...previous, [id]: 'pause' }));
    try {
      const current = await readAccountControls(id);
      if (!accountControlBaseline(current, id)) throw new Error('Current settings are incomplete. Read current settings before changing this account.');
      const result = await saveAccountControls(current, { isActive: target });
      accountNotice(id, { color: result.confirmed ? 'teal' : 'orange', text: result.confirmed ? `${account.displayName || account.name || id} ${target ? 'resumed' : 'paused'}. Saved state verified. Other routing gates still apply.` : result.message, blocked: !result.confirmed });
      if (result.confirmed) { setVerified(previous => ({ ...previous, [id]: { connection: result.current, at: Date.now() } })); resource.refresh(); onChanged?.(); }
    } catch (error) { accountNotice(id, { color: 'orange', text: error.message, blocked: true }); }
    finally { finish(id); }
  }
  async function saveDraft(account, form) {
    const id = accountControlId(account), draft = drafts[id];
    if (!draft || busy[id] || notices[id]?.blocked) return;
    const baseline = accountControlBaseline(policies.get(id), id);
    const change = accountDraftState(draft);
    if (!change.dirty || !change.patch || !baseline || !sameAccountControls(baseline, draft.before)) return;
    setBusy(previous => ({ ...previous, [id]: 'save' }));
    try {
      const result = await saveAccountControls(draft.before, change.patch);
      accountNotice(id, { color: result.confirmed ? 'teal' : 'orange', text: result.message, blocked: !result.confirmed });
      if (result.confirmed) {
        setVerified(previous => ({ ...previous, [id]: { connection: result.current, at: Date.now() } }));
        discard(id, form);
        resource.refresh(); onChanged?.();
      }
    } finally { finish(id); }
  }
  const inventoryKnown = Array.isArray(connections);
  const confirmedEmpty = inventoryKnown && connections.length === 0 && accounts.length === 0 && !resource.loading && !resource.error;
  if (confirmedEmpty) return <section className={styles.panel} aria-label="Account control panel">
    <div className={styles.controls}><div className={styles.heading}><div><h2>Your accounts</h2><Text size="sm" c="dimmed">No accounts connected yet.</Text></div></div></div>
    <div className={styles.empty}><h3>Connect your first account</h3><Text size="sm">Choose Add account in Connections to connect a provider. Your accounts, usage and reported quota will appear here.</Text><Button component="a" href="/dashboard/connections" mt="md" leftSection={<Icon name="i-add" />}>Connect an account</Button></div>
  </section>;
  return <section tabIndex={-1} className={styles.panel} aria-label="Account control panel" data-density={preferences?.density || 'comfortable'}>
    <div className={styles.controls}>
      <div className={styles.heading}><div><h2>Your accounts</h2><Text size="sm" c="dimmed">{!accounts.length && resource.loading ? 'Reading configured accounts…' : !accounts.length && (resource.error || !inventoryKnown) ? 'Account inventory unavailable.' : `${matching.length} of ${scoped.length} accounts. Pause manually or set a reserve below.`}</Text></div><TextInput className={styles.search} aria-label="Search accounts" leftSection={<Icon name="i-search" />} placeholder="Search accounts or providers" type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} /><Group gap="xs" className={styles.headingActions}><Button ref={customizeOrigin} size="compact-sm" variant="default" aria-expanded={customize} onClick={() => setCustomize(previous => !previous)} leftSection={<Icon name="i-shaping" />} aria-label="Customize">Customize</Button><Button size="compact-sm" variant="default" onClick={refresh} leftSection={<Icon name="i-refresh" />} aria-label="Refresh">Refresh</Button></Group></div>
      <div className={styles.toolbar}><NativeSelect aria-label="Account status" value={status} onChange={event => setStatus(event.currentTarget.value)} data={STATES.map(item => ({ value: item.value, label: `${item.label} (${scoped.filter(account => matchesState(account, item.value)).length})` }))} /><NativeSelect aria-label="Sort accounts" value={sort} onChange={event => { setSort(event.currentTarget.value); setSortAt(now); }} data={[{ value: 'name', label: 'Account name' }, { value: 'reset', label: 'Next observed reset' }, { value: 'headroom', label: 'Least recorded headroom' }]} /><SegmentedControl size="xs" aria-label="Capacity measure" value={mode} onChange={setMode} data={[{ value: 'remaining', label: 'Remaining' }, { value: 'used', label: 'Used' }]} /><SegmentedControl size="xs" aria-label="Account view" value={view} onChange={setView} data={[{ value: 'cards', label: 'Cards' }, { value: 'rows', label: 'Rows' }]} /><SegmentedControl size="xs" aria-label="Account controls" value={detailLevel} onChange={setDetailLevel} data={[{ value: 'everyday', label: 'Everyday' }, { value: 'advanced', label: 'Advanced' }]} />{onComparisonChange ? <Group gap="xs" className={styles.comparisonActions}><Button variant="light" disabled={selected.length < 2 || selected.length > 4 || !onCompare} onClick={() => onCompare?.()}>Compare selected ({selected.length})</Button>{selected.length ? <Button variant="subtle" onClick={() => onComparisonChange([])}>Clear selection</Button> : null}</Group> : null}</div>
      {selected.length || sort !== 'name' ? <div className={styles.selectionNote}>{selected.length ? <span role="status">{selected.length} of 4 selected{selectedElsewhere ? `, ${selectedElsewhere} outside this view` : ''}. Selection stays across filters.</span> : null}{sort !== 'name' ? <span>Missing {sort === 'reset' ? 'reset times' : 'percentages'}, stale and unlimited observations sort last. Refresh to re-evaluate age.</span> : null}</div> : null}
    </div>
    {customize ? <section className={styles.customize} aria-label="Account panel visibility"><div className={styles.customizeHeading}><Text size="sm">Visibility affects this browser only. Hidden accounts still route requests.</Text><Button variant="subtle" onClick={() => { setCustomize(false); customizeOrigin.current?.focus(); }}>Done</Button></div><SegmentedControl aria-label="Account density" value={preferences?.density || 'comfortable'} onChange={density => setPreferences(previous => ({ ...previous, density }))} data={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} /><div className={styles.visibilityAccounts}>{scoped.map(account => { const id = accountControlId(account); return <div className={styles.preference} key={id}><Checkbox label={`Show ${account.displayName || account.name || id}`} checked={!hiddenAccounts.includes(id)} onChange={event => preference('hiddenAccounts', id, !event.currentTarget.checked)} />{accountWindows(account).map(window => <Checkbox ml="lg" mt="xs" key={window.key} label={window.key} checked={!hiddenWindows.includes(windowId(id, window.key))} onChange={event => preference('hiddenWindows', windowId(id, window.key), !event.currentTarget.checked)} />)}</div>; })}</div><Button mt="sm" variant="default" onClick={() => setPreferences({ hiddenAccounts: [], hiddenWindows: [], density: 'comfortable' })}>Restore default view</Button></section> : null}
    {Object.keys(drafts).length ? <div className={styles.draftSummary} role="status">{Object.keys(drafts).length} unsaved account {Object.keys(drafts).length === 1 ? 'draft' : 'drafts'}{Object.keys(drafts).some(id => !matching.some(account => accountControlId(account) === id)) ? '. Some drafts are outside this view; filtering does not discard them.' : '.'}</div> : null}

    {resource.error ? <Alert color="orange">Account settings could not be refreshed. {resource.error}<Button size="compact-sm" variant="subtle" onClick={refresh}>Retry account inventory</Button></Alert> : null}
    {!accounts.length && resource.loading ? <Text role="status">Reading configured accounts…</Text> : null}
    <div className={view === 'rows' ? styles.rows : styles.cards}>{matching.map(account => {
      const id = accountControlId(account), evidence = accountControlEvidence(account, now);
      const name = account.displayName || account.name || id;
      const windows = accountWindows(account), visibleWindows = windows.filter(window => !hiddenWindows.includes(windowId(id, window.key)));
      const baseline = accountControlBaseline(policies.get(id), id), draft = drafts[id];
      const change = draft ? accountDraftState(draft) : { dirty: false, patch: null };
      const stale = Boolean(draft && (!baseline || !sameAccountControls(baseline, draft.before)));
      const notice = notices[id], needsRead = !baseline || stale || notice?.blocked;
      const canEdit = Boolean(baseline || draft?.before) && !busy[id];
      return <article key={id} aria-label={name} className={styles.card} data-selected={selectedAccountId === id || undefined} data-comparing={selected.includes(id) || undefined} data-account-id={id}>
        <header className={styles.cardHeader}>{onComparisonChange ? <label className={styles.comparisonCheckbox}><Checkbox size="sm" aria-label={`Compare ${name}`} checked={selected.includes(id)} disabled={!selected.includes(id) && selected.length >= 4} onChange={event => compareSelection(id, event.currentTarget.checked)} /></label> : null}<button type="button" className={styles.identity} onClick={() => onSelect?.(id)}><ProviderMark provider={account.provider} /><span><strong>{name}</strong><small>{account.provider}</small></span></button></header>
        <div className={styles.accountEvidence}><div className={styles.configurationLine}><Badge color={account.isActive === true ? 'teal' : 'gray'} variant="light" data-configured={account.isActive === true ? 'on' : undefined}>{account.isActive === true ? 'Configured on' : account.isActive === false ? 'Manually paused' : 'Config unknown'}</Badge><span>{evidence.health}</span></div>{evidence.gates.map(gate => <span className={styles.gate} key={gate}>{gate}</span>)}</div>
        <form tabIndex={-1} className={styles.accountSettings} aria-label={`Account settings for ${name}`} onSubmit={event => { event.preventDefault(); saveDraft(account, event.currentTarget); }}>
        <div className={styles.windows}>{groupQuotaProducts(account.provider, visibleWindows).map(group => <QuotaProduct key={group.id} group={group} now={now} mode={mode} onInspect={key => onSelect?.(id, key)} thresholdFor={key => draft ? draft.thresholds[key] ?? 0 : baseline ? baseline.quotaPauseThresholds[key] ?? 0 : ''} onThresholdChange={(key, value) => edit(account, baseline, 'threshold', value, key)} disabled={!canEdit} />)}{!windows.length ? <div className={styles.emptyWindow}>No quota window recorded. Usage and reset are unknown.</div> : !visibleWindows.length ? <Text size="sm" c="dimmed">All windows hidden in Customize.</Text> : null}</div>
        <div className={styles.evidenceDetails} hidden={detailLevel !== 'advanced'}><div><p>Configuration and stored health do not establish model access. Other routing gates can still apply.</p><p>{accountWindowTime(evidence.observedAt, now).absolute ? `Health recorded ${accountWindowTime(evidence.observedAt, now).absolute}` : 'Health observation time unknown.'}</p>{visibleWindows.map(window => <div className={styles.windowEvidence} key={window.key}><strong>{window.key}</strong><span>{window.unlimited ? 'Auto-pause not applicable' : window.threshold > 0 ? `Pause ≤ ${number(window.threshold)}% left` : 'Auto-pause off'}</span><span>Observed {accountWindowTime(window.observedAt, now).absolute || 'at an unknown time'}</span><span>Reset {accountWindowTime(window.resetAt, now, true).absolute || 'time unknown'}</span></div>)}</div></div>
        <footer className={styles.cardFooter}><div hidden={detailLevel !== 'advanced'}><NumberInput className={styles.priorityControl} label="Priority" aria-label="Fallback priority" min={1} allowDecimal={false} value={draft ? draft.priority : baseline?.priority ?? ''} placeholder={baseline ? 'Unset' : 'Unknown'} onChange={value => edit(account, baseline, 'priority', value)} disabled={!canEdit} hideControls /></div><Group gap="xs"><Button size="compact-sm" variant="default" loading={busy[id] === 'pause'} disabled={!!busy[id] || notice?.blocked || typeof account.isActive !== 'boolean'} onClick={() => pause(account)} aria-label={account.isActive === false ? 'Resume' : 'Pause'} leftSection={<Icon name={account.isActive === false ? 'i-play' : 'i-pause'} />}>{account.isActive === false ? 'Resume' : 'Pause'}</Button><Button size="compact-sm" variant="subtle" onClick={() => onSelect?.(id)}>Details</Button></Group>{Number.isFinite(account.activity?.records) ? <span>{number(account.activity.records)} attempts in selected period</span> : null}</footer>
        {change.dirty || needsRead || notice ? <div className={styles.saveControls}>{stale ? <Text size="sm" c="orange" role="status">Stored settings changed. Your draft is retained.</Text> : !baseline ? <Text size="sm">Read current settings to edit this account.</Text> : null}{notice ? <Text size="sm" c={notice.color} role="status">{notice.text}</Text> : null}{change.dirty && !change.patch ? <Text size="sm" c="orange">Use a whole priority of at least 1 and thresholds from 0 to 100.</Text> : null}<Group gap="xs">{change.dirty ? <><Button type="submit" size="compact-sm" loading={busy[id] === 'save'} disabled={!change.patch || !!busy[id] || !!needsRead}>Save changes</Button><Button size="compact-sm" variant="default" disabled={!!busy[id]} onClick={event => discard(id, event.currentTarget.form)}>Discard</Button></> : null}{needsRead ? <Button size="compact-sm" variant="light" loading={busy[id] === 'read'} disabled={!!busy[id]} onClick={() => inspectCurrent(account)}>Read current settings</Button> : null}</Group></div> : null}
        </form>
      </article>;
    })}</div>
    {!matching.length && !resource.loading && !resource.error && !inventoryKnown ? <div className={styles.empty}><h3>Account inventory unavailable</h3><Text size="sm">The account list was not returned. Retry to read current accounts.</Text><Button mt="sm" variant="default" onClick={refresh}>Retry account inventory</Button></div> : null}
    {!matching.length && !resource.loading && !resource.error && inventoryKnown ? <div className={styles.empty}><h3>No accounts match this view</h3><Text size="sm">{!scoped.length ? 'Adjust the shared provider or account filters above to see your configured accounts.' : 'Clear search or status filters, or restore hidden accounts to see the configured collection.'}</Text><Group mt="sm"><Button variant="default" onClick={() => { setQuery(''); setStatus('all'); }}>Clear filters</Button><Button variant="subtle" onClick={() => setPreferences(previous => ({ ...previous, hiddenAccounts: [], hiddenWindows: [] }))}>Show all accounts and windows</Button></Group></div> : null}
  </section>;
}
