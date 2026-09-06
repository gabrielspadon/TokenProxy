import { randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { DATA_FILE } from '../paths.js';
import { readContextAnalytics } from '../analytics/client.js';
import { validateNotificationEvidenceQuery } from '../analytics/notificationRuleQueries.mjs';
import { CONDITIONS, conditionFor } from '../../notifications/conditions.mjs';
import { evaluateRule } from '../../notifications/evaluate.mjs';

// Rules are operator configuration; alerts are evidence about a moment. The
// split matters on edit: changing a rule writes a new revision and leaves every
// alert it already produced pointing at the revision that produced it.
//
// NOTHING HERE ACTS. This module writes rows and reads rows. No function in it
// changes a route, an account, a profile, or any provider-facing state.

export class RuleConflictError extends Error {
  constructor(expected, actual) {
    super('This rule was changed by someone else.');
    this.name = 'RuleConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}
export class RuleValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleValidationError';
  }
}

const MIN_COOLDOWN_SECONDS = 60;
const MAX_SECONDS = 90 * 86_400;

export function validateRuleInput(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) throw new RuleValidationError('A rule needs a name.');
  if (!Object.keys(CONDITIONS).includes(input?.conditionKind)) {
    throw new RuleValidationError('Unsupported condition.');
  }
  const condition = conditionFor(input.conditionKind);
  const scopeKind = input?.scopeKind;
  if (!['global', 'connection', 'provider'].includes(scopeKind)) {
    throw new RuleValidationError('Unsupported scope.');
  }
  const scopeId = scopeKind === 'global' ? null : String(input?.scopeId ?? '').trim();
  if (scopeKind !== 'global' && (!scopeId || scopeId.length > 512)) {
    throw new RuleValidationError('This scope needs a subject.');
  }
  const threshold = Number(input?.threshold);
  const [low, high] = condition.thresholdRange;
  if (!Number.isFinite(threshold) || threshold < low || threshold > high) {
    throw new RuleValidationError(`Threshold must be between ${low} and ${high}.`);
  }
  const durationSeconds = Number(input?.durationSeconds);
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_SECONDS) {
    throw new RuleValidationError('Duration must be a positive number of seconds.');
  }
  const cooldownSeconds = Number(input?.cooldownSeconds);
  if (
    !Number.isInteger(cooldownSeconds) ||
    cooldownSeconds < MIN_COOLDOWN_SECONDS ||
    cooldownSeconds > MAX_SECONDS
  ) {
    throw new RuleValidationError(`Cooldown must be at least ${MIN_COOLDOWN_SECONDS} seconds.`);
  }
  return {
    name,
    conditionKind: input.conditionKind,
    scopeKind,
    scopeId,
    threshold,
    durationSeconds,
    cooldownSeconds,
    enabled: input?.enabled === undefined ? true : Boolean(input.enabled),
  };
}

const toRule = (row) =>
  row && {
    ...row,
    enabled: Boolean(row.enabled),
    condition: CONDITIONS[row.conditionKind] ?? null,
  };

function writeVersion(db, rule, change, at) {
  db.run(
    `INSERT INTO notificationRuleVersions(ruleId, revision, change, definition, changedAt)
     VALUES(?, ?, ?, ?, ?)`,
    [rule.id, rule.revision, change, JSON.stringify(rule), at]
  );
}

export async function listRules() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM notificationRules ORDER BY createdAt DESC, id ASC`).map(toRule);
}

export async function getRule(id) {
  const db = await getAdapter();
  return toRule(db.get(`SELECT * FROM notificationRules WHERE id = ?`, [id]));
}

export async function createRule(input) {
  const clean = validateRuleInput(input);
  const at = new Date().toISOString();
  const rule = { id: randomUUID(), ...clean, revision: 1, createdAt: at, updatedAt: at };
  const db = await getAdapter();
  db.transaction(() => {
    db.run(
      `INSERT INTO notificationRules(id, name, scopeKind, scopeId, conditionKind, threshold,
         durationSeconds, cooldownSeconds, enabled, revision, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rule.id,
        rule.name,
        rule.scopeKind,
        rule.scopeId,
        rule.conditionKind,
        rule.threshold,
        rule.durationSeconds,
        rule.cooldownSeconds,
        rule.enabled ? 1 : 0,
        1,
        at,
        at,
      ]
    );
    writeVersion(db, rule, 'created', at);
  });
  return toRule({ ...rule, enabled: rule.enabled ? 1 : 0 });
}

