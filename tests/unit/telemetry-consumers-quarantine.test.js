import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getAdapter } from '../../src/lib/db/driver.js';
import { REQUEST_TERMINAL_COLUMNS } from '../../src/lib/db/terminalEvidence.js';
import { telemetryFilterSql } from '../../src/lib/db/analytics/telemetryFilter.mjs';
import { createQuarantineManifest, applyQuarantine, revertQuarantine } from '../../src/lib/db/repos/telemetryQuarantineRepo.js';
import { saveRequestStats, getStatsItems, getStatsSummary, getStatsFilters, getTrafficWindow } from '../../src/lib/db/repos/requestStatsRepo.js';
import { getUsageStats, getUsageStatsInRange, getUsageHistory, getChartData, getRecentLogs, getSpendWindow, getActiveRequests, trackActiveSession, getActiveSessions, saveRequestUsage, getDailyConnectionUsage } from '../../src/lib/db/repos/usageRepo.js';
import { getApiKeyUsage, getApiKeyUsageTotals } from '../../src/lib/db/repos/apiKeysRepo.js';
import { getKeyAttribution } from '../../src/lib/db/repos/keyAttributionRepo.js';
import { listProjectCandidates } from '../../src/lib/db/repos/projectsRepo.js';
import { handoffTargets, createShapingHandoff, pendingShapingHandoffs, listShapingHandoffs } from '../../src/lib/db/repos/shapingHandoffsRepo.js';
import { listSessionPins } from '../../src/lib/db/repos/sessionPinsRepo.js';
import { createRule } from '../../src/lib/db/repos/notificationRulesRepo.js';
import { saveActionPolicy, enqueueAuthorizedAction, executeAction } from '../../src/lib/notifications/remediation.mjs';

let db, rows, receipt, keyId, key, projectId, at, sessionId;
const proof = 'Reviewed exact fixture identities retained for quarantine regression';
const ref = value => `ctx1_${value.repeat(64)}`;
const insert = (table, values) => db.run(`INSERT INTO ${table}(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map(() => '?').join(',')})`, Object.values(values));

beforeAll(async () => {
  db = await getAdapter();
  const columns = db.all('PRAGMA table_info(requestStats)').map(row => row.name);
  expect(columns).toEqual(expect.arrayContaining([...Object.keys(REQUEST_TERMINAL_COLUMNS), 'sourceUsageId']));
});

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('TOKENPROXY_TELEMETRY_ORIGIN', '');
  for (const table of ['telemetryQuarantineRows', 'telemetryQuarantineReceipts', 'contextHandoffApplications', 'shapingHandoffs',
    'sessionAffinity', 'contextStages', 'requestStats', 'usageHistory', 'usageDaily', 'contextSessions', 'projectBindings', 'projects', 'apiKeys']) db.run(`DELETE FROM ${table}`);
  global._activeSessions.clear();
  at = new Date(Date.now() - 1000).toISOString(); keyId = randomUUID(); key = randomUUID(); projectId = randomUUID();
  insert('apiKeys', { id: keyId, key, name: 'Fixture key', isActive: 1, createdAt: at });
  insert('projects', { id: projectId, name: 'Fixture project', revision: 1, createdAt: at, updatedAt: at });
  insert('contextSessions', { sessionHash: 'b'.repeat(64), identitySource: 'explicit', firstSeenAt: at, lastSeenAt: at });
  sessionId = db.get('SELECT id FROM contextSessions').id;
  insert('sessionAffinity', { sessionHash: 'b'.repeat(64), model: 'fixture-model', connectionId: 'fixture-connection', pinnedAt: at, lastSeenAt: at });
  rows = ['unknown', 'unknown', 'production', 'import', 'test'].map((origin, index) => {
    const requestId = randomUUID(), provider = `provider-${index}`;
    const identity = { clientKeyId: keyId, clientRef: ref(String(index + 1)), projectRef: ref('a'), clientSessionRef: ref(String(index + 1)), clientIdentitySource: 'client-reported' };
    const usage = insert('usageHistory', { timestamp: at, provider, model: 'fixture-model', connectionId: 'fixture-connection', apiKey: key,
      requestId, dataOrigin: origin, promptTokens: 10, completionTokens: 5, cost: 1, status: 'ok', tokens: '{"prompt_tokens":10,"completion_tokens":5}', ...identity });
    insert('requestStats', { id: requestId, timestamp: at, provider, model: 'fixture-model', connectionId: 'fixture-connection',
      dataOrigin: origin, status: 'success', promptTokens: 10, completionTokens: 5, latencyTotal: 100, contextSessionId: sessionId, clientTool: provider, ...identity });
    insert('projectBindings', { id: randomUUID(), projectId, apiKeyId: keyId, clientRef: identity.clientRef, projectRef: identity.projectRef, createdAt: at });
    return { requestId, usageId: String(usage.lastInsertRowid), provider, identity };
  });
  // Deliberately stale inclusive aggregate, never a source for visible totals.
  const day = new Date(at); const dateKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  insert('usageDaily', { dateKey, data: JSON.stringify({ requests: 99, promptTokens: 9999, completionTokens: 9999, cost: 9999 }) });
  receipt = createQuarantineManifest(db, { evidence: proof, rows: [
    { sourceTable: 'requestStats', rowId: rows[0].requestId }, { sourceTable: 'usageHistory', rowId: rows[0].usageId },
  ] });
});
afterEach(() => vi.unstubAllEnvs());

