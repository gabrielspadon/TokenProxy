'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Button,
  Loader,
  NativeSelect,
  NumberInput,
  Select,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Icon } from '@/shared/components/Icon';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  Card,
  DensitySwitch,
  EvidenceLine,
  StateWord,
  useDensity,
  useLevel,
} from '@/shared/workspace/Board';
import { CommitNumber } from '@/shared/workspace/CommitFields';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import styles from '@/shared/workspace/board.module.css';
import shared from '@/shared/workspace/workspace.module.css';
import { overrideCandidates, parseWindow } from './contextModel';
import {
  BUCKETS,
  SORTS,
  contextBucket,
  contextEntries,
  contextSummary,
  filterContext,
  sortContext,
  widestWindow,
  windowMeter,
} from './contextBoardModel';
import { BulkOverrides } from './BulkOverrides';
import './styles.css';

const ENDPOINT = '/api/model-context';
// A catalog of a thousand-plus models is not a scrolling problem, it is a
// rendering one: the board draws the first page and search narrows it.
const CAP = 60;
const TONE = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, bucket.tone]));
const WORD = { override: 'Overridden', registered: 'Registered', unknown: 'Unknown' };
const tokens = (value) =>
  Number.isFinite(value) && value > 0 ? value.toLocaleString('en-US') : 'Unknown';
const toast = (color, message, title) =>
  notifications.show({ color, message, title, autoClose: color === 'teal' ? 4000 : 9000 });

function ExactKey({ children }) {
  return (
    <code className="model-context-key" dir="ltr">
      <bdi dir="ltr">{children}</bdi>
    </code>
  );
}

// The meter line is a glance, so it carries the compact figure with the exact
// one in its title; the editable field and the expanded facts carry the exact
// number, which is what an operator types against.
function CompactTokens({ value }) {
  return Number.isFinite(value) && value > 0 ? (
    <bdi className="model-context-number" dir="ltr" title={tokens(value)}>
      {new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}
    </bdi>
  ) : (
    <>Unknown</>
  );
}

function TokenValue({ value }) {
  return Number.isFinite(value) && value > 0 ? (
    <bdi className="model-context-number" dir="ltr">
      {tokens(value)}
    </bdi>
  ) : (
    <>Unknown</>
  );
}

// A destructive act confirms inline, next to the thing it removes: the shared
// Confirm/Cancel pair, never a dialog.
function RemoveOverride({ name, saved, disabled, onRemove }) {
  if (!saved) return null;
  return (
    <InlineConfirm
      label={`Remove the override for ${name}`}
      hint={`Remove the saved override ${saved}`}
      icon="i-close"
      verb="Remove"
      danger
      disabled={disabled}
      onConfirm={onRemove}
    />
  );
}

// The precedence evidence, expanded under the card or row rather than in a
// layer: which keys could win, which one does, and where the next value would
// come from once this one is removed.
function ContextDetail({ entry, scopeKey, overrides, disabled, onScope }) {
  const candidates = entry.provider ? overrideCandidates(entry.provider, entry.row.model) : [];
  const options = [...new Map(candidates.map((candidate) => [candidate.key, candidate])).values()];
  return (
    <div className="model-context-detail" id={`context-detail-${entry.id}`}>
      <dl className="model-context-facts">
        <div>
          <dt>Catalog window</dt>
          <dd>
            {entry.provider ? (
              <>
                <TokenValue value={entry.catalog} /> tokens
              </>
            ) : (
              'Not a catalog model'
            )}
          </dd>
        </div>
        <div>
          <dt>Effective window</dt>
          <dd>
            <TokenValue value={entry.effective} /> tokens
          </dd>
        </div>
        <div>
          <dt>Winning override key</dt>
          <dd>{entry.winner ? <ExactKey>{entry.winner.key}</ExactKey> : 'None'}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{entry.winner?.scope || 'Registered or capability default'}</dd>
        </div>
      </dl>
      {entry.provider ? (
        <NativeSelect
          size="xs"
          label="Override scope and saved key"
          dir="ltr"
          attributes={{ input: { dir: 'ltr' } }}
          data-context-key-scope
          className="model-context-scope"
          value={scopeKey}
          disabled={disabled}
          onChange={(event) => onScope(event.currentTarget.value)}
          data={options.map((option) => ({
            value: option.key,
            label: `${option.scope} · ⁦${option.key}⁩`,
          }))}
        />
      ) : (
        <p>
          Exact saved key <ExactKey>{entry.key}</ExactKey>
        </p>
      )}
      <p className="model-context-caution">
        Provider-scoped keys affect that provider identity. Bare keys and wildcard rules can affect
        several providers. An override does not establish provider entitlement or capacity, and
        cannot by itself force a client&rsquo;s auto-compaction threshold to 100%.
      </p>
      <ol className="model-context-precedence">
        {candidates.length ? (
          candidates.map((candidate) => (
            <li key={candidate.key}>
              {candidate.scope} <ExactKey>{candidate.key}</ExactKey>
              {Object.hasOwn(overrides, candidate.key) ? (
                <>
                  {' '}
                  · <TokenValue value={overrides[candidate.key]} /> tokens saved
                </>
              ) : (
                ' · not saved'
              )}
            </li>
          ))
        ) : (
          <li>Provider / raw model, provider / basename, basename, then raw model exact keys.</li>
        )}
        <li>
          Wildcard keys follow exact keys. The first matching saved wildcard wins,
          case-insensitively, in saved map order.
        </li>
      </ol>
      <p>
        Saving replaces this exact key and reloads the gateway override map. Removing it exposes the
        next matching rule or registered default. Requests already being processed may retain
        earlier values.
      </p>
    </div>
  );
}

