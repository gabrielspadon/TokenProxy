// Read-only evidence projections for notification rule evaluation, run inside
// the bounded analytics worker. Same contract as operationEventsQueries: named
// operations only, every filter applied before any pagination or limit, and a
// hard row ceiling so one rule over a long retained history cannot pull an
// unbounded population into memory.

import { CONDITIONS, UNAVAILABLE_CONDITIONS } from '../../notifications/conditions.mjs';

const DAY = 86_400_000;
export const NOTIFICATION_EVIDENCE_MAX_ROWS = 20_000;
export const NOTIFICATION_DEFAULT_DAYS = 30;

const KINDS = Object.keys(CONDITIONS);
const ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function bound(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (!ISO.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new TypeError('Notification evidence bounds require an explicit UTC offset');
  }
  return new Date(raw).toISOString();
}

export function validateNotificationEvidenceQuery(input) {
  const allowed = ['operation', 'conditionKind', 'scopeKind', 'scopeId', 'start', 'end'];
  if (
    input?.operation !== 'notification-evidence' ||
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    !KINDS.includes(input.conditionKind) ||
    !['global', 'connection', 'provider'].includes(input.scopeKind) ||
    (input.scopeKind === 'global'
      ? input.scopeId != null
      : typeof input.scopeId !== 'string' || !input.scopeId.trim() || input.scopeId.length > 512)
  ) {
    throw new TypeError('Invalid notification evidence operation');
  }
  const now = Date.now();
  const start = bound(input.start, new Date(now - NOTIFICATION_DEFAULT_DAYS * DAY).toISOString());
  const end = bound(input.end, new Date(now).toISOString());
  if (start >= end) throw new TypeError('Invalid notification evidence time range');
  return {
    operation: 'notification-evidence',
    conditionKind: input.conditionKind,
    scopeKind: input.scopeKind,
    scopeId: input.scopeKind === 'global' ? null : input.scopeId,
    start,
    end,
  };
}

// Scope restriction is expressed as SQL in each projection below, so it is
// applied by the database before rows are counted or cut, never by filtering a
// page that has already been read.
function quotaEvidence(db, query) {
  const clauses = ['capturedAt >= ?', 'capturedAt < ?'];
  const values = [query.start, query.end];
  if (query.scopeKind === 'connection') {
    clauses.push('connectionId = ?');
    values.push(query.scopeId);
  } else if (query.scopeKind === 'provider') {
    clauses.push('provider = ?');
    values.push(query.scopeId);
  }
  const where = clauses.join(' AND ');
  const total = db.get(
    `SELECT COUNT(*) AS total FROM quotaObservations WHERE ${where}`,
    values
  ).total;
  if (total > NOTIFICATION_EVIDENCE_MAX_ROWS) {
    return { total, complete: false, reason: 'observation_limit', groups: [] };
  }
  const rows = db.all(
    `SELECT id, connectionId, provider, scope, remaining, "limit", percentage,
       observedAt, capturedAt, confidence, unit, observationKind
     FROM quotaObservations WHERE ${where}
     ORDER BY connectionId ASC, scope ASC, observedAt ASC, capturedAt ASC, id ASC
     LIMIT ?`,
    [...values, NOTIFICATION_EVIDENCE_MAX_ROWS]
  );
  const groups = new Map();
  for (const row of rows) {
    // Only a directly observed balance can support a headroom claim.
    if (row.observationKind !== 'observed') continue;
    const key = `${row.connectionId}::${row.scope}`;
    if (!groups.has(key)) {
      groups.set(key, {
        scopeKey: key,
        connectionId: row.connectionId,
        provider: row.provider,
        scope: row.scope,
        unit: row.unit,
        samples: [],
      });
    }
    // Percentage when the provider reports one, else derived from remaining
    // over limit. An unknown denominator yields no value rather than a guess.
    const percentage =
      typeof row.percentage === 'number' && Number.isFinite(row.percentage)
        ? row.percentage
        : Number.isFinite(row.remaining) && Number.isFinite(row.limit) && row.limit > 0
          ? (row.remaining / row.limit) * 100
          : null;
    groups.get(key).samples.push({
      at: row.observedAt || row.capturedAt,
      value: percentage,
      ref: row.id,
      confidence: row.confidence,
      measured: percentage !== null,
    });
  }
  return { total, complete: true, groups: [...groups.values()] };
}

