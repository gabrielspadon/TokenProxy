// Presentation rules for retained operation events. Pure, so the wording that
// decides whether an operator resends a probe is testable without a DOM.
//
// The load-bearing distinction: a `started` row with no terminal receipt is
// UNRESOLVED, which is neither a success nor a failure and is not permission to
// resend. It must never be rendered with the failure vocabulary.

export const OPERATION_HISTORY_PAGE_SIZE = 10;

// Every state the schema's CHECK constraint permits, offered in the filter.
export const OPERATION_STATES = [
  'started',
  'succeeded',
  'failed',
  'cancelled',
  'uncertain',
  'conflict',
];

// start/end are deliberately omitted: the route defaults them to its own
// 30-day window, which keeps this URL stable across renders (useResource keys
// its effect on the URL) and keeps the queried range the server's answer
// rather than a client guess. The response reports the range it actually used.
export function operationHistoryUrl(
  subjectId,
  page = 1,
  { subjectKind = 'proxyPool', state, allSubjects = false, filters = {} } = {}
) {
  if (!subjectId && !allSubjects) return null;
  const params = new URLSearchParams({
    ...(allSubjects ? filters : { subjectKind, subjectId }),
    page: String(page),
    pageSize: String(filters.pageSize || OPERATION_HISTORY_PAGE_SIZE),
  });
  if (state) params.set('state', state);
  return `/api/admin/operations/events?${params}`;
}

// A missing value is a word. Never a zero, never an empty cell.
export const NOT_RECORDED = 'Not recorded';

export const operationTimestamp = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'UTC',
      })
    : NOT_RECORDED;

export const operationText = (value) =>
  value === null || value === undefined || value === '' ? NOT_RECORDED : String(value);

export const operationNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
    : NOT_RECORDED;

export const UNRESOLVED_LABEL = 'No terminal receipt retained';

// Tones map onto the module's own colours, where `open` is neither good nor
// bad. `kind` is what the row IS: a start, a committed terminal receipt, or a
// start whose receipt never arrived. The three render differently.
const STATE_PRESENTATION = {
  started: {
    label: 'Started',
    tone: 'open',
    kind: 'start',
    meaning:
      'Recorded before any socket opened. A terminal receipt for this operation is retained; it may be outside the selected page or range.',
    activation: 'Activation is decided by the terminal receipt, not by this row.',
  },
  succeeded: {
    label: 'Succeeded',
    tone: 'ok',
    kind: 'terminal',
    meaning: 'The probe reached its target.',
    activation:
      'This pool was set active in the same transaction that wrote this receipt. Connections and provider strategies bound to it route through it again.',
  },
  failed: {
    label: 'Failed',
    tone: 'bad',
    kind: 'terminal',
    meaning: 'The probe completed and did not reach its target.',
    activation:
      'This pool was disabled in the same transaction that wrote this receipt. Connections and provider strategies bound to it stop routing through it until a later probe succeeds.',
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'open',
    kind: 'terminal',
    meaning:
      'The caller stopped the probe before it answered. This is not a failure. Nothing was established about the pool either way.',
    activation:
      'Activation was left exactly as it was. Nothing was enabled and nothing was disabled.',
  },
  uncertain: {
    label: 'Uncertain',
    tone: 'warn',
    kind: 'terminal',
    meaning: 'The probe returned without establishing an outcome.',
    activation: 'Activation was left exactly as it was.',
  },
  conflict: {
    label: 'Conflict',
    tone: 'warn',
    kind: 'terminal',
    meaning:
      'The result landed against a pool that no longer matched the configuration the probe was decided against, so the result was discarded instead of applied.',
    activation: 'Activation was left exactly as it was. The discarded result changed nothing.',
  },
};

const UNRESOLVED_PRESENTATION = {
  label: UNRESOLVED_LABEL,
  tone: 'open',
  kind: 'unresolved',
  meaning:
    'This operation recorded its start and no terminal receipt is retained for it. It may still be running or have been interrupted. It is neither a success nor a failure, and it is not permission to resend the check.',
  activation:
    'The effect on activation cannot be established from this start record. Read the current pool state before taking another action.',
};