/**
 * Optimistic concurrency: the caller states the revision it edited. A mismatch
 * raises RuleConflictError carrying the live row, so the surface can show what
 * changed instead of silently overwriting another operator's edit.
 */
export async function updateRule(id, expectedRevision, input) {
  const clean = validateRuleInput(input);
  const at = new Date().toISOString();
  const db = await getAdapter();
  let updated;
  db.transaction(() => {
    const current = db.get(`SELECT * FROM notificationRules WHERE id = ?`, [id]);
    if (!current) throw new RuleValidationError('This rule no longer exists.');
    if (Number(current.revision) !== Number(expectedRevision)) {
      throw new RuleConflictError(Number(expectedRevision), toRule(current));
    }
    const revision = Number(current.revision) + 1;
    db.run(
      `UPDATE notificationRules SET name=?, scopeKind=?, scopeId=?, conditionKind=?, threshold=?,
         durationSeconds=?, cooldownSeconds=?, enabled=?, revision=?, updatedAt=?
       WHERE id=? AND revision=?`,
      [
        clean.name,
        clean.scopeKind,
        clean.scopeId,
        clean.conditionKind,
        clean.threshold,
        clean.durationSeconds,
        clean.cooldownSeconds,
        clean.enabled ? 1 : 0,
        revision,
        at,
        id,
        expectedRevision,
      ]
    );
    updated = { ...current, ...clean, revision, updatedAt: at };
    const change =
      Boolean(current.enabled) !== clean.enabled
        ? clean.enabled
          ? 'enabled'
          : 'disabled'
        : 'updated';
    writeVersion(db, updated, change, at);
  });
  return toRule({ ...updated, enabled: updated.enabled ? 1 : 0 });
}

export async function deleteRule(id, expectedRevision) {
  const at = new Date().toISOString();
  const db = await getAdapter();
  db.transaction(() => {
    const current = db.get(`SELECT * FROM notificationRules WHERE id = ?`, [id]);
    if (!current) throw new RuleValidationError('This rule no longer exists.');
    if (Number(current.revision) !== Number(expectedRevision)) {
      throw new RuleConflictError(Number(expectedRevision), toRule(current));
    }
    // The version log and the alerts this rule produced both survive deletion:
    // an alert is evidence that something happened, and deleting the rule does
    // not make it not have happened.
    writeVersion(db, { ...current, revision: Number(current.revision) + 1 }, 'deleted', at);
    db.run(`DELETE FROM notificationRules WHERE id = ? AND revision = ?`, [id, expectedRevision]);
  });
  return { id, deleted: true };
}

export async function getRuleVersions(ruleId) {
  const db = await getAdapter();
  return db
    .all(
      `SELECT ruleId, revision, change, definition, changedAt FROM notificationRuleVersions
       WHERE ruleId = ? ORDER BY revision DESC`,
      [ruleId]
    )
    .map((row) => ({ ...row, definition: JSON.parse(row.definition) }));
}

// ── Alerts ────────────────────────────────────────────────────────────────

const toEvent = (row) => row && { ...row, evidence: JSON.parse(row.evidence) };

