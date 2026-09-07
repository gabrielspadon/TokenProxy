import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { TABLES, buildCreateTableSql } from '../../src/lib/db/schema.js';
import { GET, POST } from '../../src/app/api/admin/shaping/[[...path]]/route.js';
import { consentRequired } from '../../src/lib/shaping/profile.js';
import { evaluateSettings, STAGE_ORDER } from '../../src/lib/shaping/evaluate.mjs';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqlJsAdapter } from '../../src/lib/db/adapters/sqljsAdapter.js';
const fixture = vi.hoisted(() => ({ db: null, operator: true, reads: 0 }));
vi.mock('../../src/lib/db/driver.js', () => ({ getAdapter: async () => { fixture.reads++; return fixture.db; } }));
vi.mock('@/dashboardGuard', () => ({ hasValidCliToken: async () => fixture.operator, isLocalRequest: () => true }));
vi.mock('@/lib/auth/dashboardSession', () => ({ verifyDashboardAuthToken: async () => false }));
vi.mock('@/lib/auth/clientApiKey', () => ({ resolveClientApiKey: async () => ({ valid: false }) }));
vi.mock('@/lib/db/repos/apiKeysRepo.js', () => ({ validateApiKey: vi.fn() }));
vi.mock('@/lib/admin/authzLog.js', () => ({ logAdminAuthz: vi.fn() }));
beforeEach(async () => {
  fixture.operator = true; fixture.reads = 0;
  fixture.db = await createNodeSqliteAdapter(':memory:');
  for (const [name, def] of Object.entries(TABLES)) { fixture.db.exec(buildCreateTableSql(name, def)); for (const sql of def.indexes || []) fixture.db.exec(sql); }
  fixture.db.run('INSERT INTO settings(id, data) VALUES(1, ?)', [JSON.stringify({ comboStrategy: 'round-robin', comboStrategies: { protected: { tokenSaver: { rtkEnabled: false } } }, password: 'never-return-this' })]);
});
afterEach(() => { fixture.db.close(); vi.restoreAllMocks(); });
async function call(method = 'GET', path = '', body) {
  const request = new NextRequest(`http://localhost/api/admin/shaping/${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const response = await ({ GET, POST }[method])(request, { params: Promise.resolve({ path: path.split('?')[0].split('/').filter(Boolean) }) });
  return { status: response.status, body: await response.json() };
}
async function save(settings, extra = {}) { return call('POST', 'profiles', { name: 'Test profile', settings, consent: consentRequired(settings), ...extra }); }
it('refuses an anonymous read and mutation before state access', async () => {
  fixture.operator = false;
  expect((await call()).status).toBe(401);
  expect((await call('POST', 'profiles', {})).status).toBe(401);
  expect(fixture.reads).toBe(0);
});
it('projects actual defaults without credentials, routing overrides or endpoint settings', async () => {
  const result = await call();
  expect(result.body.settings.rtkEnabled).toBe(true);
  expect(result.body.settings.memoryToolPruningEnabled).toBe(true);
  expect(result.body.settings.rtkAllowLossy).toBe(false);
  expect(JSON.stringify(result.body)).not.toContain('never-return-this');
  expect(result.body.settings).not.toHaveProperty('comboStrategies');
});
it('retains immutable revisions, rejects stale revisions and does not change live settings', async () => {
  const current = (await call()).body, before = fixture.db.get('SELECT data FROM settings').data;
  const first = await save(current.settings);
  const second = await save({ ...current.settings, rtkEnabled: false }, { profileId: first.body.version.profileId, expectedRevision: 1 });
  expect(second.body.version.revision).toBe(2);
  expect((await save(current.settings, { profileId: first.body.version.profileId, expectedRevision: 1 })).status).toBe(409);
  expect((await call('GET', `profiles/${first.body.version.id}`)).body.settings.rtkEnabled).toBe(true);
  expect(fixture.db.get('SELECT data FROM settings').data).toBe(before);
  expect((await call('GET', 'profiles?page=2&pageSize=1')).body.pagination).toEqual({ page: 2, pageSize: 1, total: 2, pages: 2 });
});
it('requires explicit content-change consent and refuses out-of-scope settings', async () => {
  const settings = (await call()).body.settings;
  expect((await save(settings, { consent: [] })).status).toBe(422);
  expect((await save({ ...settings, password: 'injected' })).status).toBe(400);
  expect((await save({ ...settings, pxpipeTimeoutMs: null })).status).toBe(400);
  expect((await call('GET', 'profiles?page=1&page=2')).status).toBe(400);
});
it('versions every context control with strict booleans and requires consent for content changes', async () => {
  const current = (await call()).body.settings;
  const controls = {
    epochMicroEnabled: true,
    epochAutoEnabled: true,
    dietEnabled: true,
    linguaEnabled: true,
    adaptiveCacheTtlEnabled: true,
  };
  const required = ['dietEnabled', 'epochAutoEnabled', 'epochMicroEnabled', 'linguaEnabled'];
  const consent = consentRequired({ ...current, ...controls });
  expect(consent).toEqual(expect.arrayContaining(required));
  expect(consent).not.toContain('adaptiveCacheTtlEnabled');
  expect((await save({ ...current, ...controls }, { consent: [] })).status).toBe(422);
  const saved = await save({ ...current, ...controls });
  expect(saved.status).toBe(200);
  expect(saved.body.version.settings).toMatchObject(controls);
  expect((await save({ ...current, epochMicroEnabled: 'true' })).status).toBe(400);
});
it('runs and promotes a legacy profile without rewriting its stored version or hash', async () => {
  const current = (await call()).body;
  const legacy = { ...current.settings };
  const omitted = ['epochMicroEnabled', 'epochAutoEnabled', 'dietEnabled', 'linguaEnabled', 'adaptiveCacheTtlEnabled'];
  for (const key of omitted) delete legacy[key];
  const inserted = fixture.db.run(
    'INSERT INTO shapingProfileVersions(profileId,name,revision,settings,consent,contentHash,createdAt) VALUES(?,?,?,?,?,?,?)',
    ['legacy-profile', 'Legacy profile', 1, JSON.stringify(legacy), JSON.stringify(consentRequired({ ...legacy, epochMicroEnabled: false, epochAutoEnabled: false, dietEnabled: false, linguaEnabled: false, adaptiveCacheTtlEnabled: false })), 'legacy-content-hash', new Date().toISOString()],
  );
  const versionId = inserted.lastInsertRowid;
  const loaded = await call('GET', `profiles/${versionId}`);
  expect(loaded.status).toBe(200);
  expect(loaded.body.settings).toEqual(legacy);
  const experiment = await call('POST', 'experiments', { baselineVersionId: versionId, candidateVersionId: versionId, fixtureSetId: 'context-integrity-v1' });
  expect(experiment.status).toBe(200);
  const promoted = await call('POST', 'promote', {
    versionId, experimentId: experiment.body.id, expectedCurrent: current.currentHash,
    consent: consentRequired({ ...legacy, epochMicroEnabled: false, epochAutoEnabled: false, dietEnabled: false, linguaEnabled: false, adaptiveCacheTtlEnabled: false }),
  });
  expect(promoted.status).toBe(200);
  for (const key of omitted) expect((await call()).body.settings[key]).toBe(false);
  expect(fixture.db.get('SELECT settings,contentHash FROM shapingProfileVersions WHERE id=?', [versionId])).toEqual({ settings: JSON.stringify(legacy), contentHash: 'legacy-content-hash' });
});
it('runs an actual bounded worker, persists results and atomically promotes then rolls back', async () => {
  const current = (await call()).body, before = fixture.db.get('SELECT data FROM settings').data;
  const baseline = (await save(current.settings)).body.version;
  const candidate = (await save({ ...current.settings, cavemanEnabled: true, thinkingStripEnabled: true })).body.version;
  const experiment = await call('POST', 'experiments', { baselineVersionId: baseline.id, candidateVersionId: candidate.id, fixtureSetId: 'context-integrity-v1' });
  expect(experiment.status).toBe(200);
  expect(experiment.body.result.candidate.results).toHaveLength(4);
  expect(experiment.body.result.candidate.coverage.providerCalls).toBe(0);
  expect(experiment.body.result.candidate.coverage.tokenCounts).toBeNull();
  expect(fixture.db.get('SELECT data FROM settings').data).toBe(before);
  expect((await call('GET', `experiments/${experiment.body.id}`)).body.result).toEqual(experiment.body.result);
  const promoted = await call('POST', 'promote', { versionId: candidate.id, experimentId: experiment.body.id, expectedCurrent: current.currentHash, consent: candidate.consent });
  expect(promoted.status).toBe(200);
  expect(promoted.body.outcome).toBe('applied');
  expect((await call()).body.settings.cavemanEnabled).toBe(true);
  const raw = JSON.parse(fixture.db.get('SELECT data FROM settings').data);
  expect(raw.password).toBe('never-return-this'); expect(raw.comboStrategies.protected.tokenSaver.rtkEnabled).toBe(false);
  expect((await call('POST', 'promote', { versionId: candidate.id, experimentId: experiment.body.id, expectedCurrent: current.currentHash, consent: candidate.consent })).status).toBe(409);
  const rollback = await call('POST', 'rollback', { rollbackReceiptId: promoted.body.id, expectedCurrent: promoted.body.afterHash, consent: consentRequired(current.settings) });
  expect(rollback.status).toBe(200);
  expect((await call()).body.settings).toEqual(current.settings);
  expect((await call('GET', 'receipts')).body.pagination.total).toBe(2);
});
it('reports unsupported stages and refuses unreviewed promotion', async () => {
  const current = (await call()).body;
  const profile = (await save({ ...current.settings, headroomEnabled: true, pxpipeEnabled: true, embedReorderEnabled: true, memoryHandoffEnabled: true })).body.version;
  const experiment = await call('POST', 'experiments', { baselineVersionId: profile.id, candidateVersionId: profile.id, fixtureSetId: 'context-integrity-v1' });
  expect(experiment.body.result.candidate.unsupported).toEqual(['pxpipe', 'headroom', 'reorder', 'handoff']);
  const request = { versionId: profile.id, experimentId: experiment.body.id, expectedCurrent: current.currentHash, consent: profile.consent };
  expect((await call('POST', 'promote', request)).status).toBe(422);
  expect((await call('POST', 'promote', { ...request, acknowledgeUnsupported: experiment.body.result.candidate.unsupported })).status).toBe(200);
});
it('keeps canonical gateway order and deterministic body hashes with honest signed bytes', async () => {
  const source = readFileSync(new URL('../../open-sse/handlers/chatCore.js', import.meta.url), 'utf8');
  const measured = [...source.matchAll(/measureSaverStage\(\s*"([a-zA-Z]+)"/g)].map(match => match[1]);
  expect(STAGE_ORDER.slice(1)).toEqual(measured.filter(name => !['anchor', 'final'].includes(name)));
  const settings = { ...(await call()).body.settings, cavemanEnabled: true, rtkEnabled: true, thinkingStripEnabled: true };
  const a = await evaluateSettings(settings, 'context-integrity-v1'), b = await evaluateSettings(settings, 'context-integrity-v1');
  expect(a.results.map(r => r.afterHash)).toEqual(b.results.map(r => r.afterHash));
  for (const row of a.results) {
    expect(row.stages.map(s => s.stage)).toEqual(STAGE_ORDER);
    expect(row.deltaBytes).toBe(row.afterBytes - row.beforeBytes);
    expect(row.stages.reduce((n, s) => n + s.deltaBytes, 0)).toBe(row.deltaBytes);
    expect(row.stages.find(s => s.stage === 'inject').deltaBytes).toBeGreaterThan(0);
    expect(row.validity.currentPreserved && row.validity.liveThinkingPreserved && row.validity.errorEvidencePreserved && row.validity.toolTransactionsValid).toBe(true);
  }
});

it('persists versions and experiment evidence across actual disk reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shaping-roundtrip-')), file = join(directory, 'data.sqlite');
  fixture.db.close(); fixture.db = await createSqlJsAdapter(file);
  for (const [table, def] of Object.entries(TABLES)) { fixture.db.exec(buildCreateTableSql(table, def)); for (const sql of def.indexes || []) fixture.db.exec(sql); }
  try {
    const current = (await call()).body, profile = (await save(current.settings)).body.version;
    const experiment = await call('POST', 'experiments', { baselineVersionId: profile.id, candidateVersionId: profile.id, fixtureSetId: 'context-integrity-v1' });
    const promoted = await call('POST', 'promote', { versionId: profile.id, experimentId: experiment.body.id, expectedCurrent: current.currentHash, consent: profile.consent });
    const reopened = await createSqlJsAdapter(file);
    try {
      expect(JSON.parse(reopened.get('SELECT settings FROM shapingProfileVersions').settings)).toEqual(profile.settings);
      expect(JSON.parse(reopened.get('SELECT result FROM shapingExperiments').result)).toEqual(experiment.body.result);
      expect(reopened.get('SELECT id FROM shapingReceipts').id).toBe(promoted.body.id);
    } finally { reopened.close(); }
  } finally { fixture.db.close(); fixture.db = await createNodeSqliteAdapter(':memory:'); rmSync(directory, { recursive: true, force: true }); }
});

it('rolls settings back if writing its receipt fails inside the transaction', async () => {
  const current = (await call()).body, candidate = (await save({ ...current.settings, rtkEnabled: false })).body.version;
  const experiment = await call('POST', 'experiments', { baselineVersionId: candidate.id, candidateVersionId: candidate.id, fixtureSetId: 'context-integrity-v1' });
  const before = fixture.db.get('SELECT data FROM settings').data, run = fixture.db.run.bind(fixture.db);
  vi.spyOn(fixture.db, 'run').mockImplementation((sql, values) => { if (sql.startsWith('INSERT INTO shapingReceipts')) throw new Error('private failure detail'); return run(sql, values); });
  const result = await call('POST', 'promote', { versionId: candidate.id, experimentId: experiment.body.id, expectedCurrent: current.currentHash, consent: candidate.consent });
  expect(result.status).toBe(500); expect(JSON.stringify(result.body)).not.toContain('private failure');
  expect(fixture.db.get('SELECT data FROM settings').data).toBe(before);
});

it('reports post-commit persistence uncertainty without claiming that activation failed', async () => {
  const current = (await call()).body, candidate = (await save({ ...current.settings, rtkEnabled: false })).body.version;
  const experiment = await call('POST', 'experiments', { baselineVersionId: candidate.id, candidateVersionId: candidate.id, fixtureSetId: 'context-integrity-v1' });
  fixture.db.flush = () => { throw new Error('disk full secret'); };
  const result = await call('POST', 'promote', { versionId: candidate.id, experimentId: experiment.body.id, expectedCurrent: current.currentHash, consent: candidate.consent });
  expect(result.status).toBe(207); expect(result.body.persistence).toBe('unconfirmed');
  expect((await call()).body.settings.rtkEnabled).toBe(false);
  expect(fixture.db.get('SELECT COUNT(*) AS count FROM shapingReceipts').count).toBe(1);
});

it('checks defaults after a concurrent explicit setting is deleted before promotion', async () => {
  fixture.db.run('UPDATE settings SET data = ?', [JSON.stringify({ rtkEnabled: false })]);
  const current = (await call()).body, candidate = (await save(current.settings)).body.version;
  const experiment = await call('POST', 'experiments', { baselineVersionId: candidate.id, candidateVersionId: candidate.id, fixtureSetId: 'context-integrity-v1' });
  fixture.db.run('UPDATE settings SET data = ?', ['{}']);
  const result = await call('POST', 'promote', { versionId: candidate.id, experimentId: experiment.body.id, expectedCurrent: current.currentHash, consent: candidate.consent });
  expect(result.status).toBe(409); expect((await call()).body.settings.rtkEnabled).toBe(true);
});
