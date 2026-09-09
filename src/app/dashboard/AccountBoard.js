'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Loader,
  NumberInput,
  SegmentedControl,
  Select,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { Icon } from '@/shared/components/Icon';
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
import {
  BUCKETS,
  SORTS,
  accountBucket,
  accountStateWord,
  filterAccounts,
  fleetSummary,
  orderCards,
  providerList,
  resetShort,
  visibleWindowLines,
  windowHiddenId,
  windowLevel,
  windowLines,
} from './accountBoardModel';
import { AccountDetail } from './AccountDetail';
import { AddAccountRow } from './AddAccountRow';
import styles from './accountBoard.module.css';

const EMPTY = [];
const TONE = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, bucket.tone]));
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

// Commits on Enter or blur, reverts on Escape. The draft is React state, so a
// re-render that lands while a value is being typed cannot wipe it; a revert
// remounts the input so the formatted saved value is what shows. A Tooltip
// parent injects its own onBlur/onKeyDown through cloneElement, so those are
// chained rather than spread over.
export function CommitNumber({ value, onCommit, onBlur, onKeyDown, ...props }) {
  const [draft, setDraft] = useState(value ?? '');
  const [seen, setSeen] = useState(value);
  const [revision, setRevision] = useState(0);
  const sent = useRef(null);
  if (seen !== value) {
    setSeen(value);
    setDraft(value ?? '');
  }
  useEffect(() => {
    sent.current = null;
  }, [value]);
  const revert = () => {
    setDraft(value ?? '');
    setRevision((previous) => previous + 1);
  };
  const commit = () => {
    const next = Number(draft);
    if (draft === '' || !Number.isFinite(next) || next === (value ?? NaN)) {
      revert();
      return;
    }
    if (sent.current === next) return;
    sent.current = next;
    onCommit(next);
  };
  return (
    <NumberInput
      key={`${value ?? ''}:${revision}`}
      size="xs"
      hideControls
      allowDecimal={false}
      value={draft}
      onChange={setDraft}
      {...props}
      onBlur={(event) => {
        onBlur?.(event);
        commit();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') revert();
      }}
    />
  );
}

