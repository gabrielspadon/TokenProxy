import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TABLES, buildCreateTableSql } from '../../src/lib/db/schema.js';
import { createTransactionController } from '../../src/lib/db/adapters/criticalTransaction.js';
import { applyQuarantine, createQuarantineManifest, revertQuarantine } from '../../src/lib/db/repos/telemetryQuarantineRepo.js';
import { readContextOverview, readContextSession } from '../../src/lib/db/analytics/contextQueries.mjs';
import { readContextEvents } from '../../src/lib/db/analytics/contextEvents.mjs';
import { readContextEvidenceExport } from '../../src/lib/db/analytics/contextEvidenceExport.mjs';
import { readContextRelated } from '../../src/lib/db/analytics/contextRelated.mjs';
import { attachCounterfactualEvidence } from '../../src/lib/db/analytics/counterfactualEvidence.mjs';
import { readKeyUsage } from '../../src/lib/db/analytics/keyUsageQueries.mjs';
import { readNotificationEvidence } from '../../src/lib/db/analytics/notificationRuleQueries.mjs';
import { readSessionPinTimeline } from '../../src/lib/db/analytics/sessionPinTimelineQueries.mjs';
import { measureContextStructure } from '../../open-sse/utils/contextStructure.js';

const start = '2026-09-06T00:00:00.000Z', at = '2026-09-06T12:00:00.000Z', end = '2026-09-07T00:00:00.000Z';
const hash = 'a'.repeat(64), evidence = 'Owned synthetic exact-identity quarantine regression fixture';
const origins = [['fixture', 'unknown'], ['test', 'test'], ['production', 'production'], ['imported', 'import'], ['unknown', 'unknown'], ['null', null]];
const retained = ['fixture', 'production', 'imported', 'unknown', 'null'].sort();
const visible = retained.filter(id => id !== 'fixture');
const definition = { scope: {}, context: {}, selection: null, comparisonIds: [] };
let raw, db;