export async function listRuleEvents({ ruleId, outcome, limit = 100 } = {}) {
  const db = await getAdapter();
  const clauses = [];
  const values = [];
  if (ruleId) {
    clauses.push('ruleId = ?');
    values.push(ruleId);
  }
  if (outcome) {
    clauses.push('outcome = ?');
    values.push(outcome);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const capped = Math.min(Number(limit) || 100, 500);
  return db
    .all(`SELECT * FROM notificationRuleEvents ${where} ORDER BY firedAt DESC, id DESC LIMIT ?`, [
      ...values,
      capped,
    ])
    .map(toEvent);
}

/**
 * Record a firing. The partial unique index on (ruleId, scopeKey) WHERE
 * outcome='firing' is what actually prevents a duplicate concurrent alert, so
 * two evaluators racing produce one row and one loser, not two alerts.
 * Returns null when an open alert already holds the slot.
 */
export async function recordFiring(rule, firing, scopeKey) {
  const db = await getAdapter();
  const open = db.get(
    `SELECT id FROM notificationRuleEvents WHERE ruleId = ? AND scopeKey = ? AND outcome = 'firing'`,
    [rule.id, scopeKey]
  );
  if (open) return null;
  const row = {
    id: randomUUID(),
    ruleId: rule.id,
    ruleRevision: rule.revision,
    scopeKey,
    firedAt: firing.firedAt,
    breachStartedAt: firing.breachStartedAt,
    observedValue: firing.observedValue ?? null,
    evidence: JSON.stringify({
      kind: conditionFor(rule.conditionKind).evidenceKind,
      refs: firing.refs ?? [],
    }),
  };
  try {
    db.run(
      `INSERT INTO notificationRuleEvents(id, ruleId, ruleRevision, scopeKey, firedAt,
         breachStartedAt, observedValue, evidence, outcome)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'firing')`,
      [
        row.id,
        row.ruleId,
        row.ruleRevision,
        row.scopeKey,
        row.firedAt,
        row.breachStartedAt,
        row.observedValue,
        row.evidence,
      ]
    );
  } catch {
    // Lost the race against another evaluator; the winner's alert stands.
    return null;
  }
  return toEvent({ ...row, outcome: 'firing', acknowledgedAt: null, snoozedUntil: null });
}

/**
 * Acknowledge is terminal and idempotent-by-refusal: acknowledging an already
 * acknowledged alert is refused rather than silently re-stamped, so the
 * timestamp keeps meaning "when the operator first took this".
 */
export async function acknowledgeEvent(id, { at = new Date().toISOString() } = {}) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM notificationRuleEvents WHERE id = ?`, [id]);
  if (!row) throw new RuleValidationError('This alert no longer exists.');
  if (row.outcome === 'acknowledged') {
    throw new RuleValidationError('This alert was already acknowledged.');
  }
  db.run(
    `UPDATE notificationRuleEvents SET outcome='acknowledged', acknowledgedAt=?
     WHERE id=? AND outcome='firing'`,
    [at, id]
  );
  return toEvent(db.get(`SELECT * FROM notificationRuleEvents WHERE id = ?`, [id]));
}

/**
 * Snooze suppresses REPETITION until a future instant. It deliberately does not
 * resolve the alert: the outcome stays 'firing', so a snoozed problem is still
 * an open problem and still occupies the rule+scope slot.
 */
export async function snoozeEvent(id, until, { now = Date.now() } = {}) {
  const parsed = Date.parse(until);
  if (!Number.isFinite(parsed)) throw new RuleValidationError('Snooze needs a valid instant.');
  if (parsed <= now) throw new RuleValidationError('Snooze must end in the future.');
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM notificationRuleEvents WHERE id = ?`, [id]);
  if (!row) throw new RuleValidationError('This alert no longer exists.');
  if (row.outcome === 'acknowledged') {
    throw new RuleValidationError('An acknowledged alert cannot be snoozed.');
  }
  db.run(`UPDATE notificationRuleEvents SET snoozedUntil=? WHERE id=? AND outcome='firing'`, [
    new Date(parsed).toISOString(),
    id,
  ]);
  return toEvent(db.get(`SELECT * FROM notificationRuleEvents WHERE id = ?`, [id]));
}

// ── Evaluation and dry run ────────────────────────────────────────────────

async function evidenceFor(rule, { start, end, signal }) {
  // Validate HERE, with the worker's own validator, before the query crosses
  // the thread boundary. Inside the worker a malformed range is indistinguish-
  // able from a failed read, so it would surface as "temporarily unavailable"
  // and blame the service for the caller's input.
  const query = validateNotificationEvidenceQuery({
    operation: 'notification-evidence',
    conditionKind: rule.conditionKind,
    scopeKind: rule.scopeKind,
    scopeId: rule.scopeId,
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  });
  const writer = await getAdapter();
  return readContextAnalytics(query, { file: DATA_FILE, driver: writer.driver, signal });
}

