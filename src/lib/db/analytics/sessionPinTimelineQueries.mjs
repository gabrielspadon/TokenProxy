import { telemetryFilterSql } from './telemetryFilter.mjs';

// Read-only per-pin timeline projection for the bounded analytics worker.
// Requests, account switches and control receipts merge into ONE time-ordered
// stream. Same contract as operationEventsQueries: every supported filter is
// applied before the stable cursor pages it, never after a page is cut.
//
// Each source keeps its own recorded time basis and its own exact identifier.
// Nothing is inferred across sources, and a source that retention no longer
// holds is reported as unavailable rather than rendered as an empty history.
export const PIN_TIMELINE_MAX_PAGE = 100;
export const PIN_TIMELINE_DEFAULT_PAGE = 25;
export const PIN_TIMELINE_MAX_BYTES = 1024 * 1024;
export const PIN_TIMELINE_EPOCH = '1970-01-01T00:00:00.000Z';
export const PIN_TIMELINE_KINDS = ['action', 'request', 'switch'];

// Exactly what a caller may send to the route. The pin is named by its opaque
// id only; the routing hash and physical model are derived from it, never
// accepted from the wire.
export const PIN_TIMELINE_REQUEST_PARAMS = [
  'pinId',
  'kind',
  'connectionId',
  'start',
  'end',
  'pageSize',
  'cursor',
];

export const PIN_TIMELINE_TIME_BASIS = {
  request: 'requestStats.timestamp',
  switch: 'accountSwitches.switchedAt',
  action: 'sessionPinActions.createdAt',
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function encodeTimelineCursor(row) {
  return Buffer.from(JSON.stringify([row.at, row.kind, row.id])).toString('base64url');
}

// Reversible and self-checking, like the pin id: a re-encode must reproduce the
// exact input, so no alternative encoding of the same tuple is accepted.
export function decodeTimelineCursor(raw) {
  let fields;
  try {
    fields = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('Invalid timeline cursor');
  }
  if (
    typeof raw !== 'string' ||
    raw.length > 1024 ||
    !Array.isArray(fields) ||
    fields.length !== 3 ||
    fields.some((value) => typeof value !== 'string') ||
    !PIN_TIMELINE_KINDS.includes(fields[1]) ||
    fields[0].length > 40 ||
    fields[2].length > 256 ||
    encodeTimelineCursor({ at: fields[0], kind: fields[1], id: fields[2] }) !== raw
  )
    throw new TypeError('Invalid timeline cursor');
  return { at: fields[0], kind: fields[1], id: fields[2] };
}

export function parseSessionPinTimelineQuery(params, { now = Date.now() } = {}) {
  const allowed = new Set([
    'sessionHash',
    'model',
    'kind',
    'connectionId',
    'start',
    'end',
    'pageSize',
    'cursor',
  ]);
  const seen = new Set();
  for (const [key] of params) {
    if (!allowed.has(key) || seen.has(key))
      throw new TypeError('Unknown or duplicate pin timeline parameter');
    seen.add(key);
  }
  const sessionHash = params.get('sessionHash');
  if (typeof sessionHash !== 'string' || !/^[a-f0-9]{32,64}$/.test(sessionHash))
    throw new TypeError('Invalid pin timeline identity');
  const model = params.get('model');
  if (typeof model !== 'string' || !model || model.length > 512)
    throw new TypeError('Invalid pin timeline model');

  const raw = params.get('pageSize');
  if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > PIN_TIMELINE_MAX_PAGE))
    throw new TypeError('Invalid pageSize');
  const pageSize = raw === null ? PIN_TIMELINE_DEFAULT_PAGE : Number(raw);

  const bound = (key, fallback) => {
    const value = params.get(key);
    if (value === null) return fallback;
    if (!ISO.test(value) || !Number.isFinite(Date.parse(value)))
      throw new TypeError('Pin timeline bounds require an explicit UTC offset');
    return new Date(value).toISOString();
  };
  // The default range is the whole retained history; the caller narrows it.
  const start = bound('start', PIN_TIMELINE_EPOCH);
  const end = bound('end', new Date(now).toISOString());
  if (start >= end) throw new TypeError('Invalid pin timeline time range');

  const query = { sessionHash, model, start, end, pageSize };
  if (params.has('kind')) {
    const kind = params.get('kind');
    if (!PIN_TIMELINE_KINDS.includes(kind)) throw new TypeError('Invalid kind');
    query.kind = kind;
  }
  if (params.has('connectionId')) {
    const connectionId = params.get('connectionId');
    if (typeof connectionId !== 'string' || !connectionId || connectionId.length > 128)
      throw new TypeError('Invalid connectionId');
    query.connectionId = connectionId;
  }
  if (params.has('cursor')) {
    const cursor = params.get('cursor');
    decodeTimelineCursor(cursor);
    query.cursor = cursor;
  }
  return query;
}

