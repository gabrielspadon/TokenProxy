'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, NativeSelect, TextInput, Tooltip } from '@mantine/core';
import { Icon } from '@/shared/components/Icon';
import { ProviderMark, providerIdentity } from '@/shared/components/ProviderMark';
import { useOptionalWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { accountPath } from './accountPath';
import { call } from '@/shared/api';
import { Notice } from '@/shared/components/Notice';
import { refusal } from '@/shared/refusal';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  DensitySwitch,
  EvidenceLine,
  StateWord,
  boardStyles as board,
  useDensity,
  useLevel,
} from '@/shared/workspace/Board';

// A stored path either refuses new routing, cannot be read, or applies. The
// three read as their own words rather than as one "configured".
const PATH_TONE = {
  direct: 'positive',
  pool: 'positive',
  inherited: null,
  legacy: 'ember',
  unknown: 'ember',
  unavailable: 'refusal',
};
// Short enough for the board's state column; the full sentence rides the
// tooltip and the expanded evidence rather than overflowing the grid.
const PATH_WORD = {
  direct: 'Direct',
  pool: 'Pooled',
  inherited: 'Inherited',
  legacy: 'Override',
  unknown: 'Unknown',
  unavailable: 'Refused',
};
const ACCOUNT_BUCKETS = [
  { id: 'enabled', label: 'Account enabled', tone: 'positive' },
  { id: 'disabled', label: 'Account disabled', tone: 'ember' },
];

