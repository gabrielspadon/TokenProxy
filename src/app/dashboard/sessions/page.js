'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePoll } from '@/shared/hooks/usePoll';
import { useEventStream } from '@/shared/hooks/useEventStream';
import { useUsageStream } from '@/store/usageStream';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { QuotaWindow } from '@/shared/components/QuotaWindow';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtRelative } from '@/shared/format';
import { recordTime } from '@/shared/components/workspace/economics';
import { TONE, WORDS as STATUS } from '@/shared/status';
import { Icon } from '@/shared/components/Icon';
import SessionPins from '@/shared/components/SessionPins';
import './styles.css';
import { Button } from '@mantine/core';
import { useResource } from '@/shared/workspace/useResource';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';

const HORIZON_MS = 6 * 3600 * 1000;
const PAGE = 25;
const WORDS = {
  ...STATUS,
  active: 'Running',
  pending: 'Waiting',
  done: 'Finished',
  error: 'Failed',
};

// The closed trigger vocabulary of the admin ABI, one sentence each. An
// unmapped value prints raw rather than being renamed to something it is not.
const TRIGGER = {
  exhausted: 'Quota exhausted',
  reset: 'A window reset restored an earlier account',
  drain: 'The account was drained',
  model_failure: 'This model failed on that account',
  manual: 'Set by hand',
};
const TRIGGER_TONE = { exhausted: 'warn', reset: 'ok', drain: 'warn', model_failure: 'bad' };

const SINCE = [
  { value: '', label: 'Any time' },
  { value: String(3600e3), label: 'The last hour' },
  { value: String(86400e3), label: 'The last day' },
  { value: String(7 * 86400e3), label: 'The last week' },
];

const EMPTY = { connectionId: '', model: '', since: '' };

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
      <span data-i18n-skip>{c?.displayName || c?.provider || id}</span>
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

// One switch receipt. Every field is picked by name: `sessionHash` is on the
// wire and is deliberately not read here, because it is the session identity
// and this surface never renders one.
function Receipt({ r, names, now }) {
  const {setSelectedRecord}=useWorkspace();
  return (
    <div className="row sessions-row">
      <div className="who">
        <Button variant="subtle" size="compact-sm" onClick={()=>setSelectedRecord({kind:'routing-switch',id:r.receiptId,model:r.model,connectionId:r.newConnectionId,fromConnectionId:r.oldConnectionId,...(Number.isFinite(Date.parse(r.timestamp))?{timestamp:new Date(r.timestamp).toISOString()}:{})})} aria-label={`Select routing receipt ${r.receiptId}`}>{recordTime(r.timestamp)}</Button>
        <span className="sub" data-i18n-skip>
          {fmtRelative(r.timestamp, now)}
        </span>
      </div>
      <div className="who">
        <span className="status" data-tone={TRIGGER_TONE[r.trigger]}>
          {TRIGGER[r.trigger] || <span data-i18n-skip>{r.trigger}</span>}
        </span>
        <span className="sub id" data-i18n-skip>
          {r.model}
        </span>
      </div>
      <div>
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
            <dd className="id" data-i18n-skip>
              {r.receiptId}
            </dd>
          </dl>
        </details>
      </div>
    </div>
  );
}

