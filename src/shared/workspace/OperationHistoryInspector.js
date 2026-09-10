'use client';
import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Loader,
  Pagination,
  Select,
  Text,
  Tooltip,
} from '@mantine/core';
import { Icon } from '@/shared/components/Icon';
import { useResource } from './useResource';
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
} from './Board';
import {
  NOT_RECORDED,
  OPERATION_CODES,
  OPERATION_STATES,
  operationHistoryLimits,
  operationHistoryUrl,
  operationNumber,
  operationTimestamp,
  operationText,
  resolveOperationRows,
} from './operationHistoryModel';
import styles from './operationHistoryInspector.module.css';

// Outcome, not state: every retained row lands in exactly one of these, each a
// summary chip that filters and, in Everyday, a card group.
export const OPERATION_OUTCOMES = [
  { id: 'succeeded', label: 'Succeeded', tone: 'positive' },
  { id: 'failed', label: 'Failed', tone: 'refusal' },
  { id: 'unresolved', label: 'Unresolved', tone: 'ember' },
  { id: 'inconclusive', label: 'Inconclusive', tone: null },
];

export function operationOutcome(row) {
  if (row?.unresolved) return 'unresolved';
  if (row?.state === 'succeeded') return 'succeeded';
  if (row?.state === 'failed') return 'failed';
  return 'inconclusive';
}

// The value column is narrow, so a duration reads in the largest unit that
// keeps it under six characters.
const duration = (ms) =>
  ms < 1000 ? `${operationNumber(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;

const SUBJECT_ICON = {
  proxyPool: 'i-network',
  connection: 'i-connections',
  clientKey: 'i-keys',
};

function Freshness({ value }) {
  if (!value) return null;
  return (
    <Text size="xs" c="dimmed" className={styles.freshness}>
      {value.source === 'last-persisted-snapshot'
        ? `Persisted file ${operationTimestamp(value.persistedAt)}`
        : `Committed snapshot ${operationTimestamp(value.snapshotCompletedAt)}`}{' '}
      UTC.
    </Text>
  );
}

// A measured value, right-aligned tabular mono, or the word for its absence.
function Measured({ value, unit }) {
  if (value === null || value === undefined)
    return <span className={styles.unknown}>{NOT_RECORDED}</span>;
  return (
    <span className={styles.measure}>
      {operationNumber(value)}
      {unit ? ` ${unit}` : ''}
    </span>
  );
}

function Flag({ value, when, absent }) {
  if (typeof value !== 'boolean') return <span className={styles.unknown}>{NOT_RECORDED}</span>;
  return <>{value ? when : absent}</>;
}

function Selected({ row }) {
  const { presentation, details } = row;
  return (
    <section className={styles.selected} aria-label="Selected operation event">
      <h4>What this row means</h4>
      <p className={styles.state} data-tone={presentation.tone}>
        {presentation.label}
      </p>
      <code className={styles.operationId}>{row.operationId}</code>
      <p>{presentation.meaning}</p>
      {row.terminalReceipt && (
        <p>
          Terminal receipt {row.terminalReceipt.id} recorded{' '}
          <strong>{row.terminalReceipt.state}</strong> at{' '}
          {operationTimestamp(row.terminalReceipt.capturedAt)} UTC.
        </p>
      )}
      <h5>Recorded effect</h5>
      <p>{presentation.activation}</p>
      {row.code ? (
        <>
          <h5>Recorded code</h5>
          <p>
            <code className={styles.code}>{row.code}</code>{' '}
            {OPERATION_CODES[row.code] || 'This code has no explanation on this screen.'}
          </p>
        </>
      ) : null}
      <h5>Retained detail</h5>
      <dl className={styles.facts}>
        <dt>Subject</dt>
        <dd>
          {operationText(row.subjectKind)} · {operationText(row.subjectId)}
        </dd>
        <dt>Provider</dt>
        <dd>{operationText(row.provider)}</dd>
        <dt>Connection</dt>
        <dd>{operationText(row.connectionId)}</dd>
        <dt>Request</dt>
        <dd>{operationText(row.requestId)}</dd>
        <dt>Reason</dt>
        <dd>{operationText(details?.reason)}</dd>
        <dt>Target host</dt>
        <dd>{operationText(details?.targetHost)}</dd>
        <dt>Upstream status</dt>
        <dd>
          <Measured value={details?.status ?? null} />
        </dd>
        <dt>Elapsed</dt>
        <dd>
          <Measured value={details?.elapsedMs ?? null} unit="ms" />
        </dd>
        <dt>Probe kind</dt>
        <dd>{operationText(details?.kind)}</dd>
        <dt>Pool type</dt>
        <dd>{operationText(details?.poolType)}</dd>
        <dt>Reached its deadline</dt>
        <dd>
          <Flag value={details?.timedOut} when="Yes" absent="No" />
        </dd>
        <dt>Caller cancelled it</dt>
        <dd>
          <Flag value={details?.cancelled} when="Yes" absent="No" />
        </dd>
        <dt>Configuration conflict</dt>
        <dd>
          <Flag
            value={details?.conflict}
            when="Yes, the result was discarded"
            absent="None recorded"
          />
        </dd>
      </dl>
    </section>
  );
}

function OperationIdentity({ row, expanded, onOpen }) {
  return (
    <div className={board.identity}>
      <span className={styles.subjectMark} aria-hidden="true">
        <Icon name={SUBJECT_ICON[row.subjectKind] || 'i-system'} />
      </span>
      <div className={board.identityText}>
        <span className={board.nameLine}>
          <button
            type="button"
            className={`${board.nameButton} ${styles.idButton}`}
            aria-label={`Inspect operation ${row.operationId} ${row.phase}`}
            aria-pressed={expanded}
            aria-expanded={expanded}
            data-operation-row={row.id}
            onClick={onOpen}
          >
            {row.operationId}
          </button>
        </span>
        <small>
          {operationText(row.phase)} · {operationText(row.subjectId)}
        </small>
      </div>
    </div>
  );
}

// The one measured quantity a retained row reliably carries. It is a duration,
// not a level, so it draws as a composition share rather than a status meter.
function OperationEvidence({ row }) {
  const elapsed = row.details?.elapsedMs;
  const status = row.details?.status;
  if (!Number.isFinite(elapsed) && !Number.isFinite(status))
    return <span className={board.muted}>No timing recorded</span>;
  return (
    <>
      {Number.isFinite(elapsed) ? (
        <EvidenceLine
          label="Elapsed"
          shares={[{ kind: 'read', percent: Math.min(100, (elapsed / 30000) * 100) }]}
          value={duration(elapsed)}
          note={
            row.details?.timedOut
              ? 'deadline reached'
              : row.details?.cancelled
                ? 'caller cancelled'
                : row.details?.kind || 'measured'
          }
          title="The bar reads against a thirty-second deadline."
        />
      ) : null}
      {Number.isFinite(status) ? (
        <EvidenceLine
          label="Upstream"
          meter={false}
          value={operationNumber(status)}
          note={row.code ? row.code : 'status recorded'}
        />
      ) : null}
    </>
  );
}

function OperationCaret({ expanded, onToggle, label }) {
  return (
    <Tooltip label={expanded ? 'Collapse' : 'Retained evidence'}>
      <button
        type="button"
        className={board.caret}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} operation ${label}`}
        onClick={onToggle}
      >
        <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
      </button>
    </Tooltip>
  );
}

