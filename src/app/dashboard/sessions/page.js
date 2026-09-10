'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ActionIcon, Button, NativeSelect, Select, TextInput, Tooltip } from '@mantine/core';
import { usePoll } from '@/shared/hooks/usePoll';
import { useEventStream } from '@/shared/hooks/useEventStream';
import { useUsageStream } from '@/store/usageStream';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { QuotaWindow } from '@/shared/components/QuotaWindow';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtRelative } from '@/shared/format';
import { recordTime } from '@/shared/components/workspace/economics';
import { WORDS as STATUS } from '@/shared/status';
import { Icon } from '@/shared/components/Icon';
import SessionPins from '@/shared/components/SessionPins';
import './styles.css';
import { useResource } from '@/shared/workspace/useResource';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import shared from '@/shared/workspace/workspace.module.css';
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

const HORIZON_MS = 6 * 3600 * 1000;
const PAGE = 25;
const WORDS = {
  ...STATUS,
  active: 'Running',
  pending: 'Waiting',
  done: 'Finished',
  error: 'Failed',
};

// The live buckets a session can be in, each a summary chip and a card group.
const LIVE_BUCKETS = [
  { id: 'active', label: 'Running', tone: 'positive' },
  { id: 'pending', label: 'Waiting', tone: 'ember' },
  { id: 'error', label: 'Failed', tone: 'refusal' },
  { id: 'done', label: 'Finished', tone: null },
];

// The closed trigger vocabulary of the admin ABI, one sentence each. An
// unmapped value prints raw rather than being renamed to something it is not.
const TRIGGER = {
  exhausted: 'Quota exhausted',
  reset: 'Reset-triggered account selection',
  drain: 'The account was drained',
  model_failure: 'This model failed on that account',
  manual: 'Set by hand',
};
const TRIGGER_TONE = {
  exhausted: 'ember',
  reset: 'positive',
  drain: 'ember',
  model_failure: 'refusal',
  manual: null,
};
const TRIGGER_ORDER = ['exhausted', 'model_failure', 'drain', 'reset', 'manual'];

const SINCE = [
  { value: 'current', label: 'Current shared UTC range' },
  { value: '', label: 'Any time' },
  { value: String(3600e3), label: 'The last hour' },
  { value: String(86400e3), label: 'The last day' },
  { value: String(7 * 86400e3), label: 'The last week' },
];

const EMPTY = { connectionId: '', model: '', since: '' };
const recordStartedAt = (row) =>
  typeof row.startedAt === 'number' ? row.startedAt : Date.parse(row.startedAt);

function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}

function Account({ id, names }) {
  const c = names.get(id);
  if (!id) return <span className="unreported">Not reported</span>;
  return (
    <Link href={`/dashboard/connections/${id}`} prefetch={false}>
      <span>{c?.displayName || c?.provider || id}</span>
    </Link>
  );
}

function Evidence({ id, windows, names, now }) {
  if (windows === null) return <span className="unreported">There was no earlier account</span>;
  if (!windows || windows.length === 0)
    return <span className="unreported">No window was recorded</span>;
  const c = names.get(id);
  return (
    <div className="rows">
      {windows.map((w, i) => (
        <QuotaWindow
          key={`${w.scope}-${i}`}
          provider={c?.provider}
          name={c?.displayName || c?.provider}
          window={w}
          horizonMs={HORIZON_MS}
          now={now}
        />
      ))}
    </div>
  );
}