function insert(table, row) {
  if (!Object.hasOwn(TABLES, table) || Object.keys(row).some(key => !Object.hasOwn(TABLES[table].columns, key))) throw new Error('Unknown fixture column');
  const keys = Object.keys(row);
  return db.run(`INSERT INTO ${table}(${keys.map(key => `"${key}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`, Object.values(row));
}
function attempt(id, dataOrigin = 'unknown', patch = {}) {
  insert('requestStats', { id, dataOrigin, timestamp: at, provider: 'fixture-provider', model: 'fixture-model', connectionId: 'account',
    contextSessionId: 1, logicalRequestId: `logical-${id}`, clientKeyId: 'key', attempt: 1, status: 'success', usageSource: 'provider',
    promptTokens: 100, completionTokens: 10, usageInputPresent: 1, usageOutputPresent: 1, latencyTotal: 88600000000, ...patch });
}
function usage(id, requestId, dataOrigin = 'unknown', patch = {}) {
  insert('usageHistory', { id, dataOrigin, timestamp: at, requestId, logicalRequestId: `logical-${requestId}`, contextSessionId: 1,
    provider: 'fixture-provider', model: 'fixture-model', connectionId: 'account', attempt: 1, apiKey: 'synthetic-key',
    promptTokens: 100, completionTokens: 10, cost: 1, projectId: 'project', ...patch });
}
function event(id, requestId, patch = {}) {
  insert('contextClientEvents', { id, clientKeyId: 'key', clientRef: 'synthetic-client', clientEventId: id, occurredAt: at, recordedAt: at, type: 'compaction',
    requestId, logicalRequestId: requestId ? `logical-${requestId}` : null, contextSessionId: requestId ? 1 : null, payloadHash: 'synthetic', ...patch });
}
function quarantine(rows = [{ sourceTable: 'requestStats', rowId: 'fixture' }, { sourceTable: 'usageHistory', rowId: '1' }]) {
  const manifest = createQuarantineManifest(db, { rows, evidence });
  applyQuarantine(db, manifest, { evidence });
  return () => revertQuarantine(db, manifest, { evidence });
}
const ids = items => items.map(row => row.id).sort();
const exported = (patch = {}, mode = 'population', limit = 100) => readContextEvidenceExport(db, { ...definition, ...patch }, mode, limit);
const notification = () => readNotificationEvidence(db, { conditionKind: 'compression_saver_failure', scopeKind: 'global', scopeId: null, start, end });
const timeline = (patch = {}) => readSessionPinTimeline(db, { sessionHash: hash, model: 'fixture-model', start, end, pageSize: 100, ...patch });
const sourceRows = () => ['requestStats', 'usageHistory'].map(table => db.all(`SELECT * FROM ${table} ORDER BY id`));

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for (const [name, table] of Object.entries(TABLES)) {
    // Imported schemas can retain nullable origins; the display predicate must
    // preserve those rows alongside the canonical non-null origin population.
    const imported = ['requestStats', 'usageHistory'].includes(name) ? { ...table, columns: { ...table.columns, dataOrigin: "TEXT DEFAULT 'unknown'" } } : table;
    raw.exec(buildCreateTableSql(name, imported));
  }
  const controller = createTransactionController({ exec: sql => raw.exec(sql), readSynchronous: () => raw.prepare('PRAGMA synchronous').get().synchronous, isInTransaction: () => raw.isTransaction });
  db = {
    get: (sql, args = []) => raw.prepare(sql).get(...args), all: (sql, args = []) => raw.prepare(sql).all(...args),
    run: (sql, args = []) => raw.prepare(sql).run(...args), criticalTransaction: controller.criticalTransaction,
    transaction: fn => controller.transaction(() => { raw.exec('BEGIN'); try { const value = fn(); raw.exec('COMMIT'); return value; } catch (error) { raw.exec('ROLLBACK'); throw error; } }),
  };
  insert('contextSessions', { id: 1, sessionHash: hash, identitySource: 'explicit', firstSeenAt: at, lastSeenAt: at, projectLabel: 'Same fixture name' });
  insert('apiKeys', { id: 'key', key: 'synthetic-key', createdAt: at });
  insert('apiKeys', { id: 'unused', key: 'unused-synthetic-key', createdAt: at });
  origins.forEach(([id, origin], index) => {
    attempt(id, origin); usage(index + 1, id, origin); event(`event-${id}`, id);
    insert('contextStages', { requestId: id, ordinal: 0, stage: 'headroom', beforeBytes: 100, afterBytes: 90, deltaBytes: -10,
      outcome: 'failed', outcomeSource: 'execution', risk: 'external-service', executionRequestId: id, errorCode: 'service_timeout', durationMs: 4.5, durationSource: 'monotonic' });
    const structure = measureContextStructure({ messages: [{ role: 'user', content: 'Synthetic fixture only' }] }, 'client-received', Buffer.alloc(32, 1));
    insert('contextStructures', { requestId: id, boundary: 'client-received', version: 1, data: JSON.stringify(structure) });
  });
  event('unlinked', null);
  event('wrong-owner', 'production', { clientKeyId: 'another-key' });
  insert('sessionAffinity', { sessionHash: hash, model: 'fixture-model', connectionId: 'account', pinnedAt: at, lastSeenAt: at });
  insert('accountSwitches', { id: 'switch', sessionHash: hash, model: 'fixture-model', fromConnectionId: 'old', toConnectionId: 'account', trigger: 'exhaustion', reason: 'quota', switchedAt: at });
  insert('sessionPinActions', { id: 'action', version: 1, sessionHash: hash, model: 'fixture-model', action: 'clear', expectedRevision: 'r', expectedBinding: '{}',
    status: 'applied', beforeState: '{}', preview: '{}', createdAt: at, previewExpiresAt: end, appliedAt: at });
});
afterEach(() => raw.close());