function OperationRow({ row, expanded, onToggle }) {
  const outcome = operationOutcome(row);
  const tone = OPERATION_OUTCOMES.find((item) => item.id === outcome)?.tone;
  return (
    <article
      className={`${board.row}${row.unresolved ? ` ${styles.unresolvedRow}` : ''}`}
      data-operation-id={row.id}
      data-expanded={expanded || undefined}
      data-bucket={outcome}
      data-kind={row.presentation.kind}
      aria-label={`Operation ${row.operationId} ${row.phase}`}
    >
      <div className={board.main}>
        <OperationCaret expanded={expanded} onToggle={onToggle} label={row.operationId} />
        <OperationIdentity row={row} expanded={expanded} onOpen={onToggle} />
        <div className={`${board.state} ${styles.wrapState}`}>
          <Tooltip label={row.presentation.meaning} multiline w={320}>
            <span>
              <StateWord tone={tone}>{row.presentation.label}</StateWord>
            </span>
          </Tooltip>
          {row.unresolved ? (
            <span className={styles.unresolvedMark} aria-hidden="true">
              <Icon name="i-warning" />
            </span>
          ) : null}
        </div>
        <div className={board.quota}>
          <OperationEvidence row={row} />
        </div>
        <div className={board.activity}>
          <span>{operationTimestamp(row.occurredAt)}</span>
          <small>captured {operationTimestamp(row.capturedAt)}</small>
        </div>
        <div className={board.activity}>
          <span>{operationText(row.actorClass)}</span>
          <small>{operationText(row.source)}</small>
        </div>
      </div>
      {expanded ? (
        <div className={board.detail} role="region" aria-label="Operation evidence">
          <Selected row={row} />
        </div>
      ) : null}
    </article>
  );
}

