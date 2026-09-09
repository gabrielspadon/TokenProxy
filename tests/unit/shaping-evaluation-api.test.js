import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { TABLES, buildCreateTableSql } from '../../src/lib/db/schema.js';
import { GET, POST } from '../../src/app/api/admin/shaping/[[...path]]/route.js';
import { consentRequired } from '../../src/lib/shaping/profile.js';
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

it('retains selected corpus versions with consent, pagination and exact experiment attribution', async () => {
  const fixtures = [{ id: 'operator-case', contextWindow: 200000, body: { model: 'fixture', messages: [{ role: 'user', content: 'Selected private test input' }], max_tokens: 16 } }];
  const request = { name: 'Selected workload', fixtures, acknowledgeRetention: true };
  expect((await call('POST', 'evaluation-sets', { ...request, acknowledgeRetention: false })).status).toBe(422);
  const saved = await call('POST', 'evaluation-sets', request);
  expect(saved.status).toBe(200); expect(saved.body.persistence).toBe('confirmed');
  const first = saved.body.version;
  const revision = await call('POST', 'evaluation-sets', { ...request, setId: first.setId, expectedRevision: 1 });
  expect(revision.body.version.revision).toBe(2);
  expect((await call('POST', 'evaluation-sets', { ...request, setId: first.setId, expectedRevision: 1 })).status).toBe(409);
  const page = await call('GET', 'evaluation-sets?page=2&pageSize=1');
  expect(page.body.pagination.total).toBe(2); expect(page.body.rows).toHaveLength(1);
  expect(JSON.stringify(page.body)).not.toContain('Selected private test input');
  expect((await call('GET', `evaluation-sets/${first.id}`)).body.fixtures).toEqual(fixtures);
  const current = (await call()).body, profile = (await save(current.settings)).body.version;
  const experiment = await call('POST', 'experiments', { baselineVersionId: profile.id, candidateVersionId: profile.id, fixtureSetId: first.id });
  expect(experiment.status).toBe(200); expect(experiment.body.result.status).toBe('completed');
  expect(experiment.body.result.evaluationSet).toMatchObject({ id: first.id, revision: 1, contentHash: first.contentHash, count: 1 });
  expect(experiment.body.result.candidate.results).toHaveLength(1);
  expect(experiment.body.result.comparison).toMatchObject({ disposition: 'equivalent-on-selected-set', recommendationToActivate: false, taskOutcomeChange: null, monetarySavings: null });
  expect((await call('GET', `experiments/${experiment.body.id}`)).body.result).toEqual(experiment.body.result);
});

it('retains cancellation and refuses to promote incomplete evidence', async () => {
  const current = (await call()).body, profile = (await save(current.settings)).body.version;
  const controller = new AbortController(); controller.abort();
  const request = new NextRequest('http://localhost/api/admin/shaping/experiments', { method: 'POST', signal: controller.signal,
    body: JSON.stringify({ baselineVersionId: profile.id, candidateVersionId: profile.id, fixtureSetId: 'context-integrity-v1' }) });
  const response = await POST(request, { params: Promise.resolve({ path: ['experiments'] }) });
  const result = await response.json();
  expect(result.result.status).toBe('cancelled');
  expect((await call('GET', `experiments/${result.id}`)).body.result.status).toBe('cancelled');
  expect((await call('POST', 'promote', { versionId: profile.id, expectedCurrent: current.currentHash, consent: profile.consent, experimentId: result.id })).status).toBe(422);
  expect((await call()).body.currentHash).toBe(current.currentHash);
});
