'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ActionIcon, Button, NativeSelect, Select, Tooltip } from '@mantine/core';
import { call } from '@/shared/api';
import { Icon } from '@/shared/components/Icon';
import { ProviderMark, providerIdentity } from '@/shared/components/ProviderMark';
import { useOptionalWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { quotaTimestamp } from '@/shared/workspace/quotaWorkbenchModel';
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
import {
  TIMELINE_KINDS,
  TIMELINE_KIND_LABEL,
  TIMELINE_PAGE_SIZE,
  timelineIdentifiers,
  timelineSummary,
  timelineUnavailable,
  timelineUrl,
  pinAttemptSelection,
} from '@/shared/workspace/pinTimelineModel';
import styles from './sessionPins.module.css';

const ROOT = '/api/admin/session-pins';
const timestamp = (value) => (value ? `${quotaTimestamp(value)} UTC` : 'Unknown');
// The note column is narrow, so an evidence line carries the short clock and
// keeps the exact instant in its tooltip.
const shortTime = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      })
    : 'Unknown';
const at = (value) => (value ? Date.parse(value) : NaN);

// Shared workspace scope maps onto the exact list filters the backend accepts.
// The shared end boundary is exclusive; lastSeenTo is inclusive at the same instant.
export function pinsUrl(scope, cursor = '') {
  const query = new URLSearchParams();
  if (scope?.provider) query.set('provider', scope.provider);
  if (scope?.connectionId) query.set('connectionId', scope.connectionId);
  if (scope?.model) query.set('model', scope.model);
  if (scope?.start) query.set('lastSeenFrom', scope.start);
  if (scope?.end) query.set('lastSeenTo', scope.end);
  if (cursor) query.set('before', cursor);
  const text = query.toString();
  return text ? `${ROOT}?${text}` : ROOT;
}

// Every stored status renders as its own word. Anything unrecognized is uncertain,
// never silently folded into a healthy state.
export function receiptState(action) {
  switch (action?.status) {
    case 'preview':
      return 'Saved preview';
    case 'queued':
      return 'Queued';
    case 'applied':
      return 'Applied';
    case 'cancelled':
      return 'Cancelled';
    case 'conflict':
      return action.reason === 'preview_expired' ? 'Stale preview' : 'Conflicting state';
    default:
      return 'Uncertain';
  }
}

// One bucket per pin, and every pin lands in exactly one. `free` is a retained
// binding that names no account, so routing for it is unconstrained; `expired`
// is a binding whose idle or operator deadline has passed and is retained as
// evidence rather than as a constraint.
export const PIN_BUCKETS = [
  { id: 'pinned', label: 'Pinned', tone: 'positive', word: 'Pinned' },
  { id: 'expired', label: 'Expired', tone: 'ember', word: 'Expired' },
  { id: 'free', label: 'Free', tone: null, word: 'Free' },
];

export function pinDeadline(pin) {
  const ends = [at(pin?.expiresAt), at(pin?.operatorExpiresAt)].filter(Number.isFinite);
  return ends.length ? Math.min(...ends) : NaN;
}

export function pinBucket(pin, now = Date.now()) {
  if (!pin?.connectionId) return 'free';
  if (pin.state !== 'active') return 'expired';
  const ends = pinDeadline(pin);
  return Number.isFinite(ends) && ends <= now ? 'expired' : 'pinned';
}

export function pinStateWord(pin, now) {
  return PIN_BUCKETS.find((item) => item.id === pinBucket(pin, now))?.word || 'Unknown';
}