function Evidence({ entry, widest }) {
  const meter = windowMeter(entry.effective, widest);
  return (
    <>
      <EvidenceLine
        label="Effective"
        remaining={meter.remaining}
        level={meter.level}
        unknown={meter.unknown}
        value={<CompactTokens value={entry.effective} />}
        note={entry.winner?.key || ''}
        title={
          entry.winner
            ? `${entry.winner.scope} · ${entry.winner.key}`
            : 'Registered or capability default'
        }
      />
      {entry.provider && entry.catalog !== entry.effective ? (
        <EvidenceLine
          label="Catalog"
          remaining={windowMeter(entry.catalog, widest).remaining}
          level={windowMeter(entry.catalog, widest).level}
          unknown={windowMeter(entry.catalog, widest).unknown}
          value={<CompactTokens value={entry.catalog} />}
          note="Registered default"
          title="The window the catalog reports before any override"
        />
      ) : null}
    </>
  );
}

function TokenField({ entry, scopeKey, disabled, onCommit }) {
  return (
    <Tooltip label={`Saves to ${scopeKey} on Enter or blur`}>
      <CommitNumber
        className="model-context-tokens"
        aria-label={`Context window in tokens for ${entry.name}`}
        data-context-token-input
        dir="ltr"
        attributes={{ input: { dir: 'ltr' } }}
        inputMode="numeric"
        placeholder="Unknown"
        value={entry.saved ?? entry.effective ?? ''}
        disabled={disabled}
        onCommit={onCommit}
      />
    </Tooltip>
  );
}