it('filters context summaries, dimensions, stages, projects and both attributed and unattributed coverage before paging', () => {
  attempt('unattributed', 'unknown', { contextSessionId: null });
  attempt('hidden-unattributed', 'test', { contextSessionId: null });
  const baseline = readContextOverview(db);
  const before = sourceRows(), revert = quarantine();
  const result = readContextOverview(db, { pageSize: 1 });
  expect(result.summary).toMatchObject({ attempts: 4, requests: 4, sessions: 1, providerInputTokens: 400 });
  expect(result.recording).toMatchObject({ totalRetainedAttempts: 5, attributedAttempts: 4, unattributedAttempts: 1 });
  expect(result.sessions).toMatchObject([{ attempts: 4, providerInputTokens: 400 }]);
  expect(result.stages).toMatchObject([{ samples: 4, savedBytes: 40 }]);
  expect(result.dimensions).toMatchObject([{ attempts: 4 }]);
  expect(result.projects).toMatchObject([{ attempts: 4 }]);
  expect(readContextOverview(db, { view: 'summary' }).summary).toEqual(result.summary);
  expect(readContextOverview(db, { view: 'projects', pageSize: 1 }).projects).toMatchObject([{ attempts: 4 }]);
  const intervals = readContextOverview(db, { view: 'interval-comparison', from: start, until: end, baselineFrom: start, baselineUntil: end });
  expect(intervals.selected.summary.attempts).toBe(4);
  expect(intervals.baseline.summary.attempts).toBe(4);
  expect(sourceRows()).toEqual(before);
  revert();
  expect(readContextOverview(db)).toEqual(baseline);
  expect(sourceRows()).toEqual(before);
});

it('uses visible usage identities for project attribution without multiplying requests or accepting wrong links', () => {
  usage(20, 'production');
  usage(21, 'unknown', 'unknown', { projectId: 'other', logicalRequestId: 'wrong-logical' });
  usage(22, 'unknown', 'test', { projectId: 'other' });
  const baseline = readContextOverview(db, { projectId: 'project' }).summary;
  const revert = quarantine([{ sourceTable: 'usageHistory', rowId: '3' }]);
  expect(readContextOverview(db, { projectId: 'project' }).summary).toEqual(baseline);
  const revertSecond = quarantine([{ sourceTable: 'usageHistory', rowId: '20' }]);
  expect(readContextOverview(db, { projectId: 'project' }).summary.attempts).toBe(4);
  expect(readContextOverview(db, { projectId: 'other' }).summary.attempts).toBe(0);
  expect(readContextOverview(db).summary.attempts).toBe(5);
  revertSecond(); revert();
  expect(readContextOverview(db, { projectId: 'project' }).summary).toEqual(baseline);
});

it('keeps session totals, paged turns, trends and independent routing history consistent', () => {
  const baseline = readContextSession(db, 1), revert = quarantine();
  const first = readContextSession(db, 1, { pageSize: 2 });
  const second = readContextSession(db, 1, { pageSize: 2, page: 2 });
  expect(ids([...first.turns, ...second.turns])).toEqual(visible);
  expect(first.pagination).toMatchObject({ totalItems: 4, totalPages: 2, hasNext: true });
  expect(first.summary.attempts).toBe(4);
  expect(first.trend.points.reduce((total, point) => total + point.attempts, 0)).toBe(4);
  expect(first.pins).toEqual(baseline.pins);
  expect(first.switches).toEqual(baseline.switches);
  expect(readContextSession(db, 1, { view: 'routing' }).items.map(row => row.id)).toEqual(['switch']);
  revert();
  expect(readContextSession(db, 1)).toEqual(baseline);
});

