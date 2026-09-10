'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Button,
  NativeSelect,
  PasswordInput,
  Select,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { runGrant, importPasted } from '@/shared/oauthGrant';
import { AUTH, WORDS } from '@/shared/status';
import { fmtNum, fmtRelative, fmtTime } from '@/shared/format';
import { AI_PROVIDERS } from '@/shared/constants/providers';
import { Icon } from '@/shared/components/Icon';
import { ProviderMark, providerIdentity } from '@/shared/components/ProviderMark';
import { useOptionalWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  Card,
  DensitySwitch,
  StateWord,
  boardStyles,
  useDensity,
  useLevel,
} from '@/shared/workspace/Board';
import {
  BUCKETS,
  SORTS,
  accountBucket,
  accountStateWord,
  credentialModes,
  filterAccounts,
  orderCards,
  providerList,
  visibleWindowLines,
} from '../accountBoardModel';
import {
  accountControlBaseline,
  accountControlEvidence,
  accountControlId,
  accountControlState,
  mergeAccountControls,
  readAccountControls,
  saveAccountControls,
  sortAccountControls,
} from '../accountControlPanelModel';
import { applyDrainChanges } from '../capacityControlsModel';
import { CommitNumber, NameField } from '@/shared/workspace/CommitFields';
import { HiddenCount, HiddenWindows, QuotaLine, useHiddenWindows } from '../QuotaLine';
import { UsageLine } from '../ActivityEvidence';
import { AddAccountRow } from '../AddAccountRow';
import { accountPath } from '../network/accountPath';
import ProviderImports from './ProviderImports';
import ProviderControls from './ProviderControls';
import KiroSocial from './KiroSocial';
import { ProviderOptionInputs, accountOptionFields, buildAccountOptions } from './AccountOptions';
import shared from '@/shared/workspace/workspace.module.css';
import styles from './connections.module.css';
import './styles.css';

const EMPTY = [];
const TONE = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, bucket.tone]));
const VIEWS = [
  { value: 'accounts', label: 'Accounts' },
  { value: 'add', label: 'Add' },
  { value: 'import', label: 'Import' },
  { value: 'provider-policy', label: 'Providers' },
  { value: 'kiro', label: 'Kiro' },
];
const RELEASE_WORD = {
  active: 'Active',
  pending: 'Pending',
  rolled_back: 'Rolled back',
  failed: 'Failed',
};
const RELEASE_TONE = {
  active: 'positive',
  pending: 'ember',
  rolled_back: 'ember',
  failed: 'refusal',
};
const CAUSE_WORD = {
  cooldown: 'cooling down after a rate limit',
  drained: 'drained',
  probe_failed: 'a failed probe',
  token_expired: 'an expired credential',
  error: 'a recorded error',
};
const MODE_WORD = {
  oauth: 'OAuth grant',
  apikey: 'API key',
  cookie: 'Cookie',
  none: 'No credential',
  paste: 'Pasted token',
};

// Connections keeps one distinction the Capacity board folds away: an account
// whose qualification has never been established is not ready, it is unknown,
// and this page exists to say which.
const unchecked = (account, state) => state === 'Not checked' || !account.status;
const bucketOf = (account, now) => {
  const state = accountControlState(account, now);
  if (state === 'Paused' || state === 'Quota pause') return 'paused';
  if (state === 'Draining' || state === 'Cooldown' || state === 'Needs attention') return 'attention';
  return unchecked(account, state) ? 'unknown' : accountBucket(account, now);
};
const wordOf = (account, now) => {
  const state = accountControlState(account, now);
  if (state === 'Paused' || state === 'Quota pause' || state === 'Draining' || state === 'Cooldown')
    return state;
  return unchecked(account, state) ? 'Not checked' : accountStateWord(account, now);
};
const summaryOf = (accounts, now) => {
  const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, 0]));
  for (const account of accounts) counts[bucketOf(account, now)] += 1;
  return counts;
};

const toast = (color, message, title) =>
  notifications.show({ color, message, title, autoClose: color === 'teal' ? 4000 : 9000 });
const failure = (body, status) =>
  typeof body?.error === 'string' ? body.error : body?.error?.message || `Refused (${status})`;

function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}

function accountInvestigationHref(path, account, workspace) {
  const id = accountControlId(account);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(workspace?.scope || {})) {
    if (value !== null && value !== undefined && value !== '') query.set(key, value);
  }
  query.set('provider', account.provider);
  query.set('connectionId', id);
  query.set(
    'selected',
    JSON.stringify({ kind: 'account', id, connectionId: id, provider: account.provider })
  );
  if (workspace?.comparisonIds?.length) query.set('compare', workspace.comparisonIds.join(','));
  return `${path}?${query}`;
}

