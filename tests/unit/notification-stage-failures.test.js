import { beforeEach, expect, it } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';
import { readNotificationEvidence, validateNotificationEvidenceQuery } from '@/lib/db/analytics/notificationRuleQueries.mjs';
import { evaluateRule } from '@/lib/notifications/evaluate.mjs';
import { evidenceHref } from '@/shared/workspace/notificationRulesModel.js';

const db = await getAdapter();
const start = '2026-09-08T12:00:00.000Z', end = '2026-09-08T13:00:00.000Z';
beforeEach(() => { db.run('DELETE FROM contextStages'); db.run('DELETE FROM requestStats'); });
function request(id, provider = 'fixture', connectionId = 'account', timestamp = '2026-09-08T12:30:00.000Z') {
  db.run('INSERT INTO requestStats(id,provider,connectionId,timestamp) VALUES(?,?,?,?)', [id, provider, connectionId, timestamp]);
}
function stage(requestId, ordinal, outcome, outcomeSource = 'execution') {
  db.run(`INSERT INTO contextStages(requestId,ordinal,stage,beforeBytes,afterBytes,deltaBytes,outcome,risk,outcomeSource,errorCode)
    VALUES(?,?,'headroom',10,10,0,?,'external-service',?,?)`, [requestId, ordinal, outcome, outcomeSource, outcome === 'failed' ? 'service_timeout' : null]);
}
function evidence(scopeKind = 'global', scopeId = null) {
  return readNotificationEvidence(db, validateNotificationEvidenceQuery({ operation: 'notification-evidence', conditionKind: 'compression_saver_failure', start, end, scopeKind, scopeId }));
}

it('counts exact failed stage identities but excludes cancellation, unchanged bytes and historical inference', () => {
  request('one');
  stage('one', 0, 'failed'); stage('one', 1, 'failed');
  stage('one', 2, 'cancelled'); stage('one', 3, 'unchanged'); stage('one', 4, 'skipped'); stage('one', 5, 'applied');
  stage('one', 6, 'failed', null);
  const result = evidence();
  expect(result.total).toBe(2);
  expect(result.groups[0].samples.map(row => JSON.parse(row.ref))).toEqual([['one', 0, null], ['one', 1, null]]);
  const rule = { conditionKind: 'compression_saver_failure', threshold: 2, durationSeconds: 60, cooldownSeconds: 60 };
  expect(evaluateRule(rule, result.groups[0].samples).firings).toHaveLength(1);
  expect(evaluateRule(rule, result.groups[0].samples).firings[0].observedValue).toBe(2);
});

it('applies provider, account and half-open time bounds before counting records', () => {
  request('one'); stage('one', 0, 'failed');
  request('two', 'other', 'other-account'); stage('two', 0, 'failed');
  request('end', 'fixture', 'account', end); stage('end', 0, 'failed');
  request('before', 'fixture', 'account', '2026-09-08T11:59:59.999Z'); stage('before', 0, 'failed');
  expect(evidence().total).toBe(2);
  expect(evidence('provider', 'fixture').total).toBe(1);
  expect(evidence('connection', 'other-account').groups[0].samples[0].ref).toBe('["two",0,null]');
  expect(evidence('provider', 'missing').groups).toEqual([]);
  expect(evidence().timeRange).toEqual({ field: 'requestStats.timestamp', start, end, endExclusive: true });
});

it('preserves explicitly unattributed failures without inventing an account', () => {
  request('unknown', null, null); stage('unknown', 0, 'failed');
  expect(evidence().groups[0]).toMatchObject({ scopeKey: 'provider:unattributed', provider: null, connectionId: null });
  expect(evidence('connection', 'account').total).toBe(0);
});

it('counts preparation execution once when retry attempts retain the same stage ledger', () => {
  request('origin'); stage('origin', 0, 'failed');
  request('retry'); stage('retry', 0, 'failed');
  db.run("UPDATE contextStages SET executionRequestId='origin'");
  expect(evidence().groups[0].samples.map(row => JSON.parse(row.ref))).toEqual([['origin', 0, null]]);
  request('new-execution'); stage('new-execution', 0, 'failed');
  db.run("UPDATE contextStages SET executionRequestId=requestId WHERE requestId='new-execution'");
  expect(evidence().total).toBe(2);
});

it('links only references carrying an exact retained session identity', () => {
  const href = evidenceHref('contextStage', JSON.stringify(['request-one', 2, 7]));
  expect(JSON.parse(new URL(href, 'http://localhost').searchParams.get('selected'))).toEqual({ kind: 'context-attempt', id: 'request-one', sessionId: 7 });
  expect(evidenceHref('contextStage', JSON.stringify(['request-one', 2, null]))).toBeNull();
  expect(evidenceHref('contextStage', 'malformed')).toBeNull();
});