async function visibleSnapshot() {
  const [summary, items, filters, traffic, history, logs, spend, recent, attribution, candidates, targets, pins] = await Promise.all([
    getStatsSummary(), getStatsItems(), getStatsFilters(), getTrafficWindow('2000-01-01T00:00:00.000Z'), getUsageHistory(), getRecentLogs(),
    getSpendWindow('2000-01-01T00:00:00.000Z'), getActiveRequests(), getKeyAttribution(), listProjectCandidates(keyId), handoffTargets(), listSessionPins(),
  ]);
  return { summary, items, filters, traffic, history, logs, spend, recent, attribution, candidates, targets, pins };
}

it('excludes exact active receipt rows across linked views and immediately restores them after revert', async () => {
  const before = await visibleSnapshot();
  expect(before.summary.totalRequests).toBe(4);
  expect(before.history).toHaveLength(4);
  applyQuarantine(db, receipt, { evidence: proof });
  const during = await visibleSnapshot();
  expect(during.summary.totalRequests).toBe(3);
  expect(during.traffic.requests).toBe(3);
  expect(during.history.map(row => row.provider).sort()).toEqual(['provider-1', 'provider-2', 'provider-3']);
  expect(during.logs).toHaveLength(3);
  expect(during.spend).toMatchObject({ spendUsd: 3, samples: 3 });
  expect(during.recent.recentRequests).toHaveLength(3);
  expect(during.attribution[keyId].requests).toBe(3);
  expect(during.candidates.items).toHaveLength(3);
  expect(during.targets.pagination.total).toBe(3);
  expect(during.pins.pins[0].requests).toHaveLength(3);
  expect(JSON.stringify(during.items)).not.toContain(rows[0].requestId);
  expect(JSON.stringify(during.filters)).not.toContain('provider-0');
  revertQuarantine(db, receipt, { evidence: proof });
  const after = await visibleSnapshot();
  expect(after.summary.totalRequests).toBe(4);
  expect(after.history).toEqual(before.history);
  expect(after.recent.recentRequests).toEqual(before.recent.recentRequests);
  expect(db.get('SELECT COUNT(*) AS n FROM requestStats').n).toBe(5);
  expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(5);
});

it.each(['today', '24h', '7d', '30d', '60d', 'all'])('reconstructs %s totals and charts from the visible population, ignoring stale daily data', async period => {
  applyQuarantine(db, receipt, { evidence: proof });
  const stats = await getUsageStats(period), chart = await getChartData(period);
  expect(stats).toMatchObject({ totalRequests: 3, totalPromptTokens: 30, totalCompletionTokens: 15, totalCost: 3 });
  expect(stats.recentRequests).toHaveLength(3);
  expect(stats.last10Minutes.reduce((sum, row) => sum + row.requests, 0)).toBe(3);
  expect(chart.reduce((sum, row) => sum + row.tokens, 0)).toBe(45);
  expect(chart.reduce((sum, row) => sum + row.cost, 0)).toBe(3);
  revertQuarantine(db, receipt, { evidence: proof });
  expect((await getUsageStats(period)).totalRequests).toBe(4);
});

it('applies the same explicit date range and traverses bounded history batches without missing rows', async () => {
  const day = new Date(at), date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  db.transaction(() => { for (let index = 0; index < 513; index++) insert('usageHistory', { timestamp: at, provider: 'batch', model: 'fixture-model', promptTokens: 1, completionTokens: 0, cost: 0, tokens: '{"prompt_tokens":1}', dataOrigin: 'unknown' }); });
  applyQuarantine(db, receipt, { evidence: proof });
  const range = { startDate: date, endDate: date };
  expect(await getUsageStatsInRange('all', range)).toMatchObject({ totalRequests: 516, totalPromptTokens: 543, period: 'range', range });
  expect((await getChartData('all', range)).reduce((sum, row) => sum + row.tokens, 0)).toBe(558);
});