export function NameField({ name, disabled, onCommit, onOpen, expanded }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [cancelled, setCancelled] = useState(false);
  if (!editing)
    return (
      <span className={styles.nameLine}>
        <button
          type="button"
          className={styles.nameButton}
          aria-expanded={expanded}
          onClick={onOpen}
        >
          {name}
        </button>
        <Tooltip label="Rename">
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Rename ${name}`}
            disabled={disabled}
            onClick={() => {
              setDraft(name);
              setCancelled(false);
              setEditing(true);
            }}
          >
            <Icon name="i-edit" />
          </button>
        </Tooltip>
      </span>
    );
  const finish = () => {
    setEditing(false);
    const next = draft.trim();
    if (!cancelled && next && next !== name) onCommit(next);
  };
  return (
    <TextInput
      size="xs"
      autoFocus
      aria-label={`Account name for ${name}`}
      value={draft}
      maxLength={120}
      className={styles.nameInput}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish();
        }
        if (event.key === 'Escape') {
          setCancelled(true);
          setEditing(false);
        }
      }}
    />
  );
}

function QuotaLine({ window, now, advanced, disabled, onInspect, onThreshold, onHide }) {
  const known = Number.isFinite(window.remaining) && !window.unlimited;
  const stale = accountWindowStale(window, now);
  const level = windowLevel(window);
  const observed = accountWindowTime(window.observedAt, now);
  const reset = accountWindowTime(window.resetAt, now, true);
  const evidence = `${window.key}: ${known ? `${number(window.remaining)}% remaining` : window.unlimited ? 'unlimited' : 'remaining unknown'}. ${observed.label}. ${reset.label}.${window.threshold > 0 ? ` Auto-pause at ${number(window.threshold)}% remaining.` : ''}`;
  return (
    <div className={styles.line} data-stale={stale || undefined} data-level={level || undefined}>
      <button
        type="button"
        className={styles.lineLabel}
        title={evidence}
        onClick={() => onInspect(window.key)}
      >
        {window.label}
      </button>
      <Tooltip label={evidence}>
        <div
          className={styles.meter}
          role={known ? 'meter' : undefined}
          aria-label={known ? `${window.key} remaining` : undefined}
          aria-valuemin={known ? 0 : undefined}
          aria-valuemax={known ? 100 : undefined}
          aria-valuenow={known ? window.remaining : undefined}
          aria-valuetext={known ? `${number(window.remaining)} percent remaining` : undefined}
          data-unknown={!known || undefined}
        >
          {known ? <span className={styles.fill} style={{ width: `${window.remaining}%` }} /> : null}
          {window.threshold > 0 && !window.unlimited ? (
            <span className={styles.threshold} style={{ left: `${window.threshold}%` }} />
          ) : null}
        </div>
      </Tooltip>
      <span className={styles.lineValue}>
        {window.unlimited ? '∞' : known ? `${number(window.remaining)}%` : '—'}
      </span>
      <span className={styles.lineReset}>{resetShort(window, now)}</span>
      {advanced && !window.unlimited ? (
        <Tooltip label="Auto-pause when remaining drops to this percentage. 0 turns it off.">
          <CommitNumber
            className={styles.pauseAt}
            aria-label={`Auto-pause threshold for ${window.key}`}
            value={window.threshold || 0}
            min={0}
            max={100}
            suffix="%"
            disabled={disabled}
            onCommit={(next) => onThreshold(window.key, next)}
          />
        </Tooltip>
      ) : null}
      <Tooltip label="Hide this window">
        <button
          type="button"
          className={styles.lineHide}
          aria-label={`Hide ${window.label}`}
          onClick={() => onHide(window.key, true)}
        >
          <Icon name="i-hide" />
        </button>
      </Tooltip>
    </div>
  );
}

// Windows that are off the card, with the way back for the ones the person
// hid. A window hidden by the depletion rule returns on its own.
function HiddenWindows({ hidden, onHide }) {
  if (!hidden.length) return null;
  return (
    <div className={styles.hiddenRow} aria-label="Hidden windows">
      <Icon name="i-hide" />
      {hidden.map((window) =>
        window.reason === 'manual' ? (
          <Tooltip key={window.key} label="Show this window again">
            <button
              type="button"
              className={styles.hiddenChip}
              aria-label={`Show ${window.label}`}
              onClick={() => onHide(window.key, false)}
            >
              <Icon name="i-show" />
              {window.label}
            </button>
          </Tooltip>
        ) : (
          <Tooltip key={window.key} label="Hidden while the longer window is depleted. It returns when that window has room again.">
            <span className={styles.hiddenChip} data-auto>
              {window.label}
            </span>
          </Tooltip>
        )
      )}
    </div>
  );
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
        </div>
        <div className={styles.quota}>
          {lines.shown.map((window) => (
            <QuotaLine
              key={window.key}
              window={window}
              now={now}
              advanced={advanced}
              disabled={!editable}
              onInspect={onInspect}
              onThreshold={onThreshold}
              onHide={onHideWindow}
            />
          ))}
          {!lines.shown.length && !lines.hidden.length ? (
            <span className={styles.muted}>No quota recorded</span>
          ) : null}
          <HiddenWindows hidden={lines.hidden} onHide={onHideWindow} />
        </div>
        <div className={styles.activity}>
          {account.activityState ? (
            <span className={styles.muted}>{account.activityState}</span>
          ) : record ? (
            <>
              <span>{number(record.records)} attempts</span>
              {advanced ? (
                <small>
                  {compact(record.inputSamples > 0 ? record.inputTokens : NaN)} in ·{' '}
                  {pct(record.cacheReadFraction)} cached
                  {record.failed > 0 ? ` · ${number(record.failed)} failed` : ''}
                </small>
              ) : null}
            </>
          ) : (
            <span className={styles.muted}>No attempts</span>
          )}
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
function AccountCard({
  account,
  now,
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
  const paused = account.isActive === false;
  const lines = visibleWindowLines(account, hiddenWindows, now);
  const record = account.activity;
  return (
    <article
      className={styles.card}
      data-account-id={id}
      data-expanded={expanded || undefined}
      data-bucket={bucket}
      aria-label={name}
    >
      <header className={styles.cardHead}>
        <ProviderMark provider={account.provider} size="small" />
        <div className={styles.identityText}>
          <NameField
            name={name}
            disabled={!!busy}
            expanded={expanded}
            onOpen={() => onToggle(null)}
            onCommit={onRename}
          />
          <small>{providerIdentity(account.provider).name}</small>
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
      <div className={styles.cardState}>
        <Tooltip label={[evidence.health, ...evidence.gates, account.lastError].filter(Boolean).join('. ')}>
          <span className={styles.stateWord} data-tone={TONE[bucket]}>
            <i />
            {word}
          </span>
        </Tooltip>
        {verdict ? (
          <Badge
            size="xs"
            variant="light"
            color={verdict.verdict === 'admissible' ? 'teal' : verdict.verdict === 'blocked' ? 'orange' : 'gray'}
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
              ? `${number(record.records)} attempts`
              : 'No attempts'}
        </span>
      </div>
      <div className={styles.cardWindows}>
        {lines.shown.map((window) => (
          <QuotaLine
            key={window.key}
            window={window}
            now={now}
            advanced={false}
            disabled
            onInspect={onInspect}
            onThreshold={() => {}}
            onHide={onHideWindow}
          />
        ))}
        {!lines.shown.length && !lines.hidden.length ? (
          <span className={styles.muted}>No quota recorded</span>
        ) : null}
        <HiddenWindows hidden={lines.hidden} onHide={onHideWindow} />
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
export function AccountBoard({ rows, drains, anchor, now, advanced, density, onDensity, onChanged }) {
  const {
    scope,
    setScope,
    selectedAccountId,
    setSelectedAccountId,
    selectedRecord,
    comparisonIds,
    setComparisonIds,
    health,
  } = useWorkspace();
  const resource = useResource('/api/providers');
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const [sort, setSort] = useState('name');
  const [sortAt, setSortAt] = useState(now);
  const [busy, setBusy] = useState({});
  const [adding, setAdding] = useState(false);
  const [comparing, setComparing] = useState(false);
  // Windows the person hid, per browser, keyed by account and window key.
  const [hiddenList, setHiddenList] = useLocalStorage({
    key: 'tokenproxy.capacity-hidden-windows',
    defaultValue: [],
  });
  const hiddenWindows = useMemo(() => new Set(hiddenList), [hiddenList]);
  const hideWindow = (account, key, hide) => {
    const id = windowHiddenId(account, key);
    setHiddenList((previous) =>
      hide ? [...new Set([...previous, id])] : previous.filter((value) => value !== id)
    );
  };
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
  const visible = sortAccountControls(filterAccounts(scoped, { query, bucket }, now), sort, sortAt);
  const verdicts = useEligibility(scope.model, providers);
  const compared = accounts.filter((account) => comparisonIds.includes(accountControlId(account)));
  const selectedScope = selectedRecord?.windowScope || null;
  const inventoryKnown = Array.isArray(resource.data?.connections);
  const empty = inventoryKnown && !accounts.length && !resource.loading && !resource.error;

  function refresh() {
    setSortAt(now);
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
  function savePolicy(account, kind, patch, label) {
    const id = accountControlId(account);
    return mutate(id, kind, async () => {
      const current = await readAccountControls(id);
      if (!accountControlBaseline(current, id))
        throw new Error('Current settings are incomplete, so this account cannot be edited yet.');
      const result = await saveAccountControls(current, patch);
      toast(
        result.confirmed ? 'teal' : 'orange',
        result.confirmed ? `${label} saved and read back.` : result.message,
        account.displayName || account.name || id
      );
      refresh();
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
      refresh();
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
      refresh();
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
      <div className={styles.fleet} role="group" aria-label="Account summary">
        <button
          type="button"
          className={styles.fleetChip}
          aria-pressed={!bucket}
          onClick={() => setBucket(null)}
        >
          <strong>{scoped.length}</strong> accounts
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
        <span className={styles.spacer} />
        <Text size="xs" c="dimmed" className={styles.fleetNote}>
          {health.loading || (resource.loading && !accounts.length)
            ? 'Reading accounts…'
            : advanced
              ? 'Edits save on Enter or blur'
              : 'Advanced view adds priority, drain and auto-pause'}
        </Text>
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
        <Tooltip label="Refresh accounts">
          <ActionIcon variant="default" aria-label="Refresh accounts" onClick={refresh}>
            <Icon name="i-refresh" />
          </ActionIcon>
        </Tooltip>
      </div>
      {adding ? (
        <AddAccountRow
          onClose={() => setAdding(false)}
          onAdded={(connection) => {
            if (connection) toast('teal', `${connection.name || connection.id} added.`);
            refresh();
          }}
        />
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
      {!advanced
        ? BUCKETS.map((item) => {
            const members = orderCards(
              visible.filter((account) => accountBucket(account, now) === item.id),
              now
            );
            if (!members.length) return null;
            return (
              <section key={item.id} className={styles.group} aria-label={`${item.label} accounts`}>
                <h3 className={styles.groupTitle} data-tone={item.tone}>
                  <i />
                  {item.label}
                  <span>{members.length}</span>
                </h3>
                <div className={styles.cards}>
                  {members.map((account) => {
                    const id = accountControlId(account);
                    return (
                      <AccountCard
                        key={id}
                        account={account}
                        now={now}
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
                  })}
                </div>
              </section>
            );
          })
        : null}
      <div className={styles.rows} hidden={!advanced}>
        {advanced && visible.map((account) => {
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
                  {
                    quotaPauseThresholds: {
                      ...(account.quotaPauseThresholds || {}),
                      [key]: threshold,
                    },
                  },
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
