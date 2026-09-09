import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getAdapter } from '@/lib/db/driver.js';
import { createApiKey, updateApiKey } from '@/lib/db/repos/apiKeysRepo.js';
import { prepareContextCapture } from '@/lib/db/repos/contextEvidenceRepo.js';
import { createProject, updateProject, bindProject, unbindProject, getProject, listProjects, listProjectCandidates, listProjectVersions, listProjectAlerts } from '@/lib/db/repos/projectsRepo.js';
import { reserveBudget, markBudgetDispatched, releaseBudgetReservation, getBudgetStatus } from '@/lib/db/repos/budgetRepo.js';
import { saveRequestUsage, reconcileBudgetUsage } from '@/lib/db/repos/usageRepo.js';
import { readActivityAnalytics } from '@/lib/db/analytics/activityQueries.mjs';
import { projectSpendingForecast } from '@/lib/db/projectBudgetEvidence.js';
const db = await getAdapter();
const fields = { provider: 'fixture', model: 'model', connectionId: 'account' };
beforeEach(() => {
  for (const table of ['projectBindings','projectPolicyVersions','projectBudgetAlerts','projectBudgetUsageHours','projectBudgetAccounts','projects','apiKeyBudgetReservations','apiKeyBudgetAccounts','usageHistory','requestStats','apiKeys']) db.run(`DELETE FROM ${table}`);
});
async function client(name = 'one', limits = {}) {
  const created = await createApiKey(name, 'isolated');
  const key = await updateApiKey(created.id, { ...limits, budgetPolicy: 'strict' });
  const capture = await prepareContextCapture({ body: {}, apiKey: key.key, headers: new Headers({ 'x-tokenproxy-client-id': name, 'x-tokenproxy-project-id': 'private-project', 'x-tokenproxy-task-id': 'private-task' }) });
  const context = { requestId: randomUUID(), logicalRequestId: randomUUID(), attempt: 1, explicitIdentity: capture.identity, apiKeyId: key.id };
  await saveRequestUsage({ ...fields, apiKey: key.key, contextTelemetry: context, tokens: { prompt_tokens: 1, completion_tokens: 1, cost_usd: 0.01 } });
  return { key, identity: capture.identity, context };
}
async function projectFor(clients, policy = {}) {
  let data = await createProject({ name: 'Research', maxCompletionTokens: 100, ...policy });
  for (const c of clients) data = await bindProject(data.project.id, { expectedRevision: data.project.revision, apiKeyId: c.key.id, clientRef: c.identity.clientRef, projectRef: c.identity.projectRef });
  return data;
}
const admission = (c, bounds = { completionTokens: 30 }, extra = {}) => reserveBudget({ apiKey: c.key.key, requestId: randomUUID(), logicalRequestId: randomUUID(), explicitIdentity: c.identity, bounds, ...extra });
const usage = (c, r, tokens, extra = {}) => saveRequestUsage({ ...fields, apiKey: c.key.key, requestId: r.requestId, logicalRequestId: r.logicalRequestId, tokens, ...extra });

