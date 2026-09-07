'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, Modal, NativeSelect, NumberInput, SegmentedControl, Text, TextInput } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { useResource } from '@/shared/workspace/useResource';
import { accountControlId, accountControlState, accountLimitsPatch, accountWindows, accountWindowTime, mergeAccountControls, readAccountControls, saveAccountControls } from './accountControlPanelModel';
import styles from './accountControlPanel.module.css';

const EMPTY = [];
const STATES = ['Enabled', 'Paused', 'Quota pause', 'Draining', 'Cooldown', 'Needs attention', 'Not checked', 'Unknown'];
const number = value => new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value);
const windowId = (id, key) => JSON.stringify([id, key]);

function QuotaMeter({ window, mode, now, onInspect }) {
  const known = window.remaining !== null && !window.unlimited;
  const value = known ? mode === 'remaining' ? window.remaining : 100 - window.remaining : null;
  const reset = accountWindowTime(window.resetAt, now, true);
  const observed = accountWindowTime(window.observedAt, now);
  const observedAt = Date.parse(window.observedAt);
  const retained = !Number.isFinite(observedAt) || observedAt > now || now - observedAt > 900000 || Date.parse(window.resetAt) <= now;
  const low = known && window.remaining <= Math.max(10, window.threshold);
  return <div className={styles.window} data-retained={retained || !known || undefined}>
    <div className={styles.windowHeading}><button type="button" onClick={onInspect}>{window.key}</button><strong data-low={low || undefined}>{window.unlimited ? 'Unlimited' : value === null ? 'Unknown' : `${number(value)}% ${mode}`}</strong></div>
    <div className={styles.meter} role={known ? 'meter' : undefined} aria-label={`${window.key} ${mode}`} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? 100 : undefined} aria-valuenow={value ?? undefined} aria-valuetext={known ? `${number(value)} percent ${mode}; observed capacity` : undefined} data-unknown={!known || undefined}>
      {known ? <span className={styles.fill} data-low={low || undefined} style={{ width: `${value}%` }} /> : null}
      {window.threshold > 0 && !window.unlimited ? <span className={styles.threshold} style={{ left: `${mode === 'remaining' ? window.threshold : 100 - window.threshold}%` }} title={`Pause at or below ${window.threshold}% remaining`} /> : null}
    </div>
    <div className={styles.windowMeta}><span title={reset.absolute || undefined}>{reset.label}</span><span>{window.unlimited ? 'Auto-pause not applicable' : window.threshold > 0 ? `Pause ≤ ${number(window.threshold)}% left` : 'Auto-pause off'}</span></div>
    <div className={styles.observation}><span title={observed.absolute || undefined}>{observed.label}</span>{reset.absolute ? <time dateTime={window.resetAt}>{reset.absolute}</time> : null}</div>
  </div>;
}