function OperationCard({ row, expanded, onToggle }) {
  const outcome = operationOutcome(row);
  const tone = OPERATION_OUTCOMES.find((item) => item.id === outcome)?.tone;
  return (
    <article
      className={`${board.card}${row.unresolved ? ` ${styles.unresolvedRow}` : ''}`}
      data-operation-id={row.id}
      data-expanded={expanded || undefined}
      data-bucket={outcome}
      data-kind={row.presentation.kind}
      aria-label={`Operation ${row.operationId} ${row.phase}`}
    >
      <header className={board.cardHead}>
        <OperationIdentity row={row} expanded={expanded} onOpen={onToggle} />
        <OperationCaret expanded={expanded} onToggle={onToggle} label={row.operationId} />
      </header>
      <div className={`${board.cardState} ${styles.wrapState}`}>
        <Tooltip label={row.presentation.meaning} multiline w={320}>
          <span>
            <StateWord tone={tone}>{row.presentation.label}</StateWord>
          </span>
        </Tooltip>
        <span className={board.spacer} />
        <span className={board.cardAttempts}>{operationTimestamp(row.occurredAt)}</span>
      </div>
      <div className={board.cardWindows}>
        <OperationEvidence row={row} />
      </div>
      {expanded ? (
        <div className={board.detail} role="region" aria-label="Operation evidence">
          <Selected row={row} />
        </div>
      ) : null}
    </article>
  );
}

/**
 * Retained probe history for one subject, or for a whole scope, newest capture
 * first, paged through the bounded analytics query rather than loaded whole.
 *
 * The state word carries the distinction this screen exists for: a start whose
 * terminal receipt never arrived reads as unresolved, which is neither a
 * success nor a failure, and the copy says so instead of implying the probe can
 * simply be run again.
 */