// One group's evidence, shaped for whichever evaluator the condition declares.
function firingsForGroup(rule, group, { asOf, lastFiredAt }) {
  if (rule.conditionKind === 'stale_telemetry') {
    const measured = group.samples.filter((sample) => sample.measured !== false);
    const newest = measured.at(-1);
    return evaluateRule(
      rule,
      { lastObservedAt: newest?.at ?? null, lastRef: newest?.ref ?? null },
      { asOf, lastFiredAt }
    );
  }
  const samples =
    rule.conditionKind === 'quota_risk'
      ? group.samples.filter((sample) => sample.measured)
      : group.samples;
  return evaluateRule(rule, samples, { lastFiredAt });
}

/**
 * DRY RUN. Runs the real evaluator over the RETAINED HISTORICAL POPULATION and
 * reports every instant the rule would have fired on, each linked to the record
 * ids that caused it. Nothing is written and nothing is sent. Where the
 * evidence is incomplete or absent, that is reported as such rather than
 * presented as a clean result.
 */
export async function dryRunRule(input, { start, end, signal, asOf } = {}) {
  const rule = { id: 'dry-run', revision: 0, ...validateRuleInput(input) };
  const evidence = await evidenceFor(rule, { start, end, signal });
  const at = asOf || evidence.timeRange.end;
  const groups = evidence.groups.map((group) => {
    const { firings, state } = firingsForGroup(rule, group, { asOf: at, lastFiredAt: null });
    return {
      scopeKey: group.scopeKey,
      connectionId: group.connectionId ?? null,
      provider: group.provider ?? null,
      scope: group.scope ?? null,
      sampleCount: group.samples.length,
      measuredCount: group.samples.filter((sample) => sample.measured !== false).length,
      state,
      firings,
    };
  });
  return {
    rule,
    asOf: at,
    evaluated: true,
    complete: evidence.complete,
    reason: evidence.reason ?? null,
    total: evidence.total,
    limit: evidence.limit,
    timeRange: evidence.timeRange,
    groups,
    firingCount: groups.reduce((sum, group) => sum + group.firings.length, 0),
    // A dry run over an empty population is an honest "no evidence", never a
    // pass. The surface renders these differently.
    evidenceAbsent: evidence.total === 0,
    freshness: evidence.freshness ?? null,
  };
}

/**
 * Live evaluation of every enabled rule. Read-only against the analytics
 * snapshot; the only writes are alert rows. Cooldown carries across runs
 * through the most recent firing already recorded for that rule and scope.
 */
export async function evaluateEnabledRules({ start, end, signal, asOf } = {}) {
  const db = await getAdapter();
  const rules = db
    .all(`SELECT * FROM notificationRules WHERE enabled = 1 ORDER BY createdAt ASC`)
    .map(toRule);
  const produced = [];
  for (const rule of rules) {
    let evidence;
    try {
      evidence = await evidenceFor(rule, { start, end, signal });
    } catch {
      // Evidence unavailable is not a breach. A rule that cannot be evaluated
      // stays silent rather than firing on the absence of its own input.
      continue;
    }
    if (!evidence.complete) continue;
    const at = asOf || evidence.timeRange.end;
    for (const group of evidence.groups) {
      const previous = db.get(
        `SELECT firedAt, snoozedUntil FROM notificationRuleEvents
         WHERE ruleId = ? AND scopeKey = ? ORDER BY firedAt DESC, id DESC LIMIT 1`,
        [rule.id, group.scopeKey]
      );
      const lastFiredAt = previous ? Date.parse(previous.firedAt) : null;
      const { firings } = firingsForGroup(rule, group, {
        asOf: at,
        lastFiredAt: Number.isFinite(lastFiredAt) ? lastFiredAt : null,
      });
      const latest = firings.at(-1);
      if (!latest) continue;
      const snoozedUntil = previous?.snoozedUntil ? Date.parse(previous.snoozedUntil) : null;
      if (Number.isFinite(snoozedUntil) && Date.parse(latest.firedAt) < snoozedUntil) continue;
      const event = await recordFiring(rule, latest, group.scopeKey);
      if (event) produced.push(event);
    }
  }
  return { evaluated: rules.length, fired: produced.length, events: produced };
}