it('excludes hidden owned events without turning them into unlinked reports', () => {
  const baseline = readContextEvents(db), revert = quarantine();
  const first = readContextEvents(db, { pageSize: 3 }), second = readContextEvents(db, { pageSize: 3, page: 2 });
  expect(ids([...first.events, ...second.events])).toEqual([...visible.map(id => `event-${id}`), 'unlinked'].sort());
  expect(first.pagination.totalItems).toBe(5);
  expect(readContextEvents(db, { requestId: 'fixture' }).events).toEqual([]);
  expect(readContextEvents(db, { provider: 'fixture-provider' }).pagination.totalItems).toBe(4);
  revert();
  expect(readContextEvents(db)).toEqual(baseline);
});

it('filters export ceilings, selections and related evidence while preserving measured stage durations', () => {
  const baseline = exported(), revert = quarantine();
  const result = exported({}, 'population', 4);
  expect(ids(result.items)).toEqual(visible);
  expect(result).toMatchObject({ totalRecords: 4, coverage: { attributedAttempts: 4, relatedClientEvents: 4, attemptsWithStructure: 4, attemptsWithLinkedCost: 4 } });
  for (const item of result.items) expect(item.stages[0]).toMatchObject({ durationMs: 4.5, durationSource: 'monotonic' });
  expect(exported({ selection: { kind: 'context-attempt', id: 'fixture', sessionId: 1 } }, 'selected').items).toEqual([]);
  const compared = exported({ selection: { id: 'fixture', sessionId: 1 }, context: { baseline: { id: 'unknown', sessionId: 1 } } }, 'attempt-comparison');
  expect(compared.missingAttempts).toEqual([{ role: 'selected', id: 'fixture', sessionId: 1 }]);
  expect(ids(compared.items)).toEqual(['unknown']);
  expect(exported({ comparisonIds: ['account', 'missing'] }, 'comparison').coverage.accountsWithoutMatchingAttempts).toEqual(['missing']);
  expect(exported({}, 'population', 3)).toMatchObject({ exceeded: true, totalRecords: 4 });
  revert();
  expect(exported()).toEqual(baseline);
});

it('filters both sides of cost joins and rejects hidden structures even for explicitly supplied IDs', () => {
  usage(20, 'production', 'test');
  usage(21, 'production', 'unknown', { logicalRequestId: 'different' });
  usage(22, 'production');
  const baseline = readContextRelated(db, ['production', 'fixture']);
  const revert = quarantine([{ sourceTable: 'requestStats', rowId: 'fixture' }, { sourceTable: 'usageHistory', rowId: '22' }]);
  const related = readContextRelated(db, ['production', 'fixture', 'test']);
  expect([...related.structures.keys()]).toEqual(['production']);
  expect([...related.costs.keys()]).toEqual(['production']);
  expect(related.costs.get('production').map(row => row.ledgerId)).toEqual([3]);
  expect(related.rejectedStructures).toBe(0);
  revert();
  expect(readContextRelated(db, ['production', 'fixture'])).toEqual(baseline);
});

it('masks hidden request joins while retaining handoff metadata, historical references and cardinality', () => {
  const handoff = (id, sourceRequestId, targetRequestId, requestId = 'production') => {
    insert('shapingHandoffs', { id, sourceRequestId, targetRequestId, projectId: 'project', targetClientKeyId: 'key', targetClientRef: 'client',
      targetProjectRef: 'project', targetClientSessionRef: 'session', contentHash: 'synthetic', createdAt: at, expiresAt: end });
    insert('contextHandoffApplications', { handoffId: id, requestId, executionRequestId: requestId, logicalRequestId: `logical-${requestId}`, appliedAt: at });
  };
  handoff('linked', 'fixture', 'test');
  handoff('historical', 'not-retained-source', 'not-retained-target');
  handoff('hidden-application', 'production', 'production', 'fixture');
  const baseline = readContextRelated(db, ['production', 'fixture']), revert = quarantine();
  const result = readContextRelated(db, ['production', 'fixture']);
  expect([...result.handoffs.keys()]).toEqual(['production']);
  expect(result.handoffs.get('production')).toHaveLength(2);
  expect(result.handoffs.get('production').find(row => row.handoffId === 'linked')).toMatchObject({ sourceRequestId: null, targetRequestId: null,
    sourceSessionId: null, targetSessionId: null, projectId: 'project', contentHash: 'synthetic' });
  expect(result.handoffs.get('production').find(row => row.handoffId === 'historical')).toMatchObject({ sourceRequestId: 'not-retained-source', targetRequestId: 'not-retained-target', sourceSessionId: null, targetSessionId: null });
  revert();
  expect(readContextRelated(db, ['production', 'fixture'])).toEqual(baseline);
});