// One switch receipt in full. Every field is picked by name: `sessionHash` is
// on the wire and is deliberately not read here, because it is the session
// identity and this surface never renders one.
function Receipt({ r, names, now }) {
  const { setSelectedRecord } = useWorkspace();
  return (
    <div className="sessions-receipt">
      <dl className="facts">
        <dt>Left</dt>
        <dd>
          {r.oldConnectionId ? (
            <Account id={r.oldConnectionId} names={names} />
          ) : (
            <span className="unreported">Nothing. This was the first pin of that session.</span>
          )}
        </dd>
        <dt>Landed on</dt>
        <dd>
          <Account id={r.newConnectionId} names={names} />
        </dd>
        <dt>Recorded</dt>
        <dd>
          {recordTime(r.timestamp)} · {fmtRelative(r.timestamp, now)}
        </dd>
      </dl>
      <details className="sessions-evidence">
        <summary>Quota evidence at the switch</summary>
        <dl className="facts">
          <dt>Left</dt>
          <dd>
            <Evidence
              id={r.oldConnectionId}
              windows={r.windows?.old ?? null}
              names={names}
              now={now}
            />
          </dd>
          <dt>Landed on</dt>
          <dd>
            <Evidence id={r.newConnectionId} windows={r.windows?.new} names={names} now={now} />
          </dd>
          <dt>Receipt</dt>
          <dd className="id">{r.receiptId}</dd>
        </dl>
      </details>
      <Button
        variant="subtle"
        size="compact-xs"
        onClick={() =>
          setSelectedRecord({
            kind: 'routing-switch',
            id: r.receiptId,
            model: r.model,
            connectionId: r.newConnectionId,
            fromConnectionId: r.oldConnectionId,
            ...(Number.isFinite(Date.parse(r.timestamp))
              ? { timestamp: new Date(r.timestamp).toISOString() }
              : {}),
          })
        }
        aria-label={`Select routing receipt ${r.receiptId}`}
      >
        Keep this receipt selected
      </Button>
    </div>
  );
}

// The remaining share a recorded window carried at the moment of the switch.
function windowShare(windows) {
  const window = Array.isArray(windows) ? windows[0] : null;
  if (!window || !Number.isFinite(window.remaining) || !Number.isFinite(window.limit) || !window.limit)
    return null;
  return {
    scope: window.scope || 'window',
    remaining: Math.max(0, Math.min(100, Math.round((window.remaining / window.limit) * 100))),
  };
}
const meterLevel = (remaining) =>
  remaining <= 0 ? 'depleted' : remaining <= 20 ? 'low' : remaining <= 50 ? 'warn' : 'good';

function SwitchEvidence({ r }) {
  const left = windowShare(r.windows?.old);
  const landed = windowShare(r.windows?.new);
  if (!left && !landed) return <span className={board.muted}>No window was recorded</span>;
  return (
    <>
      {left ? (
        <EvidenceLine
          label={`Left · ${left.scope}`}
          remaining={left.remaining}
          level={meterLevel(left.remaining)}
          value={`${left.remaining}%`}
          note="at the switch"
        />
      ) : null}
      {landed ? (
        <EvidenceLine
          label={`Landed · ${landed.scope}`}
          remaining={landed.remaining}
          level={meterLevel(landed.remaining)}
          value={`${landed.remaining}%`}
          note="at the switch"
        />
      ) : null}
    </>
  );
}

function SwitchIdentity({ r, names, expanded, onOpen }) {
  const destination = names.get(r.newConnectionId);
  return (
    <div className={board.identity}>
      <ProviderMark provider={destination?.provider} size="small" />
      <div className={board.identityText}>
        <span className={board.nameLine}>
          <button
            type="button"
            className={board.nameButton}
            aria-expanded={expanded}
            aria-label={`Inspect receipt ${r.receiptId}`}
            onClick={onOpen}
          >
            {r.model}
          </button>
        </span>
        <small>
          {r.oldConnectionId
            ? names.get(r.oldConnectionId)?.displayName || r.oldConnectionId
            : 'First pin'}
          {' → '}
          {names.get(r.newConnectionId)?.displayName || r.newConnectionId || 'Not reported'}
        </small>
      </div>
    </div>
  );
}

function SwitchCaret({ expanded, onToggle, label }) {
  return (
    <Tooltip label={expanded ? 'Collapse' : 'Evidence at the switch'}>
      <button
        type="button"
        className={board.caret}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
        onClick={onToggle}
      >
        <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
      </button>
    </Tooltip>
  );
}