export function OperationHistoryInspector({
  subjectId,
  subjectKind = 'proxyPool',
  label,
  allSubjects = false,
  filters = {},
  initialPage = 1,
  initialSelectedId = null,
  onViewChange,
  search,
  onSearch,
  searchLabel = 'Search operation ids',
  toolbar = null,
  scopeRow = null,
  density: densityProp,
  onDensity,
  showDensity = false,
}) {
  const advanced = useLevel();
  // One density switch per page: the page reads the choice once and hands it
  // down, and a nested inspector follows the same stored value without
  // offering a second control.
  const [ownDensity, setOwnDensity] = useDensity();
  const density = densityProp ?? ownDensity;
  const setDensity = onDensity ?? setOwnDensity;
  const [page, setPage] = useState(initialPage);
  const [state, setState] = useState(filters.state || null);
  const [outcome, setOutcome] = useState(null);
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const resource = useResource(
    operationHistoryUrl(subjectId, page, { subjectKind, state, allSubjects, filters })
  );
  // Page and selection are per-subject state. Rather than resetting them in an
  // effect when subjectId changes (a cascading render), the caller keys this
  // component on the subject so a different subject is a fresh mount.
  const rows = resolveOperationRows(resource.data?.items);
  const counts = Object.fromEntries(
    OPERATION_OUTCOMES.map((item) => [
      item.id,
      rows.filter((row) => operationOutcome(row) === item.id).length,
    ])
  );
  const visible = outcome ? rows.filter((row) => operationOutcome(row) === outcome) : rows;
  const unresolvedCount = counts.unresolved;
  const openRow = (row) => {
    const next = selectedId === row.id ? null : row.id;
    setSelectedId(next);
    onViewChange?.({ event: next });
  };

  return (
    <section
      className={styles.inspector}
      aria-label={allSubjects ? 'Operation history' : 'Probe operation history'}
    >
      {/* Nested under a subject the board needs its own name; on the
          Operations lens the page heading already carries it. */}
      {allSubjects ? null : (
        <div className={styles.lens}>
          <h3>Probe history</h3>
          <p className={styles.note}>
            Retained receipts for {label ? <strong>{label}</strong> : 'this pool'}, newest capture
            first.
          </p>
        </div>
      )}
      <Board
        label={allSubjects ? 'Retained operation events' : 'Retained probe events'}
        advanced={advanced}
        data-compare="none"
        density={density}
        layout={advanced ? 'rows' : 'cards'}
      >
        <BoardSummary
          label="Operation summary"
          active={outcome}
          onPick={setOutcome}
          chips={
            resource.data
              ? [
                  {
                    count: rows.length,
                    label: rows.length === 1 ? 'event on this page' : 'events on this page',
                  },
                  ...OPERATION_OUTCOMES.filter((item) => counts[item.id] > 0).map((item) => ({
                    id: item.id,
                    tone: item.tone,
                    count: counts[item.id],
                    label: item.label.toLowerCase(),
                  })),
                ]
              : [{ count: '—', label: 'events on this page' }]
          }
          note={
            <span title="Each row is evidence that was written at the time; it is not re-derived from the subject as it stands now. Reading history does not run a probe, retry an operation or change its subject.">
              {resource.data
                ? `${operationNumber(resource.data.total)} matching retained events, page ${operationNumber(resource.data.page)} of ${operationNumber(resource.data.pages)}`
                : 'Reading retained events…'}
            </span>
          }
        />
        <BoardToolbar
          search={search}
          onSearch={onSearch}
          searchLabel={searchLabel}
          actions={
            <>
              {toolbar}
              <Tooltip label="Re-read the retained events">
                <ActionIcon
                  variant="default"
                  aria-label="Refresh history"
                  loading={resource.loading}
                  onClick={resource.refresh}
                >
                  <Icon name="i-refresh" />
                </ActionIcon>
              </Tooltip>
            </>
          }
        >
          <Select
            size="xs"
            aria-label="Filter recorded operation state"
            placeholder="All recorded states"
            clearable
            clearButtonProps={{ 'aria-label': 'Clear operation state filter' }}
            value={state}
            onChange={(value) => {
              setState(value);
              onViewChange?.({ state: value, page: 1, event: null });
              setPage(1);
              setSelectedId(null);
            }}
            data={OPERATION_STATES.map((value) => ({ value, label: value }))}
            className={styles.filter}
          />
          {showDensity ? (
            <Tooltip label="How much room each event takes">
              <DensitySwitch value={density} onChange={setDensity} />
            </Tooltip>
          ) : null}
        </BoardToolbar>
        {scopeRow}
        {unresolvedCount > 0 ? (
          <p className={styles.unresolvedBanner} role="status">
            {operationNumber(unresolvedCount)} of these operations recorded a start with no terminal
            receipt. Each one is unresolved and may still be running. That is neither a success nor
            a failure, and it is not permission to resend the check.
          </p>
        ) : null}
        {resource.error ? (
          <Alert
            color="orange"
            className={styles.alert}
            title={allSubjects ? 'Operation history unavailable' : 'Probe history unavailable'}
          >
            {resource.error}
            <div>
              <Button variant="subtle" size="compact-xs" onClick={resource.refresh}>
                Retry history
              </Button>
            </div>
          </Alert>
        ) : null}
        {advanced && visible.length ? (
          <div className={board.head} aria-hidden="true">
            <span />
            <span>Operation and phase</span>
            <span>State</span>
            <span>Recorded measurement</span>
            <span>Occurred (UTC)</span>
            <span>Actor</span>
          </div>
        ) : null}
        {advanced ? (
          <div className={board.rows}>
            {visible.map((row) => (
              <OperationRow
                key={row.id}
                row={row}
                expanded={row.id === selectedId}
                onToggle={() => openRow(row)}
              />
            ))}
          </div>
        ) : (
          OPERATION_OUTCOMES.map((item) => {
            const members = visible.filter((row) => operationOutcome(row) === item.id);
            if (!members.length) return null;
            return (
              <BoardGroup key={item.id} label={item.label} tone={item.tone} count={members.length}>
                {members.map((row) => (
                  <OperationCard
                    key={row.id}
                    row={row}
                    expanded={row.id === selectedId}
                    onToggle={() => openRow(row)}
                  />
                ))}
              </BoardGroup>
            );
          })
        )}
        <div className={board.messages}>
          {resource.loading && !resource.data ? (
            <p className={board.empty} role="status">
              <Loader size="xs" /> Reading retained events…
            </p>
          ) : null}
          {!resource.loading && !resource.error && !rows.length ? (
            <p className={board.empty}>
              {allSubjects
                ? 'No operation event for this scope was captured'
                : 'No probe event for this pool was captured'}{' '}
              in the read window. History cannot be reconstructed for work that ran before events
              were retained. These records do not cover every application action.
            </p>
          ) : null}
          {rows.length > 0 && !visible.length ? (
            <p className={board.empty}>
              No event matches.{' '}
              <button type="button" className={board.linkButton} onClick={() => setOutcome(null)}>
                Clear filters
              </button>
            </p>
          ) : null}
        </div>
        {rows.length ? (
          <div className={styles.pager}>
            <span className={board.muted}>
              Select an operation id to read its exact subject, retained state and recorded effect.
            </span>
            <span className={board.spacer} />
            <Pagination
              total={resource.data?.pages || 1}
              value={page}
              onChange={(next) => {
                setPage(next);
                onViewChange?.({ page: next, event: null });
                setSelectedId(null);
              }}
              size="xs"
              aria-label="Operation history pages"
              getControlProps={(control) => ({ 'aria-label': `${control} operation history page` })}
              getItemProps={(item) => ({ 'aria-label': `Operation history page ${item}` })}
            />
          </div>
        ) : null}
      </Board>
      <details className={styles.limits}>
        <summary>What this history does not tell you</summary>
        <ul>
          {operationHistoryLimits(resource.data?.timeRange).map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </details>
      <Freshness value={resource.data?.freshness} />
    </section>
  );
}