export function AccountPaths({ connections, pools, onSaved, density: densityProp, onDensity, showDensity = false }) {
  const workspace = useOptionalWorkspace();
  const advanced = useLevel();
  // One density switch per page; a bare render falls back to the shared value.
  const [ownDensity, setOwnDensity] = useDensity();
  const density = densityProp ?? ownDensity;
  const setDensity = onDensity ?? setOwnDensity;
  const [localSelectedId, setLocalSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const selectedId = workspace
    ? workspace.selectedRecord?.kind === 'account'
      ? workspace.selectedRecord.id
      : null
    : localSelectedId;
  const select = (id) => {
    const connection = connections.find((account) => account.id === id);
    if (workspace)
      workspace.setSelectedRecord(
        id
          ? {
              kind: 'account',
              id,
              connectionId: id,
              ...(connection?.provider ? { provider: connection.provider } : {}),
            }
          : null
      );
    else setLocalSelectedId(id);
  };
  const needle = query.trim().toLowerCase();
  const visible = connections.filter((connection) => {
    const state = connection.isActive === false ? 'disabled' : 'enabled';
    if (bucket && state !== bucket) return false;
    if (!needle) return true;
    return [connection.name, connection.id, connection.provider]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
  const counts = {
    enabled: connections.filter((c) => c.isActive !== false).length,
    disabled: connections.filter((c) => c.isActive === false).length,
  };

  const identity = (connection, expanded) => (
    <div className={board.identity}>
      <ProviderMark provider={connection.provider} size="small" />
      <div className={board.identityText}>
        <span className={board.nameLine}>
          <button
            type="button"
            className={board.nameButton}
            aria-expanded={expanded}
            aria-label={`Inspect account path for ${connection.name || connection.id}`}
            onClick={() => select(expanded ? null : connection.id)}
          >
            {connection.name || connection.id}
          </button>
        </span>
        <small>{providerIdentity(connection.provider).name}</small>
      </div>
    </div>
  );

  // A path target is a name, not a proportion, so the row line draws no bar and
  // the value column carries the target in full. A card has no width for a
  // grid line beside it, so the card states the target and its policy as one
  // wrapping sentence instead of clipping both.
  const evidence = (connection, path) => (
    <EvidenceLine
      label="Target"
      meter={false}
      value={path.label}
      note={
        path.kind === 'pool' || path.kind === 'unavailable'
          ? connection.providerSpecificData?.strictProxy
            ? 'strict binding'
            : 'direct fallback allowed'
          : 'stored policy'
      }
      title={`${path.label}. ${path.policy} Reachability is not established by this configuration read.`}
    />
  );

  const cardEvidence = (path) => (
    <p className={board.muted}>
      {path.label}. {path.policy}
    </p>
  );

  const detail = (connection) => {
    const path = accountPath(connection, pools);
    return (
      <div className="network-path-inspector" aria-label="Network path inspector">
        <dl className="facts">
          <dt>Provider</dt>
          <dd>
            <bdi>{connection.provider}</bdi>
          </dd>
          <dt>Account path</dt>
          <dd>
            <bdi>{path.label}</bdi>
          </dd>
          <dt>Failure policy</dt>
          <dd>{path.policy}</dd>
          <dt>Reachability</dt>
          <dd>Not established by this configuration read.</dd>
          <dt>Upstream model access</dt>
          <dd>Unknown until supported evidence is recorded.</dd>
        </dl>
        <AccountPathBinding
          key={connection.id}
          connection={connection}
          pools={pools}
          onSaved={onSaved}
        />
        <Link href={`/dashboard/connections/${encodeURIComponent(connection.id)}`} prefetch={false}>
          Account policy and credentials
        </Link>
      </div>
    );
  };

  const caret = (connection, expanded) => (
    <Tooltip label={expanded ? 'Collapse' : 'Path evidence and binding'}>
      <button
        type="button"
        className={board.caret}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${connection.name || connection.id}`}
        onClick={() => select(expanded ? null : connection.id)}
      >
        <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
      </button>
    </Tooltip>
  );

  return (
    <section className="network-paths" aria-labelledby="network-paths-title">
      <h3 id="network-paths-title" className="network-lens">
        Account paths
      </h3>
      <Board
        label="Account paths"
        advanced={advanced}
        data-compare="none"
        density={density}
        layout={advanced ? 'rows' : 'cards'}
      >
        <BoardSummary
          label="Account path summary"
          active={bucket}
          onPick={setBucket}
          chips={[
            {
              count: connections.length,
              label: connections.length === 1 ? 'account' : 'accounts',
            },
            ...ACCOUNT_BUCKETS.map((item) => ({
              id: item.id,
              tone: item.tone,
              count: counts[item.id],
              label: item.label.toLowerCase(),
            })),
          ]}
          note={
            <span title="Stored account → proxy pool → provider policy. Opening this comparison does not test a route or change eligibility.">
              Stored policy only; no route is tested here
            </span>
          }
        />
        <BoardToolbar search={query} onSearch={setQuery} searchLabel="Search accounts">
          {showDensity ? (
            <Tooltip label="How much room every board on this page takes">
              <DensitySwitch value={density} onChange={setDensity} />
            </Tooltip>
          ) : null}
        </BoardToolbar>
        {advanced && visible.length ? (
          <div className={board.head} aria-hidden="true">
            <span />
            <span>Account</span>
            <span>Stored path</span>
            <span>Evidence</span>
            <span>Account state</span>
            <span />
          </div>
        ) : null}
        {advanced ? (
          <div className={board.rows}>
            {visible.map((connection) => {
              const expanded = selectedId === connection.id;
              const path = accountPath(connection, pools);
              return (
                <article
                  key={connection.id}
                  className={board.row}
                  data-connection-id={connection.id}
                  data-expanded={expanded || undefined}
                  aria-label={connection.name || connection.id}
                >
                  <div className={board.main}>
                    {caret(connection, expanded)}
                    {identity(connection, expanded)}
                    <div className={board.state}>
                      <Tooltip label={path.policy}>
                        <span>
                          <StateWord tone={PATH_TONE[path.kind]}>{PATH_WORD[path.kind]}</StateWord>
                        </span>
                      </Tooltip>
                    </div>
                    <div className={board.quota}>{evidence(connection, path)}</div>
                    <div className={board.activity}>
                      <span>
                        {connection.isActive === false ? 'Account disabled' : 'Account enabled'}
                      </span>
                      <small>{connection.id}</small>
                    </div>
                    <div className={board.actions} />
                  </div>
                  {expanded ? (
                    <div className={board.detail} role="region" aria-label="Account path">
                      {detail(connection)}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          ACCOUNT_BUCKETS.map((item) => {
            const members = visible.filter(
              (connection) => (connection.isActive === false ? 'disabled' : 'enabled') === item.id
            );
            if (!members.length) return null;
            return (
              <BoardGroup key={item.id} label={item.label} tone={item.tone} count={members.length}>
                {members.map((connection) => {
                  const expanded = selectedId === connection.id;
                  const path = accountPath(connection, pools);
                  return (
                    <article
                      key={connection.id}
                      className={board.card}
                      data-connection-id={connection.id}
                      data-expanded={expanded || undefined}
                      aria-label={connection.name || connection.id}
                    >
                      <header className={board.cardHead}>
                        {identity(connection, expanded)}
                        {caret(connection, expanded)}
                      </header>
                      <div className={board.cardState}>
                        <Tooltip label={path.policy}>
                          <span>
                            <StateWord tone={PATH_TONE[path.kind]}>{PATH_WORD[path.kind]}</StateWord>
                          </span>
                        </Tooltip>
                      </div>
                      <div className={board.cardWindows}>{cardEvidence(path)}</div>
                      {expanded ? (
                        <div className={board.detail} role="region" aria-label="Account path">
                          {detail(connection)}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </BoardGroup>
            );
          })
        )}
        <div className={board.messages}>
          {!connections.length ? (
            <p className={board.empty}>
              No credentialed accounts are configured. Provider strategies below also cover virtual
              accounts without credentials.
            </p>
          ) : null}
          {connections.length > 0 && !visible.length ? (
            <p className={board.empty}>
              No account matches.{' '}
              <button
                type="button"
                className={board.linkButton}
                onClick={() => {
                  setQuery('');
                  setBucket(null);
                }}
              >
                Clear filters
              </button>
            </p>
          ) : null}
        </div>
      </Board>
    </section>
  );
}

export function accountBindingBody(mode, proxyUrl, noProxy) {
  if (mode === '__legacy__')
    return {
      connectionProxyEnabled: true,
      connectionProxyUrl: proxyUrl,
      connectionNoProxy: noProxy || '',
    };
  return { proxyPoolId: mode === '__clear__' ? null : mode || '__none__' };
}

export function AccountPathBinding({ connection, pools, onSaved }) {
  const data = connection.providerSpecificData || {};
  const [mode, setMode] = useState(
    data.proxyPoolId ||
      (data.connectionProxyMode === 'direct'
        ? '__none__'
        : data.connectionProxyMode === 'proxy' || data.connectionProxyEnabled
          ? '__legacy__'
          : '__clear__')
  );
  const [proxyUrl, setProxyUrl] = useState('');
  const [noProxy, setNoProxy] = useState(data.connectionNoProxy || '');
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    const clear = () => {
      if (document.hidden) {
        setProxyUrl('');
        setReview(null);
      }
    };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);
  async function save() {
    setBusy(true);
    setNotice(null);
    const response = await call(`/api/providers/${encodeURIComponent(connection.id)}`, {
      method: 'PUT',
      body: review,
    });
    setProxyUrl('');
    if (!response.ok) {
      setBusy(false);
      if (!response.status) {
        setUncertain(true);
        setReview(null);
        setNotice({
          tone: 'warn',
          title: 'The account path outcome is unknown.',
          next: 'Refresh this account before another change. Do not repeat the interrupted write.',
        });
      } else setNotice(refusal(response.status, response.body));
      return;
    }
    const read = await call(`/api/providers/${encodeURIComponent(connection.id)}`);
    const saved = read.body?.connection;
    const expected = response.body?.connection;
    const fields = [
      'proxyPoolId',
      'strictProxy',
      'connectionProxyMode',
      'connectionProxyEnabled',
      'connectionNoProxy',
    ];
    const matches =
      read.ok &&
      saved?.id === connection.id &&
      saved.provider === connection.provider &&
      expected?.id === connection.id &&
      fields.every(
        (field) =>
          (saved.providerSpecificData?.[field] ?? null) ===
          (expected.providerSpecificData?.[field] ?? null)
      );
    setBusy(false);
    setReview(null);
    setUncertain(!matches);
    onSaved?.();
    setNotice(
      matches
        ? {
            tone: 'ok',
            title: 'Account path saved and read back.',
            next: 'The saved path applies to subsequent routing. Reachability and provider authentication remain untested.',
          }
        : {
            tone: 'warn',
            title: 'Accepted, but the saved account path was not confirmed.',
            next: 'Refresh the account before another change. Do not repeat the mutation.',
          }
    );
  }
  const consequence =
    mode === '__none__'
      ? 'Subsequent requests use an explicit direct connection.'
      : mode === '__clear__'
        ? 'The pool binding is cleared and the retained account or global path applies.'
        : mode === '__legacy__'
          ? 'Subsequent requests use the supplied account proxy.'
          : 'Subsequent requests use the selected pool and its strictness. A strict binding refuses direct fallback.';
  return (
    <section aria-label="Account path binding" className="network-binding">
      <h3>Change account path</h3>
      {notice ? <Notice {...notice} /> : null}
      <div className="network-edit">
        <NativeSelect
          size="xs"
          label="Account path"
          className={board.addProvider}
          value={mode}
          disabled={busy || uncertain || Boolean(review)}
          onChange={(event) => {
            setNotice(null);
            setMode(event.currentTarget.value);
          }}
          data={[
            { value: '__none__', label: 'Explicit direct connection' },
            { value: '__clear__', label: 'Clear pool; restore retained account or global path' },
            { value: '__legacy__', label: 'Custom proxy for this account' },
            ...pools
              .filter((pool) => pool.isActive === true)
              .map((pool) => ({
                value: pool.id,
                label: `${pool.name}${pool.strictProxy ? ' · Strict' : ' · Direct fallback allowed'}`,
              })),
          ]}
        />
        {mode === '__legacy__' ? (
          <>
            <TextInput
              size="xs"
              label="Account proxy URL"
              type="password"
              autoComplete="off"
              required
              className={board.addSecret}
              value={proxyUrl}
              disabled={busy || uncertain || Boolean(review)}
              onChange={(event) => setProxyUrl(event.currentTarget.value)}
            />
            <TextInput
              size="xs"
              label="Bypass hosts"
              className={board.addName}
              value={noProxy}
              disabled={busy || uncertain || Boolean(review)}
              onChange={(event) => setNoProxy(event.currentTarget.value)}
            />
          </>
        ) : null}
        <Button
          size="xs"
          disabled={busy || uncertain || Boolean(review)}
          onClick={() => {
            setNotice(null);
            setReview(accountBindingBody(mode, proxyUrl, noProxy));
          }}
        >
          Review account path
        </Button>
      </div>
      <p className={board.muted}>
        A pool takes precedence over retained account proxy settings and supplies its strictness.
        Clearing a pool restores those settings. Explicit direct bypasses account, global and
        environment proxies.
      </p>
      {review ? (
        <div className={board.notice} role="alertdialog" aria-label="Review account path">
          <span className={board.muted}>{consequence}</span>{' '}
          <Button size="compact-xs" disabled={busy} onClick={save}>
            Apply account path
          </Button>{' '}
          <Button
            size="compact-xs"
            variant="default"
            disabled={busy}
            onClick={() => {
              setReview(null);
              setProxyUrl('');
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </section>
  );
}
