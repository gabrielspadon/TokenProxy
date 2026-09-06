import { getAdapter } from '../driver.js';
import { DATA_FILE } from '../paths.js';
import { readContextAnalytics } from '../analytics/client.js';
import { parseOperationEventsQuery } from '../analytics/operationEventsQueries.mjs';

// Structural evidence only. Anything outside this allowlist — credentials,
// full proxy URLs, response bodies, arbitrary exception text — is dropped
// before the row is written, not redacted after.
const DETAIL_KEYS = new Set([
  'status',
  'statusText',
  'elapsedMs',
  'timedOut',
  'cancelled',
  'kind',
  'reason',
  'targetHost',
  'poolType',
  'conflict',
]);
const DETAIL_MAX_STRING = 128;

export function sanitizeOperationDetails(input) {
  const out = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (!DETAIL_KEYS.has(key)) continue;
      if (typeof value === 'boolean') out[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      else if (
        typeof value === 'string' &&
        value.length <= DETAIL_MAX_STRING &&
        !value.includes('://')
      )
        out[key] = value;
    }
  }
  return JSON.stringify(out);
}

function insertEvent(db, event) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO operationEvents(operationId, phase, state, source, actorClass,
       subjectKind, subjectId, provider, connectionId, requestId, logicalRequestId,
       occurredAt, capturedAt, code, details)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.operationId,
      event.phase,
      event.state,
      event.source,
      event.actorClass,
      event.subjectKind,
      event.subjectId,
      event.provider ?? null,
      event.connectionId ?? null,
      event.requestId ?? null,
      event.logicalRequestId ?? null,
      event.occurredAt ?? now,
      now,
      event.code ?? null,
      sanitizeOperationDetails(event.details),
    ]
  );
}

// Retained BEFORE the probe runs. If the process dies between this row and the
// terminal one, the operation reads as unresolved — never as a success, and
// never as permission to resend the check.
export async function recordOperationStarted(event) {
  const db = await getAdapter();
  insertEvent(db, { ...event, state: 'started' });
}

// The terminal receipt and its effect commit or roll back together. `decide`
// runs inside the transaction against fresh state and returns
// { state, code?, details?, effect? }; when `effect` is present it is applied
// in the same transaction as the event row.
export async function recordOperationTerminal(eventBase, decide) {
  const db = await getAdapter();
  let outcome;
  db.transaction(() => {
    outcome = typeof decide === 'function' ? decide(db) : decide;
    insertEvent(db, { ...eventBase, ...outcome, effect: undefined });
    outcome.effect?.(db);
  });
  return outcome;
}

export async function getOperationEvents(params, { signal, now } = {}) {
  const query = parseOperationEventsQuery(params, { now });
  const writer = await getAdapter();
  return readContextAnalytics(
    { operation: 'operation-events', ...query },
    { file: DATA_FILE, driver: writer.driver, signal }
  );
}