export default function SessionsPage() {
  const { scope, setScope, snapshot, selectedRecord, observeSnapshot } = useWorkspace();
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const retainedReceipt = useResource(
    selectedRecord?.kind === 'routing-switch'
      ? `/api/admin/receipts/${encodeURIComponent(selectedRecord.id)}`
      : null,
    { onSnapshot: observeSnapshot }
  );
  const detail = usePoll('/api/admin/health/detail', 30000);
  const apply = useUsageStream((s) => s.apply);
  const usage = useUsageStream((s) => s.data);
  const receivedAt = useUsageStream((s) => s.receivedAt);
  const stream = useEventStream('/api/usage/stream?period=today', apply);

  const draftKey = JSON.stringify(scope);
  const [draftState, setDraftState] = useState({ key: null, value: EMPTY });
  const draft =
    draftState.key === draftKey
      ? draftState.value
      : {
          connectionId: scope.connectionId || '',
          model: scope.model || '',
          since: scope.start || scope.end ? 'current' : '',
        };
  const setDraft = (value) => setDraftState({ key: draftKey, value });
  const filters = {
    connectionId: scope.connectionId,
    model: scope.model,
    since: scope.start,
    until: scope.end,
    provider: scope.provider,
  };
  const [extra, setExtra] = useState([]);
  const [pagedCursor, setPagedCursor] = useState(undefined);
  const [pageRefusal, setPageRefusal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);
  const [lookupDraft, setLookupDraft] = useState('');
  const [lookup, setLookup] = useState(null);
  const [liveQuery, setLiveQuery] = useState('');
  const [liveBucket, setLiveBucket] = useState(null);
  const [trigger, setTrigger] = useState(null);
  const [openReceipt, setOpenReceipt] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const url = useMemo(() => {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (filters.connectionId) q.set('connectionId', filters.connectionId);
    if (filters.model) q.set('model', filters.model);
    if (filters.since) q.set('since', filters.since);
    if (filters.until) q.set('until', filters.until);
    if (filters.provider) q.set('provider', filters.provider);
    return `/api/admin/receipts?${q}`;
  }, [filters.connectionId, filters.model, filters.since, filters.until, filters.provider]);
  const receipts = usePoll(url, 30000);

  // Reset the paging state the moment `url` changes rather than in an effect
  // (react-hooks/set-state-in-effect): a new filter query is a new key, so a
  // stale url reads as null instead of carrying over the old page.
  const [pagedForUrl, setPagedForUrl] = useState(url);
  if (url !== pagedForUrl) {
    setPagedForUrl(url);
    setExtra([]);
    setPagedCursor(undefined);
    setPageRefusal(null);
  }

  const names = useMemo(
    () => new Map((detail.data?.checks?.connections || []).map((c) => [c.connectionId, c])),
    [detail.data]
  );
  const sessions = (usage?.activeSessions || [])
    .filter(
      (row) =>
        (!scope.provider || row.provider === scope.provider) &&
        (!scope.model || row.model === scope.model) &&
        (!scope.connectionId || row.connectionId === scope.connectionId) &&
        (!scope.start || recordStartedAt(row) >= Date.parse(scope.start)) &&
        (!scope.end || recordStartedAt(row) < Date.parse(scope.end))
    )
    .sort(
      (a, b) =>
        recordStartedAt(a) - recordStartedAt(b) ||
        String(a.requestId || '').localeCompare(String(b.requestId || ''))
    );
  const liveNeedle = liveQuery.trim().toLowerCase();
  const liveVisible = sessions.filter(
    (row) =>
      (!liveBucket || (row.status || 'active') === liveBucket) &&
      (!liveNeedle ||
        [row.account, row.provider, row.model]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(liveNeedle)))
  );
  const liveCounts = Object.fromEntries(
    LIVE_BUCKETS.map((item) => [
      item.id,
      sessions.filter((row) => (row.status || 'active') === item.id).length,
    ])
  );
  const liveFollowing = !['summary', 'paused', 'historical', 'snapshot'].includes(stream.status);
  // ponytail: page one is polled and later pages are held here, so a switch
  // recorded while paged deep arrives on the next poll and dedupes by id.
  const rows = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const r of [...(receipts.data?.receipts || []), ...extra]) {
      if (seen.has(r.receiptId)) continue;
      seen.add(r.receiptId);
      out.push(r);
    }
    return out;
  }, [receipts.data, extra]);
  const cursor = pagedCursor === undefined ? (receipts.data?.nextCursor ?? null) : pagedCursor;
  const filtered = Boolean(
    filters.connectionId || filters.model || filters.since || filters.until || filters.provider
  );
  const triggerCounts = Object.fromEntries(
    TRIGGER_ORDER.map((id) => [id, rows.filter((r) => r.trigger === id).length])
  );
  const visibleRows = trigger ? rows.filter((r) => r.trigger === trigger) : rows;

  const applyFilters = (patch = draft) => {
    const anchor = snapshot?.capturedAt ? Date.parse(snapshot.capturedAt) : Date.now();
    setScope({
      connectionId: (patch.connectionId ?? scope.connectionId) || null,
      model: (patch.model ?? scope.model) || null,
      ...(patch.since === 'current'
        ? {}
        : patch.since
          ? {
              period: 'custom',
              start: new Date(anchor - Number(patch.since)).toISOString(),
              end: new Date(anchor).toISOString(),
            }
          : { period: 'all', start: null, end: null }),
    });
  };

  const showMore = async () => {
    if (!cursor || busy) return;
    setBusy(true);
    const res = await call(`${url}&cursor=${encodeURIComponent(cursor)}`);
    setBusy(false);
    if (!res.ok) {
      setPageRefusal(refusal(res.status, res.body));
      return;
    }
    setPageRefusal(null);
    setExtra((x) => [...x, ...(res.body?.receipts || [])]);
    setPagedCursor(res.body?.nextCursor ?? null);
  };

  const find = async (e) => {
    e.preventDefault();
    const id = lookupDraft.trim();
    if (!id) return;
    const res = await call(`/api/admin/receipts/${encodeURIComponent(id)}`);
    setLookup(res.ok ? { receipt: res.body } : { refusal: refusal(res.status, res.body) });
  };

  return (
    <div className={shared.lensPage} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Sessions</h1>
          <p>Which sessions are open, where each is pinned, and every recorded reason one moved</p>
        </div>
        <div className="sessions-heading-actions">
          <Freshness
            status={stream.status}
            reason={stream.reason}
            lastDataAt={stream.lastDataAt || receivedAt}
          />
          <Button component={Link} href="/dashboard/models" variant="default" size="compact-xs">
            Open policy workbench
          </Button>
        </div>
      </div>
      <ScopeBar />
      <div className={shared.lensBody}>
      {selectedRecord?.kind === 'routing-switch' && (
        <section aria-label="Selected routing evidence" className="panel">
          <h3 className="sessions-lens">Selected routing receipt</h3>
          {retainedReceipt.loading ? (
            <p role="status">Reading selected receipt…</p>
          ) : retainedReceipt.error ? (
            <p role="alert">
              The selected receipt is unavailable. Its identity is retained; no substitute was
              chosen.
            </p>
          ) : retainedReceipt.data ? (
            <Receipt r={retainedReceipt.data} names={names} now={now} />
          ) : null}
        </section>
      )}

      <section aria-labelledby="h-inflight">
        <h3 id="h-inflight" className="sessions-lens">
          Observed request activity
        </h3>
        {stream.status === 'stale' ? (
          <Notice
            tone="warn"
            title="The usage stream stopped."
            next="The sessions below are from the last frame received. Reconnecting in the background."
          />
        ) : null}
        <Board
          label="Observed request activity"
          data-compare="none"
          advanced={advanced}
          density={density}
          layout={advanced ? 'rows' : 'cards'}
        >
          <BoardSummary
            label="Session summary"
            active={liveBucket}
            onPick={setLiveBucket}
            chips={
              usage
                ? [
                    {
                      count: sessions.length,
                      label: sessions.length === 1 ? 'session' : 'sessions',
                    },
                    ...LIVE_BUCKETS.map((item) => ({
                      id: item.id,
                      tone: item.tone,
                      count: liveCounts[item.id],
                      label: item.label.toLowerCase(),
                    })),
                  ]
                : [{ count: '—', label: 'sessions' }]
            }
            note={
              <span title="A session is named by the account it is on, never by its own identity. The gateway stores only a one-way hash of that identity, and this surface never shows it. Provider, model and account filters use exact retained identities; a row without an exact account ID cannot enter an account-filtered population, and started time defines the activity interval.">
                {usage
                  ? `${fmtNum(new Set(sessions.map((s) => s.model).filter(Boolean)).size)} models in flight · ${fmtNum(names.size)} accounts known`
                  : 'Waiting for the first frame'}
              </span>
            }
          />
          <BoardToolbar
            search={liveQuery}
            onSearch={setLiveQuery}
            searchLabel="Search sessions in flight"
          >
            <Tooltip label="How much room every board on this page takes">
              <DensitySwitch value={density} onChange={setDensity} />
            </Tooltip>
          </BoardToolbar>
          {!liveFollowing ? (
            <p className={board.notice}>
              {stream.status === 'paused'
                ? 'Live activity is paused. The last received frame remains visible.'
                : stream.status === 'historical' || stream.status === 'snapshot'
                  ? 'Historical or snapshot scope does not reconstruct in-flight activity. Retained pins and receipts below use their own recorded evidence.'
                  : 'Summary mode keeps the activity stream closed. Choose Live to follow current activity.'}
            </p>
          ) : null}
          {advanced && liveVisible.length ? (
            <div className={board.head} aria-hidden="true">
              <span />
              <span>Account</span>
              <span>State</span>
              <span>Elapsed</span>
              <span>Started</span>
              <span />
            </div>
          ) : null}
          {advanced ? (
            <div className={board.rows}>
              {liveVisible.map((s, i) => (
                <LiveRow
                  key={s.requestId || `${s.provider}-${s.model}-${s.startedAt}-${i}`}
                  session={s}
                  now={now}
                />
              ))}
            </div>
          ) : (
            LIVE_BUCKETS.map((item) => {
              const members = liveVisible.filter((s) => (s.status || 'active') === item.id);
              if (!members.length) return null;
              return (
                <BoardGroup
                  key={item.id}
                  label={item.label}
                  tone={item.tone}
                  count={members.length}
                >
                  {members.map((s, i) => (
                    <LiveCard
                      key={s.requestId || `${s.provider}-${s.model}-${s.startedAt}-${i}`}
                      session={s}
                      now={now}
                    />
                  ))}
                </BoardGroup>
              );
            })
          )}
          <div className={board.messages}>
            {!usage && liveFollowing && stream.status !== 'stale' ? (
              <p className={board.empty} role="status">
                Waiting for the first frame
              </p>
            ) : null}
            {usage && sessions.length === 0 && liveFollowing ? (
              <p className={board.empty}>
                No session is in flight right now. One appears here while a request it owns is open.
              </p>
            ) : null}
            {sessions.length > 0 && liveVisible.length === 0 ? (
              <p className={board.empty}>
                No session matches.{' '}
                <button
                  type="button"
                  className={board.linkButton}
                  onClick={() => {
                    setLiveQuery('');
                    setLiveBucket(null);
                  }}
                >
                  Clear filters
                </button>
              </p>
            ) : null}
          </div>
        </Board>
      </section>

      <SessionPins density={density} />

      <section aria-labelledby="h-moves">
        <div className="sessions-lens-row">
          <h3 id="h-moves" className="sessions-lens">
            Why sessions moved
          </h3>
          <Freshness status={pollFresh(receipts)} lastDataAt={receipts.goodAt} />
        </div>
        <Board
          label="Account switch receipts"
          data-compare="none"
          advanced={advanced}
          density={density}
          layout={advanced ? 'rows' : 'cards'}
        >
          <BoardSummary
            label="Switch summary"
            active={trigger}
            onPick={setTrigger}
            chips={
              receipts.data
                ? [
                    { count: rows.length, label: rows.length === 1 ? 'switch' : 'switches' },
                    ...TRIGGER_ORDER.filter((id) => triggerCounts[id] > 0).map((id) => ({
                      id,
                      tone: TRIGGER_TONE[id],
                      count: triggerCounts[id],
                      label: TRIGGER[id].toLowerCase(),
                    })),
                  ]
                : [{ count: '—', label: 'switches' }]
            }
            note={
              <span title="One receipt for every time a session left one account for another. Receipts are written once and never edited or deleted. Provider, account, model and UTC bounds follow the shared scope above; provider attribution uses the destination account's current configuration, and deleted destinations remain unknown.">
                {receipts.loading && !receipts.data
                  ? 'Reading the switch log'
                  : 'Newest recorded first'}
              </span>
            }
          />
          <BoardToolbar
            actions={
              <>
                {cursor ? (
                  <Button
                    variant="default"
                    size="compact-xs"
                    type="button"
                    onClick={showMore}
                    disabled={busy}
                  >
                    {busy ? 'Reading' : 'Show older'}
                  </Button>
                ) : null}
                <Tooltip label="Look up one exact retained receipt id">
                  <ActionIcon
                    variant={finding ? 'light' : 'default'}
                    aria-label="Find one receipt"
                    aria-expanded={finding}
                    onClick={() => setFinding((value) => !value)}
                  >
                    <Icon name="i-search" />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Re-read the switch log">
                  <ActionIcon
                    variant="default"
                    aria-label="Refresh switch log"
                    loading={receipts.loading}
                    onClick={receipts.refresh}
                  >
                    <Icon name="i-refresh" />
                  </ActionIcon>
                </Tooltip>
              </>
            }
          >
            <NativeSelect
              size="xs"
              aria-label="Account"
              className={board.sort}
              value={draft.connectionId ?? scope.connectionId ?? ''}
              onChange={(e) => {
                const next = { ...draft, connectionId: e.currentTarget.value };
                setDraft(next);
                applyFilters(next);
              }}
              data={[
                { value: '', label: 'Every account' },
                ...(detail.data?.checks?.connections || []).map((c) => ({
                  value: c.connectionId,
                  label: c.displayName || c.provider,
                })),
              ]}
            />
            <TextInput
              size="xs"
              aria-label="Model"
              placeholder="Model"
              className={board.search}
              value={draft.model ?? scope.model ?? ''}
              onChange={(e) => setDraft({ ...draft, model: e.currentTarget.value })}
              onBlur={() => applyFilters()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyFilters();
                }
              }}
            />
            <Select
              size="xs"
              aria-label="Since"
              className={board.sort}
              data={SINCE}
              value={draft.since}
              allowDeselect={false}
              onChange={(value) => {
                const next = { ...draft, since: value ?? '' };
                setDraft(next);
                applyFilters(next);
              }}
            />
          </BoardToolbar>
          {finding ? (
            <form className={board.addRow} onSubmit={find} aria-label="Find one receipt">
              <TextInput
                size="xs"
                label="Receipt id"
                className={board.addName}
                value={lookupDraft}
                onChange={(e) => setLookupDraft(e.currentTarget.value)}
              />
              <Button size="xs" type="submit" leftSection={<Icon name="i-search" />}>
                Find
              </Button>
              <span className={board.addNote}>
                An exact retained receipt ID is looked up across the complete stored log. A missing
                ID is never replaced by a similar timestamp or account.
              </span>
            </form>
          ) : null}
          {lookup?.refusal ? <Notice {...lookup.refusal} /> : null}
          {lookup?.receipt ? (
            <div className={board.comparison} role="region" aria-label="Found receipt">
              <Receipt r={lookup.receipt} names={names} now={now} />
            </div>
          ) : null}
          {receipts.error && !receipts.data ? <Notice {...refusal(receipts.status, receipts.error)} /> : null}
          {pageRefusal ? <Notice {...pageRefusal} /> : null}
          {advanced && visibleRows.length ? (
            <div className={board.head} aria-hidden="true">
              <span />
              <span>Model and move</span>
              <span>Why it moved</span>
              <span>Quota at the switch</span>
              <span>When (UTC)</span>
              <span />
            </div>
          ) : null}
          {advanced ? (
            <div className={board.rows}>
              {visibleRows.map((r) => (
                <SwitchRow
                  key={r.receiptId}
                  r={r}
                  names={names}
                  now={now}
                  expanded={openReceipt === r.receiptId}
                  onToggle={() =>
                    setOpenReceipt(openReceipt === r.receiptId ? null : r.receiptId)
                  }
                />
              ))}
            </div>
          ) : (
            TRIGGER_ORDER.map((id) => {
              const members = visibleRows.filter((r) => r.trigger === id);
              if (!members.length) return null;
              return (
                <BoardGroup
                  key={id}
                  label={TRIGGER[id]}
                  tone={TRIGGER_TONE[id]}
                  count={members.length}
                >
                  {members.map((r) => (
                    <SwitchCard
                      key={r.receiptId}
                      r={r}
                      names={names}
                      now={now}
                      expanded={openReceipt === r.receiptId}
                      onToggle={() =>
                        setOpenReceipt(openReceipt === r.receiptId ? null : r.receiptId)
                      }
                    />
                  ))}
                </BoardGroup>
              );
            })
          )}
          <div className={board.messages}>
            {receipts.loading && !receipts.data ? (
              <p className={board.empty} role="status">
                Reading the switch log
              </p>
            ) : null}
            {receipts.data && rows.length === 0 && filtered ? (
              <p className={board.empty}>
                No switch matches these filters. Widen the account, the model or the time and apply
                again.
              </p>
            ) : null}
            {receipts.data && rows.length === 0 && !filtered ? (
              <p className={board.empty}>
                No switch has been recorded yet. The first time a session is pinned to an account is
                itself written here.
              </p>
            ) : null}
            {rows.length > 0 && visibleRows.length === 0 ? (
              <p className={board.empty}>
                No switch matches.{' '}
                <button type="button" className={board.linkButton} onClick={() => setTrigger(null)}>
                  Clear filters
                </button>
              </p>
            ) : null}
          </div>
        </Board>
      </section>

      <details className="sessions-evidence sessions-foot">
        <summary>When a pin moves, and what is not reported</summary>
        <div>
          <p>
            A pin holds a session on one account for one model so a conversation keeps landing where
            its context already is. It does not move just because ranking would now put another
            account first. It moves only when one of these happens.
          </p>
          <ul className="bullets">
            <li>The account it points at becomes unavailable.</li>
            <li>The quota of the account it points at is exhausted.</li>
            <li>An operator puts that account into drain.</li>
            <li>That one model fails on that account.</li>
            <li>
              A higher-priority account that was not eligible when the pin was made becomes eligible
              again.
            </li>
          </ul>
          <p>
            A session staying on an account that no longer looks like the best one is this
            stickiness working, not a fault.
          </p>
          <p>Not reported here:</p>
          <ul className="bullets">
            <li>
              Whether a connection is being skipped because a quota window crossed its auto-pause
              threshold. A session pinned to such a connection still reads as healthy.
            </li>
            <li>
              Whether one model on a connection is locked out after a model-scoped failure, and
              until when. That lockout is one of the reasons a pin moves.
            </li>
          </ul>
        </div>
      </details>
      </div>
    </div>
  );
}