it('retains inclusive budget/quota accounting and preserves writes under an active receipt', async () => {
  const before = await getApiKeyUsage(key);
  applyQuarantine(db, receipt, { evidence: proof });
  expect(await getApiKeyUsage(key)).toEqual(before);
  expect((await getApiKeyUsageTotals())[key]).toEqual(before);
  expect((await getDailyConnectionUsage('fixture-connection')).requests).toBe(5);
  await saveRequestUsage({ requestId: rows[0].requestId, provider: rows[0].provider, model: 'fixture-model', tokens: { prompt_tokens: 99, completion_tokens: 1 } });
  expect(db.get('SELECT promptTokens FROM usageHistory WHERE id=?', [rows[0].usageId]).promptTokens).toBe(10);
  const id = randomUUID();
  await saveRequestUsage({ requestId: id, provider: 'new-provider', model: 'fixture-model', tokens: { prompt_tokens: 2, completion_tokens: 1 }, dataOrigin: 'test' });
  expect(db.get('SELECT dataOrigin FROM usageHistory WHERE requestId=?', [id]).dataOrigin).toBe('production');
  expect((await getUsageHistory()).some(row => row.provider === 'new-provider')).toBe(true);
});

it('assigns process origin at both writers and preserves existing imported origin during upsert', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  const id = randomUUID();
  await saveRequestStats({ id, provider: 'origin', model: 'fixture-model', dataOrigin: 'production', contextTelemetry: { dataOrigin: 'production' } });
  await saveRequestUsage({ requestId: id, provider: 'origin', model: 'fixture-model', tokens: { prompt_tokens: 2, completion_tokens: 1 }, dataOrigin: 'production' });
  expect(db.get('SELECT dataOrigin FROM requestStats WHERE id=?', [id]).dataOrigin).toBe('test');
  expect(db.get('SELECT dataOrigin FROM usageHistory WHERE requestId=?', [id]).dataOrigin).toBe('test');
  await saveRequestStats({ id: rows[3].requestId, status: 'success', tokens: { prompt_tokens: 99 } });
  expect(db.get('SELECT dataOrigin FROM requestStats WHERE id=?', [rows[3].requestId]).dataOrigin).toBe('import');
  expect((await getUsageHistory()).some(row => row.provider === 'origin')).toBe(false);
});

it.each([['test', 'test'], ['unrecognized', 'unknown']])('uses server-owned origin override %s for built fixture processes', async (override, expected) => {
  vi.stubEnv('TOKENPROXY_TELEMETRY_ORIGIN', override);
  const id = randomUUID();
  await saveRequestStats({ id, provider: 'origin', model: 'fixture-model', dataOrigin: 'production' });
  await saveRequestUsage({ requestId: id, provider: 'origin', model: 'fixture-model', tokens: { prompt_tokens: 2, completion_tokens: 1 }, dataOrigin: 'production' });
  expect(db.get('SELECT dataOrigin FROM requestStats WHERE id=?', [id]).dataOrigin).toBe(expected);
  expect(db.get('SELECT dataOrigin FROM usageHistory WHERE requestId=?', [id]).dataOrigin).toBe(expected);
});

it('rechecks exact completed usage IDs instead of retaining a stale active-session completion', async () => {
  const active = trackActiveSession({ provider: 'session-provider', model: 'fixture-model' });
  const id = randomUUID();
  await saveRequestUsage({ requestId: id, provider: 'session-provider', model: 'fixture-model', tokens: { prompt_tokens: 2, completion_tokens: 1 } });
  const usageId = String(db.get('SELECT id FROM usageHistory WHERE requestId=?', [id]).id);
  const completion = createQuarantineManifest(db, { evidence: proof, rows: [{ sourceTable: 'usageHistory', rowId: usageId }] });
  expect((await getActiveSessions()).some(row => row.requestId === active)).toBe(true);
  applyQuarantine(db, completion, { evidence: proof });
  expect((await getActiveSessions()).some(row => row.requestId === active)).toBe(false);
  revertQuarantine(db, completion, { evidence: proof });
  expect((await getActiveSessions()).some(row => row.requestId === active)).toBe(true);
});

