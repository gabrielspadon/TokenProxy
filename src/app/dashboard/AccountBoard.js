'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Loader,
  SegmentedControl,
  Select,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Icon } from '@/shared/components/Icon';
import { CommitNumber, NameField } from '@/shared/workspace/CommitFields';
import { ProviderMark, providerIdentity } from '@/shared/components/ProviderMark';
import { call } from '@/shared/api';
import { useResource } from '@/shared/workspace/useResource';
import { useWorkspace, analyticsUrl } from '@/shared/workspace/WorkspaceProvider';
import {
  accountControlBaseline,
  accountControlEvidence,
  accountControlId,
  accountWindowStale,
  accountWindowTime,
  mergeAccountControls,
  readAccountControls,
  saveAccountControls,
  sortAccountControls,
} from './accountControlPanelModel';
import { applyDrainChanges } from './capacityControlsModel';
import { HiddenCount, HiddenWindows, QuotaLine, useHiddenWindows } from './QuotaLine';
import { ResetHorizon, UsageLine } from './ActivityEvidence';
import {
  BUCKETS,
  SECTIONS,
  SORTS,
  accountBucket,
  accountEvidence,
  accountReturnsAt,
  accountSeat,
  accountSection,
  accountStateWord,
  filterAccounts,
  fleetSummary,
  headroomOf,
  orderSection,
  providerList,
  sectionSummary,
  visibleWindowLines,
  windowLines,
} from './accountBoardModel';
import { AccountDetail } from './AccountDetail';
import { AddAccountRow } from './AddAccountRow';
import styles from '@/shared/workspace/board.module.css';

const EMPTY = [];
const TONE = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, bucket.tone]));
// How much the card is entitled to claim, said in the operator's words rather
// than the ranker's. `fresh` needs no badge: it is the case the meters already
// describe, and a badge on every card is a badge that means nothing.
const EVIDENCE_NOTE = {
  stale: { label: 'Reading is old', title: 'The last quota read is past the freshness line.' },
  unknown: {
    label: 'No reading',
    title: 'No readable quota window. Shown here because it has served work or passed its test.',
  },
};
const number = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value)
    : '—';
const compact = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
    : '—';
const pct = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '—');
const toast = (color, message, title) =>
  notifications.show({ color, message, title, autoClose: color === 'teal' ? 4000 : 9000 });
const failure = (body, status) =>
  typeof body?.error === 'string' ? body.error : body?.error?.message || `Refused (${status})`;