const HOUR = 3600e3;
export function pinDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'Unknown';
  if (ms < 60e3) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < HOUR) return `${Math.round(ms / 60e3)} m`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / (24 * HOUR))} d`;
}

const level = (remaining) =>
  remaining <= 0 ? 'depleted' : remaining <= 20 ? 'low' : remaining <= 50 ? 'warn' : 'good';

// The evidence a pin carries: how long it has held, and how much life is left
// in each deadline that can end it. Age is a composition share (cool hue) so it
// never reads as a status meter beside the two that are.
export function pinLines(pin, now = Date.now()) {
  const lines = [];
  const pinned = at(pin?.pinnedAt);
  if (Number.isFinite(pinned)) {
    const age = Math.max(0, now - pinned);
    lines.push({
      key: 'age',
      label: 'Age',
      shares: [{ kind: 'input', percent: Math.min(100, (age / (24 * HOUR)) * 100) }],
      value: pinDuration(age),
      note: `from ${shortTime(pin.pinnedAt)}`,
      title: `Pinned ${timestamp(pin.pinnedAt)}. The bar reads against one day.`,
    });
  }
  const idle = at(pin?.expiresAt);
  const seen = at(pin?.lastSeenAt);
  if (Number.isFinite(idle)) {
    const span = Number.isFinite(seen) && idle > seen ? idle - seen : 24 * HOUR;
    const left = Math.max(0, Math.min(span, idle - now));
    const remaining = Math.round((left / span) * 100);
    lines.push({
      key: 'idle',
      label: 'Idle',
      remaining,
      level: level(remaining),
      value: `${remaining}%`,
      note:
        idle <= now
          ? `passed ${shortTime(pin.expiresAt)}`
          : `${pinDuration(idle - now)} to ${shortTime(pin.expiresAt)}`,
      title: `Idle expiry ${timestamp(pin.expiresAt)}. Normal activity extends it by 24 hours.`,
    });
  }
  const operator = at(pin?.operatorExpiresAt);
  if (Number.isFinite(operator)) {
    const span = Number.isFinite(pinned) && operator > pinned ? operator - pinned : 24 * HOUR;
    const left = Math.max(0, Math.min(span, operator - now));
    const remaining = Math.round((left / span) * 100);
    lines.push({
      key: 'operator',
      label: 'Deadline',
      remaining,
      level: level(remaining),
      value: `${remaining}%`,
      note:
        operator <= now
          ? `passed ${shortTime(pin.operatorExpiresAt)}`
          : `${pinDuration(operator - now)} to ${shortTime(pin.operatorExpiresAt)}`,
      title: `Operator deadline ${timestamp(pin.operatorExpiresAt)}. It caps the idle extension.`,
    });
  }
  return lines;
}

export const PIN_SORTS = [
  { value: 'seen', label: 'Last seen first' },
  { value: 'ends', label: 'Ends soonest' },
  { value: 'model', label: 'Model' },
  { value: 'account', label: 'Account' },
];

export function filterPins(pins, { query, bucket }, now = Date.now()) {
  const needle = String(query || '')
    .trim()
    .toLowerCase();
  return pins.filter((pin) => {
    if (bucket && pinBucket(pin, now) !== bucket) return false;
    if (!needle) return true;
    return [pin.model, pin.connectionId, pin.provider]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

export function sortPins(pins, sort, now = Date.now()) {
  const rows = [...pins];
  if (sort === 'model')
    return rows.sort((a, b) => String(a.model || '').localeCompare(String(b.model || '')));
  if (sort === 'account')
    return rows.sort((a, b) =>
      String(a.connectionId || '').localeCompare(String(b.connectionId || ''))
    );
  if (sort === 'ends')
    return rows.sort(
      (a, b) => (pinDeadline(a) || Infinity) - (pinDeadline(b) || Infinity) || 0
    );
  return rows.sort((a, b) => (at(b.lastSeenAt) || 0) - (at(a.lastSeenAt) || 0));
}

export function pinSummary(pins, now = Date.now()) {
  const counts = { pinned: 0, expired: 0, free: 0 };
  for (const pin of pins) counts[pinBucket(pin, now)] += 1;
  return counts;
}

// The full timeline pages through retained history for one binding. It reads
// its own pages, so opening it never re-reads or reorders the pin list, and it
// renders inside the expanded row so the inventory above cannot shift.
function Timeline({ pin, onReceipt }) {
  const workspace = useOptionalWorkspace();
  const [filters, setFilters] = useState({ kind: '', connectionId: '' });
  const [paging, setPaging] = useState({ cursor: '', trail: [] });
  const [read, setRead] = useState({ key: null, body: null, error: '' });
  const url = timelineUrl({
    pinId: pin.id,
    kind: filters.kind,
    connectionId: filters.connectionId,
    cursor: paging.cursor,
    pageSize: TIMELINE_PAGE_SIZE,
  });
  useEffect(() => {
    let active = true;
    void call(url).then((response) => {
      if (!active) return;
      setRead({
        key: url,
        body: response.ok ? response.body : null,
        error: response.ok ? '' : response.body?.code || 'Timeline could not be read',
      });
    });
    return () => {
      active = false;
    };
  }, [url]);
  const page = read.key === url ? read.body : null;
  const error = read.key === url ? read.error : '';
  const loading = read.key !== url;
  // A filter change restarts paging: a cursor is only valid inside the set it
  // was cut from.
  const refine = (update) => {
    setPaging({ cursor: '', trail: [] });
    setFilters((current) => ({ ...current, ...update }));
  };
  const accounts = [
    ...new Set(
      (page?.items || [])
        .map((item) => item.connectionId)
        .filter((value) => typeof value === 'string' && value)
    ),
  ].sort();
  return (
    <div className={styles.timeline}>
      <div className={styles.timelineControls}>
        <NativeSelect
          size="xs"
          label="Source"
          className={styles.control}
          disabled={loading}
          value={filters.kind}
          onChange={(event) => refine({ kind: event.currentTarget.value })}
          data={TIMELINE_KINDS}
        />
        <NativeSelect
          size="xs"
          label="Account"
          className={styles.control}
          disabled={loading}
          value={filters.connectionId}
          onChange={(event) => refine({ connectionId: event.currentTarget.value })}
          data={[
            { value: '', label: 'Every account' },
            ...[
              ...new Set([...accounts, ...(filters.connectionId ? [filters.connectionId] : [])]),
            ].map((id) => ({ value: id, label: id })),
          ]}
        />
      </div>
      {error && (
        <p role="alert" className={styles.alert}>
          {error.replaceAll('_', ' ')}. Retry before reading this history.
        </p>
      )}
      {loading && <p role="status">Reading timeline…</p>}
      {page && (
        <>
          <p className={styles.note}>
            {page.total} retained {page.total === 1 ? 'entry' : 'entries'} in this scope, ordered by{' '}
            {page.boundaries?.ordering || 'recorded time'}. Requests are timed by{' '}
            <code>{page.timeBasis?.request || 'unknown'}</code>, switches by{' '}
            <code>{page.timeBasis?.switch || 'unknown'}</code> and receipts by{' '}
            <code>{page.timeBasis?.action || 'unknown'}</code>.
          </p>
          {timelineUnavailable(page).map((text) => (
            <p key={text} className={styles.notice}>
              {text}
            </p>
          ))}
          {page.complete === false && (
            <p className={styles.notice}>
              {page.instruction || 'This page exceeded its response bound and was not rendered.'}
            </p>
          )}
          {page.items.length ? (
            <ol className={styles.timelineList} aria-label="Full pin timeline">
              {page.items.map((item) => (
                <li key={`${item.kind}:${item.id}`} data-kind={item.kind}>
                  <span className={styles.timelineKind}>
                    {TIMELINE_KIND_LABEL[item.kind] || 'Unknown source'}
                  </span>{' '}
                  <span className={styles.timelineAt}>{timestamp(item.at)}</span>
                  <p>{timelineSummary(item)}</p>
                  <dl className={styles.timelineIds}>
                    {timelineIdentifiers(item).map((identifier) => (
                      <div key={identifier.label}>
                        <dt>{identifier.label}</dt>
                        <dd>
                          <code>{identifier.value}</code>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {item.kind === 'action' && (
                    <button
                      className={board.linkButton}
                      type="button"
                      onClick={() => onReceipt(item.actionId)}
                    >
                      Open receipt <code>{item.actionId.slice(0, 8)}</code>
                    </button>
                  )}
                  {item.kind === 'request' && (
                    <AttemptLink item={item} sessionId={pin.session?.id} workspace={workspace} />
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.empty}>No retained history matches this source and account.</p>
          )}
          <div className={styles.pager}>
            {paging.trail.length > 0 && (
              <Button
                variant="default"
                size="compact-xs"
                disabled={loading}
                onClick={() =>
                  setPaging({ cursor: paging.trail.at(-1), trail: paging.trail.slice(0, -1) })
                }
              >
                Previous entries
              </Button>
            )}
            {page.next && (
              <Button
                variant="default"
                size="compact-xs"
                disabled={loading}
                onClick={() =>
                  setPaging({ cursor: page.next, trail: [...paging.trail, paging.cursor] })
                }
              >
                More entries
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function History({ pin, bound, busy, onReceipt }) {
  const workspace = useOptionalWorkspace();
  return (
    <>
      <h4>Recent history</h4>
      <p className={styles.note}>
        Most recent {bound} requests, account switches and control receipts for this binding. Older
        history is retained by the gateway but not shown here.
      </p>
      {pin.requests.length ? (
        <ul className={styles.history} aria-label="Recent requests">
          {pin.requests.map((request) => (
            <li key={request.id}>
              Requested {request.requestedModel || 'Unknown'} · served{' '}
              {request.servedModel || 'Not confirmed'} · {request.status} ·{' '}
              <code>{request.id}</code>
              <AttemptLink item={request} sessionId={pin.session?.id} workspace={workspace} />
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>
          No exact retained requests for this binding identity and model.
        </p>
      )}
      {pin.switches.length > 0 && (
        <ul className={styles.history} aria-label="Recent account switches">
          {pin.switches.map((item) => (
            <li key={item.id}>
              {timestamp(item.switchedAt)} · {item.fromConnectionId || 'First binding'} →{' '}
              {item.toConnectionId} · {item.trigger}
            </li>
          ))}
        </ul>
      )}
      {pin.actions.length > 0 && (
        <ul className={styles.history} aria-label="Recent control receipts">
          {pin.actions.map((item) => (
            <li key={item.id}>
              <button
                className={board.linkButton}
                type="button"
                disabled={busy}
                onClick={() => onReceipt(item.id)}
              >
                Receipt <code>{item.id.slice(0, 8)}</code> · {item.action} · {receiptState(item)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AttemptLink({ item, sessionId, workspace }) {
  const selection = pinAttemptSelection(item, sessionId);
  if (!selection || !workspace?.setSelectedRecord) return null;
  return (
    <Link
      className={styles.attemptLink}
      href="/dashboard/context"
      onClick={() => {
        workspace.setContextView({ sessionId, page: 1 });
        workspace.setSelectedRecord(selection);
      }}
    >
      Inspect exact attempt and ordered stages
    </Link>
  );
}

function ControlReceipt({ receipt, busy, onReceipt, uncertainId }) {
  if (!receipt && !uncertainId) return null;
  return (
    <div role="status" className={styles.receipt} aria-label="Retained pin control receipt">
      <strong>{uncertainId ? 'Application status unknown' : receiptState(receipt)}</strong>
      <p>
        Control receipt <code>{receipt?.id || uncertainId}</code> ·{' '}
        {receipt?.reason || 'Read the retained receipt before another change.'}
      </p>
      <p>
        {receipt?.status === 'queued'
          ? 'Waiting for a subsequent request. No request has been moved.'
          : 'This receipt describes affinity control, not provider acceptance or a billing result.'}
      </p>
      {receipt?.action === 'clear' && receipt.status === 'applied' && (
        <p>Affinity was cleared. The receipt remains available after its pin leaves the list.</p>
      )}
      <Button
        variant="subtle"
        size="compact-xs"
        disabled={busy}
        onClick={() => onReceipt(receipt?.id || uncertainId)}
      >
        Refresh receipt
      </Button>
    </div>
  );
}

// The binding controls, inline in the expanded row. Preview then apply: there
// is no dialog and no control that mutates on its first click.
function Inspector({
  pin,
  busy,
  form,
  preview,
  bound,
  expanded,
  onExpand,
  onSubmit,
  onApply,
  onReceipt,
  onEdit,
  onClose,
}) {
  const { action, target, deadline, setAction, setTarget, setDeadline } = form;
  return (
    <div className={styles.dockBody}>
      <div className={styles.dockHead}>
        <div>
          <h4>Change this binding</h4>
          <p className={styles.note}>
            {pin.model} · account {pin.connectionId || 'not named'}
          </p>
        </div>
        <span className={board.spacer} />
        <Button variant="subtle" size="compact-xs" disabled={busy} onClick={onClose}>
          Close pin controls
        </Button>
      </div>
      <form onSubmit={onSubmit} className={styles.form}>
        <NativeSelect
          size="xs"
          label="Change"
          className={styles.control}
          disabled={busy}
          value={action}
          onChange={(e) => onEdit(() => setAction(e.currentTarget.value))}
          data={[
            { value: 'clear', label: 'Clear affinity' },
            { value: 'expire', label: 'Set expiry deadline' },
            { value: 'reassign', label: 'Reassign on a later request' },
          ]}
        />
        {action === 'reassign' && (
          <NativeSelect
            size="xs"
            required
            label="Target account"
            className={styles.control}
            value={target}
            disabled={busy}
            onChange={(e) => onEdit(() => setTarget(e.currentTarget.value))}
            data={[
              { value: '', label: 'Choose an account' },
              ...pin.targets
                .filter((item) => item.id !== pin.connectionId)
                .map((item) => ({
                  value: item.id,
                  label: `${item.name || item.id} · ${item.enabled ? 'Enabled' : 'Disabled'}`,
                })),
            ]}
          />
        )}
        {action === 'expire' && (
          <label className={styles.field}>
            <span>Expiry in your local time</span>
            <input
              required
              type="datetime-local"
              value={deadline}
              disabled={busy}
              onChange={(e) => onEdit(() => setDeadline(e.target.value))}
            />
          </label>
        )}
        <Button type="submit" size="xs" disabled={busy} leftSection={<Icon name="i-check" />}>
          Preview change
        </Button>
      </form>
      {preview && (
        <div role="region" aria-label="Pin change preview" className={styles.preview}>
          <strong>Preview before applying</strong>
          <p>{preview.preview.consequence}</p>
          <p>
            One pin affected. Model remains {preview.model}. Upstream readiness remains unknown.
          </p>
          {preview.preview.localTarget && (
            <p>
              Captured account decision {preview.preview.localTarget.status} ·{' '}
              {preview.preview.localTarget.reason}
            </p>
          )}
          {preview.preview.conflicts?.length > 0 && (
            <ul>
              {preview.preview.conflicts.map((item, index) => (
                <li key={index}>{item.reason}</li>
              ))}
            </ul>
          )}
          {preview.preview.cancelledActions?.length > 0 && (
            <p>
              Clearing also cancels queued control {preview.preview.cancelledActions.join(', ')}.
            </p>
          )}
          {preview.preview.unknownEvidence?.length > 0 && (
            <p className={styles.note}>
              Not verified here · {preview.preview.unknownEvidence.join(', ')}
            </p>
          )}
          <p className={styles.note}>
            Preview valid until {timestamp(preview.previewExpiresAt)}. Pending reassignment waits if
            its account is unavailable or a request explicitly names a different account. Clear
            affinity cancels a pending reassignment.
          </p>
          <Button size="xs" disabled={busy} onClick={onApply}>
            Apply this change
          </Button>
        </div>
      )}
      <dl className={styles.facts}>
        <dt>Binding state</dt>
        <dd>{pin.state === 'active' ? 'Active' : 'Expired'}</dd>
        <dt>Provider</dt>
        <dd>{pin.provider || 'Unknown'}</dd>
        <dt>Pinned (UTC)</dt>
        <dd>{timestamp(pin.pinnedAt)}</dd>
        <dt>Last seen (UTC)</dt>
        <dd>{timestamp(pin.lastSeenAt)}</dd>
        <dt>Idle expiry (UTC)</dt>
        <dd>{timestamp(pin.expiresAt)}</dd>
        <dt>Operator deadline (UTC)</dt>
        <dd>{pin.operatorExpiresAt ? timestamp(pin.operatorExpiresAt) : 'No operator deadline'}</dd>
        <dt>Session join</dt>
        <dd>
          {pin.session
            ? `${pin.session.id} · ${pin.session.identitySource} routing identity`
            : 'No exact retained session join'}
        </dd>
      </dl>
      <p className={styles.note}>
        Normal activity extends idle expiry by 24 hours, capped by an operator deadline. Controls
        apply to later requests only; admitted work stays on its current account.
      </p>
      <History pin={pin} bound={bound} busy={busy} onReceipt={onReceipt} />
      <Button
        variant="subtle"
        size="compact-xs"
        aria-expanded={expanded}
        aria-controls="pin-full-timeline"
        onClick={onExpand}
      >
        {expanded ? 'Hide full timeline' : 'Full timeline'}
      </Button>
      <div id="pin-full-timeline" hidden={!expanded}>
        {expanded && <Timeline pin={pin} onReceipt={onReceipt} />}
      </div>
    </div>
  );
}

// The identity block a card and a row share: the mark of the bound account, the
// model as the expand control, and the account under it.
function PinIdentity({ pin, expanded, onOpen }) {
  return (
    <div className={board.identity}>
      <ProviderMark provider={pin.provider} size="small" />
      <div className={board.identityText}>
        <span className={board.nameLine}>
          <button
            type="button"
            className={board.nameButton}
            aria-label={`Inspect pin ${pin.model} on ${pin.connectionId}`}
            aria-pressed={expanded}
            aria-expanded={expanded}
            data-pin-id={pin.id}
            onClick={onOpen}
          >
            {pin.model}
          </button>
        </span>
        <small>
          {providerIdentity(pin.provider).name}
          {pin.connectionId ? ` · ${pin.connectionId}` : ' · No account named'}
        </small>
      </div>
    </div>
  );
}

function PinLines({ lines }) {
  if (!lines.length) return <span className={board.muted}>No deadline recorded</span>;
  return lines.map((line) => (
    <EvidenceLine
      key={line.key}
      label={line.label}
      remaining={line.remaining}
      level={line.level}
      shares={line.shares}
      value={line.value}
      note={line.note}
      title={line.title}
    />
  ));
}

function PinActions({ pin }) {
  return (
    <div className={board.actions}>
      <Tooltip label="Open the bound account in Connections">
        <ActionIcon
          component={Link}
          href={`/dashboard/connections/${encodeURIComponent(pin.connectionId || '')}`}
          variant="subtle"
          color="gray"
          aria-label={`Open ${pin.connectionId || 'the bound account'} in Connections`}
          data-disabled={!pin.connectionId || undefined}
        >
          <Icon name="i-open" />
        </ActionIcon>
      </Tooltip>
    </div>
  );
}

function PinRow({ pin, now, expanded, onToggle, detail }) {
  const bucket = pinBucket(pin, now);
  const tone = PIN_BUCKETS.find((item) => item.id === bucket)?.tone;
  const lines = pinLines(pin, now);
  return (
    <article
      className={board.row}
      data-pin-id={pin.id}
      data-expanded={expanded || undefined}
      data-bucket={bucket}
      aria-label={`${pin.model} on ${pin.connectionId || 'no account'}`}
    >
      <div className={board.main}>
        <Tooltip label={expanded ? 'Collapse' : 'Binding controls and evidence'}>
          <button
            type="button"
            className={board.caret}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${pin.model}`}
            onClick={onToggle}
          >
            <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
          </button>
        </Tooltip>
        <PinIdentity pin={pin} expanded={expanded} onOpen={onToggle} />
        <div className={board.state}>
          <StateWord tone={tone}>{pinStateWord(pin, now)}</StateWord>
          {pin.operatorExpiresAt ? (
            <Tooltip label="An operator deadline caps this binding">
              <span className={styles.deadlineMark}>
                <Icon name="i-clock" />
              </span>
            </Tooltip>
          ) : null}
        </div>
        <div className={board.quota}>
          <PinLines lines={lines} />
        </div>
        <div className={board.activity}>
          <span>{shortTime(pin.lastSeenAt)}</span>
          <small>{pin.session ? 'Session join retained' : 'No session join'}</small>
        </div>
        <PinActions pin={pin} />
      </div>
      {expanded && detail ? (
        <div className={board.detail} role="region" aria-label="Selected pin controls">
          {detail}
        </div>
      ) : null}
    </article>
  );
}