const UNKNOWN_PRESENTATION = {
  label: NOT_RECORDED,
  tone: 'warn',
  kind: 'unresolved',
  meaning: 'This row carries a state this screen does not know how to read.',
  activation: 'The effect on activation cannot be stated from this row.',
};

export const OPERATION_CODES = {
  pool_configuration_changed:
    'The pool was edited between the probe being decided and its result landing, so the result was not applied to activation.',
  pool_removed:
    'The pool no longer existed when the result landed, so the result was not applied to activation.',
  probe_cancelled: 'The request was aborted before the probe answered.',
  probe_timeout: 'The probe reached its own deadline without an answer.',
  probe_failed: 'The probe completed and its target refused or errored.',
};

const KEY = (row) => JSON.stringify([row.operationId, row.phase]);

/**
 * Attach presentation to each retained row, deciding resolution by pairing a
 * `started` row against a terminal receipt for the same operation and phase.
 *
 * The API projects the retained terminal receipt across pagination and filters.
 * Older responses can only be paired among the rows handed in; no missing
 * receipt establishes an interruption or an unchanged activation state.
 */
export function resolveOperationRows(items) {
  const rows = Array.isArray(items) ? items : [];
  const terminals = new Set();
  for (const row of rows) if (row.state !== 'started') terminals.add(KEY(row));
  return rows.map((row) => {
    const unresolved = row.state === 'started' && !row.terminalReceipt && !terminals.has(KEY(row));
    const presentation = unresolved
      ? UNRESOLVED_PRESENTATION
      : STATE_PRESENTATION[row.state] || UNKNOWN_PRESENTATION;
    const pool = !row.subjectKind || row.subjectKind === 'proxyPool';
    return {
      ...row,
      unresolved,
      presentation: pool ? presentation : {
        ...presentation,
        meaning: unresolved
          ? UNRESOLVED_PRESENTATION.meaning
          : row.state === 'started'
            ? 'A start was retained. Its terminal receipt may be outside this page or range.'
            : `This operation retained a ${row.state} terminal receipt. Its subject, phase and recorded detail describe the scope.`,
        activation: 'This receipt does not establish a proxy-pool activation change. Inspect the named subject and phase before taking another action.',
      },
    };
  });
}

/**
 * The consequence of the control, stated before it is used.
 *
 * This is copy, not decoration: the probe writes activation in the same
 * transaction as its receipt, so an operator who reads only "Test" has not
 * been told what they are about to change.
 */
export const PROBE_CONSEQUENCE = {
  title: 'Running this probe can change whether the pool is active.',
  scope:
    'A probe that reaches its target sets this pool active. A probe that completes and fails disables it, and every connection and provider strategy bound to this pool stops routing through it until a later probe succeeds.',
  timing:
    'The change is written in the same transaction as the receipt, so it takes effect the moment the probe answers. There is no separate confirmation step.',
  reversal:
    'Reverse it by probing again once the path works, or by editing the pool. Nothing else undoes it, and the receipt itself is retained either way.',
  unchanged:
    'A cancelled probe, and a probe whose result lands after the pool has been edited or deleted, leave activation exactly as it was.',
};

// Named so the operator reads the boundary of the evidence, not a completeness
// claim the query cannot support.
export function operationHistoryLimits(timeRange) {
  return [
    `Only events captured from ${operationTimestamp(timeRange?.start)} to ${operationTimestamp(timeRange?.end)} UTC are read. Anything captured outside that window is retained but not shown here.`,
    'Rows are ordered and filtered on capture time. Occurrence time is shown beside it because the two can differ, and a late capture moves a row without moving when it happened.',
    'The retained terminal receipt is matched by operation and phase across all retained events, including other pages and times. A missing receipt does not establish whether the operation is still running or was interrupted.',
    'Nothing is joined onto the pool record. The pool name, its URL and its present activation are not read into these rows, so a row cannot be checked against the current configuration from this screen, and a pool deleted since a probe keeps its history.',
    'Retained detail is an allowlist of structural fields. An upstream error message, a response body and a full proxy URL were dropped before the row was written, so they are not recoverable here.',
  ];
}