describe('exact project attribution and joint budget authority', () => {
  it('requires an explicitly observed binding and never assigns earlier usage retrospectively', async () => {
    const c = await client(), p = await projectFor([c]);
    expect(db.get('SELECT projectId FROM usageHistory').projectId).toBeNull();
    expect(p.account.recordedCompletionTokens).toBe(0);
    const other = await createProject({ name: 'Other' });
    await expect(bindProject(other.project.id, { expectedRevision: 1, apiKeyId: c.key.id, clientRef: c.identity.clientRef, projectRef: `ctx1_${'f'.repeat(64)}` })).rejects.toMatchObject({ code: 'project_identity_unobserved' });
    expect(JSON.stringify(p)).not.toContain(c.key.key);
    expect(JSON.stringify(p)).not.toContain('private-project');
  });
  it('refuses omitted, mismatched, and cross-key metadata on an explicitly bound key', async () => {
    const c = await client(), other = await client('two'); await projectFor([c]);
    await expect(admission(c, {}, { explicitIdentity: undefined })).rejects.toMatchObject({ code: 'project-identity-required' });
    await expect(admission(c, {}, { explicitIdentity: { ...c.identity, projectRef: `ctx1_${'f'.repeat(64)}` } })).rejects.toMatchObject({ code: 'project-identity-unbound' });
    await expect(admission(c, {}, { explicitIdentity: other.identity })).rejects.toMatchObject({ code: 'project-identity-required' });
    expect(db.get('SELECT COUNT(*) AS n FROM apiKeyBudgetReservations').n).toBe(0);
    expect(await admission(other, {})).toBeNull();
  });
  it('shares one project ceiling across concurrent keys without leaking rejected key reservations', async () => {
    const a = await client('a', { maxCompletionTokens: 1000 }), b = await client('b', { maxCompletionTokens: 1000 });
    const p = await projectFor([a, b]);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => admission(i % 2 ? a : b)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'project_budget_exceeded')).toBe(true);
    expect((await getProject(p.project.id)).outstanding.completionTokens).toBe(90);
    expect(db.get('SELECT COUNT(*) AS n FROM apiKeyBudgetReservations').n).toBe(3);
    const held = await Promise.all([a, b].map(c => getBudgetStatus(c.key.id)));
    expect(held.reduce((sum, row) => sum + row.outstanding.completionTokens, 0)).toBe(90);
  });
  it('retains strict unknown-bound refusal and explicit best-effort single outstanding exposure', async () => {
    const c = await client(); let p = await projectFor([c], { maxCompletionTokens: null, maxCostUsd: 10 });
    await expect(admission(c, {})).rejects.toMatchObject({ code: 'budget-bound-unavailable' });
    p = await updateProject(p.project.id, { expectedRevision: p.project.revision, budgetPolicy: 'reserve-remaining' });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => admission(c, {})));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await getProject(p.project.id)).outstanding.costUsd).toBe(10);
    expect(p.project.budgetExplanation).toContain('may exceed');
  });
  it('settles and reconciles one shared reservation, hourly counters, and immutable alert receipts exactly once', async () => {
    const c = await client('one', { maxCompletionTokens: 200 }), p = await projectFor([c], { alertPercent: 30 });
    const r = await admission(c, { completionTokens: 100 }); await markBudgetDispatched(r.requestId);
    await usage(c, r, { prompt_tokens: 4, completion_tokens: 20, cost_usd: 1 }, { usageFinality: 'partial' });
    expect((await getProject(p.project.id)).outstanding.completionTokens).toBe(80);
    const evidence = { kind: 'provider-usage', reference: 'fixture-receipt', tokens: { prompt_tokens: 4, completion_tokens: 40, cost_usd: 2 } };
    await reconcileBudgetUsage(c.key.id, r.requestId, evidence); await reconcileBudgetUsage(c.key.id, r.requestId, evidence);
    const after = await getProject(p.project.id);
    expect(after.account).toMatchObject({ recordedCompletionTokens: 40, recordedCostUsd: 2 });
    expect(after.outstanding.completionTokens).toBe(0);
    expect((await getBudgetStatus(c.key.id)).account.recordedCompletionTokens).toBe(41);
    expect(db.get('SELECT * FROM projectBudgetUsageHours')).toMatchObject({ records: 1, completionTokens: 40, costUsd: 2, knownCostRecords: 1 });
    expect((await listProjectAlerts(p.project.id)).items).toHaveLength(1);
    expect((await listProjectAlerts(p.project.id)).items[0]).toMatchObject({ policyRevision: p.project.revision, evidence: { providerChargeConfirmed: false, contributingRecords: { projectId: p.project.id } } });
    expect(db.get('SELECT COUNT(*) AS n FROM usageHistory WHERE projectId=?', [p.project.id]).n).toBe(1);
  });
  it('archives only subsequent dispatches and preserves in-flight attribution after explicit unbinding', async () => {
    const c = await client(); let p = await projectFor([c]); const r = await admission(c); await markBudgetDispatched(r.requestId);
    const revision = p.project.revision;
    p = await updateProject(p.project.id, { expectedRevision: revision, archived: true });
    await expect(admission(c)).rejects.toMatchObject({ code: 'project-unavailable' });
    await unbindProject(p.project.id, p.bindings[0].id, { expectedRevision: p.project.revision });
    expect(await admission(c)).toBeNull();
    await usage(c, r, { prompt_tokens: 4, completion_tokens: 10 });
    expect(db.get('SELECT projectId,projectPolicyRevision FROM usageHistory WHERE requestId=?', [r.requestId])).toEqual({ projectId: p.project.id, projectPolicyRevision: revision });
  });
  it('releases key and project exposure only on confirmed nonacceptance', async () => {
    const c = await client(), p = await projectFor([c]); const r = await admission(c, { completionTokens: 100 }); await markBudgetDispatched(r.requestId);
    await expect(releaseBudgetReservation(c.key.id, r.requestId, { kind: 'proven-no-dispatch', reference: 'fixture-timeout' })).rejects.toThrow();
    await releaseBudgetReservation(c.key.id, r.requestId, { kind: 'provider-nonacceptance', reference: 'fixture-rejection' });
    expect((await getProject(p.project.id)).outstanding.requests).toBe(0);
    expect(await admission(c, { completionTokens: 100 })).toBeTruthy();
  });
  it('retains authenticated task and project references after request retention expires, including pagination', async () => {
    const c = await client(); const p = await projectFor([c]);
    for (let i = 0; i < 3; i++) { const r = await admission(c, { completionTokens: 10 }); await markBudgetDispatched(r.requestId); await usage(c, r, { prompt_tokens: 4, completion_tokens: 5, cost_usd: 1 }); }
    db.run('DELETE FROM requestStats');
    const result = readActivityAnalytics(db, { operation: 'activity', view: 'economics', projectRef: c.identity.projectRef, taskRef: c.identity.taskRef, pageSize: 1 });
    expect(result.summary.records).toBe(4);
    expect(result.items[0]).toMatchObject({ projectRef: c.identity.projectRef, taskRef: c.identity.taskRef, requestLink: 'unavailable' });
    expect(db.get('SELECT COUNT(*) AS n FROM usageHistory WHERE projectId=?', [p.project.id]).n).toBe(3);
    expect((await listProjectCandidates(c.key.id)).items).toHaveLength(1);
  });
  it('alert-only project policy observes without blocking while key enforcement remains active', async () => {
    const c = await client('one', { maxCompletionTokens: 100 }), p = await projectFor([c], { maxCompletionTokens: 1, budgetMode: 'alert', alertPercent: 50 });
    const r = await admission(c, { completionTokens: 90 }); await markBudgetDispatched(r.requestId);
    await usage(c, r, { prompt_tokens: 0, completion_tokens: 80 });
    expect((await listProjectAlerts(p.project.id)).items).toHaveLength(1);
    await expect(admission(c, { completionTokens: 30 })).rejects.toMatchObject({ code: 'api_key_budget_exceeded' });
  });
  it('rejects stale policy writes and paginates immutable policy versions and projects', async () => {
    let p = await createProject({ name: 'Original' });
    p = await updateProject(p.project.id, { expectedRevision: 1, name: 'Changed' });
    await expect(updateProject(p.project.id, { expectedRevision: 1, name: 'Overwrite' })).rejects.toMatchObject({ status: 409 });
    const versions = await listProjectVersions(p.project.id, { limit: 1 });
    expect(versions.items[0].document.project.name).toBe('Changed');
    expect((await listProjectVersions(p.project.id, { limit: 1, before: versions.nextCursor })).items[0].document.project.name).toBe('Original');
    await createProject({ name: 'Second' }); const first = await listProjects({ limit: 1 });
    expect((await listProjects({ limit: 1, before: first.nextCursor })).items[0].id).not.toBe(first.items[0].id);
  });
  it('bounds the complete project binding snapshot independently of the per-key limit', async () => {
    const c = await client(); const p = await createProject({ name: 'Full project' });
    for (let i = 0; i < 100; i++) db.run('INSERT INTO projectBindings(id,projectId,apiKeyId,clientRef,projectRef,createdAt) VALUES(?,?,?,?,?,?)', [randomUUID(), p.project.id, `fixture-${i}`, c.identity.clientRef, c.identity.projectRef, new Date().toISOString()]);
    await expect(bindProject(p.project.id, { expectedRevision: 1, apiKeyId: c.key.id, clientRef: c.identity.clientRef, projectRef: c.identity.projectRef })).rejects.toMatchObject({ status: 409 });
    expect((await getProject(p.project.id)).bindings).toHaveLength(100);
  });
  it('paginates the full observed identity population without duplicates or key mixing', async () => {
    const c = await client();
    for (let i = 0; i < 4; i++) db.run('INSERT INTO usageHistory(timestamp,clientKeyId,clientIdentitySource,clientRef,projectRef) VALUES(?,?,?,?,?)', [new Date().toISOString(), c.key.id, 'client-reported', c.identity.clientRef, `ctx1_${String(i).repeat(64)}`]);
    const seen = new Set(); let before = null;
    do { const page = await listProjectCandidates(c.key.id, { limit: 2, before }); for (const row of page.items) { expect(row.apiKeyId).toBe(c.key.id); expect(seen.has(row.projectRef)).toBe(false); seen.add(row.projectRef); } before = page.nextCursor; } while (before);
    expect(seen.size).toBe(5);
  });
  it('projects delivery preparation status without exposing subscribed endpoint identities or hashes', async () => {
    const p = await createProject({ name: 'Notification scope' });
    const at = new Date().toISOString();
    db.run('INSERT INTO projectBudgetAlerts(id,projectId,policyRevision,firedAt,evidence,notificationTargets,notificationQueuedAt,notificationAttempts) VALUES(?,?,?,?,?,?,?,?)', [randomUUID(),p.project.id,1,at,'{"dimensions":[]}',JSON.stringify([{id:'private-endpoint',destinationHash:'a'.repeat(64)}]),at,1]);
    const result = await listProjectAlerts(p.project.id);
    expect(result.items[0]).toMatchObject({notificationStatus:'delivery-prepared',notificationAttempts:1});
    expect(JSON.stringify(result)).not.toContain('private-endpoint'); expect(JSON.stringify(result)).not.toContain('destinationHash'); expect(result.items[0]).not.toHaveProperty('notificationTargets');
  });
});

