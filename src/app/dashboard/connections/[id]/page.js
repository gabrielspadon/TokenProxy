'use client';
import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Button,
  Checkbox,
  NativeSelect,
  PasswordInput,
  SegmentedControl,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { usePoll } from '@/shared/hooks/usePoll';
import { Notice } from '@/shared/components/Notice';
import { QuotaWindow } from '@/shared/components/QuotaWindow';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import {
  runGrant,
  importPasted,
  credentialDocument,
  requiresCredentialDocument,
} from '@/shared/oauthGrant';
import { TONE, WORDS, AUTH } from '@/shared/status';
import { fmtNum, fmtRelative, fmtTime, fmtDuration, isEpoch } from '@/shared/format';
import { AI_PROVIDERS, MEDIA_PROVIDER_KINDS } from '@/shared/constants/providers';
import { resolveAccountCapacity, resolveProviderCeiling } from '@/shared/utils/accountCapacity';
import { captureAccountControls } from '@/shared/utils/accountControls';
import { Icon } from '@/shared/components/Icon';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { StateWord, boardStyles, useLevel } from '@/shared/workspace/Board';
import { CommitNumber } from '@/shared/workspace/CommitFields';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import { AccountModelAccess } from '../AccountModelAccess';
import AccountOptions from '../AccountOptions';
import AccountOperations from '../AccountOperations';
import { accountPath } from '../../network/accountPath';
import shared from '@/shared/workspace/workspace.module.css';
import styles from '../connections.module.css';
import '../styles.css';

const HORIZON_MS = 6 * 60 * 60 * 1000;
const EMPTY = [];
const TASKS = [
  { value: 'policy', label: 'Policy' },
  { value: 'models', label: 'Models' },
  { value: 'auth', label: 'Auth' },
  { value: 'diagnostics', label: 'Diagnostics' },
];
const WORD_TONE = { ok: 'positive', warn: 'ember', bad: 'refusal', neutral: 'slate' };
const KIND_WORD = Object.fromEntries(MEDIA_PROVIDER_KINDS.map((kind) => [kind.id, kind.label]));
KIND_WORD.chat = 'Chat';

const toast = (color, message, title) =>
  notifications.show({ color, message, title, autoClose: color === 'teal' ? 4000 : 9000 });