// What a connection is, beside what it is doing: the identity an operator has
// to trust, the participation gate, and the outbound path. Inline under the
// card or the row, never in a dock.
function ConnectionDetail({ account, path, pathKnown, workspace, now }) {
  const id = accountControlId(account);
  const draining = account.drain?.isDraining ?? account.isDraining;
  return (
    <div className={boardStyles.tabPanel}>
      <div className={styles.detailGrid}>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Account ID</dt>
            <dd>
              <bdi>{id}</bdi>
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Authentication</dt>
            <dd>{AUTH[account.authType] || account.authType || 'Unknown'}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Qualification</dt>
            <dd>{WORDS[account.status] || account.status || 'Unknown'}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Last observed</dt>
            <dd>
              {account.lastQualifiedAt ? fmtRelative(account.lastQualifiedAt, now) : 'Not recorded'}
            </dd>
          </div>
        </dl>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Local participation</dt>
            <dd>
              {account.isActive === false
                ? 'Disabled'
                : draining
                  ? 'Draining; no new work'
                  : 'Enabled; model, quota and capacity restrictions still apply'}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Upstream model entitlement</dt>
            <dd>Unknown. A stored account or health result does not establish model access.</dd>
          </div>
          <div className={styles.fact}>
            <dt>Network path</dt>
            <dd>
              {pathKnown ? (
                <>
                  <bdi>{path.label}</bdi>. {path.policy}
                </>
              ) : (
                'Pool inventory unavailable; path not verified.'
              )}
            </dd>
          </div>
          {account.lastError ? (
            <div className={styles.fact}>
              <dt>Recorded error</dt>
              <dd>{account.lastError}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className={styles.detailActions}>
        <Button
          size="xs"
          variant="default"
          component={Link}
          href={`/dashboard/connections/${encodeURIComponent(id)}`}
          prefetch={false}
          leftSection={<Icon name="i-tune" />}
        >
          Configure account
        </Button>
        {[
          ['Capacity', '/dashboard'],
          ['Context', '/dashboard/context'],
          ['Economics', '/dashboard/usage'],
        ].map(([label, target]) => (
          <Button
            key={target}
            size="xs"
            variant="subtle"
            component={Link}
            href={accountInvestigationHref(target, account, workspace)}
            onClick={() => workspace?.setScope({ provider: account.provider, connectionId: id })}
          >
            {label}
          </Button>
        ))}
      </div>
      <Text size="xs" c="dimmed" mt={6}>
        Qualification combines recorded validation with drain, active state and cooldown. It does
        not establish model eligibility. Current configuration and historical activity stay
        separate.
      </Text>
    </div>
  );
}

function ConnectionControls({ account, busy, advanced, onPause, onDrain, onPriority }) {
  const id = accountControlId(account);
  const name = account.displayName || account.name || id;
  const paused = account.isActive === false;
  const draining = account.drain?.isDraining ?? account.isDraining;
  const editable = Boolean(accountControlBaseline(account, id)) && !busy;
  return (
    <>
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
            disabled={Boolean(busy) && busy !== 'drain'}
            onClick={() => onDrain(!draining)}
          >
            <Icon name="i-drain" />
          </ActionIcon>
        </Tooltip>
      ) : null}
      <Tooltip label={paused ? 'Enable' : 'Disable'}>
        <ActionIcon
          variant={paused ? 'light' : 'subtle'}
          color={paused ? 'teal' : 'gray'}
          aria-label={`${paused ? 'Enable' : 'Disable'} ${name}`}
          loading={busy === 'pause'}
          disabled={(Boolean(busy) && busy !== 'pause') || typeof account.isActive !== 'boolean'}
          onClick={onPause}
        >
          <Icon name={paused ? 'i-play' : 'i-pause'} />
        </ActionIcon>
      </Tooltip>
      {advanced ? (
        <Tooltip label="Configure this account">
          <ActionIcon
            component={Link}
            href={`/dashboard/connections/${encodeURIComponent(id)}`}
            prefetch={false}
            variant="subtle"
            color="gray"
            aria-label={`Configure ${name}`}
          >
            <Icon name="i-tune" />
          </ActionIcon>
        </Tooltip>
      ) : null}
    </>
  );
}

function ConnectionEvidence({ account, now, lines, showHidden, onShowHidden, onHideWindow }) {
  return (
    <>
      <UsageLine record={account.activity} state={account.activityState} />
      {lines.shown.map((window) => (
        <QuotaLine
          key={window.key}
          window={window}
          now={now}
          onHide={(key) => onHideWindow(key, true)}
        />
      ))}
      {!lines.shown.length && !lines.hidden.length ? (
        <span className={boardStyles.muted}>No quota recorded</span>
      ) : null}
      {showHidden ? (
        <HiddenWindows hidden={lines.hidden} onShow={(key) => onHideWindow(key, false)} />
      ) : null}
      {onShowHidden ? null : null}
    </>
  );
}

function ConnectionCard(props) {
  const { account, now, expanded, onToggle, hiddenWindows, onHideWindow, busy } = props;
  const id = accountControlId(account);
  const name = account.displayName || account.name || id;
  const bucket = bucketOf(account, now);
  const evidence = accountControlEvidence(account, now);
  const lines = visibleWindowLines(account, hiddenWindows, now);
  const [showHidden, setShowHidden] = useState(false);
  return (
    <Card
      id={id}
      bucket={bucket}
      expanded={expanded}
      label={name}
      head={
        <>
          <ProviderMark provider={account.provider} size="small" />
          <div className={boardStyles.identityText}>
            <NameField
              name={name}
              disabled={Boolean(busy)}
              expanded={expanded}
              onOpen={onToggle}
              onCommit={props.onRename}
            />
            <small>
              {providerIdentity(account.provider).name} ·{' '}
              {AUTH[account.authType] || account.authType || 'Unknown credential'}
            </small>
          </div>
          <ConnectionControls
            account={account}
            busy={busy}
            advanced={false}
            onPause={props.onPause}
            onDrain={props.onDrain}
            onPriority={props.onPriority}
          />
          <Tooltip label={expanded ? 'Collapse' : 'Details'}>
            <button
              type="button"
              className={boardStyles.caret}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
              onClick={onToggle}
            >
              <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
            </button>
          </Tooltip>
        </>
      }
      state={
        <>
          <Tooltip
            label={[evidence.health, ...evidence.gates, account.lastError]
              .filter(Boolean)
              .join('. ')}
          >
            <span className={boardStyles.stateWord} data-tone={TONE[bucket]}>
              <i />
              {wordOf(account, now)}
            </span>
          </Tooltip>
          <span className={boardStyles.spacer} />
          <span className={boardStyles.cardAttempts}>
            {account.lastQualifiedAt
              ? `Observed ${fmtRelative(account.lastQualifiedAt, now)}`
              : 'Never observed'}
          </span>
          <HiddenCount
            hidden={lines.hidden}
            name={name}
            open={showHidden}
            onToggle={() => setShowHidden((value) => !value)}
          />
        </>
      }
      detail={
        <ConnectionDetail
          account={account}
          path={props.path}
          pathKnown={props.pathKnown}
          workspace={props.workspace}
          now={now}
        />
      }
    >
      <ConnectionEvidence
        account={account}
        now={now}
        lines={lines}
        showHidden={showHidden}
        onHideWindow={onHideWindow}
      />
    </Card>
  );
}