export function validateSessionPinTimelineQuery(input) {
  if (
    input?.operation !== 'session-pin-timeline' ||
    Object.keys(input).some(
      (key) =>
        ![
          'operation',
          'sessionHash',
          'model',
          'start',
          'end',
          'pageSize',
          'kind',
          'connectionId',
          'cursor',
        ].includes(key)
    )
  )
    throw new TypeError('Invalid pin timeline operation');
  const params = new URLSearchParams();
  for (const key of ['sessionHash', 'model', 'start', 'end', 'kind', 'connectionId', 'cursor'])
    if (input[key] !== undefined) params.set(key, String(input[key]));
  if (input.pageSize !== undefined) params.set('pageSize', String(input.pageSize));
  return { operation: 'session-pin-timeline', ...parseSessionPinTimelineQuery(params) };
}

// One projection per source with the same column list, so the merge is a plain
// UNION ALL and the total order is decided by SQLite, not by a JS sort that
// would have to see every row first. "trigger" is quoted: it is a keyword.
const UNION = `
  SELECT r.timestamp AS at, 'request' AS kind, r.id AS id, r.connectionId AS connectionId,
         NULL AS fromConnectionId, r.model AS model, r.requestedModel AS requestedModel,
         r.status AS status, r.logicalRequestId AS logicalRequestId, NULL AS "trigger",
         NULL AS reason, NULL AS action, r.dispatchCoverage AS dispatchCoverage,
         NULL AS appliedAt
    FROM requestStats r WHERE r.contextSessionId = ? AND r.model = ? AND ${telemetryFilterSql('requestStats', 'r')}
  UNION ALL
  SELECT s.switchedAt, 'switch', s.id, s.toConnectionId, s.fromConnectionId, s.model,
         NULL, NULL, NULL, s."trigger", s.reason, NULL, NULL, NULL
    FROM accountSwitches s WHERE s.sessionHash = ? AND s.model = ?
  UNION ALL
  SELECT a.createdAt, 'action', a.id, a.targetConnectionId, NULL, a.model,
         NULL, a.status, NULL, NULL, a.reason, a.action, NULL, a.appliedAt
    FROM sessionPinActions a WHERE a.sessionHash = ? AND a.model = ?`;

function shapeRow(row) {
  const base = { kind: row.kind, id: row.id, at: row.at, model: row.model ?? null };
  if (row.kind === 'request')
    return {
      ...base,
      timeBasis: 'timestamp',
      requestId: row.id,
      logicalRequestId: row.logicalRequestId ?? null,
      connectionId: row.connectionId ?? null,
      requestedModel: row.requestedModel ?? null,
      selectedModel: row.model ?? null,
      // Only a recorded success attests a served model. Everything else stays
      // unknown rather than assuming the selected model was the served one.
      servedModel: row.status === 'success' ? (row.model ?? null) : null,
      status: row.status ?? null,
      dispatchCoverage: row.dispatchCoverage ?? null,
    };
  if (row.kind === 'switch')
    return {
      ...base,
      timeBasis: 'switchedAt',
      switchId: row.id,
      connectionId: row.connectionId ?? null,
      fromConnectionId: row.fromConnectionId ?? null,
      toConnectionId: row.connectionId ?? null,
      trigger: row.trigger ?? null,
      reason: row.reason ?? null,
    };
  return {
    ...base,
    timeBasis: 'createdAt',
    actionId: row.id,
    action: row.action ?? null,
    status: row.status ?? null,
    reason: row.reason ?? null,
    connectionId: row.connectionId ?? null,
    targetConnectionId: row.connectionId ?? null,
    appliedAt: row.appliedAt ?? null,
  };
}