function PinCard({ pin, now, expanded, onToggle, detail }) {
  const bucket = pinBucket(pin, now);
  const tone = PIN_BUCKETS.find((item) => item.id === bucket)?.tone;
  const lines = pinLines(pin, now);
  return (
    <article
      className={board.card}
      data-pin-id={pin.id}
      data-expanded={expanded || undefined}
      data-bucket={bucket}
      aria-label={`${pin.model} on ${pin.connectionId || 'no account'}`}
    >
      <header className={board.cardHead}>
        <PinIdentity pin={pin} expanded={expanded} onOpen={onToggle} />
        <Tooltip label={expanded ? 'Collapse' : 'Binding controls and evidence'}>
          <button
            type="button"
            className={board.caret}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${pin.model}`}
            onClick={onToggle}
          >
            <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
          </button>
        </Tooltip>
      </header>
      <div className={board.cardState}>
        <StateWord tone={tone}>{pinStateWord(pin, now)}</StateWord>
        <span className={board.spacer} />
        <span className={board.cardAttempts} title={`Last seen ${timestamp(pin.lastSeenAt)}`}>
          Seen {shortTime(pin.lastSeenAt)}
        </span>
      </div>
      <div className={board.cardWindows}>
        <PinLines lines={lines} />
      </div>
      {expanded && detail ? (
        <div className={board.detail} role="region" aria-label="Selected pin controls">
          {detail}
        </div>
      ) : null}
    </article>
  );
}

export default function SessionPins({ onChanged, density: densityProp, showDensity = false } = {}) {
  const workspace = useOptionalWorkspace();
  const scope = workspace?.scope;
  const scopeKey = pinsUrl(scope);
  const advanced = useLevel();
  // One density switch per page. The page reads the choice and hands it down;
  // a bare render falls back to the shared stored value.
  const [ownDensity, setOwnDensity] = useDensity();
  const density = densityProp ?? ownDensity;
  // A cursor pages within one filtered set; a filter change restarts paging
  // by keying the paging state to the filter set, never by an effect.
  const [paging, setPaging] = useState({ key: scopeKey, cursor: '', trail: [] });
  const cursor = paging.key === scopeKey ? paging.cursor : '';
  const trail = paging.key === scopeKey ? paging.trail : [];
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState({ key: null, body: null, error: '' });
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const [sort, setSort] = useState('seen');
  const boardRef = useRef(null);
  const returnPinFocus = useRef(null);
  useEffect(() => {
    if (selectedId)
      boardRef.current
        ?.querySelector('[aria-label="Selected pin controls"] select')
        ?.focus();
    else if (returnPinFocus.current) {
      [...(boardRef.current?.querySelectorAll('button[data-pin-id]') || [])]
        .find((element) => element.dataset.pinId === returnPinFocus.current)
        ?.focus();
      returnPinFocus.current = null;
    }
  }, [selectedId]);
  const [action, setAction] = useState('clear');
  const [target, setTarget] = useState('');
  const [deadline, setDeadline] = useState('');
  const [preview, setPreview] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [mutationError, setMutationError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [uncertainId, setUncertainId] = useState(null);
  const generation = useRef(0);
  const url = pinsUrl(scope, cursor);
  const readKey = `${url}#${revision}`;
  useEffect(() => {
    let active = true;
    void call(url).then((response) => {
      if (!active) return;
      setRead({
        key: readKey,
        body: response.ok ? response.body : null,
        error: response.ok ? '' : response.body?.code || 'Pins could not be read',
      });
    });
    return () => {
      active = false;
    };
  }, [url, readKey]);
  const page = read.key === readKey ? read.body : null;
  const error = mutationError || (read.key === readKey ? read.error : '');
  const busy = pending || read.key !== readKey;
  const refresh = () => {
    setPreview(null);
    setMutationError('');
    setRevision((value) => value + 1);
  };
  const edit = (update) => {
    setPreview(null);
    setMutationError('');
    update();
  };
  const select = useCallback(
    (id) => {
      if (pending || uncertainId) return;
      setSelectedId(id);
      setPreview(null);
      setReceipt(null);
      setMutationError('');
      setTarget('');
      // The timeline is scoped to one binding, so a different pin collapses it
      // rather than showing the previous pin's history under a new heading.
      setExpanded(false);
    },
    [pending, uncertainId]
  );
  const pins = useMemo(() => page?.pins || [], [page]);
  const selected = pins.find((pin) => pin.id === selectedId) || null;
  const bound = page?.boundaries?.historyLimitPerPin ?? 8;
  // The evidence clock: the observation the page reports, else a wall clock
  // that advances on its own so remaining life is never frozen at mount.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.parse(page?.observedAt) || clock;
  const providers = useMemo(
    () => [...new Set(pins.map((pin) => pin.provider).filter(Boolean))].sort(),
    [pins]
  );
  const counts = pinSummary(pins, now);
  const visible = sortPins(filterPins(pins, { query, bucket }, now), sort, now);
  async function inspect(event) {
    event.preventDefault();
    if (!selected || uncertainId) return;
    if (action === 'expire' && !Number.isFinite(Date.parse(deadline))) {
      setMutationError('Choose a valid expiry');
      return;
    }
    const seq = ++generation.current;
    setPending(true);
    setMutationError('');
    setPreview(null);
    const actionId = crypto.randomUUID();
    const response = await call(`${ROOT}/preview`, {
      method: 'POST',
      body: {
        id: actionId,
        pinId: selected.id,
        expectedRevision: selected.revision,
        action,
        ...(action === 'reassign' ? { targetConnectionId: target } : {}),
        ...(action === 'expire' ? { deadline: new Date(deadline).toISOString() } : {}),
      },
    });
    if (seq !== generation.current) return;
    if (response.ok) setPreview(response.body);
    else {
      setMutationError(response.body?.code || 'Preview was refused');
      if (!response.status || response.status >= 500) setUncertainId(actionId);
    }
    setPending(false);
  }
  async function apply() {
    if (!preview || uncertainId) return;
    const seq = ++generation.current;
    setPending(true);
    setMutationError('');
    const response = await call(`${ROOT}/apply`, {
      method: 'POST',
      body: { id: preview.id, expectedRevision: preview.expectedRevision },
    });
    if (seq !== generation.current) return;
    setPreview(null);
    if (response.body?.id) setReceipt(response.body);
    if (!response.ok)
      setMutationError(response.body?.reason || response.body?.code || 'Change was refused');
    if (!response.ok && (!response.status || response.status >= 500)) setUncertainId(preview.id);
    if (response.ok) {
      onChanged?.(response.body);
      setRevision((value) => value + 1);
    }
    setPending(false);
  }
  async function readReceipt(id) {
    const seq = ++generation.current;
    setPending(true);
    const response = await call(`${ROOT}/actions/${id}`);
    if (seq !== generation.current) return;
    if (response.ok) {
      setReceipt(response.body);
      if (uncertainId) setRevision((value) => value + 1);
      setUncertainId(null);
      setMutationError('');
    } else if (response.status === 404) {
      setUncertainId(null);
      setReceipt(null);
      setPreview(null);
      setRevision((value) => value + 1);
      setMutationError(
        'No retained receipt at this id. Current pins are being read; a new preview is required'
      );
    } else setMutationError(response.body?.code || 'Receipt could not be read');
    setPending(false);
  }
  const detail = selected ? (
    <Inspector
      pin={selected}
      busy={busy || Boolean(uncertainId)}
      bound={bound}
      expanded={expanded}
      onExpand={() => setExpanded((value) => !value)}
      form={{ action, target, deadline, setAction, setTarget, setDeadline }}
      preview={preview}
      onSubmit={inspect}
      onApply={apply}
      onReceipt={readReceipt}
      onEdit={edit}
      onClose={() => {
        returnPinFocus.current = selectedId;
        select(null);
      }}
    />
  ) : null;
  const toggle = (id) => select(selectedId === id ? null : id);

  return (
    <section className={styles.workbench} ref={boardRef} aria-labelledby="session-pins-title">
      <h3 id="session-pins-title" className={styles.lens}>
        Account pins
      </h3>
      <Board
        label="Account pins"
        data-compare="none"
        advanced={advanced}
        density={density}
        layout={advanced ? 'rows' : 'cards'}
      >
        <BoardSummary
          label="Pin summary"
          active={bucket}
          onPick={setBucket}
          chips={
            page
              ? [
                  { count: pins.length, label: pins.length === 1 ? 'pin' : 'pins' },
                  ...PIN_BUCKETS.map((item) => ({
                    id: item.id,
                    tone: item.tone,
                    count: counts[item.id],
                    label: item.label.toLowerCase(),
                  })),
                ]
              : [{ count: '—', label: 'pins' }]
          }
          note={
            <span title="A pin keeps one routing identity and physical model on an account. Controls apply to later requests; admitted work stays on its current account. Opaque pin identifiers are linkable routing hashes, not raw client identities.">
              {page ? `Observed ${timestamp(page.observedAt)}` : 'Reading pins…'}
            </span>
          }
        />
        <BoardToolbar
          search={query}
          onSearch={setQuery}
          searchLabel="Search pins"
          actions={
            <>
              {trail.length > 0 && (
                <Button
                  variant="default"
                  size="compact-xs"
                  disabled={busy}
                  onClick={() =>
                    setPaging({ key: scopeKey, cursor: trail.at(-1), trail: trail.slice(0, -1) })
                  }
                >
                  Previous pins
                </Button>
              )}
              {page?.next && (
                <Button
                  variant="default"
                  size="compact-xs"
                  disabled={busy}
                  onClick={() =>
                    setPaging({ key: scopeKey, cursor: page.next, trail: [...trail, cursor] })
                  }
                >
                  More pins
                </Button>
              )}
              <Tooltip label="Re-read the retained pins">
                <ActionIcon
                  variant="default"
                  aria-label="Refresh pins"
                  loading={busy}
                  onClick={() => {
                    setPaging({ key: scopeKey, cursor: '', trail: [] });
                    refresh();
                  }}
                >
                  <Icon name="i-refresh" />
                </ActionIcon>
              </Tooltip>
            </>
          }
        >
          {providers.length > 1 ? (
            <div className={board.providers} role="group" aria-label="Provider filter">
              {providers.map((provider) => (
                <Tooltip key={provider} label={providerIdentity(provider).name}>
                  <button
                    type="button"
                    className={board.providerChip}
                    aria-label={`${providerIdentity(provider).name} pins`}
                    aria-pressed={query === provider}
                    onClick={() => setQuery(query === provider ? '' : provider)}
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
              aria-label="Sort pins"
              data={PIN_SORTS}
              value={sort}
              onChange={(value) => value && setSort(value)}
              leftSection={<Icon name="i-sort" />}
              className={board.sort}
              allowDeselect={false}
            />
          ) : null}
          {showDensity ? (
            <Tooltip label="How much room each pin takes">
              <DensitySwitch value={density} onChange={setOwnDensity} />
            </Tooltip>
          ) : null}
        </BoardToolbar>
        {(scope?.provider || scope?.connectionId || scope?.model || scope?.start) && (
          <p className={styles.notice}>
            The shared scope filters this list. The time range bounds each pin&apos;s recorded last
            activity, not its expiry.
          </p>
        )}
        {error && (
          <p role="alert" className={styles.alert}>
            {error.replaceAll('_', ' ')}.{' '}
            {uncertainId
              ? 'Read the retained receipt before another change. No mutation is replayed.'
              : 'Refresh and preview again before applying.'}
          </p>
        )}
        <ControlReceipt
          receipt={receipt}
          uncertainId={uncertainId}
          busy={busy}
          onReceipt={readReceipt}
        />
        {advanced && visible.length ? (
          <div className={board.head} aria-hidden="true">
            <span />
            <span>Pin</span>
            <span>Binding</span>
            <span>Age and remaining life</span>
            <span>Last seen</span>
            <span>Open</span>
          </div>
        ) : null}
        {advanced ? (
          <div className={board.rows}>
            {visible.map((pin) => (
              <PinRow
                key={pin.id}
                pin={pin}
                now={now}
                expanded={pin.id === selectedId}
                onToggle={() => toggle(pin.id)}
                detail={detail}
              />
            ))}
          </div>
        ) : (
          PIN_BUCKETS.map((item) => {
            const members = visible.filter((pin) => pinBucket(pin, now) === item.id);
            if (!members.length) return null;
            return (
              <BoardGroup
                key={item.id}
                label={item.label}
                tone={item.tone}
                count={members.length}
              >
                {members.map((pin) => (
                  <PinCard
                    key={pin.id}
                    pin={pin}
                    now={now}
                    expanded={pin.id === selectedId}
                    onToggle={() => toggle(pin.id)}
                    detail={detail}
                  />
                ))}
              </BoardGroup>
            );
          })
        )}
        <div className={board.messages}>
          {!page && !error ? (
            <p className={board.empty} role="status">
              Reading pins…
            </p>
          ) : null}
          {page && pins.length === 0 ? (
            <p className={board.empty}>
              No retained pin matches this scope and page. A pin is written the first time a session
              lands on an account.
            </p>
          ) : null}
          {page && pins.length > 0 && visible.length === 0 ? (
            <p className={board.empty}>
              No pin matches.{' '}
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
          {selectedId && page && !selected ? (
            <p className={styles.notice} role="status">
              The selected pin is not in the current page or scope. Its selection is retained; widen
              the scope or page back to it.
            </p>
          ) : null}
        </div>
      </Board>
    </section>
  );
}