describe('recorded project spending projection', () => {
  const end = Date.parse('2026-09-08T12:00:00Z');
  const account = { initializedAt: '2026-09-08T08:01:00Z', recordedCostUsd: 6 };
  const hours = ['09','10','11'].map(hour => ({ hour: `2026-09-08T${hour}:00:00.000Z`, records: 2, knownCostRecords: 2, costUsd: 2 }));
  it('uses complete-hour ledger coverage with explicit assumptions and no provider charge guarantee', () => {
    expect(projectSpendingForecast({ maxCostUsd: 10 }, account, hours, end)).toMatchObject({ available: true, completeHours: 3, meanUsdPerHour: 2, forecast24HoursUsd: 48, hoursToRecordedCostLimit: 2, providerChargeConfirmed: false });
  });
  it('refuses sparse or incomplete cost evidence rather than making missing usage free', () => {
    expect(projectSpendingForecast({}, account, hours.slice(0, 1), end).reason).toBe('insufficient-complete-hour-evidence');
    expect(projectSpendingForecast({}, account, hours.map(row => ({ ...row, knownCostRecords: 1 })), end).reason).toBe('incomplete-cost-coverage');
  });
  it('does not infer an exhaustion horizon from an incomplete lifetime cost balance', () => {
    expect(projectSpendingForecast({ maxCostUsd: 10 }, { ...account, unknownCostRows: 1 }, hours, end)).toMatchObject({
      available: true, forecast24HoursUsd: 48, hoursToRecordedCostLimit: null,
      recordedCostLimitHorizonReason: 'lifetime-cost-coverage-incomplete',
    });
  });
  it('does not present a reversed observation interval for a newly created project', () => {
    for (const initializedAt of ['2026-09-08T12:00:00Z', '2026-09-08T12:15:00Z', '2026-09-09T12:00:00Z']) {
      expect(projectSpendingForecast({}, { initializedAt }, hours, end + 30 * 60000)).toMatchObject({
        available: false, completeHours: 0, records: 0,
        timeRange: { start: null, end: '2026-09-08T12:00:00.000Z' },
        reason: 'insufficient-complete-hour-evidence',
      });
    }
  });
});