export function readSessionPinTimeline(db, query) {
  const { sessionHash, model, start, end, pageSize, kind, connectionId } = query;
  // Exact join only, the same provenance the pin list requires. A per-request
  // fallback identity is never joined.
  const session = db.get(
    "SELECT id, identitySource FROM contextSessions WHERE sessionHash = ? AND identitySource IN ('explicit','inferred','routing')",
    [sessionHash]
  );
  const unionValues = [session ? session.id : null, model, sessionHash, model, sessionHash, model];

  const clauses = ['at >= ?', 'at < ?'];
  const values = [start, end];
  if (kind !== undefined) {
    clauses.push('kind = ?');
    values.push(kind);
  }
  if (connectionId !== undefined) {
    clauses.push('connectionId = ?');
    values.push(connectionId);
  }
  const total = db.get(`SELECT COUNT(*) AS total FROM (${UNION}) WHERE ${clauses.join(' AND ')}`, [
    ...unionValues,
    ...values,
  ]).total;

  // The cursor is applied LAST, on top of the already filtered set, so paging
  // never widens or narrows the set it walks.
  const pageClauses = [...clauses];
  const pageValues = [...values];
  if (query.cursor !== undefined) {
    const cursor = decodeTimelineCursor(query.cursor);
    pageClauses.push('(at < ? OR (at = ? AND (kind < ? OR (kind = ? AND id < ?))))');
    pageValues.push(cursor.at, cursor.at, cursor.kind, cursor.kind, cursor.id);
  }
  const rows = db.all(
    `SELECT * FROM (${UNION}) WHERE ${pageClauses.join(' AND ')} ORDER BY at DESC, kind DESC, id DESC LIMIT ?`,
    [...unionValues, ...pageValues, pageSize + 1]
  );
  const page = rows.slice(0, pageSize);
  const result = {
    version: 1,
    model,
    items: page.map(shapeRow),
    total,
    pageSize,
    next: rows.length > pageSize ? encodeTimelineCursor(page[page.length - 1]) : null,
    filters: {
      ...(kind !== undefined ? { kind } : {}),
      ...(connectionId !== undefined ? { connectionId } : {}),
    },
    timeRange: { start, end, endExclusive: true },
    timeBasis: PIN_TIMELINE_TIME_BASIS,
    sources: {
      request: session
        ? { available: true, join: 'stored-routing-hash', identitySource: session.identitySource }
        : {
            available: false,
            join: 'stored-routing-hash',
            identitySource: null,
            reason: 'no-retained-session-join',
          },
      switch: { available: true, join: 'stored-routing-hash-and-model', identitySource: null },
      action: { available: true, join: 'stored-routing-hash-and-model', identitySource: null },
    },
    boundaries: {
      pageSizeLimit: PIN_TIMELINE_MAX_PAGE,
      responseByteLimit: PIN_TIMELINE_MAX_BYTES,
      ordering: 'recorded time, then kind, then id, all descending',
      absentHistory: 'unknown',
      servedModel: 'recorded only for a successful request',
    },
    complete: true,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > PIN_TIMELINE_MAX_BYTES)
    return {
      ...result,
      items: [],
      next: null,
      complete: false,
      reason: 'response_limit',
      instruction: 'Reduce the page size before displaying this history.',
    };
  return result;
}