export default function SessionsPage() {
  const {scope,setScope,snapshot,selectedRecord,observeSnapshot}=useWorkspace();
  const retainedReceipt=useResource(selectedRecord?.kind==='routing-switch' ? `/api/admin/receipts/${encodeURIComponent(selectedRecord.id)}` : null,{onSnapshot:observeSnapshot});
  const detail = usePoll('/api/admin/health/detail', 30000);
  const apply = useUsageStream((s) => s.apply);
  const usage = useUsageStream((s) => s.data);
  const receivedAt = useUsageStream((s) => s.receivedAt);
  const stream = useEventStream('/api/usage/stream?period=today', apply);

  const draftKey=JSON.stringify(scope);
  const [draftState,setDraftState]=useState({key:null,value:EMPTY});
  const draft=draftState.key===draftKey ? draftState.value : {connectionId:scope.connectionId || '',model:scope.model || '',since:scope.start || scope.end ? 'current' : ''};
  const setDraft=(value)=>setDraftState({key:draftKey,value});
  const filters={connectionId:scope.connectionId,model:scope.model,since:scope.start,until:scope.end,provider:scope.provider};
  const [extra, setExtra] = useState([]);
  const [pagedCursor, setPagedCursor] = useState(undefined);
  const [pageRefusal, setPageRefusal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lookupDraft, setLookupDraft] = useState('');
  const [lookup, setLookup] = useState(null);
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
    if (filters.until) q.set('until',filters.until);
    if (filters.provider) q.set('provider',filters.provider);
    return `/api/admin/receipts?${q}`;
  }, [filters.connectionId,filters.model,filters.since,filters.until,filters.provider]);
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
  const sessions = usage?.activeSessions || [];
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
  const filtered = Boolean(filters.connectionId || filters.model || filters.since || filters.until || filters.provider);

  const applyFilters = (e) => {
    e.preventDefault();
    const anchor=snapshot?.capturedAt ? Date.parse(snapshot.capturedAt) : Date.now();
    setScope({connectionId:(draft.connectionId ?? scope.connectionId) || null,model:(draft.model ?? scope.model) || null,
      ...(draft.since==='current' ? {} : draft.since ? {period:'custom',start:new Date(anchor-Number(draft.since)).toISOString(),end:new Date(anchor).toISOString()} : {period:'all',start:null,end:null})});
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
    <>
      <div className="screen-head">
        <h1>Sessions</h1>
        <Button component={Link} href="/dashboard/models" variant="default" size="compact-sm">Open policy workbench</Button>
        <Freshness status={stream.status} lastDataAt={receivedAt} />
      </div>

      <ScopeBar />
      {selectedRecord?.kind==='routing-switch' && <section aria-label="Selected routing evidence" className="panel">
        <h2>Selected routing receipt</h2>
        <p className="caption">Exact retained identity, independent of the current list scope.</p>
        {retainedReceipt.loading ? <p role="status">Reading selected receipt…</p> : retainedReceipt.error ? <p role="alert">The selected receipt is unavailable. Its identity is retained; no substitute was chosen.</p> : retainedReceipt.data ? <Receipt r={retainedReceipt.data} names={names} now={now}/> : null}
      </section>}
      <div className="measures">
        <div className="measure big">
          <span className="label">In flight</span>
          <span className="value" data-i18n-skip>
            {usage ? fmtNum(sessions.length) : '—'}
          </span>
        </div>
        <div className="measure big">
          <span className="label">Models in flight</span>
          <span className="value" data-i18n-skip>
            {usage ? fmtNum(new Set(sessions.map((s) => s.model).filter(Boolean)).size) : '—'}
          </span>
        </div>
        <div className="measure big">
          <span className="label">Switches shown</span>
          <span className="value" data-i18n-skip>
            {receipts.data ? fmtNum(rows.length) : '—'}
          </span>
        </div>
        <div className="measure big">
          <span className="label">Accounts known</span>
          <span className="value" data-i18n-skip>
            {detail.data ? fmtNum(names.size) : '—'}
          </span>
        </div>
      </div>

      <section aria-labelledby="h-inflight">
        <h2 id="h-inflight">Sessions in flight</h2>
        <p className="caption">
          A session is named by the account it is on, never by its own identity. The gateway stores
          only a one-way hash of that identity, and this surface never shows it.
        </p>
        {stream.status === 'stale' ? (
          <Notice
            tone="warn"
            title="The usage stream stopped."
            next="The sessions below are from the last frame received. Reconnecting in the background."
          />
        ) : null}
        {!usage && stream.status !== 'stale' ? (
          <p className="skeleton">Waiting for the first frame</p>
        ) : null}
        {usage && sessions.length === 0 ? (
          <p className="empty">
            No session is in flight right now. One appears here while a request it owns is open.
          </p>
        ) : null}
        {sessions.length ? (
          <div className="rows">
            <div className="row head sessions-live">
              <span>Account</span>
              <span>Started</span>
              <span>State</span>
            </div>
            {sessions.map((s, i) => (
              <div
                key={`${s.provider}-${s.model}-${s.startedAt}-${i}`}
                className="row sessions-live"
              >
                <span className="who">
                  <span className="name" data-i18n-skip>
                    {s.account || s.provider}
                  </span>
                  <span className="sub">
                    <span className="id" data-i18n-skip>
                      {s.model}
                    </span>{' '}
                    <span data-i18n-skip>{s.provider}</span>
                  </span>
                </span>
                <span data-i18n-skip>{s.startedAt ? fmtRelative(s.startedAt, now) : ''}</span>
                <span className="status" data-tone={TONE[s.status] || 'ok'}>
                  {WORDS[s.status] || <span data-i18n-skip>{s.status}</span>}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-moves">
        <div className="screen-head">
          <h2 id="h-moves">Why sessions moved</h2>
          <Freshness status={pollFresh(receipts)} lastDataAt={receipts.goodAt} />
        </div>
        <p className="caption">
          One receipt for every time a session left one account for another. Receipts are written
          once and never edited or deleted.
        </p>
        <p className="caption">Provider, account, model and UTC bounds follow the shared scope above. Provider attribution uses the destination account’s current configuration; deleted destinations remain unknown.</p>
        <form className="sessions-filters" onSubmit={applyFilters}>
          <label className="field">
            <span>Account</span>
            <select
              className="select"
              value={draft.connectionId ?? scope.connectionId ?? ''}
              onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })}
            >
              <option value="">Every account</option>
              {(detail.data?.checks?.connections || []).map((c) => (
                <option key={c.connectionId} value={c.connectionId}>
                  {c.displayName || c.provider}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Model</span>
            <input
              className="input"
              value={draft.model ?? scope.model ?? ''}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Since</span>
            <select
              className="select"
              value={draft.since}
              onChange={(e) => setDraft({ ...draft, since: e.target.value })}
            >
              <option value="current">Current shared UTC range</option>
              {SINCE.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button className="button" type="submit">
            <Icon name="i-search" />
            Apply
          </button>
        </form>
        {receipts.error && !receipts.data ? (
          <Notice {...refusal(receipts.status, receipts.error)} />
        ) : null}
        {receipts.loading && !receipts.data ? (
          <p className="skeleton">Reading the switch log</p>
        ) : null}
        {receipts.data && rows.length === 0 && filtered ? (
          <p className="empty">
            No switch matches these filters. Widen the account, the model or the time and apply
            again.
          </p>
        ) : null}
        {receipts.data && rows.length === 0 && !filtered ? (
          <p className="empty">
            No switch has been recorded yet. The first time a session is pinned to an account is
            itself written here.
          </p>
        ) : null}
        {rows.length ? (
          <div className="rows">
            <div className="row head sessions-ledger">
              <span aria-hidden="true" />
              <span>When (UTC)</span>
              <span>Why it moved</span>
              <span>Model</span>
              <span>Accounts</span>
            </div>
            {rows.map((r) => (
              <details key={r.receiptId} className="sessions-fold">
                <summary className="sessions-ledger">
                  <span className="sessions-caret" aria-hidden="true" />
                  <span className="who">
                    <span className="id" data-i18n-skip>{recordTime(r.timestamp)}</span>
                    <span className="sub" data-i18n-skip>{fmtRelative(r.timestamp, now)}</span>
                  </span>
                  <span className="status" data-tone={TRIGGER_TONE[r.trigger]}>
                    {TRIGGER[r.trigger] || <span data-i18n-skip>{r.trigger}</span>}
                  </span>
                  <span className="id" data-i18n-skip>{r.model}</span>
                  <span className="sessions-move" data-i18n-skip>
                    {r.oldConnectionId ? names.get(r.oldConnectionId)?.displayName || r.oldConnectionId : 'First pin'}
                    {' → '}
                    {names.get(r.newConnectionId)?.displayName || r.newConnectionId || 'Not reported'}
                  </span>
                </summary>
                <Receipt r={r} names={names} now={now} />
              </details>
            ))}
          </div>
        ) : null}
        {pageRefusal ? <Notice {...pageRefusal} /> : null}
        {cursor ? (
          <p className="sessions-more">
            <button className="button quiet" type="button" onClick={showMore} disabled={busy}>
              {busy ? 'Reading' : 'Show older'}
            </button>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="h-find" className="panel">
        <h2 id="h-find">Find one receipt</h2>
        <p className="caption">
          An exact retained receipt ID is looked up across the complete stored log. A missing ID is never replaced by a similar timestamp or account.
        </p>
        <form className="sessions-filters" onSubmit={find}>
          <label className="field">
            <span>Receipt id</span>
            <input
              className="input"
              value={lookupDraft}
              onChange={(e) => setLookupDraft(e.target.value)}
            />
          </label>
          <button className="button" type="submit">
            <Icon name="i-search" />
            Find
          </button>
        </form>
        {lookup?.refusal ? <Notice {...lookup.refusal} /> : null}
        {lookup?.receipt ? (
          <div className="rows">
            <Receipt r={lookup.receipt} names={names} now={now} />
          </div>
        ) : null}
      </section>

      <SessionPins />

      <section aria-labelledby="h-stick">
        <h2 id="h-stick">When a pin moves</h2>
        <details className="sessions-evidence">
          <summary>How pinning decides, in full</summary>
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
        </details>
      </section>

      <section aria-labelledby="h-gap">
        <h2 id="h-gap">Not reported</h2>
        <ul className="bullets">
          <li>
            Whether a connection is being skipped because a quota window crossed its auto-pause
            threshold. A session pinned to such a connection still reads as healthy.
          </li>
          <li>
            Whether one model on a connection is locked out after a model-scoped failure, and until
            when. That lockout is one of the reasons a pin moves.
          </li>
        </ul>
      </section>
    </>
  );
}
