'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Button,
  Checkbox,
  CopyButton,
  NativeSelect,
  SegmentedControl,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import { useAuthStatus } from '@/store/authStatus';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtRelative, fmtUnit, fmtUsd } from '@/shared/format';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  Card,
  DensitySwitch,
  EvidenceLine,
  StateWord,
  boardStyles,
  useDensity,
  useLevel,
} from '@/shared/workspace/Board';
import { CommitNumber, CommitText } from '@/shared/workspace/CommitFields';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import { KeyBudget } from './KeyBudget';
import { KeyLifecycle } from './KeyLifecycle';
import { ClientSetup } from './ClientSetup';
import { AccessProfiles } from './AccessProfiles';
import { keyBudgetState, keyBudgetMeasurements } from './budget';
import shared from '@/shared/workspace/workspace.module.css';
import styles from './keys.module.css';
import './styles.css';

const EMPTY = [];
// Every key lands in exactly one bucket; the order here is the order the strip
// and the groups render.
const BUCKETS = [
  { id: 'on', label: 'Enabled', tone: 'positive' },
  { id: 'held', label: 'Attention', tone: 'ember' },
  { id: 'over', label: 'Ceiling reached', tone: 'refusal' },
  { id: 'off', label: 'Off', tone: 'slate' },
];
const TONE = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, bucket.tone]));
const BUCKET_OF = {
  on: 'on',
  held: 'held',
  blocked: 'held',
  unknown: 'held',
  over: 'over',
  off: 'off',
  expired: 'off',
};
const VIEWS = [
  { value: 'keys', label: 'Keys' },
  { value: 'profiles', label: 'Profiles' },
  { value: 'advanced', label: 'Access' },
];
const DETAIL_TASKS = [
  { value: 'limits', label: 'Limits' },
  { value: 'setup', label: 'Client setup' },
  { value: 'lifecycle', label: 'Lifecycle' },
];
const CEILINGS = [
  { field: 'maxCostUsd', used: 'costUsd', label: 'Cost', render: fmtUsd },
  { field: 'maxPromptTokens', used: 'promptTokens', label: 'Prompt tokens', render: fmtNum },
  { field: 'maxCompletionTokens', used: 'completionTokens', label: 'Completion', render: fmtNum },
];

const SHORT = { promptTokens: 'Prompt', completionTokens: 'Completion', costUsd: 'Cost' };
const compact = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
    : '—';
const toast = (color, message, title) =>
  notifications.show({ color, message, title, autoClose: color === 'teal' ? 4000 : 9000 });