it('keeps approved handoff receipts and execution while excluding quarantined telemetry preparations and new targets', async () => {
  const result = await createShapingHandoff({ sourceRequestId: rows[0].requestId, targetRequestId: rows[1].requestId,
    summary: 'Approved retained summary', expiresAt: new Date(Date.now() + 3600000).toISOString(), acknowledgeContent: true });
  insert('contextHandoffApplications', { handoffId: result.packet.id, requestId: rows[0].requestId, executionRequestId: rows[0].requestId, logicalRequestId: rows[0].requestId, appliedAt: at });
  expect((await listShapingHandoffs()).rows[0].preparations).toBe(1);
  applyQuarantine(db, receipt, { evidence: proof });
  expect((await listShapingHandoffs()).rows[0]).toMatchObject({ state: 'active', preparations: 0 });
  expect(await pendingShapingHandoffs(rows[1].identity)).toEqual([{ id: result.packet.id, summary: 'Approved retained summary' }]);
  await expect(createShapingHandoff({ sourceRequestId: rows[0].requestId, targetRequestId: rows[2].requestId,
    summary: 'Cannot use quarantined evidence', expiresAt: new Date(Date.now() + 3600000).toISOString(), acknowledgeContent: true })).rejects.toMatchObject({ code: 'handoff_explicit_project_session_required' });
});

it('revalidates retained transformation evidence before an authorized remediation action', async () => {
  db.run("INSERT INTO providerConnections(id,provider,authType,isActive,data,createdAt,updatedAt) VALUES('fixture-connection','fixture','apikey',1,'{}',?,?) ON CONFLICT(id) DO NOTHING", [at, at]);
  insert('contextStages', { requestId: rows[0].requestId, ordinal: 0, stage: 'headroom', beforeBytes: 10, afterBytes: 10,
    deltaBytes: 0, outcome: 'failed', risk: 'unchanged', outcomeSource: 'execution', executionRequestId: rows[0].requestId });
  const now = Date.now();
  const rule = await createRule({ name: 'Retained shaping failure', conditionKind: 'compression_saver_failure', scopeKind: 'connection',
    scopeId: 'fixture-connection', threshold: 1, durationSeconds: 60, cooldownSeconds: 60 });
  saveActionPolicy(db, { ruleId: rule.id, ruleRevision: rule.revision, expectedRevision: 0, enabled: true,
    action: 'drain-account', cooldownSeconds: 60, dailyLimit: 3, maxEvidenceAgeSeconds: 600 }, now - 2000);
  const event = { id: randomUUID(), ruleId: rule.id, ruleRevision: rule.revision, scopeKey: 'fixture-connection', firedAt: at,
    breachStartedAt: at, observedValue: 1, outcome: 'firing', evidence: JSON.stringify({ kind: 'contextStage', refs: [JSON.stringify([rows[0].requestId, 0])] }) };
  insert('notificationRuleEvents', event);
  const action = db.transaction(() => enqueueAuthorizedAction(db, event, now));
  const preview = () => executeAction(db, action.id, { now: now + 1, dryRun: true });
  expect(preview()).toMatchObject({ eligible: true });
  applyQuarantine(db, receipt, { evidence: proof });
  expect(preview()).toMatchObject({ eligible: false, reasonCode: 'evidence_unavailable' });
  revertQuarantine(db, receipt, { evidence: proof });
  expect(preview()).toMatchObject({ eligible: true });
});

it('follows explicit backfill provenance and retains unproven bh-name lookalikes', async () => {
  db.run('DELETE FROM requestStats');
  const source = rows[0].usageId;
  insert('requestStats', { id: `derived-${source}`, timestamp: at, sourceUsageId: Number(source), dataOrigin: 'unknown' });
  insert('requestStats', { id: `bh-${source}`, timestamp: at, dataOrigin: 'unknown' });
  const onlyUsage = createQuarantineManifest(db, { evidence: proof, rows: [{ sourceTable: 'usageHistory', rowId: source }] });
  applyQuarantine(db, onlyUsage, { evidence: proof });
  const visible = () => db.all(`SELECT id FROM requestStats WHERE ${telemetryFilterSql('requestStats')}`).map(row => row.id);
  expect(visible()).toContain(`bh-${source}`);
  expect(db.all(`SELECT id FROM requestStats WHERE sourceUsageId=? AND ${telemetryFilterSql('requestStats')}`, [source])).toEqual([]);
  revertQuarantine(db, onlyUsage, { evidence: proof });
  expect(db.all(`SELECT id FROM requestStats WHERE sourceUsageId=? AND ${telemetryFilterSql('requestStats')}`, [source])).toHaveLength(1);
});