function ConnectionRow(props) {
  const { account, now, expanded, onToggle, hiddenWindows, onHideWindow, busy } = props;
  const id = accountControlId(account);
  const name = account.displayName || account.name || id;
  const bucket = bucketOf(account, now);
  const evidence = accountControlEvidence(account, now);
  const lines = visibleWindowLines(account, hiddenWindows, now);
  const [showHidden, setShowHidden] = useState(false);
  return (
    <article
      className={boardStyles.row}
      data-account-id={id}
      data-expanded={expanded || undefined}
      data-bucket={bucket}
      aria-label={name}
    >
      <div className={boardStyles.main}>
        <Tooltip label={expanded ? 'Collapse' : 'Details'}>
          <button
            type="button"
            className={boardStyles.caret}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
            onClick={onToggle}
          >
            <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
          </button>
        </Tooltip>
        <div className={boardStyles.identity}>
          <ProviderMark provider={account.provider} size="small" />
          <div className={boardStyles.identityText}>
            <NameField
              name={name}
              disabled={Boolean(busy)}
              expanded={expanded}
              onOpen={onToggle}
              onCommit={props.onRename}
            />
            <small>
              {providerIdentity(account.provider).name}
              {account.email ? ` · ${account.email}` : ''} ·{' '}
              {AUTH[account.authType] || account.authType || 'Unknown credential'}
            </small>
          </div>
        </div>
        <div className={boardStyles.state}>
          <Tooltip
            label={[evidence.health, ...evidence.gates, account.lastError]
              .filter(Boolean)
              .join('. ')}
          >
            <span className={boardStyles.stateWord} data-tone={TONE[bucket]}>
              <i />
              {wordOf(account, now)}
            </span>
          </Tooltip>
          <HiddenCount
            hidden={lines.hidden}
            name={name}
            open={showHidden}
            onToggle={() => setShowHidden((value) => !value)}
          />
        </div>
        <div className={boardStyles.quota}>
          {lines.shown.map((window) => (
            <QuotaLine
              key={window.key}
              window={window}
              now={now}
              onHide={(key) => onHideWindow(key, true)}
            />
          ))}
          {!lines.shown.length && !lines.hidden.length ? (
            <span className={boardStyles.muted}>No quota recorded</span>
          ) : null}
          {showHidden ? (
            <HiddenWindows hidden={lines.hidden} onShow={(key) => onHideWindow(key, false)} />
          ) : null}
        </div>
        <div className={boardStyles.activity}>
          <span>
            {account.lastQualifiedAt
              ? `Observed ${fmtRelative(account.lastQualifiedAt, now)}`
              : 'Never observed'}
          </span>
          <UsageLine record={account.activity} state={account.activityState} compact />
        </div>
        <div className={boardStyles.actions}>
          <ConnectionControls
            account={account}
            busy={busy}
            advanced
            onPause={props.onPause}
            onDrain={props.onDrain}
            onPriority={props.onPriority}
          />
        </div>
      </div>
      {expanded ? (
        <div className={boardStyles.detail} role="region" aria-label="Selection details">
          <ConnectionDetail
            account={account}
            path={props.path}
            pathKnown={props.pathKnown}
            workspace={props.workspace}
            now={now}
          />
        </div>
      ) : null}
    </article>
  );
}