const bucketOf = (key) => BUCKET_OF[keyBudgetState(key).state] || 'held';
function pollFresh(poll) {
  if (poll.loading) return 'connecting';
  if (poll.error && poll.goodAt) return 'stale';
  if (poll.error) return 'reconnecting';
  return 'live';
}
const numberOrNull = (text) => {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const parseModels = (text) => {
  const list = String(text || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? list : null;
};
// One meter per ceiling: what is left of the allowance, not what was spent.
const level = (remaining) =>
  remaining <= 0 ? 'depleted' : remaining <= 20 ? 'low' : remaining <= 50 ? 'warn' : 'good';

function ceilingLines(key) {
  return keyBudgetMeasurements(key)
    .filter((row) => row.ceiling !== null)
    .map((row) => {
      const spent = (row.recorded ?? 0) + (row.held ?? 0);
      const remaining =
        row.ceiling > 0 ? Math.max(0, Math.min(100, (1 - spent / row.ceiling) * 100)) : 0;
      const render = row.used === 'costUsd' ? fmtUsd : compact;
      return {
        key: row.used,
        label: SHORT[row.used] || row.label,
        remaining,
        level: level(remaining),
        value: `${remaining.toFixed(0)}%`,
        note: `${render(row.recorded ?? 0)}/${render(row.ceiling)}`,
        title: `${row.label}: ${render(row.recorded ?? 0)} recorded and ${render(row.held ?? 0)} held against a ceiling of ${render(row.ceiling)}. A ceiling counts everything this key has ever spent.`,
      };
    });
}

// Everything a key's policy holds, edited where it is read. Each field saves
// from itself; nothing here opens a dialog.
function KeyDetail({
  record,
  profiles,
  now,
  busy,
  armed,
  setArmed,
  onSave,
  onReveal,
  onRotate,
  onRevoke,
}) {
  const [task, setTask] = useState('limits');
  const [visited, setVisited] = useState({ limits: true });
  const [overlap, setOverlap] = useState('');
  const policy = record.budget?.policy || record.effectiveBudgetPolicy || 'reserve-remaining';
  return (
    <div className={boardStyles.tabPanel}>
      <SegmentedControl
        size="xs"
        aria-label={`Tasks for ${record.name}`}
        value={task}
        onChange={(value) => {
          setTask(value);
          setVisited((current) => ({ ...current, [value]: true }));
        }}
        data={DETAIL_TASKS}
        className={styles.detailTasks}
      />
      {task === 'limits' ? (
        <>
          <div className={styles.detailForm}>
            {CEILINGS.map((ceiling) => (
              <CommitNumber
                key={ceiling.field}
                label={`${ceiling.label} ceiling`}
                aria-label={`${ceiling.label} ceiling for ${record.name}`}
                placeholder="No ceiling"
                min={0}
                allowDecimal={ceiling.field === 'maxCostUsd'}
                value={record[ceiling.field] ?? null}
                disabled={Boolean(busy)}
                onCommit={(value) => onSave({ [ceiling.field]: value }, `${ceiling.label} ceiling`)}
              />
            ))}
            <CommitText
              className={styles.detailWide}
              label="Model allowlist"
              aria-label={`Model allowlist for ${record.name}`}
              placeholder="Every model"
              value={(record.allowedModels || EMPTY).join(', ')}
              disabled={Boolean(busy)}
              onCommit={(value) => onSave({ allowedModels: parseModels(value) }, 'Model allowlist')}
            />
            <NativeSelect
              size="xs"
              label="Budget protection"
              aria-label={`Budget protection for ${record.name}`}
              value={policy}
              disabled={Boolean(busy)}
              onChange={(event) =>
                onSave({ budgetPolicy: event.currentTarget.value }, 'Budget protection')
              }
              data={[
                { value: 'strict', label: 'Verified bounds' },
                { value: 'reserve-remaining', label: 'Reserve remaining allowance' },
              ]}
            />
            <CommitText
              label="Expiry in UTC"
              aria-label={`Expiry for ${record.name}`}
              type="datetime-local"
              step="1"
              value={record.expiresAt?.slice(0, 19) || ''}
              disabled={Boolean(busy)}
              onCommit={(value) =>
                onSave({ expiresAt: value ? new Date(`${value}Z`).toISOString() : null }, 'Expiry')
              }
            />
            <NativeSelect
              size="xs"
              label="Access profile"
              aria-label={`Access profile for ${record.name}`}
              value={record.profile?.profileId || ''}
              disabled={Boolean(busy)}
              onChange={(event) =>
                onSave({ profileId: event.currentTarget.value }, 'Access profile')
              }
              data={[
                { value: '', label: 'Follow no profile' },
                ...profiles.map((profile) => ({
                  value: profile.id,
                  label: `${profile.name} (v${profile.version})`,
                })),
              ]}
            />
          </div>
          <Text size="xs" c="dimmed" mt={6}>
            A ceiling counts everything this key has ever spent, not spending from now on, so a key
            already past a new ceiling stops on its next use. One model id per entry, separated by
            commas; a whole provider is its name followed by a slash and a star. Adopting a profile
            copies its current settings onto this key.
          </Text>
          <KeyBudget record={record} />
        </>
      ) : null}
      {/* Client setup reads the gateway's own endpoints, so it mounts on its
          first visit and then stays mounted: leaving the task and coming back
          must not re-probe. */}
      {visited.setup ? (
        <div hidden={task !== 'setup'}>
          <ClientSetup record={record} />
        </div>
      ) : null}
      {task === 'lifecycle' ? <KeyLifecycle record={record} profiles={profiles} now={now} /> : null}
      <div className={styles.detailActions}>
        <InlineConfirm
          control="button"
          label="Reveal key"
          icon="i-keys"
          armed={armed === `reveal:${record.id}`}
          busy={busy === 'reveal'}
          disabled={Boolean(busy)}
          note="Sends this credential to your browser for client setup. Its activation, expiry and limits stay as configured."
          onArm={() => setArmed(`reveal:${record.id}`)}
          onCancel={() => setArmed(null)}
          onConfirm={onReveal}
        />
        {!record.supersededAt ? (
          <>
            <CommitNumber
              className={styles.createNumber}
              aria-label={`Overlap window in hours for ${record.name}`}
              placeholder="Overlap h"
              min={0}
              value={overlap === '' ? null : Number(overlap)}
              disabled={Boolean(busy)}
              onCommit={(value) => setOverlap(String(value))}
            />
            <InlineConfirm
              control="button"
              label="Rotate"
              icon="i-refresh"
              armed={armed === `rotate:${record.id}`}
              busy={busy === 'rotate'}
              disabled={Boolean(busy) || overlap === ''}
              note="Issues a successor carrying this key's ceilings, allowlist and profile, and gives this one an expiry at the end of the overlap window. The new value is shown once."
              onArm={() => setArmed(`rotate:${record.id}`)}
              onCancel={() => setArmed(null)}
              onConfirm={() => onRotate(numberOrNull(overlap))}
            />
          </>
        ) : null}
        <span className={styles.grow} />
        <InlineConfirm
          control="button"
          label="Revoke"
          icon="i-delete"
          danger
          armed={armed === `revoke:${record.id}`}
          busy={busy === 'revoke'}
          disabled={Boolean(busy)}
          note="Destroys the key and its model allowlist. Every client still using it is refused from that moment. None. A revoked key cannot be restored, and a replacement has a different value."
          onArm={() => setArmed(`revoke:${record.id}`)}
          onCancel={() => setArmed(null)}
          onConfirm={onRevoke}
        />
      </div>
    </div>
  );
}

function KeyHead({ record, now, expanded, busy, onToggle, onActive }) {
  const state = keyBudgetState(record);
  return (
    <>
      <span className="provider-mark" aria-hidden="true">
        <Icon name="i-keys" />
      </span>
      <div className={boardStyles.identityText}>
        <span className={boardStyles.nameLine}>
          <button
            type="button"
            className={boardStyles.nameButton}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {record.name}
          </button>
        </span>
        <small title={record.id}>
          {record.keyPreview ? `${record.keyPreview} · ` : ''}
          {record.createdAt
            ? `created ${fmtRelative(record.createdAt, now)}`
            : 'creation not recorded'}
        </small>
      </div>
      <Tooltip label={record.isActive ? 'Deactivate' : 'Activate'}>
        <ActionIcon
          variant={record.isActive ? 'subtle' : 'light'}
          color={record.isActive ? 'gray' : 'teal'}
          aria-label={`${record.isActive ? 'Deactivate' : 'Activate'} ${record.name}`}
          loading={busy === 'active'}
          disabled={Boolean(busy) && busy !== 'active'}
          onClick={onActive}
        >
          <Icon name={record.isActive ? 'i-pause' : 'i-play'} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={expanded ? 'Collapse' : 'Configure'}>
        <button
          type="button"
          className={boardStyles.caret}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Configure'} ${record.name}`}
          onClick={onToggle}
        >
          <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
        </button>
      </Tooltip>
      <span hidden>{state.label}</span>
    </>
  );
}

function KeyEvidence({ record }) {
  const lines = ceilingLines(record);
  return (
    <>
      {lines.map((line) => (
        <EvidenceLine
          key={line.key}
          label={line.label}
          remaining={line.remaining}
          level={line.level}
          value={line.value}
          note={line.note}
          title={line.title}
        />
      ))}
      {!lines.length ? (
        <EvidenceLine
          meter={false}
          label="Ceilings"
          value="—"
          note="No ceiling"
          title="This key has no spending or token ceiling. Every request it makes is admitted on its other checks alone."
        />
      ) : null}
    </>
  );
}

export default function KeysPage() {
  const keys = usePoll('/api/keys', 15000);
  const devices = usePoll('/api/keys/devices', 0);
  const settings = usePoll('/api/settings', 30000);
  const accessProfiles = usePoll('/api/access-profiles', 0);
  const auth = useAuthStatus((state) => state.status);
  const advanced = useLevel();
  const [density, setDensity] = useDensity();

  const [view, setView] = useState('keys');
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    maxCostUsd: '',
    allowedModels: '',
    expiresAt: '',
  });
  const [busy, setBusy] = useState({});
  const [armed, setArmed] = useState(null);
  const [refused, setRefused] = useState(null);
  const [secret, setSecret] = useState(null);
  const secretEpoch = useRef(0);
  const [picked, setPicked] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo(() => keys.data?.keys || EMPTY, [keys.data]);
  const profiles = useMemo(() => accessProfiles.data?.profiles || EMPTY, [accessProfiles.data]);

  // A shown-once value clears on its own: after a minute, when the tab is
  // hidden, or when the operator dismisses it. The epoch is what keeps a
  // response that lands AFTER any of those from putting the credential back on
  // screen, which a plain setState would do.
  const clearSecret = useCallback(() => {
    secretEpoch.current += 1;
    setSecret(null);
  }, []);
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') clearSecret();
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, [clearSecret]);
  useEffect(() => {
    if (!secret) return undefined;
    const timeout = setTimeout(clearSecret, 60000);
    return () => clearTimeout(timeout);
  }, [secret, clearSecret]);

  const needle = query.trim().toLowerCase();
  const visible = rows.filter(
    (record) =>
      (!bucket || bucketOf(record) === bucket) &&
      (!needle ||
        `${record.name} ${record.id} ${record.keyPreview || ''}`.toLowerCase().includes(needle))
  );
  const summary = Object.fromEntries(
    BUCKETS.map((item) => [item.id, rows.filter((record) => bucketOf(record) === item.id).length])
  );
  const clients = rows.reduce((total, record) => total + (record.deviceCount || 0), 0);
  const requests = rows.every((record) => Number.isFinite(record.usage?.requests))
    ? rows.reduce((total, record) => total + (record.usage?.requests || 0), 0)
    : null;
  const windowMinutes = devices.data?.windowMinutes;
  const requireApiKey = settings.data?.requireApiKey;
  const requireLogin = settings.data?.requireLogin;

  async function mutate(id, kind, run) {
    if (busy[id]) return null;
    setBusy((previous) => ({ ...previous, [id]: kind }));
    setRefused(null);
    try {
      return await run();
    } catch (error) {
      toast('orange', error.message);
      return null;
    } finally {
      setBusy((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
    }
  }

  function saveKey(record, patch, label) {
    const profileChange = Object.hasOwn(patch, 'profileId');
    return mutate(record.id, 'save', async () => {
      const response = profileChange
        ? patch.profileId
          ? await call(`/api/keys/${encodeURIComponent(record.id)}/profile`, {
              method: 'POST',
              body: { profileId: patch.profileId },
            })
          : await call(`/api/keys/${encodeURIComponent(record.id)}/profile`, { method: 'DELETE' })
        : await call(`/api/keys/${encodeURIComponent(record.id)}`, { method: 'PUT', body: patch });
      if (!response.ok) {
        setArmed(null);
        setRefused(refusal(response.status, response.body));
        return null;
      }
      const readback = await call('/api/keys');
      const saved = readback.body?.keys?.find((item) => item.id === record.id);
      const confirmed =
        readback.ok &&
        Boolean(saved) &&
        (profileChange
          ? (saved.profile?.profileId || '') === patch.profileId
          : Object.entries(patch).every(([field, value]) =>
              field === 'budgetPolicy'
                ? (saved.budget?.policy || saved.effectiveBudgetPolicy) === value
                : JSON.stringify(saved[field] ?? null) === JSON.stringify(value ?? null)
            ));
      toast(
        confirmed ? 'teal' : 'orange',
        confirmed
          ? `${label} saved and read back.`
          : `${label} was accepted, but the saved value did not read back. Refresh before another change.`,
        record.name
      );
      keys.refresh();
      accessProfiles.refresh();
      return response;
    });
  }

  function toggleActive(record) {
    return mutate(record.id, 'active', async () => {
      const response = await call(`/api/keys/${encodeURIComponent(record.id)}`, {
        method: 'PUT',
        body: { isActive: !record.isActive },
      });
      if (!response.ok) {
        setRefused(refusal(response.status, response.body));
        return null;
      }
      toast('teal', record.isActive ? 'Deactivated.' : 'Activated.', record.name);
      keys.refresh();
      return response;
    });
  }

  function reveal(record) {
    const epoch = secretEpoch.current;
    return mutate(record.id, 'reveal', async () => {
      const response = await call(`/api/keys/${encodeURIComponent(record.id)}/reveal`, {
        method: 'POST',
      });
      setArmed(null);
      if (!response.ok) {
        setRefused(refusal(response.status, response.body));
        return null;
      }
      if (epoch !== secretEpoch.current) return response;
      setSecret({ ...response.body, title: `${record.name} revealed` });
      return response;
    });
  }

  function rotate(record, overlapHours) {
    const epoch = secretEpoch.current;
    return mutate(record.id, 'rotate', async () => {
      const response = await call(`/api/keys/${encodeURIComponent(record.id)}/rotate`, {
        method: 'POST',
        body: { overlapHours },
      });
      setArmed(null);
      if (!response.ok) {
        setRefused(refusal(response.status, response.body));
        return null;
      }
      keys.refresh();
      if (epoch !== secretEpoch.current) return response;
      setSecret({
        ...response.body.successor,
        rotation: response.body,
        title: 'Successor key created',
      });
      keys.refresh();
      accessProfiles.refresh();
      return response;
    });
  }

  function revoke(record) {
    return mutate(record.id, 'revoke', async () => {
      const response = await call(`/api/keys/${encodeURIComponent(record.id)}`, {
        method: 'DELETE',
      });
      setArmed(null);
      if (!response.ok) {
        setRefused(refusal(response.status, response.body));
        return null;
      }
      toast('teal', 'Revoked. Its usage record is kept.', record.name);
      setExpandedId(null);
      keys.refresh();
      return response;
    });
  }

  function revokeSelected() {
    const ids = [...picked];
    return mutate(ids.join(','), 'revoke', async () => {
      const search = ids.map((id) => `id=${encodeURIComponent(id)}`).join('&');
      const response = await call(`/api/keys?${search}`, { method: 'DELETE' });
      setArmed(null);
      if (!response.ok) {
        setRefused(refusal(response.status, response.body));
        return null;
      }
      setPicked([]);
      toast(
        response.body.deleted === response.body.requested ? 'teal' : 'orange',
        response.body.deleted === response.body.requested
          ? 'Revoked.'
          : 'Revoked what was still there. The rest were already gone.',
        'Selected keys'
      );
      keys.refresh();
      return response;
    });
  }

  function create() {
    const epoch = secretEpoch.current;
    return mutate('__new__', 'create', async () => {
      const response = await call('/api/keys', {
        method: 'POST',
        body: {
          name: draft.name.trim(),
          expiresAt: draft.expiresAt || null,
          maxCostUsd: numberOrNull(draft.maxCostUsd),
          maxPromptTokens: null,
          maxCompletionTokens: null,
          allowedModels: parseModels(draft.allowedModels),
          budgetPolicy: 'strict',
        },
      });
      if (!response.ok) {
        setRefused(refusal(response.status, response.body));
        return null;
      }
      setDraft({ name: '', maxCostUsd: '', allowedModels: '', expiresAt: '' });
      setCreating(false);
      keys.refresh();
      if (epoch !== secretEpoch.current) return response;
      setSecret({ ...response.body, title: 'Key created' });
      return response;
    });
  }

  async function toggleKeyRequirement() {
    const response = await call('/api/settings', {
      method: 'PATCH',
      body: { requireApiKey: !requireApiKey },
    });
    if (!response.ok) {
      setRefused(refusal(response.status, response.body));
      return;
    }
    settings.refresh();
  }

  const detailFor = (record) => (
    <KeyDetail
      record={record}
      profiles={profiles}
      now={now}
      busy={busy[record.id]}
      armed={armed}
      setArmed={setArmed}
      onSave={(patch, label) => saveKey(record, patch, label)}
      onReveal={() => reveal(record)}
      onRotate={(hours) => rotate(record, hours)}
      onRevoke={() => revoke(record)}
    />
  );

  return (
    <div className={shared.lensPage} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Keys</h1>
          <p>{advanced ? 'Advanced' : 'Everyday'} · connect a client, then set its limits</p>
        </div>
        <Freshness status={pollFresh(keys)} lastDataAt={keys.goodAt} />
      </div>
      <div className={shared.scope}>
        <Tabs
          value={view}
          onChange={setView}
          keepMounted={false}
          classNames={{ list: boardStyles.tabList, tab: boardStyles.tab }}
        >
          <Tabs.List aria-label="Keys workspace">
            {VIEWS.map((item) => (
              <Tabs.Tab key={item.value} value={item.value}>
                {item.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
      </div>
      <div className={shared.lensBody}>
        <div className={styles.stack}>
      {refused ? <Notice {...refused} /> : null}
      {keys.error && !keys.data ? <Notice {...refusal(keys.status, keys.error)} /> : null}

      {view === 'keys' ? (
        <Board label="Client keys" advanced={advanced} density={density}>
          <BoardSummary
            label="Key summary"
            active={bucket}
            onPick={setBucket}
            note={`${fmtNum(clients)} clients seen · ${requests === null ? 'requests not reported' : `${fmtNum(requests)} requests`}`}
            chips={[
              { count: rows.length, label: rows.length === 1 ? 'key' : 'keys' },
              ...BUCKETS.map((item) => ({
                id: item.id,
                tone: item.tone,
                count: summary[item.id],
                label: item.label.toLowerCase(),
              })),
            ]}
          />
          <BoardToolbar
            search={query}
            onSearch={setQuery}
            searchLabel="Search keys"
            actions={
              <>
                {advanced && picked.length ? (
                  <InlineConfirm
                    control="button"
                    label={`Revoke ${picked.length} selected`}
                    icon="i-delete"
                    danger
                    armed={armed === 'revokeSelected'}
                    busy={Boolean(busy[picked.join(',')])}
                    note="Destroys every selected key and its model allowlist in one step. This cannot be undone."
                    onArm={() => setArmed('revokeSelected')}
                    onCancel={() => setArmed(null)}
                    onConfirm={revokeSelected}
                  />
                ) : null}
                <Button
                  size="xs"
                  leftSection={<Icon name="i-add" />}
                  aria-expanded={creating}
                  onClick={() => setCreating((value) => !value)}
                >
                  Create a key
                </Button>
                <Tooltip label="Re-read the key list and its recorded usage">
                  <ActionIcon
                    variant="default"
                    aria-label="Refresh keys"
                    loading={keys.loading && Boolean(keys.data)}
                    onClick={keys.refresh}
                  >
                    <Icon name="i-refresh" />
                  </ActionIcon>
                </Tooltip>
              </>
            }
          >
            <Tooltip label="How much room each key takes">
              <DensitySwitch value={density} onChange={setDensity} />
            </Tooltip>
          </BoardToolbar>
          {creating ? (
            <div className={styles.createRow} role="group" aria-label="Create a key">
              <TextInput
                size="xs"
                className={styles.createName}
                label="Name"
                aria-label="New key name"
                placeholder="For example, Work laptop"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              />
              <TextInput
                size="xs"
                className={styles.createNumber}
                label="Cost ceiling"
                aria-label="New key cost ceiling"
                placeholder="None"
                inputMode="decimal"
                value={draft.maxCostUsd}
                onChange={(event) => setDraft({ ...draft, maxCostUsd: event.currentTarget.value })}
              />
              <TextInput
                size="xs"
                className={styles.createModels}
                label="Model allowlist"
                aria-label="New key model allowlist"
                placeholder="Every model"
                value={draft.allowedModels}
                onChange={(event) =>
                  setDraft({ ...draft, allowedModels: event.currentTarget.value })
                }
              />
              <TextInput
                size="xs"
                className={styles.createNumber}
                type="date"
                label="Expires on"
                aria-label="New key expiry date"
                value={draft.expiresAt}
                onChange={(event) => setDraft({ ...draft, expiresAt: event.currentTarget.value })}
              />
              <Button size="xs" loading={busy.__new__ === 'create'} onClick={create}>
                Create
              </Button>
              <Button size="xs" variant="default" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Text size="xs" c="dimmed" className={styles.grow}>
                The key is issued for the machine that runs the gateway. Its value is shown once.
              </Text>
            </div>
          ) : null}
          {secret ? (
            <div className={styles.secret} role="status" aria-label="New key value">
              <Text size="xs" fw={600}>
                {secret.title}. This key is shown once. Copy it now.
              </Text>
              <div className={styles.secretRow}>
                <TextInput
                  size="xs"
                  readOnly
                  aria-label="Key value"
                  className={styles.secretValue}
                  classNames={{ input: 'keys-secret' }}
                  value={secret.key}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <CopyButton value={secret.key}>
                  {({ copied, copy }) => (
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<Icon name={copied ? 'i-check' : 'i-copy'} />}
                      onClick={copy}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  )}
                </CopyButton>
                <Button size="xs" onClick={clearSecret}>
                  Done
                </Button>
              </div>
              <Text size="xs" c="dimmed">
                This value clears after 60 seconds, when you leave this tab, or when you close it.
                Use Reveal key to retrieve it again.
                {secret.rotation ? (
                  <>
                    {' '}
                    This is the successor key. The previous one keeps working until{' '}
                    {fmtRelative(secret.rotation.overlapEndsAt, now)}
                    {secret.rotation.overlapTruncatedByExistingExpiry
                      ? ', which is its own existing expiry rather than the window you chose.'
                      : '.'}
                  </>
                ) : null}
              </Text>
            </div>
          ) : null}
          {!advanced
            ? BUCKETS.map((item) => {
                const members = visible.filter((record) => bucketOf(record) === item.id);
                if (!members.length) return null;
                return (
                  <BoardGroup
                    key={item.id}
                    label={item.label}
                    tone={item.tone}
                    count={members.length}
                  >
                    {members.map((record) => (
                      <Card
                        key={record.id}
                        id={record.id}
                        bucket={item.id}
                        expanded={expandedId === record.id}
                        label={record.name}
                        head={
                          <KeyHead
                            record={record}
                            now={now}
                            expanded={expandedId === record.id}
                            busy={busy[record.id]}
                            onToggle={() =>
                              setExpandedId((current) => (current === record.id ? null : record.id))
                            }
                            onActive={() => toggleActive(record)}
                          />
                        }
                        state={
                          <>
                            <StateWord tone={TONE[item.id]}>
                              {keyBudgetState(record).label}
                            </StateWord>
                            <span className={boardStyles.spacer} />
                            <span className={boardStyles.cardAttempts}>
                              {fmtNum(record.deviceCount || 0)} clients ·{' '}
                              {record.expiresAt
                                ? `expires ${fmtRelative(record.expiresAt, now)}`
                                : 'never expires'}
                            </span>
                          </>
                        }
                        detail={detailFor(record)}
                      >
                        <KeyEvidence record={record} />
                      </Card>
                    ))}
                  </BoardGroup>
                );
              })
            : null}
          {advanced ? (
            <>
              <div className={boardStyles.head} aria-hidden="true">
                <span />
                <span />
                <span>Key</span>
                <span>State</span>
                <span>Allowance remaining</span>
                <span>Clients</span>
                <span>Activate</span>
              </div>
              <div className={boardStyles.rows}>
                {visible.map((record) => {
                  const expanded = expandedId === record.id;
                  const state = keyBudgetState(record);
                  return (
                    <article
                      key={record.id}
                      className={boardStyles.row}
                      data-account-id={record.id}
                      data-expanded={expanded || undefined}
                      data-bucket={bucketOf(record)}
                      aria-label={record.name}
                    >
                      <div className={boardStyles.main}>
                        <Tooltip label={expanded ? 'Collapse' : 'Configure'}>
                          <button
                            type="button"
                            className={boardStyles.caret}
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Collapse' : 'Configure'} ${record.name}`}
                            onClick={() =>
                              setExpandedId((current) => (current === record.id ? null : record.id))
                            }
                          >
                            <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
                          </button>
                        </Tooltip>
                        <label className={styles.pick}>
                          <Checkbox
                            size="sm"
                            aria-label={`Select ${record.name}`}
                            checked={picked.includes(record.id)}
                            onChange={(event) =>
                              setPicked((current) =>
                                event.currentTarget.checked
                                  ? [...new Set([...current, record.id])]
                                  : current.filter((id) => id !== record.id)
                              )
                            }
                          />
                        </label>
                        <div className={boardStyles.identity}>
                          <span className="provider-mark" aria-hidden="true">
                            <Icon name="i-keys" />
                          </span>
                          <div className={boardStyles.identityText}>
                            <span className={boardStyles.nameLine}>
                              <button
                                type="button"
                                className={boardStyles.nameButton}
                                aria-expanded={expanded}
                                onClick={() =>
                                  setExpandedId((current) =>
                                    current === record.id ? null : record.id
                                  )
                                }
                              >
                                {record.name}
                              </button>
                            </span>
                            <small title={record.id}>
                              {record.keyPreview ? `${record.keyPreview} · ` : ''}
                              {record.id}
                            </small>
                          </div>
                        </div>
                        <div className={boardStyles.state}>
                          <StateWord tone={TONE[bucketOf(record)]}>{state.label}</StateWord>
                        </div>
                        <div className={boardStyles.quota}>
                          <KeyEvidence record={record} />
                        </div>
                        <div className={boardStyles.activity}>
                          <span>{fmtNum(record.deviceCount || 0)} clients</span>
                          <small>
                            {record.expiresAt
                              ? `expires ${fmtRelative(record.expiresAt, now)}`
                              : 'never expires'}
                          </small>
                        </div>
                        <div className={boardStyles.actions}>
                          <Tooltip label={record.isActive ? 'Deactivate' : 'Activate'}>
                            <ActionIcon
                              variant={record.isActive ? 'subtle' : 'light'}
                              color={record.isActive ? 'gray' : 'teal'}
                              aria-label={`${record.isActive ? 'Deactivate' : 'Activate'} ${record.name}`}
                              loading={busy[record.id] === 'active'}
                              disabled={Boolean(busy[record.id]) && busy[record.id] !== 'active'}
                              onClick={() => toggleActive(record)}
                            >
                              <Icon name={record.isActive ? 'i-pause' : 'i-play'} />
                            </ActionIcon>
                          </Tooltip>
                        </div>
                      </div>
                      {expanded ? (
                        <div
                          className={boardStyles.detail}
                          role="region"
                          aria-label="Selection details"
                        >
                          {detailFor(record)}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </>
          ) : null}
          <div className={boardStyles.messages}>
            {keys.loading && !keys.data ? (
              <div className={boardStyles.empty}>Reading keys…</div>
            ) : null}
            {keys.data && !rows.length ? (
              <div className={boardStyles.empty}>
                No key is issued. Create one to let a tool route through this gateway.
              </div>
            ) : null}
            {rows.length && !visible.length ? (
              <div className={boardStyles.empty}>
                No key matches.{' '}
                <button
                  type="button"
                  className={boardStyles.linkButton}
                  onClick={() => {
                    setQuery('');
                    setBucket(null);
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : null}
          </div>
        </Board>
      ) : null}

      {view === 'keys' ? (
        <Text size="xs" c="dimmed">
          A client is one address and tool seen on the key inside a recent window, counted in memory
          and reset when the gateway restarts.
          {windowMinutes ? ` Window ${fmtUnit(windowMinutes, 'minute')}.` : ''} Key lists contain
          masked previews; revealing a stored credential is an explicit action on that key.{' '}
          {keys.data?.usageState === 'unavailable'
            ? 'Historical usage is temporarily unavailable.'
            : keys.data?.usageFreshness?.snapshotCompletedAt
              ? `History was read at ${keys.data.usageFreshness.snapshotCompletedAt}.`
              : ''}
        </Text>
      ) : null}

      {view === 'profiles' ? (
        <AccessProfiles poll={accessProfiles} onKeysChanged={keys.refresh} />
      ) : null}

      {view === 'advanced' ? (
        <div className={styles.sections}>
          <section className={styles.panel} aria-label="Who may do what">
            <h2>Who may do what</h2>
            <p>Two classes of caller reach this gateway and they never overlap.</p>
            <dl className={styles.facts}>
              <div className={styles.fact}>
                <dt>Inference caller</dt>
                <dd>
                  Holds a client key and may route inference. It can never read or change
                  connections, quota, drain, releases, the catalog, or spend accounting, whichever
                  key it holds.
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>Operator</dt>
                <dd>
                  Signed in here, or holding the command-line token tied to this machine. Only an
                  operator reads or changes any of that, and the key configuration on this screen.
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>Either, or neither</dt>
                <dd>
                  Liveness and the plain model catalog answer a client key, an operator, or a caller
                  on this machine with no credential at all.
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>You</dt>
                <dd>
                  {auth?.authenticated ? (
                    <StateWord tone="positive">
                      Operator{auth.displayName ? ` · ${auth.displayName}` : ''}
                    </StateWord>
                  ) : auth?.requireLogin === false ? (
                    <StateWord tone="ember">
                      Sign-in is off, so anything reaching this port is treated as the operator
                    </StateWord>
                  ) : (
                    'Not reported'
                  )}
                </dd>
              </div>
            </dl>
            <ul>
              <li>
                A caller holding only an inference key that reaches an operator action is told it
                holds the wrong kind of credential, which is a different answer from holding none.
              </li>
              <li>
                Admin actions that change state require a local connection and operator credentials.
              </li>
              <li>
                A refused request changes nothing at all. Every other fact reads exactly as it did
                the moment before the attempt.
              </li>
            </ul>
          </section>

          <section className={styles.panel} aria-label="Decisions">
            <h2>Decisions</h2>
            {settings.error && !settings.data ? (
              <Notice {...refusal(settings.status, settings.error)} />
            ) : null}
            <dl className={styles.facts}>
              <div className={styles.fact}>
                <dt>Client key required</dt>
                <dd>
                  {requireApiKey === undefined ? (
                    'Not reported'
                  ) : (
                    <StateWord tone={requireApiKey ? 'positive' : 'ember'}>
                      {requireApiKey
                        ? 'Every inference request must carry a key'
                        : 'Inference is served without a key'}
                    </StateWord>
                  )}
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>Operator sign-in required</dt>
                <dd>
                  {requireLogin === undefined ? (
                    'Not reported'
                  ) : (
                    <StateWord tone={requireLogin ? 'positive' : 'ember'}>
                      {requireLogin ? 'A session is required' : 'Sign-in is turned off'}
                    </StateWord>
                  )}
                </dd>
              </div>
            </dl>
            <div className={styles.detailActions}>
              {requireApiKey === undefined ? null : (
                <Button size="xs" variant="default" onClick={toggleKeyRequirement}>
                  {requireApiKey ? 'Stop requiring a key' : 'Require a key'}
                </Button>
              )}
              <Button
                size="xs"
                variant="subtle"
                component={Link}
                href="/dashboard/access"
                prefetch={false}
              >
                Change sign-in under Access
              </Button>
            </div>
            <p>
              Open Client setup on a key and name a model to check its current allowlist, expiry,
              enabled state and ceilings locally. This does not establish provider entitlement,
              available quota or a successful model response.
            </p>
          </section>
        </div>
      ) : null}
        </div>
      </div>
    </div>
  );
}