function switchEvidence(db, query) {
  const excluded = CONDITIONS.repeated_fallback.excludedTriggers;
  const clauses = [
    'switchedAt >= ?',
    'switchedAt < ?',
    `trigger NOT IN (${excluded.map(() => '?').join(', ')})`,
    'fromConnectionId IS NOT NULL',
  ];
  const values = [query.start, query.end, ...excluded];
  if (query.scopeKind === 'connection') {
    clauses.push('fromConnectionId = ?');
    values.push(query.scopeId);
  } else if (query.scopeKind === 'provider') {
    // accountSwitches carries no provider column; a provider-scoped rule
    // resolves through the connection registry, which this read-only worker
    // does join because providerConnections lives in the same database.
    clauses.push(
      'fromConnectionId IN (SELECT id FROM providerConnections WHERE provider = ?)'
    );
    values.push(query.scopeId);
  }
  const where = clauses.join(' AND ');
  const total = db.get(`SELECT COUNT(*) AS total FROM accountSwitches WHERE ${where}`, values).total;
  if (total > NOTIFICATION_EVIDENCE_MAX_ROWS) {
    return { total, complete: false, reason: 'switch_limit', groups: [] };
  }
  const rows = db.all(
    `SELECT id, fromConnectionId, toConnectionId, model, trigger, switchedAt
     FROM accountSwitches WHERE ${where}
     ORDER BY fromConnectionId ASC, switchedAt ASC, id ASC LIMIT ?`,
    [...values, NOTIFICATION_EVIDENCE_MAX_ROWS]
  );
  const groups = new Map();
  for (const row of rows) {
    const key = row.fromConnectionId;
    if (!groups.has(key)) {
      groups.set(key, { scopeKey: key, connectionId: key, samples: [] });
    }
    groups.get(key).samples.push({ at: row.switchedAt, ref: row.id, trigger: row.trigger });
  }
  return { total, complete: true, groups: [...groups.values()] };
}

function operationEvidence(db, query) {
  const states = CONDITIONS.operation_failure.countedStates;
  const clauses = [
    'capturedAt >= ?',
    'capturedAt < ?',
    `state IN (${states.map(() => '?').join(', ')})`,
  ];
  const values = [query.start, query.end, ...states];
  if (query.scopeKind === 'connection') {
    clauses.push('connectionId = ?');
    values.push(query.scopeId);
  } else if (query.scopeKind === 'provider') {
    clauses.push('provider = ?');
    values.push(query.scopeId);
  }
  const where = clauses.join(' AND ');
  const total = db.get(`SELECT COUNT(*) AS total FROM operationEvents WHERE ${where}`, values).total;
  if (total > NOTIFICATION_EVIDENCE_MAX_ROWS) {
    return { total, complete: false, reason: 'event_limit', groups: [] };
  }
  const rows = db.all(
    `SELECT id, operationId, phase, state, provider, connectionId, code, capturedAt, occurredAt
     FROM operationEvents WHERE ${where}
     ORDER BY connectionId ASC, capturedAt ASC, id ASC LIMIT ?`,
    [...values, NOTIFICATION_EVIDENCE_MAX_ROWS]
  );
  const groups = new Map();
  for (const row of rows) {
    // A failure with no connection attribution still matters, and is grouped
    // under an explicit key rather than dropped.
    const key = row.connectionId || `provider:${row.provider || 'unattributed'}`;
    if (!groups.has(key)) {
      groups.set(key, { scopeKey: key, connectionId: row.connectionId, provider: row.provider, samples: [] });
    }
    groups.get(key).samples.push({
      at: row.occurredAt || row.capturedAt,
      ref: String(row.id),
      phase: row.phase,
      code: row.code,
    });
  }
  return { total, complete: true, groups: [...groups.values()] };
}

export function readNotificationEvidence(db, query) {
  const result =
    query.conditionKind === 'repeated_fallback'
      ? switchEvidence(db, query)
      : query.conditionKind === 'operation_failure'
        ? operationEvidence(db, query)
        : quotaEvidence(db, query);
  return {
    ...result,
    conditionKind: query.conditionKind,
    scopeKind: query.scopeKind,
    scopeId: query.scopeId,
    limit: NOTIFICATION_EVIDENCE_MAX_ROWS,
    unavailableConditions: UNAVAILABLE_CONDITIONS,
    timeRange: {
      field: query.conditionKind === 'repeated_fallback' ? 'switchedAt' : 'capturedAt',
      start: query.start,
      end: query.end,
      endExclusive: true,
    },
  };
}