export default function ConnectionPage({ params }) {
  const { id } = use(params);
  const advanced = useLevel();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const conn = usePoll(`/api/providers/${id}`, 10000);
  const qual = usePoll(`/api/admin/qualification/${id}`, 10000);
  const drain = usePoll('/api/admin/drain?all=true', 10000);
  const settings = usePoll('/api/settings', 30000);
  const pools = usePoll('/api/proxy-pools', 30000);

  const c = conn.data?.connection || null;
  const d = qual.data || null;
  const drainState = useMemo(
    () => (drain.data?.connections || EMPTY).find((row) => row.connectionId === id) || null,
    [drain.data, id]
  );
  const entry = c ? AI_PROVIDERS[c.provider] : null;
  const psd = c?.providerSpecificData || {};
  const poolList = pools.data?.proxyPools || EMPTY;
  const networkPath = accountPath(c, poolList);
  const status = d?.status || 'Unknown health';
  const kinds = entry?.serviceKinds?.length ? entry.serviceKinds : ['chat'];

  const [task, setTask] = useState('policy');
  const [busy, setBusy] = useState(null);
  const [armed, setArmed] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const [refused, setRefused] = useState(null);
  const [probe, setProbe] = useState(null);
  const [grantStep, setGrantStep] = useState(null);
  const validation = probe || d?.validation;
  const notFound = conn.status === 404;

  const thresholdWindows = [
    ...new Set([
      ...(c?.lastQuotaSnapshot?.windows || EMPTY).map((window) => window.key),
      ...Object.keys(c?.quotaPauseThresholds || {}),
    ]),
  ].filter((key) => typeof key === 'string' && key.length > 0);

  // Network path draft: several fields land in one write, so this one keeps a
  // draft until Save. Everything single-valued saves from its own field.
  const [pool, setPool] = useState(null);
  const poolDraft = pool ?? {
    poolId: psd.proxyPoolId || '__clear__',
    proxyUrl: '',
    noProxy: psd.connectionNoProxy || '',
  };
  const [endpoint, setEndpoint] = useState(null);
  const endpointDraft = endpoint ?? { baseUrl: psd.baseUrl || '', apiType: psd.apiType || '' };
  const [credential, setCredential] = useState({
    documentMode: false,
    document: '',
    secret: '',
    machineId: '',
    force: false,
  });
  useEffect(() => {
    const clear = () => {
      if (document.hidden) {
        setPool((current) => (current ? { ...current, proxyUrl: '' } : current));
        setCredential((current) => ({ ...current, secret: '', document: '' }));
      }
    };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);

  function reread() {
    conn.refresh();
    qual.refresh();
    drain.refresh();
    settings.refresh();
  }

  async function run(kind, request, { verify, title } = {}) {
    if (busy) return;
    setBusy(kind);
    setRefused(null);
    const response = await request();
    if (!response.ok) {
      setBusy(null);
      setArmed(null);
      if (!response.status) setUncertain(true);
      setRefused(refusal(response.status, response.body));
      return response;
    }
    if (verify) {
      const confirmed = await verify(response);
      if (!confirmed) {
        setBusy(null);
        setArmed(null);
        setUncertain(true);
        setRefused({
          tone: 'warn',
          title: 'The write was accepted, but the saved state was not read back.',
          next: 'Refresh this account before another change. Do not repeat it.',
        });
        return response;
      }
    }
    setBusy(null);
    setArmed(null);
    toast('teal', `${title || 'Saved'} and read back.`, c?.name || id);
    reread();
    return response;
  }

  const put = (body) => call(`/api/providers/${id}`, { method: 'PUT', body });
  const readBack = async (check) => {
    const read = await call(`/api/providers/${id}`);
    return read.ok && read.body?.connection?.id === id && check(read.body.connection);
  };

  async function replaceCredential() {
    if (busy) return;
    setBusy('reauth');
    setRefused(null);
    let response;
    const documentMode =
      credential.documentMode || (c.authType === 'oauth' && requiresCredentialDocument(c.provider));
    if (documentMode) {
      let body;
      try {
        body = credentialDocument(credential.document, credential.force);
      } catch (error) {
        setBusy(null);
        setRefused({ tone: 'bad', title: error.message });
        return;
      }
      response = await call(`/api/providers/${id}/reauth`, { method: 'POST', body });
    } else if (!entry?.hasOAuth || c.authType === 'apikey' || c.authType === 'cookie') {
      response = await call(`/api/providers/${id}/reauth`, {
        method: 'POST',
        body: {
          [c.authType === 'cookie' ? 'accessToken' : 'apiKey']: credential.secret,
          ...(credential.force ? { force: true } : {}),
        },
      });
    } else {
      const flowProbe = await call(
        `/api/oauth/${c.provider}/authorize?redirect_uri=${encodeURIComponent(`${window.location.origin}/callback`)}`
      );
      if (!flowProbe.ok) {
        setBusy(null);
        setRefused(refusal(flowProbe.status, flowProbe.body));
        return;
      }
      const kind = flowProbe.body.flowType;
      const reauth = {
        reauthConnectionId: id,
        ...(credential.force ? { forceReauth: true } : {}),
      };
      const out =
        kind === 'browser_token' || kind === 'import_token'
          ? await importPasted(c.provider, {
              token: credential.secret,
              machineId: credential.machineId || psd.machineId,
              reauth,
            })
          : await runGrant(c.provider, kind, {
              reauth,
              report: setGrantStep,
              deviceOptions: psd,
              meta: psd,
            });
      response = out.ok
        ? { ok: true, status: 200, body: out.connection }
        : { ok: false, status: out.status, body: out.body };
    }
    setCredential((current) => ({ ...current, secret: '', document: '' }));
    if (!response.ok) {
      setBusy(null);
      setArmed(null);
      if (!response.status) setUncertain(true);
      setRefused(refusal(response.status, response.body));
      return;
    }
    const read = await call(`/api/providers/${id}`);
    if (!read.ok || read.body?.connection?.id !== id || read.body.connection.provider !== c.provider) {
      setBusy(null);
      setArmed(null);
      setUncertain(true);
      setRefused({
        tone: 'warn',
        title: 'Credential replacement was accepted, but the selected account could not be read back.',
        next: 'Refresh before another change.',
      });
      return;
    }
    setBusy(null);
    setArmed(null);
    toast('teal', 'The stored credential was replaced in place.', c.name || id);
    reread();
  }

  async function remove() {
    setBusy('del');
    const response = await call(`/api/providers/${id}`, { method: 'DELETE' });
    if (response.ok) {
      window.location.href = '/dashboard/connections';
      return;
    }
    setBusy(null);
    setArmed(null);
    setRefused(refusal(response.status, response.body));
  }

  const draining = drainState?.isDraining;
  const gate = Boolean(busy) || uncertain;

  return (
    <div className={shared.lensPage}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1 className="connection-name">
            {c ? (
              <>
                <ProviderMark provider={c.provider} />
                {c.name || c.displayName || c.email || c.provider}
              </>
            ) : (
              '…'
            )}
          </h1>
          <p>
            <Link prefetch={false} href="/dashboard/connections">
              Connections
            </Link>
            {c ? ` · ${c.provider} · ${AUTH[c.authType] || c.authType}` : ''}
          </p>
        </div>
        <div className={styles.headActions}>
          <StateWord tone={WORD_TONE[TONE[status]] || 'ember'}>{WORDS[status] || status}</StateWord>
          {draining ? <StateWord tone="ember">Draining</StateWord> : null}
          <SegmentedControl
            size="xs"
            aria-label="Account tasks"
            value={task}
            onChange={setTask}
            data={TASKS}
            className={styles.views}
          />
        </div>
      </div>
      <div className={shared.lensBody}>
        <div className={styles.stack}>
      {notFound ? <Notice {...refusal(404, conn.error)} /> : null}
      {!notFound && conn.error && !c ? <Notice {...refusal(conn.status, conn.error)} /> : null}
      {refused ? <Notice {...refused} /> : null}
      {uncertain ? (
        <Notice
          tone="warn"
          title="Refresh this account before another change."
          next="The last accepted write could not be read back. Do not repeat it."
        >
          <Button
            size="xs"
            variant="default"
            mt={6}
            onClick={() => {
              setUncertain(false);
              setRefused(null);
              reread();
            }}
          >
            Refresh account
          </Button>
        </Notice>
      ) : null}
      {conn.loading && !c ? (
        <div className={boardStyles.empty}>Reading account…</div>
      ) : null}

      {c ? (
        <>
          {task === 'policy' ? (
            <>
              <div className={styles.sections}>
                <section className={styles.panel} aria-label="Account facts">
                  <h2>What this account is</h2>
                  <dl className={styles.facts}>
                    <div className={styles.fact}>
                      <dt>Signed in as</dt>
                      <dd>{c.email || 'Not recorded'}</dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Enabled</dt>
                      <dd>{c.isActive === false ? 'No' : 'Yes'}</dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Created</dt>
                      <dd>{c.createdAt ? fmtTime(c.createdAt) : 'Not recorded'}</dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Updated</dt>
                      <dd>{c.updatedAt ? fmtTime(c.updatedAt) : 'Not recorded'}</dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Rate limited until</dt>
                      <dd>
                        {c.rateLimitedUntil && !isEpoch(c.rateLimitedUntil)
                          ? fmtTime(c.rateLimitedUntil)
                          : 'Not rate limited'}
                      </dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Default model</dt>
                      <dd>{c.defaultModel || 'Provider default'}</dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Endpoint</dt>
                      <dd>
                        {psd.baseUrl ? `${psd.baseUrl} (${psd.apiType || 'chat'})` : 'Provider default'}
                      </dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Proxy pool</dt>
                      <dd>
                        <bdi>{networkPath.label}</bdi>
                      </dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Provider ceiling</dt>
                      <dd>
                        {resolveProviderCeiling(settings.data, c.provider) !== null
                          ? fmtNum(resolveProviderCeiling(settings.data, c.provider))
                          : 'No outer limit configured'}
                      </dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Account ceiling</dt>
                      <dd>
                        {resolveAccountCapacity(c) === 0
                          ? 'Explicitly unlimited'
                          : `${fmtNum(resolveAccountCapacity(c))}${c.maxConcurrent == null ? ' (default)' : ''}`}
                      </dd>
                    </div>
                  </dl>
                  <Text size="xs" c="dimmed">
                    {networkPath.policy} Pool binding stores its strictness on the account; pool edits
                    update bound snapshots atomically.
                  </Text>
                </section>

                <section className={styles.panel} aria-label="Account participation">
                  <h2>Participation</h2>
                  <p>
                    {c.isActive === false
                      ? 'Disabled: the account is out of the fallback order. Enabling lets it receive traffic again.'
                      : 'Enabled: the account is in the fallback order. Disabling takes it out; in-flight requests finish.'}
                  </p>
                  <div className={styles.formActions}>
                    <Button
                      size="xs"
                      variant={c.isActive === false ? 'filled' : 'default'}
                      leftSection={<Icon name={c.isActive === false ? 'i-play' : 'i-pause'} />}
                      loading={busy === 'active'}
                      disabled={gate && busy !== 'active'}
                      onClick={() =>
                        run('active', () => put({ isActive: c.isActive === false }), {
                          verify: () => readBack((saved) => saved.isActive === (c.isActive === false)),
                          title: c.isActive === false ? 'Enabled' : 'Disabled',
                        })
                      }
                    >
                      {c.isActive === false ? 'Enable' : 'Disable'}
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<Icon name={draining ? 'i-play' : 'i-drain'} />}
                      loading={busy === 'drain'}
                      disabled={gate && busy !== 'drain'}
                      onClick={() =>
                        run(
                          'drain',
                          () =>
                            draining
                              ? call(
                                  `/api/admin/drain/${id}?${new URLSearchParams(drainState?.version ? { ifMatch: drainState.version } : {})}`,
                                  { method: 'DELETE' }
                                )
                              : call(`/api/admin/drain/${id}`, {
                                  method: 'POST',
                                  body: drainState?.version ? { ifMatch: drainState.version } : {},
                                }),
                          { title: draining ? 'Drain cancelled' : 'Draining' }
                        )
                      }
                    >
                      {draining ? 'Cancel the drain' : 'Drain'}
                    </Button>
                    <span className={styles.grow} />
                    <InlineConfirm
                      control="button"
                      label="Delete"
                      icon="i-delete"
                      danger
                      armed={armed === 'del'}
                      busy={busy === 'del'}
                      disabled={gate}
                      note="The stored credential, the connection's configuration, and its place in the fallback order are destroyed. Nothing else cascades. This cannot be undone."
                      onArm={() => setArmed('del')}
                      onCancel={() => setArmed(null)}
                      onConfirm={remove}
                    />
                  </div>
                  <Text size="xs" c="dimmed">
                    New requests stop landing here while draining. Streams already open run to their
                    end.
                  </Text>
                  {draining ? (
                    <Text size="xs" c="dimmed">
                      Draining since{' '}
                      {drainState.requestedAt ? fmtTime(drainState.requestedAt) : '—'},{' '}
                      {fmtNum(drainState.activeStreams)} observed pending requests. Process counters
                      can expire or lag; they do not establish whether a response is still streaming.
                    </Text>
                  ) : null}
                </section>
                <section className={styles.panel} aria-label="Routing priority">
                  <h2>Routing priority</h2>
                  <p>
                    Fallback order within this provider; 1 is tried first. Saves on Enter or blur, and
                    moves the account the next time a request routes.
                  </p>
                  <CommitNumber
                    className={styles.priority}
                    aria-label="Routing priority"
                    value={c.priority ?? null}
                    min={1}
                    placeholder="—"
                    disabled={gate}
                    onCommit={(priority) =>
                      run('priority', () => put({ priority }), {
                        verify: () => readBack((saved) => saved.priority === priority),
                        title: 'Priority saved',
                      })
                    }
                  />
                </section>

                <section className={styles.panel} aria-label="Quota pause thresholds">
                  <h2>Quota pause thresholds</h2>
                  <p>
                    A positive threshold pauses new work at or below that percentage remaining. 0
                    turns pausing off for that window. Unlimited windows and unknown percentages never
                    pause.
                  </p>
                  {thresholdWindows.length ? (
                    <div className={styles.formNarrow}>
                      {thresholdWindows.map((scope) => (
                        <Tooltip key={scope} label={`Auto-pause ${scope} at this percentage`}>
                          <CommitNumber
                            aria-label={`Auto-pause threshold for ${scope}`}
                            label={scope}
                            size="xs"
                            min={0}
                            max={100}
                            suffix="%"
                            allowDecimal
                            decimalScale={2}
                            value={c.quotaPauseThresholds?.[scope] ?? 0}
                            disabled={gate}
                            onCommit={(value) =>
                              run(
                                'thresholds',
                                // The whole map is written, and `c` is a poll up to
                                // ten seconds old, so it is re-read first: merging
                                // into the rendered copy silently reverts a
                                // threshold someone else set in between.
                                async () => {
                                  const read = await call(`/api/providers/${id}`);
                                  if (!read.ok || read.body?.connection?.id !== id)
                                    return { ...read, ok: false };
                                  const before = read.body.connection;
                                  return put({
                                    quotaPauseThresholds: {
                                      ...(before.quotaPauseThresholds || {}),
                                      [scope]: value,
                                    },
                                    expectedControls: captureAccountControls(before),
                                  });
                                },
                                {
                                  title: `Auto-pause for ${scope} saved`,
                                  verify: () =>
                                    readBack(
                                      (saved) => (saved.quotaPauseThresholds?.[scope] ?? 0) === value
                                    ),
                                }
                              )
                            }
                          />
                        </Tooltip>
                      ))}
                    </div>
                  ) : (
                    <Text size="xs" c="dimmed">
                      No exact quota windows have been observed or configured for this account. Inputs
                      appear when a quota snapshot identifies its windows.
                    </Text>
                  )}
                </section>
                <section className={styles.panel} aria-label="Account network path">
                  <h2>Account network path</h2>
                  <p>
                    A bound pool sends every upstream call from this account through it; strictness
                    comes from the pool. Clearing a pool preserves any explicit direct or custom proxy
                    policy.
                  </p>
                  <div className={styles.form}>
                    <NativeSelect
                      size="xs"
                      label="Pool or account proxy"
                      value={poolDraft.poolId}
                      disabled={gate}
                      onChange={(event) =>
                        setPool({ ...poolDraft, poolId: event.currentTarget.value })
                      }
                      data={[
                        { value: '', label: 'Explicit direct connection' },
                        { value: '__clear__', label: 'Clear pool; restore the retained path' },
                        { value: '__legacy__', label: 'Custom proxy for this account' },
                        ...poolList
                          .filter((item) => item.isActive !== false)
                          .map((item) => ({ value: item.id, label: item.name })),
                      ]}
                    />
                    {poolDraft.poolId === '__legacy__' ? (
                      <>
                        <PasswordInput
                          size="xs"
                          autoComplete="off"
                          label="Account proxy URL"
                          value={poolDraft.proxyUrl}
                          disabled={gate}
                          onChange={(event) =>
                            setPool({ ...poolDraft, proxyUrl: event.currentTarget.value })
                          }
                        />
                        <TextInput
                          size="xs"
                          label="Bypass hosts"
                          value={poolDraft.noProxy}
                          disabled={gate}
                          onChange={(event) =>
                            setPool({ ...poolDraft, noProxy: event.currentTarget.value })
                          }
                        />
                      </>
                    ) : null}
                  </div>
                  <div className={styles.formActions}>
                    <Button
                      size="xs"
                      loading={busy === 'pool'}
                      disabled={gate && busy !== 'pool'}
                      onClick={() =>
                        run(
                          'pool',
                          () =>
                            put(
                              poolDraft.poolId === '__legacy__'
                                ? {
                                    connectionProxyEnabled: true,
                                    connectionProxyUrl: poolDraft.proxyUrl,
                                    connectionNoProxy: poolDraft.noProxy || '',
                                  }
                                : {
                                    proxyPoolId:
                                      poolDraft.poolId === '__clear__'
                                        ? null
                                        : poolDraft.poolId || '__none__',
                                  }
                            ),
                          { title: 'Network path saved' }
                        ).then(() => setPool(null))
                      }
                    >
                      Save network path
                    </Button>
                  </div>
                </section>

                <section className={styles.panel} aria-label="Endpoint override">
                  <h2>Endpoint override</h2>
                  <p>
                    Calls go to this base URL in the chosen API shape instead of the provider default.
                    An empty URL clears the override.
                  </p>
                  <div className={styles.form}>
                    <TextInput
                      size="xs"
                      type="url"
                      label="Base URL"
                      placeholder={entry?.defaultBaseUrl || 'https://'}
                      value={endpointDraft.baseUrl}
                      disabled={gate}
                      onChange={(event) =>
                        setEndpoint({ ...endpointDraft, baseUrl: event.currentTarget.value })
                      }
                    />
                    <NativeSelect
                      size="xs"
                      label="API shape"
                      value={endpointDraft.apiType}
                      disabled={gate}
                      onChange={(event) =>
                        setEndpoint({ ...endpointDraft, apiType: event.currentTarget.value })
                      }
                      data={[
                        { value: '', label: 'Provider default' },
                        { value: 'chat', label: 'chat' },
                        { value: 'responses', label: 'responses' },
                      ]}
                    />
                  </div>
                  <div className={styles.formActions}>
                    <Button
                      size="xs"
                      loading={busy === 'endpoint'}
                      disabled={gate && busy !== 'endpoint'}
                      onClick={() =>
                        run(
                          'endpoint',
                          () =>
                            put({
                              baseUrl: endpointDraft.baseUrl || '',
                              ...(endpointDraft.apiType ? { apiType: endpointDraft.apiType } : {}),
                            }),
                          { title: 'Endpoint saved' }
                        ).then(() => setEndpoint(null))
                      }
                    >
                      Save endpoint
                    </Button>
                    <Text size="xs" c="dimmed">
                      <Link href="/dashboard/connections#provider-policy" prefetch={false}>
                        Provider policy
                      </Link>{' '}
                      controls the shared provider concurrency ceiling and timeout.
                    </Text>
                  </div>
                </section>
              </div>

              <AccountOptions
                key={c.id}
                connection={c}
                onSaved={() => {
                  conn.refresh();
                  qual.refresh();
                }}
              />
            </>
          ) : null}

          {task === 'models' ? (
            <>
              <section className={styles.panel} aria-label="Services">
                <h2>Services</h2>
                <p>
                  Registered adapter services. These do not establish this account&apos;s upstream
                  entitlement.
                </p>
                <Text size="xs">{kinds.map((kind) => KIND_WORD[kind] || kind).join(', ')}</Text>
              </section>
              <AccountModelAccess key={c.id} connection={c} />
            </>
          ) : null}

          {task === 'auth' ? (
            <section className={styles.panel} aria-label="Replace the credential">
              <h2>Replace the credential</h2>
              <p>
                The stored credential is replaced in place; history and priority stay. The old
                credential is overwritten and cannot be recovered.
              </p>
              <div className={styles.form}>
                <Checkbox
                  size="xs"
                  className={styles.formWide}
                  label="Replace from a credential document"
                  checked={Boolean(
                    credential.documentMode ||
                      (c.authType === 'oauth' && requiresCredentialDocument(c.provider))
                  )}
                  disabled={
                    gate || (c.authType === 'oauth' && requiresCredentialDocument(c.provider))
                  }
                  onChange={(event) =>
                    setCredential({
                      ...credential,
                      documentMode: event.currentTarget.checked,
                      document: '',
                      secret: '',
                    })
                  }
                />
                {credential.documentMode ||
                (c.authType === 'oauth' && requiresCredentialDocument(c.provider)) ? (
                  <Textarea
                    size="xs"
                    className={styles.formWide}
                    autoComplete="off"
                    label="Credential JSON for this account"
                    description="One account document, or an export containing exactly one account. This path preserves the selected account identity."
                    minRows={3}
                    value={credential.document}
                    disabled={gate}
                    onChange={(event) =>
                      setCredential({ ...credential, document: event.currentTarget.value })
                    }
                  />
                ) : null}
                {!credential.documentMode &&
                (!entry?.hasOAuth || c.authType === 'apikey' || c.authType === 'cookie') ? (
                  <PasswordInput
                    size="xs"
                    autoComplete="off"
                    label={c.authType === 'cookie' ? 'Cookie value' : 'API key'}
                    value={credential.secret}
                    disabled={gate}
                    onChange={(event) =>
                      setCredential({ ...credential, secret: event.currentTarget.value })
                    }
                  />
                ) : null}
                {!credential.documentMode &&
                ['cursor', 'kimchi'].includes(c.provider) &&
                c.authType !== 'apikey' ? (
                  <PasswordInput
                    size="xs"
                    autoComplete="off"
                    label="Pasted token"
                    value={credential.secret}
                    disabled={gate}
                    onChange={(event) =>
                      setCredential({ ...credential, secret: event.currentTarget.value })
                    }
                  />
                ) : null}
                {c.provider === 'cursor' ? (
                  <TextInput
                    size="xs"
                    label="Machine id"
                    value={credential.machineId || psd.machineId || ''}
                    disabled={gate}
                    onChange={(event) =>
                      setCredential({ ...credential, machineId: event.currentTarget.value })
                    }
                  />
                ) : null}
                <Checkbox
                  size="xs"
                  className={styles.formWide}
                  label="Rebind even if the provider account differs"
                  checked={credential.force}
                  disabled={gate}
                  onChange={(event) =>
                    setCredential({ ...credential, force: event.currentTarget.checked })
                  }
                />
              </div>
              {grantStep ? (
                <Text size="xs" c="dimmed">
                  {grantStep}
                </Text>
              ) : null}
              <div className={styles.formActions}>
                <InlineConfirm
                  control="button"
                  label={c.authType === 'oauth' ? 'Sign in' : 'Replace credential'}
                  icon="i-keys"
                  armed={armed === 'reauth'}
                  busy={busy === 'reauth'}
                  disabled={gate}
                  note={
                    credential.force
                      ? 'Account rebinding is enabled. The old credential is overwritten.'
                      : 'The provider identity must match this account. The old credential is overwritten.'
                  }
                  onArm={() => setArmed('reauth')}
                  onCancel={() => setArmed(null)}
                  onConfirm={replaceCredential}
                />
              </div>
              <Text size="xs" c="dimmed">
                Credential values stay private and are never rendered back.
              </Text>
            </section>
          ) : null}

          {task === 'diagnostics' ? (
            <>
              <section className={styles.panel} aria-label="Last validation">
                <h2>Last validation</h2>
                {qual.error && !d ? <Notice {...refusal(qual.status, qual.error)} /> : null}
                {d || probe ? (
                  <dl className={styles.facts}>
                    <div className={styles.fact}>
                      <dt>Verdict</dt>
                      <dd>
                        {validation?.ok === true
                          ? 'Check passed'
                          : validation?.ok === false
                            ? 'Check failed'
                            : 'Not established'}
                      </dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Generation</dt>
                      <dd>Not verified by this check</dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Model</dt>
                      <dd>Not recorded</dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Check duration</dt>
                      <dd>
                        {typeof validation?.latencyMs === 'number'
                          ? fmtDuration(validation.latencyMs)
                          : 'Not recorded'}
                      </dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Error</dt>
                      <dd>{validation?.error || 'Not recorded'}</dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>Observed</dt>
                      <dd>
                        {validation?.checkedAt ? fmtRelative(validation.checkedAt, now) : 'Not recorded'}
                      </dd>
                    </div>
                  </dl>
                ) : !qual.error ? (
                  <Text size="xs" c="dimmed">
                    No validation on record.
                  </Text>
                ) : null}
                <div className={styles.formActions}>
                  <InlineConfirm
                    control="button"
                    label="Recheck"
                    icon="i-refresh"
                    armed={armed === 'recheck'}
                    busy={busy === 'recheck'}
                    disabled={gate}
                    note="Runs the provider validation. This may contact the provider, refresh credentials or consume quota. It does not establish that a model generated a response."
                    onArm={() => setArmed('recheck')}
                    onCancel={() => setArmed(null)}
                    onConfirm={async () => {
                      const response = await run(
                        'recheck',
                        () =>
                          call(`/api/admin/qualification/${id}/recheck`, {
                            method: 'POST',
                            body: {},
                          }),
                        { title: 'Recheck recorded' }
                      );
                      if (response?.ok) setProbe(response.body.validation || null);
                    }}
                  />
                  {advanced ? (
                    <Tooltip label="Force a recheck even if a result is fresh">
                      <ActionIcon
                        variant="default"
                        aria-label="Force recheck"
                        loading={busy === 'force'}
                        disabled={gate}
                        onClick={async () => {
                          const response = await run(
                            'force',
                            () =>
                              call(`/api/admin/qualification/${id}/recheck`, {
                                method: 'POST',
                                body: { force: true },
                              }),
                            { title: 'Forced recheck recorded' }
                          );
                          if (response?.ok) setProbe(response.body.validation || null);
                        }}
                      >
                        <Icon name="i-refresh" />
                      </ActionIcon>
                    </Tooltip>
                  ) : null}
                </div>
                <Text size="xs" c="dimmed">
                  Provider checks differ. A local credential check, upstream authentication and a
                  successful model request are separate evidence.
                </Text>
              </section>

              <section className={styles.panel} aria-label="Quota windows">
                <h2>Quota windows</h2>
                {d?.quota?.length ? (
                  <div className="rows">
                    {d.quota.map((window) => (
                      <QuotaWindow
                        key={window.scope}
                        provider={c.provider}
                        name={window.scope}
                        window={window}
                        horizonMs={HORIZON_MS}
                        now={now}
                      />
                    ))}
                  </div>
                ) : (
                  <Text size="xs" c="dimmed">
                    No windows observed for this account.
                  </Text>
                )}
              </section>

              <AccountOperations key={c.id} connection={c} onSaved={() => conn.refresh()} />
            </>
          ) : null}
        </>
      ) : null}
        </div>
      </div>
    </div>
  );
}