export default function ModelContextPage() {
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const [sort, setSort] = useState('name');
  const [expanded, setExpanded] = useState(null);
  const [scopeKeys, setScopeKeys] = useState({});
  const [adding, setAdding] = useState(false);
  const [addKey, setAddKey] = useState('');
  const [addTokens, setAddTokens] = useState('');
  const [bulk, setBulk] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const controller = useRef(null);

  const read = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    try {
      const response = await fetch(ENDPOINT, { cache: 'no-store', signal: next.signal });
      const body = await response.json();
      if (!response.ok) return { error: refusal(response.status, body) };
      if (
        !Array.isArray(body.models) ||
        !body.overrides ||
        typeof body.overrides !== 'object' ||
        Array.isArray(body.overrides)
      )
        return {
          error: {
            tone: 'bad',
            title: 'Context configuration could not be read.',
            detail: 'The response did not contain a model list and override map.',
          },
        };
      return next.signal.aborted ? null : { data: body };
    } catch (cause) {
      return next.signal.aborted
        ? null
        : {
            error: {
              tone: 'bad',
              title: 'Context configuration could not be read.',
              detail: cause.message,
            },
          };
    }
  }, []);

  const receive = useCallback((result) => {
    if (!result) return;
    if (result.data) setData(result.data);
    setError(result.error || null);
    setLoading(false);
    return result;
  }, []);

  // `loading` is already true on the first render, so the mount read never sets
  // state synchronously inside the effect; the button path marks the read first.
  const reread = useCallback(
    () =>
      read()
        .then(receive)
        .catch((cause) =>
          receive({
            error: {
              tone: 'bad',
              title: 'Context configuration could not be read.',
              detail: cause.message,
            },
          })
        ),
    [read, receive]
  );
  const refresh = useCallback(() => {
    setLoading(true);
    return reread();
  }, [reread]);

  useEffect(() => {
    reread();
    return () => controller.current?.abort();
  }, [reread]);

  const overrides = useMemo(() => data?.overrides || {}, [data]);
  const entries = useMemo(() => contextEntries(data?.models || [], overrides), [data, overrides]);
  const summary = contextSummary(entries);
  const widest = widestWindow(entries);
  const matching = sortContext(filterContext(entries, { query, bucket }), sort);
  const visible = showAll || matching.length <= CAP ? matching : matching.slice(0, CAP);
  const editable = Boolean(data) && !error && !loading && !blocked;
  const scopeOf = (entry) => scopeKeys[entry.id] || entry.editKey;

  async function write(entry, action) {
    if (busy) return;
    setBusy(entry.id);
    const result = await call(
      action.remove ? `${ENDPOINT}?key=${encodeURIComponent(action.key)}` : ENDPOINT,
      action.remove
        ? { method: 'DELETE' }
        : { method: 'PUT', body: { key: action.key, contextWindow: action.value } }
    );
    if (!result.ok || result.body?.success !== true) {
      const failure = result.ok
        ? { title: 'The gateway did not confirm this change.', detail: null }
        : refusal(result.status, result.body);
      toast('orange', [failure.title, failure.detail].filter(Boolean).join(' '), entry.name);
      setBusy(null);
      return;
    }
    const readback = await refresh();
    const fresh = readback?.data;
    const verified =
      fresh &&
      (action.remove
        ? !Object.hasOwn(fresh.overrides, action.key)
        : fresh.overrides[action.key] === action.value);
    if (verified) {
      toast(
        'teal',
        `${action.remove ? 'Override removed' : 'Override saved'} and verified after refresh: ${action.key}.`,
        entry.name
      );
      setBlocked(false);
    } else {
      toast(
        'orange',
        `The request succeeded, but readback did not verify the change to ${action.key}. Refresh configuration before another change.`,
        entry.name
      );
      setBlocked(true);
    }
    setBusy(null);
  }

  function save(entry, value) {
    const key = scopeOf(entry);
    const parsed = parseWindow(String(value));
    if (parsed === null) {
      toast('orange', 'Enter a positive whole number of tokens.', entry.name);
      return;
    }
    if (overrides[key] === parsed) return;
    write(entry, { key, value: parsed });
  }

  async function addOverride() {
    const key = addKey.trim();
    const value = parseWindow(String(addTokens).trim());
    if (!key || value === null) {
      toast(
        'orange',
        'Give an exact key or wildcard rule and a positive whole number of tokens.',
        'Add override'
      );
      return;
    }
    await write({ id: `override:${key}`, name: key }, { key, value });
    setAddKey('');
    setAddTokens('');
    setAdding(false);
  }

  const chips = [
    { id: null, label: entries.length === 1 ? 'entry' : 'entries', count: entries.length },
    ...BUCKETS.map((item) => ({
      id: item.id,
      tone: item.tone,
      label: item.label.toLowerCase(),
      count: summary[item.id],
    })),
  ];

  const cards = BUCKETS.map((item) => {
    const members = visible.filter((entry) => contextBucket(entry) === item.id);
    if (!members.length) return null;
    return (
      <BoardGroup key={item.id} label={item.label} tone={item.tone} count={members.length}>
        {members.map((entry) => {
          const state = contextBucket(entry);
          const isOpen = expanded === entry.id;
          return (
            <Card
              key={entry.id}
              id={entry.id}
              bucket={state}
              expanded={isOpen}
              label={entry.name}
              head={
                <>
                  {entry.provider ? <ProviderMark provider={entry.provider} size="small" /> : null}
                  <div className={styles.identityText}>
                    <span className={styles.nameLine}>
                      <button
                        type="button"
                        className={styles.nameButton}
                        aria-expanded={isOpen}
                        aria-controls={isOpen ? `context-detail-${entry.id}` : undefined}
                        onClick={() => setExpanded(isOpen ? null : entry.id)}
                      >
                        {entry.name}
                      </button>
                    </span>
                    <small>
                      <ExactKey>{entry.key}</ExactKey>
                    </small>
                  </div>
                  <Tooltip label={isOpen ? 'Collapse' : 'Matching precedence'}>
                    <button
                      type="button"
                      className={styles.caret}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${entry.name}`}
                      onClick={() => setExpanded(isOpen ? null : entry.id)}
                    >
                      <Icon name={isOpen ? 'i-chevron-up' : 'i-chevron-down'} />
                    </button>
                  </Tooltip>
                </>
              }
              state={
                <>
                  <StateWord tone={TONE[state]}>{WORD[state]}</StateWord>
                  <span className={styles.spacer} />
                  <TokenField
                    entry={entry}
                    scopeKey={scopeOf(entry)}
                    disabled={!editable || busy === entry.id}
                    onCommit={(value) => save(entry, value)}
                  />
                  <RemoveOverride
                    name={entry.name}
                    saved={entry.winner?.key}
                    disabled={!editable || busy === entry.id}
                    onRemove={() => write(entry, { key: entry.winner.key, remove: true })}
                  />
                </>
              }
              detail={
                <ContextDetail
                  entry={entry}
                  scopeKey={scopeOf(entry)}
                  overrides={overrides}
                  disabled={!editable}
                  onScope={(key) => setScopeKeys((previous) => ({ ...previous, [entry.id]: key }))}
                />
              }
            >
              <Evidence entry={entry} widest={widest} />
            </Card>
          );
        })}
      </BoardGroup>
    );
  });

  const rows = visible.map((entry) => {
    const state = contextBucket(entry);
    const isOpen = expanded === entry.id;
    return (
      <article
        key={entry.id}
        className={styles.row}
        data-account-id={entry.id}
        data-expanded={isOpen || undefined}
        data-bucket={state}
        aria-label={entry.name}
      >
        <div className={styles.main}>
          <Tooltip label={isOpen ? 'Collapse' : 'Matching precedence'}>
            <button
              type="button"
              className={styles.caret}
              aria-expanded={isOpen}
              aria-controls={isOpen ? `context-detail-${entry.id}` : undefined}
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${entry.name}`}
              onClick={() => setExpanded(isOpen ? null : entry.id)}
            >
              <Icon name={isOpen ? 'i-chevron-up' : 'i-chevron-down'} />
            </button>
          </Tooltip>
          <div className={styles.identity}>
            {entry.provider ? <ProviderMark provider={entry.provider} size="small" /> : null}
            <div className={styles.identityText}>
              <span className={styles.nameLine}>
                <button
                  type="button"
                  className={styles.nameButton}
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : entry.id)}
                >
                  {entry.name}
                </button>
              </span>
              <small>
                <ExactKey>{entry.key}</ExactKey>
              </small>
            </div>
          </div>
          <div className={styles.state}>
            <StateWord tone={TONE[state]}>{WORD[state]}</StateWord>
          </div>
          <div className={styles.quota}>
            <Evidence entry={entry} widest={widest} />
          </div>
          <div className={styles.activity}>
            <span>{entry.providerName}</span>
            <small>
              {Number.isFinite(entry.connections)
                ? `${entry.connections} configured connections`
                : entry.winner?.scope || 'Connections unknown'}
            </small>
          </div>
          <div className={styles.actions}>
            <TokenField
              entry={entry}
              scopeKey={scopeOf(entry)}
              disabled={!editable || busy === entry.id}
              onCommit={(value) => save(entry, value)}
            />
            <RemoveOverride
              name={entry.name}
              saved={entry.winner?.key}
              disabled={!editable || busy === entry.id}
              onRemove={() => write(entry, { key: entry.winner.key, remove: true })}
            />
          </div>
        </div>
        {isOpen ? (
          <div className={styles.detail} role="region" aria-label="Selection details">
            <ContextDetail
              entry={entry}
              scopeKey={scopeOf(entry)}
              overrides={overrides}
              disabled={!editable}
              onScope={(key) => setScopeKeys((previous) => ({ ...previous, [entry.id]: key }))}
            />
          </div>
        ) : null}
      </article>
    );
  });

  return (
    <div className={`${shared.lensPage} model-context-page`} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Context limits</h1>
          <p>
            {advanced ? 'Advanced' : 'Everyday'} · registered windows and the overrides the gateway
            applies
          </p>
        </div>
        <Button component={Link} href="/dashboard/shaping" variant="subtle" size="compact-xs">
          Token savings
        </Button>
      </div>
      <div className={shared.lensBody}>
        <Board label="Context limits" advanced={advanced} density={density} compare="none">
          <BoardSummary
            label="Context limit summary"
            chips={chips}
            active={bucket}
            onPick={(value) => {
              setBucket(value);
              setShowAll(false);
            }}
            note={
              loading
                ? 'Reading context configuration…'
                : blocked
                  ? 'Readback is unverified. Refresh before another change.'
                  : 'Edits save on Enter or blur. This configuration is global to the gateway.'
            }
          />
          <BoardToolbar
            search={query}
            onSearch={(value) => {
              setQuery(value);
              setShowAll(false);
            }}
            searchLabel="Find a model or saved key"
            actions={
              <>
                {advanced ? (
                  <Tooltip label="Set or remove several exact keys together">
                    <ActionIcon
                      variant={bulk ? 'light' : 'default'}
                      aria-label="Edit several overrides"
                      aria-expanded={bulk}
                      onClick={() => setBulk((value) => !value)}
                    >
                      <Icon name="i-edit" />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
                <Button
                  size="xs"
                  leftSection={<Icon name="i-add" />}
                  aria-expanded={adding}
                  onClick={() => setAdding((value) => !value)}
                >
                  Add override
                </Button>
                <Tooltip label="Re-read the saved override map">
                  <ActionIcon
                    variant="default"
                    aria-label="Refresh context configuration"
                    loading={loading}
                    onClick={refresh}
                  >
                    <Icon name="i-refresh" />
                  </ActionIcon>
                </Tooltip>
              </>
            }
          >
            {advanced ? (
              <Select
                size="xs"
                aria-label="Sort context limits"
                data={SORTS}
                value={sort}
                onChange={(value) => value && setSort(value)}
                leftSection={<Icon name="i-sort" />}
                className={styles.sort}
                allowDeselect={false}
              />
            ) : null}
            <DensitySwitch value={density} onChange={setDensity} />
          </BoardToolbar>
          {adding ? (
            <form
              className={styles.addRow}
              aria-label="Add a context override"
              onSubmit={(event) => {
                event.preventDefault();
                addOverride();
              }}
            >
              <TextInput
                size="xs"
                className={styles.addName}
                aria-label="Exact key or wildcard rule"
                placeholder="provider/model or wildcard"
                dir="ltr"
                attributes={{ input: { dir: 'ltr' } }}
                value={addKey}
                onChange={(event) => setAddKey(event.currentTarget.value)}
              />
              <NumberInput
                size="xs"
                hideControls
                allowDecimal={false}
                className={styles.addMode}
                aria-label="Context window in tokens for the new key"
                placeholder="Tokens"
                min={1}
                value={addTokens}
                onChange={setAddTokens}
              />
              <span className={styles.addNote}>
                A wildcard rule applies after every exact key, in saved order.
              </span>
              <Button size="xs" type="submit" disabled={!editable || Boolean(busy)}>
                Add
              </Button>
              <Button size="xs" variant="default" onClick={() => setAdding(false)}>
                Close
              </Button>
            </form>
          ) : null}
          {advanced && bulk ? (
            <div className="model-context-bulk-slot">
              <BulkOverrides
                overrides={overrides}
                disabled={!editable}
                onReadback={(fresh) => {
                  receive({ data: fresh });
                  setBlocked(false);
                }}
              />
            </div>
          ) : null}
          {error ? (
            <Text size="xs" c="orange.8" role="alert" className={styles.notice}>
              {error.title} {error.detail || ''} {error.next || ''}
            </Text>
          ) : null}
          {advanced ? (
            <div className={styles.head} aria-hidden="true">
              <span />
              <span>Model or saved key</span>
              <span>State</span>
              <span>Context window</span>
              <span>Provider</span>
              <span>Tokens · remove</span>
            </div>
          ) : null}
          {!advanced ? cards : null}
          <div className={styles.rows} hidden={!advanced}>
            {advanced ? rows : null}
          </div>
          <div className={styles.messages}>
            {loading && !data ? (
              <div className={styles.empty}>
                <Loader size="xs" /> Reading context configuration…
              </div>
            ) : null}
            {data && !entries.length ? (
              <div className={styles.empty}>
                No model reports a context window yet. A model appears once a provider is connected.
              </div>
            ) : null}
            {visible.length < matching.length ? (
              <div className={styles.empty}>
                Showing {visible.length.toLocaleString('en-US')} of{' '}
                {matching.length.toLocaleString('en-US')} entries. Search narrows the list.{' '}
                <button type="button" className={styles.linkButton} onClick={() => setShowAll(true)}>
                  Show every entry
                </button>
              </div>
            ) : null}
            {entries.length && !visible.length ? (
              <div className={styles.empty}>
                No model or saved key matches.{' '}
                <button
                  type="button"
                  className={styles.linkButton}
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
      </div>
    </div>
  );
}
