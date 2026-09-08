import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';
import { readNotificationEvidence, validateNotificationEvidenceQuery } from '@/lib/db/analytics/notificationRuleQueries.mjs';
import { createRule, recordFiring, listRuleEvents } from '@/lib/db/repos/notificationRulesRepo.js';
import { evaluateRule } from '@/lib/notifications/evaluate.mjs';
import { evidenceHref } from '@/shared/workspace/notificationRulesModel.js';

const db = await getAdapter();
const start = '2026-09-08T12:00:00.000Z', end = '2026-09-08T13:00:00.000Z';
const fixtureId = randomUUID();
const rule = { name: 'Controlled compatibility regression', conditionKind: 'compatibility_regression', scopeKind: 'global',
  scopeId: null, threshold: 1, durationSeconds: 60, cooldownSeconds: 60 };
beforeEach(() => {
  db.run('DELETE FROM compatibilityRuns');
  db.run('DELETE FROM compatibilityFixtures');
  db.run('INSERT INTO compatibilityFixtures(id,revision,ownerScope,name,definition,contentHash,createdAt) VALUES(?,1,?,?,?,?,?)',
    [fixtureId, 'installation-operator', 'Explicit test fixture', '{}', 'a'.repeat(64), start]);
});
function run({ id = randomUUID(), at = '2026-09-08T12:30:00.000Z', status = 'failed', ownerScope = 'installation-operator',
  scope = 'controlled-executor', fixtureHash = 'a'.repeat(64), result, ...overrides } = {}) {
  const payload = result === undefined ? { implementationHash: 'b'.repeat(64), sourceFormat: 'openai', targetFormat: 'openai',
    operation: 'request', provider: 'controlled-provider', model: 'fixture-model', scenario: 'text', fixtureVersion: 'fixture-v1',
    checks: [{ id: 'response-shape', outcome: status === 'succeeded' ? 'passed' : 'failed' }], ...overrides } : result;
  db.run(`INSERT INTO compatibilityRuns(id,ownerScope,fixtureId,fixtureRevision,fixtureHash,scope,status,
    implementationVersion,processOwner,result,createdAt,startedAt,finishedAt) VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?)`,
  [id, ownerScope, fixtureId, fixtureHash, scope, status, 'fixture-implementation', 'fixture-process', typeof payload === 'string' ? payload : JSON.stringify(payload), at, at, at]);
  return id;
}
function evidence(scopeKind = 'global', scopeId = null) {
  return readNotificationEvidence(db, validateNotificationEvidenceQuery({ operation: 'notification-evidence',
    conditionKind: 'compatibility_regression', start, end, scopeKind, scopeId }));
}

it('compares the exact prior run outside the window and retains inspectable identities', async () => {
  const previous = run({ at: '2026-09-08T11:59:00.000Z', status: 'succeeded' });
  const current = run();
  const data = evidence();
  expect(data).toMatchObject({ total: 1, complete: true, comparedRuns: 2, timeRange: { field: 'compatibilityRuns.finishedAt', start, end, endExclusive: true } });
  const sample = data.groups[0].samples[0];
  expect(JSON.parse(sample.ref)).toEqual([previous, current, 'response-shape']);
  const storedRule = await createRule(rule);
  const firing = evaluateRule(storedRule, data.groups[0].samples).firings[0];
  const event = await recordFiring(storedRule, firing, data.groups[0].scopeKey);
  expect((await listRuleEvents({ ruleId: storedRule.id }))[0].evidence).toEqual({ kind: 'compatibilityComparison', refs: [sample.ref] });
  const link = new URL(evidenceHref(event.evidence.kind, sample.ref), 'http://localhost');
  expect(link.pathname).toBe('/dashboard/compatibility');
  expect(Object.fromEntries(link.searchParams)).toEqual({ runId: current, compareRunId: previous, checkId: 'response-shape' });
});

it('filters ownership, provider and half-open bounds before comparisons', () => {
  run({ status: 'succeeded', at: start });
  run({ provider: 'other-provider', status: 'succeeded', at: start });
  run({ provider: 'other-provider' });
  run({ ownerScope: 'another-operator', at: '2026-09-08T12:15:00.000Z' });
  run({ at: end });
  expect(evidence('provider', 'controlled-provider').total).toBe(0);
  expect(evidence('provider', 'other-provider').total).toBe(1);
  expect(evidence().total).toBe(1);
  expect(evidence('provider', 'absent').groups).toEqual([]);
});

it('does not infer a regression from incomplete, unknown, changed or malformed evidence', () => {
  run({ status: 'succeeded', at: start });
  for (const status of ['cancelled', 'timed-out', 'interrupted', 'running', 'queued']) run({ status });
  run({ result: '{broken-json' });
  run({ result: [] });
  run({ fixtureHash: 'c'.repeat(64) });
  run({ scope: 'controlled-gateway-routing' });
  run({ implementationHash: null });
  run({ result: { implementationHash: 'b'.repeat(64), sourceFormat: 'openai', targetFormat: 'openai', operation: 'request',
    provider: 'controlled-provider', model: 'fixture-model', scenario: 'text', fixtureVersion: 'fixture-v1', scope: 'local-translation',
    checks: [{ id: 'response-shape', outcome: 'failed' }] } });
  run({ checks: [{ id: 'response-shape', outcome: 'unknown' }] });
  expect(evidence().total).toBe(0);
});

it('counts a passed-to-failed transition only once while repeated failures remain failed', () => {
  run({ status: 'succeeded', at: start });
  run({ at: '2026-09-08T12:10:00.000Z', checks: [{ id: 'response-shape', outcome: 'failed' }, { id: 'new-check', outcome: 'failed' }] });
  run({ at: '2026-09-08T12:20:00.000Z' });
  expect(evidence().total).toBe(1);
});

it('bounds compared metadata without copying retained request and response bodies', () => {
  run({ status: 'succeeded', at: start, output: 'sensitive-output'.repeat(20_000), request: 'sensitive-input' });
  run({ output: 'sensitive-output'.repeat(20_000), request: 'sensitive-input' });
  const data = evidence();
  expect(data.total).toBe(1);
  expect(JSON.stringify(data)).not.toContain('sensitive-');
});

it('refuses account scope because controlled fixtures carry no account identity', async () => {
  expect(() => evidence('connection', 'account')).toThrow(/Invalid notification/);
  await expect(createRule({ ...rule, scopeKind: 'connection', scopeId: 'account' })).rejects.toThrow(/scope/i);
  expect(evidenceHref('compatibilityComparison', 'malformed')).toBeNull();
  expect(evidenceHref('compatibilityComparison', JSON.stringify(['missing', randomUUID(), 'shape']))).toBeNull();
});

it('reports bounded evidence as incomplete rather than silently dropping regressions', () => {
  const limited = { get: () => ({ n: 20_001 }), all: () => { throw new Error('Over-limit history must not load'); } };
  const query = validateNotificationEvidenceQuery({ operation: 'notification-evidence', conditionKind: 'compatibility_regression', start, end, scopeKind: 'global' });
  expect(readNotificationEvidence(limited, query)).toMatchObject({ complete: false, reason: 'comparison_limit', groups: [] });
  let calls = 0;
  const bytesLimited = { get: () => ++calls === 1 ? { n: 100 } : { bytes: 8 * 1024 * 1024 + 1 }, all: limited.all };
  expect(readNotificationEvidence(bytesLimited, query)).toMatchObject({ complete: false, reason: 'comparison_byte_limit', groups: [] });
});