it('keeps keys with no visible usage and excludes only the exact source table identity', () => {
  attempt('1');
  const baseline = readKeyUsage(db), revert = quarantine([{ sourceTable: 'requestStats', rowId: '1' }]);
  expect(readKeyUsage(db)).toEqual(baseline);
  const revertUsage = quarantine([{ sourceTable: 'usageHistory', rowId: '1' }]);
  expect(readKeyUsage(db).totals.key).toMatchObject({ requests: 4, promptTokens: 400, completionTokens: 40, costUsd: 4 });
  expect(readKeyUsage(db).totals.unused).toMatchObject({ requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
  revertUsage(); revert();
  expect(readKeyUsage(db)).toEqual(baseline);
  db.run("UPDATE usageHistory SET dataOrigin='test'");
  expect(readKeyUsage(db).totals.key).toMatchObject({ requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
});

it('excludes hidden stage notifications and request timeline entries while retaining switch and action receipts', () => {
  const baselineNotification = notification(), baselineTimeline = timeline(), revert = quarantine();
  expect(notification().total).toBe(4);
  expect(notification().groups.flatMap(group => group.samples.map(sample => JSON.parse(sample.ref)[0])).sort()).toEqual(visible);
  const first = timeline({ pageSize: 3 }), second = timeline({ pageSize: 3, cursor: first.next });
  expect(first.total).toBe(6);
  expect(ids([...first.items, ...second.items])).toEqual([...visible, 'switch', 'action'].sort());
  expect(timeline({ kind: 'request' }).total).toBe(4);
  expect(timeline({ kind: 'switch' }).total).toBe(1);
  revert();
  expect(notification()).toEqual(baselineNotification);
  expect(timeline()).toEqual(baselineTimeline);
});

it('does not promote an ambiguous raw completion binding when its duplicate is quarantined', () => {
  const completionId = '11111111-1111-4111-8111-111111111111';
  const row = { completionId, provider: 'fixture-provider', model: 'fixture-model', usageSource: 'provider', requestLink: 'linked',
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
  insert('costLedger', { id: 'counterfactual', completionId, ts: at, provider: row.provider, model: row.model, baselineUsd: 2, actualUsd: 1, savedUsd: 1,
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
  db.run('UPDATE usageHistory SET completionId=? WHERE id=1', [completionId]);
  const read = () => { const selected = { ...row }; attachCounterfactualEvidence(db, [selected]); return selected.counterfactual; };
  expect(read()).toMatchObject({ available: true });
  const revert = quarantine([{ sourceTable: 'usageHistory', rowId: '1' }]);
  expect(read()).toMatchObject({ available: false, state: 'not-retained' });
  revert();
  expect(read()).toMatchObject({ available: true });
  usage(20, 'production', 'unknown', { completionId });
  expect(read()).toMatchObject({ available: false, state: 'ambiguous-completion' });
  const revertDuplicate = quarantine([{ sourceTable: 'usageHistory', rowId: '20' }]);
  expect(read()).toMatchObject({ available: false, state: 'ambiguous-completion' });
  revertDuplicate();
  db.run("UPDATE usageHistory SET dataOrigin='test' WHERE id=20");
  expect(read()).toMatchObject({ available: false, state: 'ambiguous-completion' });
});