export function AccountControlPanel({ rows = EMPTY, scope = {}, selectedAccountId, onSelect, onChanged, anchor }) {
  const panel = useRef(null);
  const limitsOrigin = useRef(null);
  const resource = useResource('/api/providers');
  const [clock, setClock] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [view, setView] = useState('cards');
  const [mode, setMode] = useState('remaining');
  const [customize, setCustomize] = useState(false);
  const [preferences, setPreferences] = useLocalStorage({ key: 'tokenproxy.account-control-panel', defaultValue: { hiddenAccounts: [], hiddenWindows: [], density: 'comfortable' } });
  const [verified, setVerified] = useState({});
  const [busy, setBusy] = useState(null);
  const [blocked, setBlocked] = useState(null);
  const [notice, setNotice] = useState(null);
  const [limits, setLimits] = useState(null);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const now = Number.isFinite(anchor) && anchor > 0 ? anchor : clock;
  const accounts = mergeAccountControls(resource.data?.connections, rows).map(account => {
    const saved = verified[accountControlId(account)];
    return saved && !(Date.parse(resource.receivedAt) > saved.at) ? { ...account, ...saved.connection } : account;
  });
  const hiddenAccounts = Array.isArray(preferences?.hiddenAccounts) ? preferences.hiddenAccounts : [];
  const hiddenWindows = Array.isArray(preferences?.hiddenWindows) ? preferences.hiddenWindows : [];
  const scoped = accounts.filter(account => (!scope.provider || account.provider === scope.provider) && (!scope.connectionId || accountControlId(account) === scope.connectionId));
  const matchesState = (account, value) => value === 'all' || (value === 'Enabled' ? account.isActive === true : accountControlState(account, now) === value);
  const matching = scoped.filter(account => (!hiddenAccounts.includes(accountControlId(account))) && matchesState(account, status) && `${account.displayName || account.name || ''} ${account.provider} ${accountControlId(account)}`.toLowerCase().includes(query.trim().toLowerCase()));
  function preference(key, id, hide) { setPreferences(previous => { const entries = Array.isArray(previous?.[key]) ? previous[key] : []; return { ...previous, [key]: hide ? [...new Set([...entries, id])] : entries.filter(value => value !== id) }; }); }
  function refresh() { setVerified({}); resource.refresh(); onChanged?.(); }
  async function inspectCurrent(id) {
    setBusy(id);
    try {
      const current = await readAccountControls(id);
      setVerified(previous => ({ ...previous, [id]: { connection: current, at: Date.now() } })); setBlocked(null);
      if (limits?.before.id === id) setLimits(previous => ({ ...previous, before: current, thresholds: { ...current.quotaPauseThresholds, ...previous.thresholds } }));
      setNotice({ color: 'teal', text: 'Current account settings read. Review your retained draft before saving.' });
    } catch (error) { setNotice({ color: 'orange', text: error.message }); }
    finally { setBusy(null); }
  }
  async function pause(account) {
    const id = accountControlId(account), target = account.isActive === false;
    setBusy(id); setNotice(null);
    try {
      const current = await readAccountControls(id);
      const result = await saveAccountControls(current, { isActive: target });
      setNotice({ color: result.confirmed ? 'teal' : 'orange', text: result.confirmed ? `${account.displayName || account.name || id} ${target ? 'resumed' : 'paused'}. Saved state verified. Other routing gates still apply.` : result.message });
      if (result.confirmed) { setVerified(previous => ({ ...previous, [id]: { connection: result.current, at: Date.now() } })); resource.refresh(); onChanged?.(); }
      else setBlocked(id);
    } catch (error) { setNotice({ color: 'orange', text: error.message }); }
    finally { setBusy(null); }
  }
  async function openLimits(account, trigger) {
    limitsOrigin.current = trigger;
    const id = accountControlId(account); setBusy(id); setNotice(null);
    try {
      const current = await readAccountControls(id);
      const windows = accountWindows({ ...account, ...current });
      setLimits({ before: current, name: account.displayName || account.name || id, priority: current.priority ?? 1, thresholds: Object.fromEntries(windows.map(window => [window.key, current.quotaPauseThresholds?.[window.key] ?? 0])) });
      setBlocked(null);
    } catch (error) { setNotice({ color: 'orange', text: error.message }); }
    finally { setBusy(null); }
  }
  const patch = limits ? accountLimitsPatch(limits.priority, limits.thresholds) : null;
  async function saveLimits() {
    if (!patch || busy || blocked === limits.before.id) return;
    const id = limits.before.id; setBusy(id); setNotice(null);
    const result = await saveAccountControls(limits.before, patch);
    setNotice({ color: result.confirmed ? 'teal' : 'orange', text: result.message });
    if (result.confirmed) { setVerified(previous => ({ ...previous, [id]: { connection: result.current, at: Date.now() } })); setLimits(null); resource.refresh(); onChanged?.(); }
    else setBlocked(id);
    setBusy(null);
  }
  const message = notice ? <Alert color={notice.color} role="status">{notice.text}{blocked ? <Button variant="subtle" size="compact-sm" loading={busy === blocked} onClick={() => inspectCurrent(blocked)}>Read current settings</Button> : null}</Alert> : null;

  return <section ref={panel} tabIndex={-1} className={styles.panel} aria-label="Account control panel" data-density={preferences?.density || 'comfortable'}>
    <div className={styles.heading}><div><h2>Your accounts</h2><Text size="sm" c="dimmed">{matching.length} of {scoped.length} in scope · stored observations</Text></div><Group gap="xs"><Button variant="default" onClick={() => setCustomize(true)}>Customize</Button><Button className={styles.panelRefresh} variant="default" onClick={refresh}>Refresh</Button></Group></div>
    <Group gap="xs" className={styles.statusStrip} aria-label="Account status filters">{[{ value: 'all', label: 'All' }, { value: 'Enabled', label: 'Configured on' }, { value: 'Paused', label: 'Manually paused' }, { value: 'Quota pause', label: 'Quota pause' }, { value: 'Needs attention', label: 'Needs attention' }].map(item => <Button key={item.value} variant={status === item.value ? 'light' : 'subtle'} color={item.value === 'Quota pause' || item.value === 'Needs attention' ? 'orange' : 'gray'} size="compact-sm" aria-pressed={status === item.value} onClick={() => setStatus(item.value)}>{item.label} {scoped.filter(account => matchesState(account, item.value)).length}</Button>)}</Group>
    {scope.start || scope.end ? <Text size="xs" c="dimmed" mt="xs">Attempt period {scope.start || 'earliest retained'} to {scope.end || 'latest retained'}. Account capacity remains a stored observation.</Text> : null}
    {resource.error ? <Alert color="orange">Account settings could not be refreshed. {resource.error}</Alert> : null}
    {message}
    <div className={styles.toolbar}><TextInput aria-label="Search accounts" placeholder="Search accounts or providers" type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} /><NativeSelect aria-label="Account status" value={status} onChange={event => setStatus(event.currentTarget.value)} data={[{ value: 'all', label: 'All states' }, ...STATES.map(state => ({ value: state, label: state }))]} /><SegmentedControl aria-label="Capacity measure" value={mode} onChange={setMode} data={[{ value: 'remaining', label: 'Remaining' }, { value: 'used', label: 'Used' }]} /><SegmentedControl aria-label="Account view" value={view} onChange={setView} data={[{ value: 'cards', label: 'Cards' }, { value: 'compare', label: 'Compare' }]} /></div>
    {!accounts.length && resource.loading ? <Text role="status">Reading configured accounts…</Text> : null}
    <div className={view === 'compare' ? styles.compare : styles.cards}>{matching.map(account => {
      const id = accountControlId(account), state = accountControlState(account, now);
      const windows = accountWindows(account), visibleWindows = windows.filter(window => !hiddenWindows.includes(windowId(id, window.key)));
      return <article key={id} aria-label={account.displayName || account.name || id} className={styles.card} data-selected={selectedAccountId === id || undefined} data-account-id={id}>
        <header className={styles.cardHeader}><button type="button" className={styles.identity} onClick={() => onSelect?.(id)}><ProviderMark provider={account.provider} /><span><strong>{account.displayName || account.name || id}</strong><small>{account.provider}</small></span></button><Badge color={state === 'Enabled' ? 'teal' : state === 'Paused' ? 'gray' : 'orange'} variant="light">{state}</Badge></header>
        <div className={styles.windows}>{visibleWindows.map(window => <QuotaMeter key={window.key} window={window} now={now} mode={mode} onInspect={() => onSelect?.(id, window.key)} />)}{!windows.length ? <div className={styles.emptyWindow}>No quota window recorded.<br/>Usage and reset are unknown.</div> : !visibleWindows.length ? <Text size="sm" c="dimmed">All windows hidden in Customize.</Text> : null}</div>
        <footer className={styles.cardFooter}><span>{account.priority != null ? `Priority ${account.priority}` : 'Priority unknown'}{Number.isFinite(account.activity?.records) ? ` · ${number(account.activity.records)} attempts in selected period` : ''}</span><Group gap="xs"><Button size="compact-sm" variant="default" disabled={!!busy || !!blocked || typeof account.isActive !== 'boolean'} onClick={() => pause(account)}>{account.isActive === false ? 'Resume' : 'Pause'}</Button><Button size="compact-sm" variant="light" disabled={!!busy || !!blocked} onClick={event => openLimits(account, event.currentTarget)}>Limits</Button><Button size="compact-sm" variant="subtle" onClick={() => onSelect?.(id)}>Details</Button></Group></footer>
      </article>;
    })}</div>
    {!matching.length && !resource.loading ? <div className={styles.empty}><h3>No accounts match this view</h3><Text size="sm">Clear filters or restore hidden accounts to see the configured collection.</Text><Group mt="sm"><Button variant="default" onClick={() => { setQuery(''); setStatus('all'); }}>Clear filters</Button><Button variant="subtle" onClick={() => setPreferences(previous => ({ ...previous, hiddenAccounts: [], hiddenWindows: [] }))}>Show all accounts and windows</Button></Group></div> : null}
    <Modal opened={customize} onClose={() => setCustomize(false)} title="Customize account panel" size="lg"><Text size="sm" c="dimmed">Visibility changes affect this browser only. Hidden accounts still route requests.</Text><SegmentedControl mt="md" aria-label="Account density" value={preferences?.density || 'comfortable'} onChange={density => setPreferences(previous => ({ ...previous, density }))} data={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />{scoped.map(account => { const id = accountControlId(account); return <div className={styles.preference} key={id}><Checkbox label={`Show ${account.displayName || account.name || id}`} checked={!hiddenAccounts.includes(id)} onChange={event => preference('hiddenAccounts', id, !event.currentTarget.checked)} />{accountWindows(account).map(window => <Checkbox ml="lg" mt="xs" key={window.key} label={window.key} checked={!hiddenWindows.includes(windowId(id, window.key))} onChange={event => preference('hiddenWindows', windowId(id, window.key), !event.currentTarget.checked)} />)}</div>; })}<Button mt="md" variant="default" onClick={() => setPreferences({ hiddenAccounts: [], hiddenWindows: [], density: 'comfortable' })}>Restore default view</Button></Modal>
    <Modal opened={!!limits} returnFocus={false} onExitTransitionEnd={() => { const trigger = limitsOrigin.current; if (trigger?.isConnected && !trigger.disabled) trigger.focus(); else panel.current?.focus(); }} onClose={() => { if (!busy) { setLimits(null); if (!blocked) setNotice(null); } }} title={limits ? `Limits for ${limits.name}` : 'Account limits'} size="lg" closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}>
      <Text size="sm">Pause applies to upcoming requests when any configured window has remaining capacity at or below its threshold. Set 0 to turn auto-pause off for that window. Unlimited or unknown quota does not trigger this pause. Active requests continue; other routing gates still apply after resuming.</Text>
      {limits ? <><NumberInput mt="md" label="Fallback priority" description="Whole number, at least 1. Priority breaks routing ties; quota and other routing rules can take precedence. Saved priorities may be renumbered." min={1} allowDecimal={false} value={limits.priority} onChange={priority => setLimits(previous => ({ ...previous, priority }))} disabled={!!busy} /><div className={styles.limitFields}>{Object.entries(limits.thresholds).map(([key, value]) => <NumberInput key={key} label={key} description="Pause at or below this remaining percentage; 0 is off" suffix="%" min={0} max={100} value={value} onChange={next => setLimits(previous => ({ ...previous, thresholds: { ...previous.thresholds, [key]: next } }))} disabled={!!busy} />)}</div>{!Object.keys(limits.thresholds).length ? <Text mt="md" size="sm">No quota windows are recorded for this account yet. Priority remains editable.</Text> : null}{notice ? <div className={styles.modalNotice}>{message}</div> : null}<Group mt="lg" justify="end"><Button variant="default" disabled={!!busy} onClick={() => { setLimits(null); if (!blocked) setNotice(null); }}>Cancel</Button><Button loading={busy === limits.before.id} disabled={!patch || !!busy || blocked === limits.before.id} onClick={saveLimits}>Save limits</Button></Group></> : null}
    </Modal>
  </section>;
}