function elapsedLine(session, now) {
  const started = recordStartedAt(session);
  if (!Number.isFinite(started)) return null;
  const ms = Math.max(0, now - started);
  const minutes = ms / 60000;
  return {
    percent: Math.min(100, (minutes / 30) * 100),
    value: minutes < 1 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(minutes)} m`,
  };
}

function LiveIdentity({ session }) {
  return (
    <div className={board.identity}>
      <ProviderMark provider={session.provider} size="small" />
      <div className={board.identityText}>
        <span className={board.nameLine}>
          <span className={board.nameButton} role="presentation">
            {session.account || session.provider}
          </span>
        </span>
        <small>
          {session.model} · {session.provider}
        </small>
      </div>
    </div>
  );
}

function LiveRow({ session, now }) {
  const status = session.status || 'active';
  const item = LIVE_BUCKETS.find((bucket) => bucket.id === status);
  const elapsed = elapsedLine(session, now);
  return (
    <article
      className={board.row}
      data-bucket={status}
      aria-label={`${session.account || session.provider} session`}
    >
      <div className={board.main}>
        <span className={board.caret} aria-hidden="true" />
        <LiveIdentity session={session} />
        <div className={board.state}>
          <StateWord tone={item?.tone}>{WORDS[status] || status}</StateWord>
        </div>
        <div className={board.quota}>
          {elapsed ? (
            <EvidenceLine
              label="Elapsed"
              shares={[{ kind: 'input', percent: elapsed.percent }]}
              value={elapsed.value}
              note="since it opened"
            />
          ) : (
            <span className={board.muted}>No start time recorded</span>
          )}
        </div>
        <div className={board.activity}>
          <span>{session.startedAt ? fmtRelative(session.startedAt, now) : 'Not reported'}</span>
        </div>
        <div className={board.actions} />
      </div>
    </article>
  );
}

function LiveCard({ session, now }) {
  const status = session.status || 'active';
  const item = LIVE_BUCKETS.find((bucket) => bucket.id === status);
  const elapsed = elapsedLine(session, now);
  return (
    <article
      className={board.card}
      data-bucket={status}
      aria-label={`${session.account || session.provider} session`}
    >
      <header className={board.cardHead}>
        <LiveIdentity session={session} />
      </header>
      <div className={board.cardState}>
        <StateWord tone={item?.tone}>{WORDS[status] || status}</StateWord>
        <span className={board.spacer} />
        <span className={board.cardAttempts}>
          {session.startedAt ? fmtRelative(session.startedAt, now) : 'Not reported'}
        </span>
      </div>
      <div className={board.cardWindows}>
        {elapsed ? (
          <EvidenceLine
            label="Elapsed"
            shares={[{ kind: 'input', percent: elapsed.percent }]}
            value={elapsed.value}
            note="since it opened"
          />
        ) : (
          <span className={board.muted}>No start time recorded</span>
        )}
      </div>
    </article>
  );
}

function SwitchRow({ r, names, now, expanded, onToggle }) {
  return (
    <article
      className={board.row}
      data-receipt-id={r.receiptId}
      data-expanded={expanded || undefined}
      data-bucket={r.trigger}
      aria-label={`Switch ${r.receiptId}`}
    >
      <div className={board.main}>
        <SwitchCaret expanded={expanded} onToggle={onToggle} label={r.model} />
        <SwitchIdentity r={r} names={names} expanded={expanded} onOpen={onToggle} />
        <div className={`${board.state} sessions-state-wrap`}>
          <StateWord tone={TRIGGER_TONE[r.trigger]}>{TRIGGER[r.trigger] || r.trigger}</StateWord>
        </div>
        <div className={board.quota}>
          <SwitchEvidence r={r} />
        </div>
        <div className={board.activity}>
          <span>{recordTime(r.timestamp)}</span>
          <small>{fmtRelative(r.timestamp, now)}</small>
        </div>
        <div className={board.actions} />
      </div>
      {expanded ? (
        <div className={board.detail} role="region" aria-label="Switch evidence">
          <Receipt r={r} names={names} now={now} />
        </div>
      ) : null}
    </article>
  );
}

function SwitchCard({ r, names, now, expanded, onToggle }) {
  return (
    <article
      className={board.card}
      data-receipt-id={r.receiptId}
      data-expanded={expanded || undefined}
      data-bucket={r.trigger}
      aria-label={`Switch ${r.receiptId}`}
    >
      <header className={board.cardHead}>
        <SwitchIdentity r={r} names={names} expanded={expanded} onOpen={onToggle} />
        <SwitchCaret expanded={expanded} onToggle={onToggle} label={r.model} />
      </header>
      <div className={`${board.cardState} sessions-state-wrap`}>
        <StateWord tone={TRIGGER_TONE[r.trigger]}>{TRIGGER[r.trigger] || r.trigger}</StateWord>
        <span className={board.spacer} />
        <span className={board.cardAttempts}>{fmtRelative(r.timestamp, now)}</span>
      </div>
      <div className={board.cardWindows}>
        <SwitchEvidence r={r} />
      </div>
      {expanded ? (
        <div className={board.detail} role="region" aria-label="Switch evidence">
          <Receipt r={r} names={names} now={now} />
        </div>
      ) : null}
    </article>
  );
}