// The full add form: the providers that need an endpoint, a region or a
// workspace field, which the inline Add account row deliberately does not
// carry. It saves from this form; there is no review dialog.
function AddConnectionForm({ entries, onSaved }) {
  const [form, setForm] = useState({
    providerId: '',
    mode: '',
    name: '',
    secret: '',
    machineId: '',
  });
  const [flow, setFlow] = useState(null);
  const [grant, setGrant] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const abortRef = useRef(null);
  const choice = useRef(0);
  const entry = entries.find((candidate) => candidate.id === form.providerId);
  const modes = entry ? credentialModes(entry) : EMPTY;
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  useEffect(() => {
    const clear = () => {
      if (document.hidden)
        setForm((current) => ({
          ...current,
          secret: '',
          clientSecret: '',
          customHeaders: '',
          managementKey: '',
        }));
    };
    document.addEventListener('visibilitychange', clear);
    return () => {
      abortRef.current?.abort();
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);

  async function pickProvider(id) {
    const epoch = ++choice.current;
    setForm({ providerId: id, mode: '', name: '', secret: '', machineId: '' });
    setFlow(null);
    setRefused(null);
    const candidate = entries.find((item) => item.id === id);
    if (!candidate) return;
    set('mode', credentialModes(candidate)[0]);
    if (candidate.hasOAuth) {
      const probe = await call(
        `/api/oauth/${id}/authorize?redirect_uri=${encodeURIComponent(`${window.location.origin}/callback`)}`
      );
      if (epoch !== choice.current) return;
      setFlow(probe.ok ? probe.body : { failed: refusal(probe.status, probe.body) });
    }
  }

  function resetDraft() {
    choice.current += 1;
    abortRef.current?.abort();
    setGrant(null);
    setRefused(null);
    setBusy(false);
    setUncertain(false);
    setForm({ providerId: '', mode: '', name: '', secret: '', machineId: '' });
  }

  async function submit(event) {
    event.preventDefault();
    const epoch = choice.current;
    setBusy(true);
    setRefused(null);
    if (!entry || !modes.includes(form.mode)) {
      setRefused({ tone: 'bad', title: 'Choose a supported provider and authentication method.' });
      setBusy(false);
      return;
    }
    if (form.mode === 'none') {
      setRefused({
        tone: 'info',
        title: 'This provider uses a virtual account.',
        next: 'No credential is stored. Use Providers to enable it, or Network to choose its outbound path.',
      });
      setBusy(false);
      return;
    }
    let out;
    if (form.mode === 'oauth') {
      if (flow?.failed) {
        setRefused(flow.failed);
        setBusy(false);
        return;
      }
      const kind = flow?.flowType || 'authorization_code';
      if (kind === 'browser_token' || kind === 'import_token') {
        out = await importPasted(form.providerId, {
          token: form.secret,
          machineId: form.machineId,
        });
      } else {
        const controller = new AbortController();
        abortRef.current = controller;
        out = await runGrant(form.providerId, kind, {
          deviceOptions: form,
          meta: { baseUrl: form.baseUrl, clientId: form.clientId, clientSecret: form.clientSecret },
          signal: controller.signal,
          report: (step) => {
            if (epoch === choice.current) setGrant((value) => ({ ...(value || {}), step }));
          },
          deviceHook: (device) => {
            if (epoch === choice.current) setGrant((value) => ({ ...(value || {}), device }));
          },
        });
      }
    } else {
      let options;
      try {
        options = buildAccountOptions(
          {
            ...form,
            name: form.name || entry.name || entry.id,
            defaultModel: form.defaultModel || '',
            globalPriority: '',
            maxConcurrent: '',
          },
          accountOptionFields(form.providerId)
        );
      } catch (error) {
        setBusy(false);
        setRefused({ tone: 'bad', title: error.message });
        return;
      }
      const response = await call('/api/providers', {
        method: 'POST',
        body: {
          provider: form.providerId,
          name: options.name,
          defaultModel: options.defaultModel,
          ...(options.providerSpecificData
            ? { providerSpecificData: options.providerSpecificData }
            : {}),
          apiKey: form.secret,
        },
      });
      out = response.ok
        ? { ok: true, connection: response.body.connection }
        : { ok: false, status: response.status, body: response.body };
    }
    if (epoch !== choice.current) return;
    setForm((current) => ({
      ...current,
      secret: '',
      clientSecret: '',
      customHeaders: '',
      managementKey: '',
    }));
    setBusy(false);
    if (!out.ok) {
      if (!out.status) setUncertain(true);
      setRefused(refusal(out.status, out.body));
      return;
    }
    const savedId = out.connection?.id;
    const read = savedId ? await call(`/api/providers/${encodeURIComponent(savedId)}`) : null;
    if (epoch !== choice.current) return;
    if (!read?.ok || read.body?.connection?.id !== savedId) {
      setUncertain(true);
      setRefused({
        tone: 'warn',
        title: 'The account write was accepted, but the saved account was not confirmed.',
        next: 'Reset the draft and refresh the account list before another import.',
      });
      onSaved?.(null);
      return;
    }
    toast('teal', `${out.connection.name || savedId} added.`, 'Connection stored');
    setGrant({ connection: out.connection });
    onSaved?.(out.connection);
  }

  const pasteFlow = flow?.flowType === 'browser_token' || flow?.flowType === 'import_token';
  return (
    <section className={styles.panel} aria-label="Add a connection">
      <h2>Add a connection</h2>
      <p>
        Every provider, including the ones that need an endpoint, a region or a workspace field. The
        Add account row on the board covers the common API key and sign-in path.
      </p>
      {refused ? <Notice {...refused} /> : null}
      {grant?.connection ? (
        <Notice tone="ok" title="The account is stored.">
          {grant.connection.email ? <p className="caption">{grant.connection.email}</p> : null}
        </Notice>
      ) : null}
      <form onSubmit={submit}>
        <fieldset disabled={busy || uncertain} className={styles.form}>
          <Select
            size="xs"
            label="Provider"
            searchable
            placeholder="Pick one"
            value={form.providerId || null}
            onChange={(value) => value && pickProvider(value)}
            data={entries.map((item) => ({ value: item.id, label: item.name || item.id }))}
          />
          {entry && modes.length > 1 ? (
            <NativeSelect
              size="xs"
              label="Credential"
              value={form.mode}
              onChange={(event) => set('mode', event.currentTarget.value)}
              data={modes.map((mode) => ({ value: mode, label: MODE_WORD[mode] || mode }))}
            />
          ) : null}
          {entry && form.mode !== 'oauth' ? (
            <>
              <TextInput
                size="xs"
                label="Name"
                value={form.name}
                onChange={(event) => set('name', event.currentTarget.value)}
              />
              {form.mode !== 'none' ? (
                <PasswordInput
                  size="xs"
                  autoComplete="off"
                  label={
                    form.mode === 'cookie'
                      ? 'Cookie value'
                      : entry.acceptsEmptyKey || entry.id === 'ollama-local'
                        ? 'API key (optional)'
                        : 'API key'
                  }
                  value={form.secret}
                  onChange={(event) => set('secret', event.currentTarget.value)}
                />
              ) : null}
            </>
          ) : null}
          {entry && form.mode !== 'oauth' && form.mode !== 'none' ? (
            <ProviderOptionInputs
              provider={form.providerId}
              values={form}
              onChange={set}
              disabled={busy}
            />
          ) : null}
          {form.mode === 'oauth' && form.providerId === 'kiro' ? (
            <>
              <NativeSelect
                size="xs"
                label="Sign-in type"
                value={form.authMethod || 'builder-id'}
                onChange={(event) => set('authMethod', event.currentTarget.value)}
                data={[
                  { value: 'builder-id', label: 'AWS Builder ID' },
                  { value: 'idc', label: 'IAM Identity Center' },
                ]}
              />
              <TextInput
                size="xs"
                label="AWS region"
                placeholder="us-east-1"
                value={form.region || ''}
                onChange={(event) => set('region', event.currentTarget.value)}
              />
              {form.authMethod === 'idc' ? (
                <TextInput
                  size="xs"
                  type="url"
                  label="Identity Center start URL"
                  value={form.startUrl || ''}
                  onChange={(event) => set('startUrl', event.currentTarget.value)}
                />
              ) : null}
            </>
          ) : null}
          {form.mode === 'oauth' && form.providerId === 'gitlab' ? (
            <>
              <TextInput
                size="xs"
                type="url"
                label="GitLab instance URL"
                placeholder="https://gitlab.com"
                value={form.baseUrl || ''}
                onChange={(event) => set('baseUrl', event.currentTarget.value)}
              />
              <TextInput
                size="xs"
                label="Application client ID"
                value={form.clientId || ''}
                onChange={(event) => set('clientId', event.currentTarget.value)}
              />
              <PasswordInput
                size="xs"
                autoComplete="off"
                label="Application secret (optional)"
                value={form.clientSecret || ''}
                onChange={(event) => set('clientSecret', event.currentTarget.value)}
              />
            </>
          ) : null}
          {entry && form.mode === 'oauth' && pasteFlow ? (
            <>
              <PasswordInput
                size="xs"
                autoComplete="off"
                label="Pasted token"
                value={form.secret}
                onChange={(event) => set('secret', event.currentTarget.value)}
              />
              {form.providerId === 'cursor' ? (
                <TextInput
                  size="xs"
                  label="Machine id"
                  value={form.machineId}
                  onChange={(event) => set('machineId', event.currentTarget.value)}
                />
              ) : null}
            </>
          ) : null}
          {form.providerId === 'vertex' ? (
            <Text size="xs" c="dimmed" className={styles.formWide}>
              The credential field accepts a Vertex API key, service-account JSON, or
              authorized-user ADC JSON. Project and location are provider options above.
            </Text>
          ) : null}
          {entry && form.mode === 'oauth' && flow?.failed ? (
            <div className={styles.formWide}>
              <Notice {...flow.failed} />
            </div>
          ) : null}
          {entry && form.mode === 'none' ? (
            <div className={styles.formWide}>
              <Notice
                tone="info"
                title="No saved credential is needed."
                next="This provider uses a virtual account. Its availability and outbound path are managed under Providers and Network."
              />
            </div>
          ) : null}
          {grant?.device ? (
            <div className={styles.formWide}>
              <Notice tone="info" title="Enter this code with the provider.">
                <p>
                  <code>{grant.device.userCode}</code> at{' '}
                  <a href={grant.device.verificationUri} target="_blank" rel="noreferrer">
                    {grant.device.verificationUri}
                  </a>
                </p>
              </Notice>
            </div>
          ) : null}
          {grant?.step ? (
            <Text size="xs" c="dimmed" className={styles.formWide}>
              {grant.step}
            </Text>
          ) : null}
        </fieldset>
        <div className={styles.formActions}>
          <Button size="xs" variant="default" onClick={resetDraft} disabled={busy}>
            Reset draft
          </Button>
          <Button
            size="xs"
            type="submit"
            loading={busy}
            disabled={uncertain || !entry || (form.mode === 'oauth' && !flow)}
          >
            {form.mode === 'oauth' ? 'Sign in' : 'Add connection'}
          </Button>
          <Text size="xs" c="dimmed">
            A new account joins the fallback order at its priority and can start receiving traffic.
          </Text>
        </div>
      </form>
    </section>
  );
}

// The recorded release pointer. Nothing here deploys software or moves
// traffic, so the change confirms inline rather than in a dialog.
function ReleaseRecords({ activation }) {
  const [restoreId, setRestoreId] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const [pending, setPending] = useState(null);
  const active = activation.data?.active || null;
  const history = activation.data?.history || EMPTY;
  const others = history.filter((item) => item.releaseId !== active?.releaseId);

  async function run(action) {
    setBusy(true);
    setRefused(null);
    const ifMatch = active?.concurrencyVersion;
    const response =
      action.kind === 'activate'
        ? await call('/api/admin/activation', {
            method: 'POST',
            body: { releaseId: action.releaseId, ...(ifMatch ? { ifMatch } : {}) },
          })
        : await call('/api/admin/rollback', {
            method: 'POST',
            body: {
              ...(ifMatch ? { ifMatch } : {}),
              ...(action.toReleaseId ? { toReleaseId: action.toReleaseId } : {}),
            },
          });
    setBusy(false);
    setPending(null);
    if (!response.ok) {
      setRefused(refusal(response.status, response.body));
      return;
    }
    const read = await call('/api/admin/activation');
    const verified =
      read.ok &&
      read.body?.active?.releaseId === response.body?.releaseId &&
      read.body?.active?.concurrencyVersion === response.body?.concurrencyVersion;
    if (!verified) {
      setRefused({
        tone: 'warn',
        title: 'The release record was accepted, but its saved state was not confirmed.',
        next: 'Refresh before another change. This does not activate software or switch traffic.',
      });
      return;
    }
    toast('teal', 'The recorded active release changed.', 'Release records');
    activation.refresh();
  }

  const confirm = (action, label) =>
    pending && pending.label === label ? (
      <>
        <Button size="compact-xs" loading={busy} onClick={() => run(action)}>
          Confirm
        </Button>
        <Button
          size="compact-xs"
          variant="default"
          disabled={busy}
          onClick={() => setPending(null)}
        >
          Cancel
        </Button>
      </>
    ) : (
      <Button
        size="compact-xs"
        variant="default"
        disabled={busy}
        onClick={() => {
          setRefused(null);
          setPending({ ...action, label });
        }}
      >
        {label}
      </Button>
    );

  return (
    <BoardGroup label="Release records" count={history.length} layout="rows">
      <Text size="xs" c="dimmed" className={boardStyles.notice}>
        Metadata only: nothing here deploys software or switches request routing.
      </Text>
      {activation.error ? <Notice {...refusal(activation.status, activation.error)} /> : null}
      {refused ? <Notice {...refused} /> : null}
      {active ? (
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Recorded active release</dt>
            <dd>{active.releaseId}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Version</dt>
            <dd>{active.version}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Recorded at</dt>
            <dd>{active.activatedAt ? fmtTime(active.activatedAt) : 'Not recorded'}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Rolls back to</dt>
            <dd>{active.previousReleaseId || 'Nothing on file'}</dd>
          </div>
        </dl>
      ) : activation.data ? (
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Recorded active release</dt>
            <dd>None on file</dd>
          </div>
        </dl>
      ) : null}
      {others.map((item) => (
        <div className={styles.releaseRow} key={item.releaseId}>
          <strong>{item.releaseId}</strong>
          <StateWord tone={RELEASE_TONE[item.status] || 'ember'}>
            {RELEASE_WORD[item.status] || item.status}
          </StateWord>
          <span>{item.version}</span>
          <span className={styles.grow} />
          {confirm({ kind: 'activate', releaseId: item.releaseId }, 'Record as active')}
        </div>
      ))}
      {active && others.length ? (
        <div className={styles.releaseRow}>
          <NativeSelect
            size="xs"
            aria-label="Release record to restore"
            value={restoreId}
            onChange={(event) => setRestoreId(event.currentTarget.value)}
            data={[
              { value: '', label: 'Previous recorded release' },
              ...others.map((item) => ({
                value: item.releaseId,
                label: item.version || item.releaseId,
              })),
            ]}
          />
          <span className={styles.grow} />
          {confirm({ kind: 'rollback', toReleaseId: restoreId }, 'Roll back')}
        </div>
      ) : null}
    </BoardGroup>
  );
}

export default function ConnectionsPage() {
  const workspace = useOptionalWorkspace();
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const scopedProvider = workspace?.scope.provider;
  const scopedAccountId = workspace?.scope.connectionId;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const providers = usePoll('/api/providers', 10000);
  const qual = usePoll('/api/admin/qualification', 10000);
  const drain = usePoll('/api/admin/drain?all=true', 10000);
  const sys = usePoll('/api/system/state?windowSeconds=3600', 30000);
  const activation = usePoll('/api/admin/activation', 30000);
  const pools = usePoll('/api/proxy-pools', 30000);
  const nodes = usePoll('/api/provider-nodes', 30000);

  const [view, setView] = useState('accounts');
  useEffect(() => {
    const readTask = () => {
      if (window.location.hash === '#provider-policy') setView('provider-policy');
    };
    readTask();
    window.addEventListener('hashchange', readTask);
    return () => window.removeEventListener('hashchange', readTask);
  }, []);

  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const [sort, setSort] = useState('name');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState({});
  const { hiddenWindows, setWindowHidden: hideWindow } = useHiddenWindows();

  const quotaSnapshots = workspace?.quota?.data?.snapshots || EMPTY;
  const activityGroups =
    (workspace?.inventoryActivity || workspace?.activity)?.data?.groups || EMPTY;
  const activityState = workspace
    ? (workspace.inventoryActivity || workspace.activity)?.loading
      ? 'Loading activity…'
      : (workspace.inventoryActivity || workspace.activity)?.error
        ? 'Activity unavailable'
        : null
    : 'Activity is read in the workspace';

  const accounts = useMemo(() => {
    const merged = mergeAccountControls(
      providers.data?.connections,
      qual.data?.connections || EMPTY
    );
    return merged.map((account) => {
      const id = accountControlId(account);
      const record = activityGroups.find((group) => group.connectionId === id);
      const snapshot = quotaSnapshots.find((item) => item.connectionId === id);
      return {
        ...account,
        windows: snapshot?.windows || EMPTY,
        // accountWindows() prefers a stored lastQuotaSnapshot over the admin
        // projection whenever its fetchedAt is newer, which on this page meant
        // a stale fixture snapshot greyed every meter while Capacity, reading
        // the same account, drew it green. Where the shared quota read has an
        // answer, that answer is the one both pages use.
        lastQuotaSnapshot: snapshot ? null : account.lastQuotaSnapshot,
        drain: !drain.error
          ? drain.data?.connections?.find((item) => item.connectionId === id)
          : null,
        activity: record,
        activityState: record ? null : activityState,
      };
    });
  }, [
    providers.data,
    qual.data,
    drain.data,
    drain.error,
    quotaSnapshots,
    activityGroups,
    activityState,
  ]);

  // Which account is open. The shared workspace owns it when there is one, so
  // a deep link and the analysis lenses agree on the selection; a page mounted
  // without a workspace keeps it locally.
  const [localExpandedId, setLocalExpandedId] = useState(null);
  const expandedId = workspace
    ? workspace.selectedRecord?.kind === 'account'
      ? workspace.selectedRecord.id
      : null
    : localExpandedId;
  const setExpandedId = (next) => {
    if (!workspace) {
      setLocalExpandedId(next);
      return;
    }
    const account = accounts.find((item) => accountControlId(item) === next);
    workspace.setSelectedRecord(
      next
        ? {
            kind: 'account',
            id: next,
            connectionId: next,
            ...(account?.provider ? { provider: account.provider } : {}),
          }
        : null
    );
  };

  const providerMarks = useMemo(() => providerList(accounts), [accounts]);
  const scoped = accounts.filter(
    (account) =>
      (!scopedProvider || account.provider === scopedProvider) &&
      (!scopedAccountId || accountControlId(account) === scopedAccountId)
  );
  const summary = summaryOf(scoped, now);
  const visible = sortAccountControls(
    filterAccounts(scoped, { query }, now).filter(
      (account) => !bucket || bucketOf(account, now) === bucket
    ),
    sort,
    now
  );
  const health = sys.data?.providerHealth || null;
  const degradedNote = !health || health.unavailable !== null
    ? 'Provider health unknown'
    : health.degradedProviders?.length
      ? health.degradedProviders
          .map(
            (item) =>
              `${item.provider}: ${fmtNum(item.degradedConnections)} degraded, likely ${item.likelyCauses.map((cause) => CAUSE_WORD[cause] || cause).join(', ')}`
          )
          .join(' · ')
      : 'No degraded provider';
  // A selection the operator made stays readable when a filter would hide it.
  const outsideFilters =
    expandedId && !visible.some((account) => accountControlId(account) === expandedId)
      ? accounts.find((account) => accountControlId(account) === expandedId)
      : null;
  const poolList = pools.data?.proxyPools || EMPTY;
  const inventoryKnown = Array.isArray(providers.data?.connections);
  const empty = inventoryKnown && !accounts.length && !providers.loading && !providers.error;

  const entries = useMemo(
    () =>
      [
        ...Object.values(AI_PROVIDERS),
        ...(nodes.data?.nodes || EMPTY).map((node) => ({
          ...node,
          authModes: ['apikey'],
          acceptsEmptyKey: node.type !== 'custom-embedding',
        })),
      ].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    [nodes.data]
  );

  function refresh() {
    providers.refresh();
    qual.refresh();
    drain.refresh();
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
  function drainAccount(account, isDraining) {
    const id = accountControlId(account);
    return mutate(id, 'drain', async () => {
      const prepared = [
        {
          ...drain.data?.connections?.find((item) => item.connectionId === id),
          connectionId: id,
          name: account.displayName || account.name || id,
        },
      ];
      const outcomes = await applyDrainChanges(prepared, isDraining);
      for (const outcome of outcomes)
        toast(outcome.state === 'confirmed' ? 'teal' : 'orange', outcome.message, prepared[0].name);
      refresh();
    });
  }

  const cardProps = (account) => {
    const id = accountControlId(account);
    return {
      account,
      now,
      expanded: expandedId === id,
      busy: busy[id],
      hiddenWindows,
      workspace,
      path: accountPath(account, poolList),
      pathKnown: Boolean(pools.data),
      onToggle: () => setExpandedId(expandedId === id ? null : id),
      onHideWindow: (key, hide) => hideWindow(account, key, hide),
      onRename: (name) => rename(account, name),
      onPause: () =>
        savePolicy(
          account,
          'pause',
          { isActive: account.isActive === false },
          account.isActive === false ? 'Enable' : 'Disable'
        ),
      onDrain: (isDraining) => drainAccount(account, isDraining),
      onPriority: (priority) => savePolicy(account, 'save', { priority }, 'Priority'),
    };
  };

  return (
    <div className={shared.lensPage} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Connections</h1>
          <p>
            {advanced ? 'Advanced' : 'Everyday'} · stored accounts, their qualification and their
            credentials
          </p>
        </div>
        <Freshness status={pollFresh(qual)} lastDataAt={qual.goodAt} />
      </div>
      <div className={shared.scope}>
        <Tabs
          value={view}
          onChange={setView}
          keepMounted={false}
          classNames={{ list: boardStyles.tabList, tab: boardStyles.tab }}
        >
          <Tabs.List aria-label="Connection tasks">
            {VIEWS.map((item) => (
              <Tabs.Tab key={item.value} value={item.value}>
                {item.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
      </div>
      {/* The provider and account scope this page reads is the shared one, so
          it is set on the shared strip. The board carries its own refresh. */}
      {workspace ? <ScopeBar showRefresh={view !== 'accounts'} /> : null}
      <div className={shared.lensBody}>
        <div className={styles.stack}>
      {[
        ['Account inventory', providers],
        ['Qualification evidence', qual],
        ['Drain state', drain],
      ].map(([label, resource]) =>
        resource.error ? (
          <div key={label}>
            <Notice
              {...(resource.status === 0 || resource.error.code === 'network'
                ? {
                    tone: 'warn',
                    title: `${label} could not be refreshed.`,
                    next: resource.data
                      ? 'Showing the last successful observation. Other account evidence is read independently.'
                      : 'This evidence is unavailable. Retry this read; no provider probe will run.',
                  }
                : refusal(resource.status, resource.error))}
            />
            <Button
              size="xs"
              variant="default"
              mt={6}
              onClick={resource.refresh}
              disabled={resource.loading}
            >
              Retry {label.toLowerCase()}
            </Button>
          </div>
        ) : null
      )}

      {view === 'accounts' ? (
        <>
          <Board label="Connection inventory" advanced={advanced} density={density} compare="none">
            <BoardSummary
              label="Connection status summary"
              active={bucket}
              onPick={setBucket}
              note={degradedNote}
              chips={[
                { count: scoped.length, label: 'accounts' },
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
              searchLabel="Search accounts"
              actions={
                <>
                  <Button
                    size="xs"
                    leftSection={<Icon name="i-add" />}
                    aria-expanded={adding}
                    onClick={() => setAdding((value) => !value)}
                  >
                    Add account
                  </Button>
                  <Tooltip label="Re-read the account inventory, qualification and drain state">
                    <ActionIcon
                      variant="default"
                      aria-label="Refresh accounts"
                      loading={providers.loading && Boolean(providers.data)}
                      onClick={refresh}
                    >
                      <Icon name="i-refresh" />
                    </ActionIcon>
                  </Tooltip>
                </>
              }
            >
              {providerMarks.length > 1 ? (
                <div className={boardStyles.providers} role="group" aria-label="Provider filter">
                  {providerMarks.map((provider) => (
                    <Tooltip key={provider} label={providerIdentity(provider).name}>
                      <button
                        type="button"
                        className={boardStyles.providerChip}
                        aria-label={`${providerIdentity(provider).name} accounts`}
                        aria-pressed={scopedProvider === provider}
                        onClick={() =>
                          workspace?.setScope({
                            provider: scopedProvider === provider ? null : provider,
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
                  onChange={(value) => value && setSort(value)}
                  leftSection={<Icon name="i-sort" />}
                  className={boardStyles.sort}
                  allowDeselect={false}
                />
              ) : null}
              <Tooltip label="How much room each account takes">
                <DensitySwitch value={density} onChange={setDensity} />
              </Tooltip>
            </BoardToolbar>
            {adding ? (
              <AddAccountRow
                onClose={() => setAdding(false)}
                onAdded={(connection) => {
                  if (connection) toast('teal', `${connection.name || connection.id} added.`);
                  refresh();
                }}
              />
            ) : null}
            {scopedProvider || scopedAccountId ? (
              <Text size="xs" c="dimmed" className={boardStyles.notice}>
                Showing the retained provider and account scope.{' '}
                <button
                  type="button"
                  className={boardStyles.linkButton}
                  onClick={() => workspace?.setScope({ provider: null, connectionId: null })}
                >
                  Show all accounts
                </button>
              </Text>
            ) : null}
            {!advanced
              ? BUCKETS.map((item) => {
                  const members = orderCards(
                    visible.filter((account) => bucketOf(account, now) === item.id),
                    now
                  );
                  if (!members.length) return null;
                  return (
                    <BoardGroup
                      key={item.id}
                      label={item.label}
                      tone={item.tone}
                      count={members.length}
                    >
                      {members.map((account) => (
                        <ConnectionCard key={accountControlId(account)} {...cardProps(account)} />
                      ))}
                    </BoardGroup>
                  );
                })
              : null}
            {advanced ? (
              <>
                <div className={boardStyles.head} aria-hidden="true">
                  <span />
                  <span>Account</span>
                  <span>Qualification</span>
                  <span>Quota remaining</span>
                  <span>Last observed</span>
                  <span>Controls</span>
                </div>
                <div className={boardStyles.rows}>
                  {visible.map((account) => (
                    <ConnectionRow key={accountControlId(account)} {...cardProps(account)} />
                  ))}
                </div>
              </>
            ) : null}
            {outsideFilters ? (
              <BoardGroup label="Selected" tone="slate" count={1}>
                <Text size="xs" c="dimmed" className={boardStyles.notice}>
                  The selected account is outside the displayed filters. Its evidence remains open.
                </Text>
                <ConnectionCard {...cardProps(outsideFilters)} />
              </BoardGroup>
            ) : null}
            <div className={boardStyles.messages}>
              {providers.loading && !accounts.length ? (
                <div className={boardStyles.empty}>Reading accounts…</div>
              ) : null}
              {empty ? (
                <div className={boardStyles.empty}>
                  No connections yet. Add one and the gateway can start routing.
                </div>
              ) : null}
              {accounts.length && !visible.length ? (
                <div className={boardStyles.empty}>
                  No accounts match.{' '}
                  <button
                    type="button"
                    className={boardStyles.linkButton}
                    onClick={() => {
                      setQuery('');
                      setBucket(null);
                      if (scopedProvider || scopedAccountId)
                        workspace?.setScope({ provider: null, connectionId: null });
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              ) : null}
            </div>
          </Board>
          <Board label="Release and routing" density={density}>
            <ReleaseRecords activation={activation} />
            <BoardGroup label="Routing constraints" count={3} layout="rows">
              <Text size="xs" c="dimmed" className={boardStyles.notice}>
                What can hold work back once an account is qualified.
              </Text>
              <dl className={styles.facts}>
                <div className={styles.fact}>
                  <dt>Account and provider limits</dt>
                  <dd>Both apply. Open an account to inspect each.</dd>
                </div>
                <div className={styles.fact}>
                  <dt>Model cooldowns and quota exclusions</dt>
                  <dd>
                    <Link href="/dashboard">Capacity</Link>, for the selected model. Provider health
                    is separate from routing eligibility.
                  </dd>
                </div>
                <div className={styles.fact}>
                  <dt>Fallback order</dt>
                  <dd>One connection at a time. Priority is written per connection.</dd>
                </div>
              </dl>
            </BoardGroup>
          </Board>
        </>
      ) : null}
      {view === 'add' ? (
        <AddConnectionForm
          entries={entries}
          onSaved={() => {
            providers.refresh();
            qual.refresh();
          }}
        />
      ) : null}
      {view === 'import' ? <ProviderImports onSaved={() => providers.refresh()} /> : null}
      {view === 'provider-policy' ? (
        <ProviderControls nodes={nodes.data?.nodes || EMPTY} onSaved={() => providers.refresh()} />
      ) : null}
      {view === 'kiro' ? <KiroSocial onSaved={() => providers.refresh()} /> : null}
        </div>
      </div>
    </div>
  );
}