// Admission verdicts for the shared model, one request per provider present.
function useEligibility(model, providers) {
  const [verdicts, setVerdicts] = useState({ key: null, byAccount: {} });
  const key = model ? JSON.stringify([model, providers]) : null;
  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    Promise.all(
      providers.map((provider) =>
        fetch(`/api/admin/eligibility?${new URLSearchParams({ provider, model })}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null)
      )
    ).then((results) => {
      const byAccount = {};
      for (const result of results)
        for (const account of result?.accounts || EMPTY) byAccount[account.connectionId] = account;
      setVerdicts({ key, byAccount });
    });
    return () => controller.abort();
  }, [key, model, providers]);
  return key && verdicts.key === key ? verdicts.byAccount : {};
}

function AccountRow({
  account,
  advanced,
  now,
  anchor,
  expanded,
  selectedScope,
  busy,
  verdict,
  compared,
  onCompare,
  onToggle,
  onInspect,
  onRename,
  onPause,
  hiddenWindows,
  onHideWindow,
  onDrain,
  onPriority,
  onThreshold,
}) {
  const id = accountControlId(account);
  const name = account.displayName || account.name || id;
  const bucket = accountBucket(account, now);
  const word = accountStateWord(account, now);
  const evidence = accountControlEvidence(account, now);
  const paused = account.isActive === false;
  const draining = account.drain?.isDraining ?? account.isDraining;
  const lines = visibleWindowLines(account, hiddenWindows, now);
  const [showHidden, setShowHidden] = useState(false);
  const editable = Boolean(accountControlBaseline(account, id)) && !busy;
  const record = account.activity;
  return (
    <article
      className={styles.row}
      data-account-id={id}
      data-expanded={expanded || undefined}
      data-bucket={bucket}
      aria-label={name}
    >
      <div className={styles.main}>
        <Tooltip label={expanded ? 'Collapse' : 'Details'}>
          <button
            type="button"
            className={styles.caret}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
            onClick={() => onToggle(null)}
          >
            <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
          </button>
        </Tooltip>
        {advanced ? (
          <label className={styles.compare}>
            <Checkbox
              size="sm"
              aria-label={`Compare ${name}`}
              checked={compared}
              onChange={(event) => onCompare(event.currentTarget.checked)}
            />
          </label>
        ) : null}
        <div className={styles.identity}>
          <ProviderMark provider={account.provider} size="small" />
          <div className={styles.identityText}>
            <NameField
              name={name}
              disabled={!!busy}
              expanded={expanded}
              onOpen={() => onToggle(null)}
              onCommit={onRename}
            />
            <small>
              {providerIdentity(account.provider).name}
              {account.email ? ` · ${account.email}` : ''}
            </small>
          </div>
        </div>
        <div className={styles.state}>
          <Tooltip
            label={[evidence.health, ...evidence.gates, account.lastError]
              .filter(Boolean)
              .join('. ')}
          >
            <span className={styles.stateWord} data-tone={TONE[bucket]}>
              <i />
              {word}
            </span>
          </Tooltip>
          {verdict ? (
            <Badge
              size="xs"
              variant="light"
              color={
                verdict.verdict === 'admissible'
                  ? 'teal'
                  : verdict.verdict === 'blocked'
                    ? 'orange'
                    : 'gray'
              }
              title={verdict.reasons?.map((reason) => reason.label).join('; ') || undefined}
            >
              {verdict.verdict}
            </Badge>
          ) : null}
          <HiddenCount
            hidden={lines.hidden}
            name={name}
            open={showHidden}
            onToggle={() => setShowHidden((value) => !value)}
          />
        </div>
        <div className={styles.quota}>
          {lines.shown.map((window) => (
            <QuotaLine
              key={window.key}
              window={window}
              now={now}
              onInspect={onInspect}
              onHide={(key) => onHideWindow(key, true)}
              threshold={
                advanced && !window.unlimited ? (
                  <Tooltip label="Auto-pause when remaining drops to this percentage. 0 turns it off.">
                    <CommitNumber
                      className={styles.pauseAt}
                      aria-label={`Auto-pause threshold for ${window.key}`}
                      value={window.threshold || 0}
                      min={0}
                      max={100}
                      suffix="%"
                      disabled={!editable}
                      onCommit={(next) => onThreshold(window.key, next)}
                    />
                  </Tooltip>
                ) : null
              }
            />
          ))}
          {!lines.shown.length && !lines.hidden.length ? (
            <span className={styles.muted}>No quota recorded</span>
          ) : null}
          {showHidden ? (
            <HiddenWindows hidden={lines.hidden} onShow={(key) => onHideWindow(key, false)} />
          ) : null}
        </div>
        <div className={styles.activity}>
          {account.activityState ? (
            <span className={styles.muted}>{account.activityState}</span>
          ) : record ? (
            <span>
              {number(record.records)} attempts
              {record.failed > 0 ? ` · ${number(record.failed)} failed` : ''}
              {account.drain?.activeStreams > 0
                ? ` · ${number(account.drain.activeStreams)} pending`
                : ''}
            </span>
          ) : (
            <span className={styles.muted}>No attempts</span>
          )}
          <UsageLine record={record} state={account.activityState} compact />
        </div>
        <div className={styles.actions}>
          {advanced ? (
            <Tooltip label="Fallback priority within this provider; 1 is tried first">
              <CommitNumber
                className={styles.priority}
                aria-label={`Priority for ${name}`}
                value={account.priority ?? null}
                min={1}
                placeholder="—"
                disabled={!editable}
                onCommit={onPriority}
              />
            </Tooltip>
          ) : null}
          {advanced ? (
            <Tooltip
              label={
                draining
                  ? 'Stop draining: allow new selections again'
                  : 'Drain: block new selections, let active streams finish'
              }
            >
              <ActionIcon
                variant={draining ? 'light' : 'subtle'}
                color={draining ? 'orange' : 'gray'}
                aria-label={`${draining ? 'Stop drain for' : 'Drain'} ${name}`}
                aria-pressed={Boolean(draining)}
                loading={busy === 'drain'}
                disabled={!!busy && busy !== 'drain'}
                onClick={() => onDrain(!draining)}
              >
                <Icon name="i-drain" />
              </ActionIcon>
            </Tooltip>
          ) : null}
          <Tooltip label={paused ? 'Resume' : 'Pause'}>
            <ActionIcon
              variant={paused ? 'light' : 'subtle'}
              color={paused ? 'teal' : 'gray'}
              aria-label={`${paused ? 'Resume' : 'Pause'} ${name}`}
              loading={busy === 'pause'}
              disabled={(!!busy && busy !== 'pause') || typeof account.isActive !== 'boolean'}
              onClick={onPause}
            >
              <Icon name={paused ? 'i-play' : 'i-pause'} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Open in Connections">
            <ActionIcon
              component={Link}
              href={`/dashboard/connections/${encodeURIComponent(id)}`}
              variant="subtle"
              color="gray"
              aria-label={`Open ${name} in Connections`}
            >
              <Icon name="i-open" />
            </ActionIcon>
          </Tooltip>
        </div>
      </div>
      {expanded ? (
        <div className={styles.detail} role="region" aria-label="Selection details">
          <AccountDetail
            key={`${id}:${selectedScope || 'overview'}`}
            row={account}
            anchor={anchor}
            selectedScope={selectedScope}
            verdict={verdict}
          />
        </div>
      ) : null}
    </article>
  );
}

// Everyday: one compact card per account, progress first. Pause, rename and
// expand stay direct; priority, drain, thresholds and comparison live in Advanced.
/**
 * The one number the card exists to show, chosen by which section it is in.
 *
 * Serving leads with headroom because that is what decides where work goes
 * next. Cooling down leads with the return time because nothing else about a
 * drained account changes what the operator does. Unverified leads with the
 * absence itself, which is the honest answer and the reason the card is
 * collapsed by default.
 */
function cardFact(account, section, now) {
  if (section === 'unverified')
    return { value: 'No quota evidence', note: 'Nothing has proved this account works' };
  if (section === 'resting') {
    const returnsAt = accountReturnsAt(account, now);
    if (returnsAt === null)
      return { value: accountStateWord(account, now), note: 'No timed return recorded' };
    const time = accountWindowTime(new Date(returnsAt).toISOString(), now, true);
    return {
      value: time.label.startsWith('Resets in ') ? `Back in ${time.label.slice(10)}` : time.label,
      note: `at ${new Date(returnsAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    };
  }
  const headroom = headroomOf(account, now);
  if (headroom === null) return { value: 'Proven by use', note: 'No quota window to read' };
  return { value: `${number(headroom)}% left`, note: 'Least room across its quota windows' };
}

function AccountCard({
  account,
  now,
  section,
  anchor,
  expanded,
  selectedScope,
  busy,
  verdict,
  onToggle,
  onInspect,
  onRename,
  onPause,
  hiddenWindows,
  onHideWindow,
}) {
  const id = accountControlId(account);
  const name = account.displayName || account.name || id;
  const bucket = accountBucket(account, now);
  const word = accountStateWord(account, now);
  const evidence = accountControlEvidence(account, now);
  const band = EVIDENCE_NOTE[accountEvidence(account, now)];
  const { login, seat } = accountSeat(account);
  const paused = account.isActive === false;
  const lines = visibleWindowLines(account, hiddenWindows, now);
  const [showHidden, setShowHidden] = useState(false);
  const record = account.activity;
  const fact = cardFact(account, section, now);
  return (
    <article
      className={styles.card}
      data-account-id={id}
      data-expanded={expanded || undefined}
      data-bucket={bucket}
      data-section={section}
      aria-label={name}
    >
      <header className={styles.cardHead}>
        <ProviderMark provider={account.provider} size="small" />
        <div className={styles.identityText}>
          <NameField
            name={name}
            display={seat ? login : name}
            disabled={!!busy}
            expanded={expanded}
            onOpen={() => onToggle(null)}
            onCommit={onRename}
          />
          <small>
            {providerIdentity(account.provider).name}
            {seat ? ` · ${seat} seat` : ''}
          </small>
        </div>
        <Tooltip label={paused ? 'Resume' : 'Pause'}>
          <ActionIcon
            variant={paused ? 'light' : 'subtle'}
            color={paused ? 'teal' : 'gray'}
            aria-label={`${paused ? 'Resume' : 'Pause'} ${name}`}
            loading={busy === 'pause'}
            disabled={(!!busy && busy !== 'pause') || typeof account.isActive !== 'boolean'}
            onClick={onPause}
          >
            <Icon name={paused ? 'i-play' : 'i-pause'} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={expanded ? 'Collapse' : 'Details'}>
          <button
            type="button"
            className={styles.caret}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
            onClick={() => onToggle(null)}
          >
            <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
          </button>
        </Tooltip>
      </header>
      {/* One primary fact, always in the same place, always the same size. */}
      <p className={styles.cardFact} title={fact.note || undefined}>
        <strong>{fact.value}</strong>
        <small>{fact.note}</small>
      </p>
      <div className={styles.cardState}>
        <Tooltip
          label={[evidence.health, ...evidence.gates, account.lastError].filter(Boolean).join('. ')}
        >
          <span className={styles.stateWord} data-tone={TONE[bucket]}>
            <i />
            {word}
          </span>
        </Tooltip>
        {band ? (
          <span className={styles.cardBand} title={band.title}>
            {band.label}
          </span>
        ) : null}
        {verdict ? (
          <Badge
            size="xs"
            variant="light"
            color={
              verdict.verdict === 'admissible'
                ? 'teal'
                : verdict.verdict === 'blocked'
                  ? 'orange'
                  : 'gray'
            }
            title={verdict.reasons?.map((reason) => reason.label).join('; ') || undefined}
          >
            {verdict.verdict}
          </Badge>
        ) : null}
        <span className={styles.spacer} />
        <span className={styles.cardAttempts}>
          {account.activityState
            ? account.activityState
            : record
              ? `${number(record.records)} attempts${record.failed > 0 ? ` · ${number(record.failed)} failed` : ''}${account.drain?.activeStreams > 0 ? ` · ${number(account.drain.activeStreams)} pending` : ''}`
              : 'No attempts'}
        </span>
        <HiddenCount
          hidden={lines.hidden}
          name={name}
          open={showHidden}
          onToggle={() => setShowHidden((value) => !value)}
        />
      </div>
      <div className={styles.cardWindows}>
        <UsageLine record={record} state={account.activityState} />
        {lines.shown.map((window) => (
          <QuotaLine
            key={window.key}
            window={window}
            now={now}
            onInspect={onInspect}
            onHide={(key) => onHideWindow(key, true)}
          />
        ))}
        {showHidden ? (
          <HiddenWindows hidden={lines.hidden} onShow={(key) => onHideWindow(key, false)} />
        ) : null}
      </div>
      {expanded ? (
        <div className={styles.detail} role="region" aria-label="Selection details">
          <AccountDetail
            key={`${id}:${selectedScope || 'overview'}`}
            row={account}
            anchor={anchor}
            selectedScope={selectedScope}
            verdict={verdict}
          />
        </div>
      ) : null}
    </article>
  );
}

function ComparisonRow({ account, now }) {
  const { scope, observeSnapshot } = useWorkspace();
  const id = accountControlId(account);
  const excluded =
    (scope.provider && scope.provider !== account.provider) ||
    (scope.connectionId && scope.connectionId !== id);
  const resource = useResource(
    excluded ? null : analyticsUrl({ ...scope, connectionId: id }, 'activity', { pageSize: 1 }),
    { onSnapshot: observeSnapshot }
  );
  const record = resource.error ? null : resource.data?.summary;
  return (
    <Table.Tr>
      <Table.Td>{account.displayName || account.name || id}</Table.Td>
      <Table.Td>{accountStateWord(account, now)}</Table.Td>
      <Table.Td>
        {excluded
          ? 'Excluded by scope'
          : resource.loading
            ? 'Reading…'
            : resource.error
              ? 'Unavailable'
              : number(record?.records)}
      </Table.Td>
      <Table.Td>{number(record?.inputSamples > 0 ? record.inputTokens : NaN)}</Table.Td>
      <Table.Td>{number(record?.cacheReadSamples > 0 ? record.cacheReadTokens : NaN)}</Table.Td>
      <Table.Td>{pct(record?.cacheReadFraction)}</Table.Td>
      <Table.Td>{windowLines(account).length}</Table.Td>
    </Table.Tr>
  );
}

// `anchor` is the evidence clock the detail views read (a number, 0 until the
// quota list answers); `now` is the ranking clock, which the page pins to the
// snapshot in an isolated preview and to the wall clock otherwise.
export function AccountBoard({
  rows,
  drains,
  anchor,
  now,
  advanced,
  density,
  onDensity,
  onChanged,
}) {
  const {
    scope,
    setScope,
    selectedAccountId,
    setSelectedAccountId,
    selectedRecord,
    comparisonIds,
    setComparisonIds,
    health,
    snapshot,
  } = useWorkspace();
  const resource = useResource('/api/providers');
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  // Serving state is the primary axis and health the secondary one. They are
  // separate state because they compose: narrowing to "cooling down" is not a
  // request to forget which of those are also paused.
  const [section, setSection] = useState(null);
  const [sort, setSort] = useState('name');
  const [sortAt, setSortAt] = useState(now);
  const [busy, setBusy] = useState({});
  const [adding, setAdding] = useState(false);
  const [comparing, setComparing] = useState(false);
  const { hiddenWindows, setWindowHidden: hideWindow } = useHiddenWindows();
  const accounts = useMemo(
    () => mergeAccountControls(resource.data?.connections, rows),
    [resource.data, rows]
  );
  const providers = useMemo(() => providerList(accounts), [accounts]);
  const scoped = accounts.filter(
    (account) =>
      (!scope.provider || account.provider === scope.provider) &&
      (!scope.connectionId || accountControlId(account) === scope.connectionId)
  );
  const summary = fleetSummary(scoped, now);
  const sections = sectionSummary(scoped, now);
  const visible = sortAccountControls(
    filterAccounts(scoped, { query, bucket, section }, now),
    sort,
    sortAt
  );
  const verdicts = useEligibility(scope.model, providers);
  const compared = accounts.filter((account) => comparisonIds.includes(accountControlId(account)));
  const selectedScope = selectedRecord?.windowScope || null;
  const inventoryKnown = Array.isArray(resource.data?.connections);
  const empty = inventoryKnown && !accounts.length && !resource.loading && !resource.error;

  // Refresh re-reads quota from every account on the board (a forced live
  // provider read per account, three at a time, honouring the probe gate),
  // then reads the retained evidence back. Without force the usage route
  // serves its recent cache, which is what left the meters unchanged. An
  // isolated snapshot has no providers to ask, so it only re-reads what is
  // retained.
  const [reading, setReading] = useState(null);
  // After one account changed, read the retained evidence back; the live
  // provider read of every account belongs to the Refresh button alone.
  function reread() {
    setSortAt(now);
    resource.refresh();
    onChanged?.();
  }
  async function readQuota(id) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await call(`/api/usage/${encodeURIComponent(id)}?force=1`);
      if (response.status !== 429) return response;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { ok: false, status: 429, body: { error: 'the probe gate stayed busy' } };
  }
  async function refresh() {
    setSortAt(now);
    if (reading) return;
    const targets = snapshot?.isolated ? [] : scoped;
    if (targets.length) {
      setReading({ done: 0, total: targets.length });
      const outcome = { read: 0, skipped: 0, failed: [] };
      const queue = [...targets];
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (queue.length) {
            const account = queue.shift();
            const id = accountControlId(account);
            const response = await readQuota(id);
            if (response.ok && response.body?.message && !response.body?.error)
              outcome.skipped += 1;
            else if (response.ok && !response.body?.error) outcome.read += 1;
            else
              outcome.failed.push(
                `${account.displayName || account.name || id}: ${response.body?.error || `HTTP ${response.status}`}`
              );
            setReading((state) => state && { ...state, done: state.done + 1 });
          }
        })
      );
      setReading(null);
      const summary = `${outcome.read} of ${targets.length} accounts re-read${outcome.skipped ? `, ${outcome.skipped} without a quota source` : ''}${outcome.failed.length ? `. ${outcome.failed.length} failed: ${outcome.failed.slice(0, 3).join(' · ')}${outcome.failed.length > 3 ? ' · …' : ''}` : '.'}`;
      toast(outcome.failed.length ? 'orange' : 'teal', summary, 'Quota re-read');
    }
    resource.refresh();
    onChanged?.();
  }
  async function mutate(id, kind, run) {
    if (busy[id]) return;
    setBusy((previous) => ({ ...previous, [id]: kind }));
    try {
      await run();
    } catch (error) {
      toast('orange', error.message);
    } finally {
      setBusy((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
    }
  }
  // `patch` may be a function of the freshly read baseline, so a write that
  // merges into a map (a window's threshold) merges into what is stored now
  // rather than into what this row rendered a moment ago.
  function savePolicy(account, kind, patch, label) {
    const id = accountControlId(account);
    return mutate(id, kind, async () => {
      const current = await readAccountControls(id);
      if (!accountControlBaseline(current, id))
        throw new Error('Current settings are incomplete, so this account cannot be edited yet.');
      const result = await saveAccountControls(
        current,
        typeof patch === 'function' ? patch(current) : patch
      );
      toast(
        result.confirmed ? 'teal' : 'orange',
        result.confirmed ? `${label} saved and read back.` : result.message,
        account.displayName || account.name || id
      );
      reread();
    });
  }
  function rename(account, name) {
    const id = accountControlId(account);
    return mutate(id, 'rename', async () => {
      const response = await call(`/api/providers/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: { name },
      });
      if (!response.ok) throw new Error(failure(response.body, response.status));
      const saved = await readAccountControls(id);
      if (saved.name !== name)
        throw new Error('The rename returned, but the saved name did not read back.');
      toast('teal', `Renamed to ${name}.`);
      reread();
    });
  }
  function drain(targets, isDraining) {
    return mutate(targets.map(accountControlId).join(','), 'drain', async () => {
      const prepared = targets.map((account) => ({
        ...drains.data?.connections?.find(
          (item) => item.connectionId === accountControlId(account)
        ),
        connectionId: accountControlId(account),
        name: account.displayName || account.name || accountControlId(account),
      }));
      const outcomes = await applyDrainChanges(prepared, isDraining);
      for (const outcome of outcomes)
        toast(
          outcome.state === 'confirmed' ? 'teal' : 'orange',
          outcome.message,
          prepared.find((item) => item.connectionId === outcome.connectionId)?.name
        );
      reread();
    });
  }
  const rowBusy = (id) =>
    busy[id] || (Object.keys(busy).find((key) => key.split(',').includes(id)) && 'drain');
  const toggle = (id, windowScope = null) => {
    if (selectedAccountId === id && !windowScope) setSelectedAccountId(null);
    else setSelectedAccountId(id, windowScope);
  };

  return (
    <section
      className={styles.board}
      aria-label="Account control panel"
      data-advanced={advanced || undefined}
      data-layout={advanced ? 'rows' : 'cards'}
      data-density={density}
    >
      {/* Serving state first: what takes work now, what is out and when it
          returns, and what nothing has proved. Health sits below it on its own
          row, because "paused" and "attention" answer a different question and
          neither axis replaces the other. One chip per section, counting the
          same accounts the sections below hold. */}
      <div className={styles.fleet} role="group" aria-label="Capacity summary" data-axis="capacity">
        <button
          type="button"
          className={styles.fleetChip}
          aria-pressed={!section}
          onClick={() => setSection(null)}
        >
          <strong>{scoped.length}</strong> accounts
        </button>
        {SECTIONS.map((item) => (
          <button
            type="button"
            key={item.id}
            className={styles.fleetChip}
            data-tone={item.tone}
            aria-pressed={section === item.id}
            title={item.note}
            onClick={() => setSection(section === item.id ? null : item.id)}
          >
            <i />
            <strong>{sections[item.id]}</strong> {item.label.toLowerCase()}
          </button>
        ))}
        <span className={styles.spacer} />
        <Text size="xs" c="dimmed" className={styles.fleetNote}>
          {health.loading || (resource.loading && !accounts.length)
            ? 'Reading accounts…'
            : advanced
              ? 'Edits save on Enter or blur'
              : 'Advanced view adds priority, drain and auto-pause'}
        </Text>
      </div>
      <div className={styles.fleet} role="group" aria-label="Health summary" data-axis="health">
        <span className={styles.axisLabel}>Health</span>
        <button
          type="button"
          className={styles.fleetChip}
          aria-pressed={!bucket}
          onClick={() => setBucket(null)}
        >
          <strong>{scoped.length}</strong> all
        </button>
        {BUCKETS.filter((item) => summary[item.id] > 0 || item.id !== 'unknown').map((item) => (
          <button
            type="button"
            key={item.id}
            className={styles.fleetChip}
            data-tone={item.tone}
            aria-pressed={bucket === item.id}
            onClick={() => setBucket(bucket === item.id ? null : item.id)}
          >
            <i />
            <strong>{summary[item.id]}</strong> {item.label.toLowerCase()}
          </button>
        ))}
      </div>
      <div className={styles.toolbar}>
        <TextInput
          size="xs"
          type="search"
          aria-label="Search accounts"
          placeholder="Search"
          leftSection={<Icon name="i-search" />}
          className={styles.search}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {providers.length > 1 ? (
          <div className={styles.providers} role="group" aria-label="Provider filter">
            {providers.map((provider) => (
              <Tooltip key={provider} label={providerIdentity(provider).name}>
                <button
                  type="button"
                  className={styles.providerChip}
                  aria-label={`${providerIdentity(provider).name} accounts`}
                  aria-pressed={scope.provider === provider}
                  onClick={() =>
                    setScope({
                      provider: scope.provider === provider ? null : provider,
                      connectionId: null,
                      model: null,
                    })
                  }
                >
                  <ProviderMark provider={provider} size="small" />
                </button>
              </Tooltip>
            ))}
          </div>
        ) : null}
        {advanced ? (
          <Select
            size="xs"
            aria-label="Sort accounts"
            data={SORTS}
            value={sort}
            onChange={(value) => {
              if (!value) return;
              setSort(value);
              setSortAt(now);
            }}
            leftSection={<Icon name="i-sort" />}
            className={styles.sort}
            allowDeselect={false}
          />
        ) : null}
        <Tooltip label="How much room each account takes">
          <SegmentedControl
            size="xs"
            aria-label="Density"
            value={density}
            onChange={onDensity}
            data={[
              { value: 'comfy', label: 'Comfy' },
              { value: 'tidy', label: 'Tidy' },
            ]}
            className={styles.density}
          />
        </Tooltip>
        <span className={styles.spacer} />
        {advanced ? (
          <Button
            size="xs"
            variant={comparisonIds.length > 1 ? 'light' : 'default'}
            disabled={comparisonIds.length < 2}
            leftSection={<Icon name="i-compare" />}
            aria-pressed={comparing}
            onClick={() => setComparing((previous) => !previous)}
          >
            Compare{comparisonIds.length ? ` (${comparisonIds.length})` : ''}
          </Button>
        ) : null}
        {advanced && comparisonIds.length ? (
          <Tooltip label="Clear comparison selection">
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Clear comparison selection"
              onClick={() => {
                setComparisonIds([]);
                setComparing(false);
              }}
            >
              <Icon name="i-close" />
            </ActionIcon>
          </Tooltip>
        ) : null}
        <Button
          size="xs"
          leftSection={<Icon name="i-add" />}
          aria-expanded={adding}
          onClick={() => setAdding((previous) => !previous)}
        >
          Add account
        </Button>
        {reading ? (
          <span className={styles.muted} role="status" aria-live="polite">
            {reading.done} / {reading.total}
          </span>
        ) : null}
        <Tooltip
          label={
            snapshot?.isolated
              ? 'Re-read the retained evidence'
              : 'Re-read quota from every account on the board, then the retained evidence'
          }
        >
          <ActionIcon
            variant="default"
            aria-label="Refresh accounts"
            loading={Boolean(reading)}
            onClick={refresh}
          >
            <Icon name="i-refresh" />
          </ActionIcon>
        </Tooltip>
      </div>
      {adding ? (
        <AddAccountRow
          onClose={() => setAdding(false)}
          onAdded={(connection) => {
            if (connection) toast('teal', `${connection.name || connection.id} added.`);
            reread();
          }}
        />
      ) : null}
      {visible.length ? (
        <ResetHorizon rows={visible} anchor={anchor} onSelect={(id, scope) => toggle(id, scope)} />
      ) : null}
      {advanced && comparing && compared.length > 1 ? (
        <div
          className={styles.comparison}
          role="region"
          aria-label="Exact account comparison totals"
        >
          <div className={styles.comparisonHead}>
            <strong>Compare {compared.length} accounts</strong>
            <span className={styles.muted}>Same shared interval · recorded quantities</span>
            <span className={styles.spacer} />
            <Button
              size="compact-xs"
              variant="default"
              leftSection={<Icon name="i-drain" />}
              disabled={!!busy[compared.map(accountControlId).join(',')]}
              onClick={() => drain(compared, true)}
            >
              Drain all
            </Button>
            <Button
              size="compact-xs"
              variant="default"
              leftSection={<Icon name="i-play" />}
              disabled={!!busy[compared.map(accountControlId).join(',')]}
              onClick={() => drain(compared, false)}
            >
              Stop drain
            </Button>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Close comparison"
              onClick={() => setComparing(false)}
            >
              <Icon name="i-close" />
            </ActionIcon>
          </div>
          <Table striped className={styles.evidenceTable}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Account</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th>Attempts</Table.Th>
                <Table.Th>Input tokens</Table.Th>
                <Table.Th>Cached reads</Table.Th>
                <Table.Th>Cache read share</Table.Th>
                <Table.Th>Quota windows</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {compared.map((account) => (
                <ComparisonRow key={accountControlId(account)} account={account} now={now} />
              ))}
            </Table.Tbody>
          </Table>
        </div>
      ) : null}
      {resource.error ? (
        <Text size="xs" c="orange.8" role="alert" className={styles.notice}>
          Account settings could not be refreshed. {resource.error}
        </Text>
      ) : null}
      {health.error ? (
        <Text size="xs" c="orange.8" role="alert" className={styles.notice}>
          {health.error}
        </Text>
      ) : null}
      {advanced ? (
        <div className={styles.head} aria-hidden="true">
          <span />
          <span />
          <span>Account</span>
          <span>State</span>
          <span>Quota remaining</span>
          <span>Activity</span>
          <span>Priority · drain · pause</span>
        </div>
      ) : null}
      {/* One section per serving state, flat. Grouping by login used to come
          first, which put a drained seat and a full one under one heading and
          left the operator to work out which was which. The seat relationship
          survives as a label on each card; the nesting does not. Within a
          section the order is the section's own question: most headroom where
          work goes next, soonest return where the operator is waiting. */}
      {!advanced
        ? SECTIONS.map((item) => {
            const members = orderSection(
              visible.filter((account) => accountSection(account, now) === item.id),
              item.id,
              now
            );
            if (!members.length) return null;
            const cards = members.map((account) => {
              const id = accountControlId(account);
              return (
                <AccountCard
                  key={id}
                  account={account}
                  now={now}
                  section={item.id}
                  anchor={anchor}
                  expanded={selectedAccountId === id}
                  selectedScope={selectedAccountId === id ? selectedScope : null}
                  busy={rowBusy(id)}
                  verdict={verdicts[id]}
                  onToggle={() => toggle(id)}
                  onInspect={(windowScope) => toggle(id, windowScope)}
                  onRename={(name) => rename(account, name)}
                  hiddenWindows={hiddenWindows}
                  onHideWindow={(key, hide) => hideWindow(account, key, hide)}
                  onPause={() =>
                    savePolicy(
                      account,
                      'pause',
                      { isActive: account.isActive === false },
                      account.isActive === false ? 'Resume' : 'Pause'
                    )
                  }
                />
              );
            });
            const count = `${members.length} ${members.length === 1 ? 'account' : 'accounts'}`;
            // An unverified account has nothing to show and nothing proving it
            // works, so it is listed rather than laid out: it stays one click
            // away instead of taking a card's worth of room from the accounts
            // that are actually serving.
            if (item.id === 'unverified')
              return (
                <details key={item.id} className={styles.group} data-collapsed="">
                  <summary className={styles.groupTitle} data-tone={item.tone}>
                    <i />
                    {item.label}
                    <span>
                      {count} · {item.note}
                    </span>
                  </summary>
                  <div className={styles.cards}>{cards}</div>
                </details>
              );
            return (
              <section key={item.id} className={styles.group} aria-label={`${item.label} accounts`}>
                <h3 className={styles.groupTitle} data-tone={item.tone}>
                  <i />
                  {item.label}
                  <span>
                    {count} · {item.note}
                  </span>
                </h3>
                <div className={styles.cards}>{cards}</div>
              </section>
            );
          })
        : null}
      <div className={styles.rows} hidden={!advanced}>
        {advanced &&
          visible.map((account) => {
            const id = accountControlId(account);
            return (
              <AccountRow
                key={id}
                account={account}
                advanced={advanced}
                now={now}
                anchor={anchor}
                expanded={selectedAccountId === id}
                selectedScope={selectedAccountId === id ? selectedScope : null}
                busy={rowBusy(id)}
                verdict={verdicts[id]}
                compared={comparisonIds.includes(id)}
                onCompare={(checked) =>
                  setComparisonIds(
                    checked
                      ? [...new Set([...comparisonIds, id])].slice(0, 4)
                      : comparisonIds.filter((value) => value !== id)
                  )
                }
                onToggle={() => toggle(id)}
                onInspect={(windowScope) => toggle(id, windowScope)}
                onRename={(name) => rename(account, name)}
                hiddenWindows={hiddenWindows}
                onHideWindow={(key, hide) => hideWindow(account, key, hide)}
                onPause={() =>
                  savePolicy(
                    account,
                    'pause',
                    { isActive: account.isActive === false },
                    account.isActive === false ? 'Resume' : 'Pause'
                  )
                }
                onDrain={(isDraining) => drain([account], isDraining)}
                onPriority={(priority) => savePolicy(account, 'save', { priority }, 'Priority')}
                onThreshold={(key, threshold) =>
                  savePolicy(
                    account,
                    'save',
                    (current) => ({
                      quotaPauseThresholds: {
                        ...(current.quotaPauseThresholds || {}),
                        [key]: threshold,
                      },
                    }),
                    `Auto-pause for ${key}`
                  )
                }
              />
            );
          })}
      </div>
      <div className={styles.messages}>
        {health.loading && !accounts.length ? (
          <div className={styles.empty}>
            <Loader size="xs" /> Reading accounts…
          </div>
        ) : null}
        {empty ? (
          <div className={styles.empty}>
            No accounts connected yet. Add one above; its usage and quota will appear here.
          </div>
        ) : null}
        {!visible.length && accounts.length ? (
          <div className={styles.empty}>
            No accounts match.{' '}
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                setQuery('');
                setBucket(null);
                setSection(null);
                if (scope.provider || scope.connectionId)
                  setScope({ provider: null, connectionId: null });
              }}
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
