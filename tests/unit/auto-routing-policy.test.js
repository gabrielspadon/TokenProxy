import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { createSqlJsAdapter } from '../../src/lib/db/adapters/sqljsAdapter.js';
import { TABLES, buildCreateTableSql } from '../../src/lib/db/schema.js';
const fixture = vi.hoisted(() => ({ db: null, operator: true, local: true, reads: 0 }));
vi.mock('../../src/lib/db/driver.js', () => ({ getAdapter: async () => { fixture.reads++; return fixture.db; } }));
vi.mock('@/dashboardGuard', () => ({ hasValidCliToken: async () => fixture.operator, isLocalRequest: () => fixture.local }));
vi.mock('@/lib/auth/dashboardSession', () => ({ verifyDashboardAuthToken: async () => false }));
vi.mock('@/lib/auth/clientApiKey', () => ({ resolveClientApiKey: async () => ({ valid: false }) }));
vi.mock('@/lib/db/repos/apiKeysRepo.js', () => ({ validateApiKey: vi.fn() }));
vi.mock('@/lib/admin/authzLog.js', () => ({ logAdminAuthz: vi.fn() }));
import { GET, POST } from '../../src/app/api/admin/auto-routing/[[...path]]/route.js';
import { resolveAutoModel } from '../../src/sse/services/autoRouter.js';
function schema(db) { for (const [name, def] of Object.entries(TABLES)) db.exec(buildCreateTableSql(name, def)); }
beforeEach(async () => {
  fixture.operator = true; fixture.local = true; fixture.reads = 0;
  fixture.db = await createNodeSqliteAdapter(':memory:'); schema(fixture.db);
  fixture.db.run('INSERT INTO settings(id,data) VALUES(1,?)', [JSON.stringify({ password: 'private-fixture-value', autoRouter: { retained: 'unchanged', rules: { extra: 'keep' } }, comboStrategies: { PlanA: { tokenSaver: false } } })]);
});
afterEach(() => { fixture.db.close(); vi.restoreAllMocks(); });
async function call(method = 'GET', path = '', body) {
  const request = new NextRequest(`http://localhost/api/admin/auto-routing/${path}`, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const response = await ({ GET, POST }[method])(request, { params: Promise.resolve({ path: path ? path.split('/') : [] }) });
  return { status: response.status, body: await response.json() };
}
const rules = { simple: 'openai/fixture-simple', coding: 'openai/fixture-code', reasoning: 'openai/fixture-reason' };
it('refuses anonymous and nonlocal mutation before state access', async () => {
  fixture.operator = false;
  expect((await call()).status).toBe(401); expect((await call('POST', '', {})).status).toBe(401); expect(fixture.reads).toBe(0);
  fixture.operator = true; fixture.local = false;
  expect((await call('POST', '', {})).status).toBe(403); expect(fixture.reads).toBe(0);
});
it('validates all three rules, records an atomic receipt and preserves unrelated settings', async () => {
  const before = (await call()).body, request = { rules, expectedCurrent: before.currentHash };
  for (const bad of [{ ...request, rules: { simple: 'openai/model' } }, { ...request, rules: { ...rules, simple: 'bare' } }, { ...request, rules: { ...rules, simple: 'openai/model with spaces' } }, { ...request, unexpected: true }, { ...request, expectedCurrent: 'bad' }]) expect((await call('POST', '', bad)).status).toBe(400);
  expect((await call('POST', '', ' '.repeat(16385))).status).toBe(413);
  const changed = await call('POST', '', request);
  expect(changed.status).toBe(200); expect(changed.body.persistence).toBe('confirmed');
  expect((await call()).body.rules).toEqual(rules);
  expect((await call('GET', `receipts/${changed.body.receipt.id}`)).body).toEqual(changed.body.receipt);
  const raw = JSON.parse(fixture.db.get('SELECT data FROM settings').data);
  expect(raw).toMatchObject({ password: 'private-fixture-value', autoRouter: { retained: 'unchanged', rules: { ...rules, extra: 'keep' } }, comboStrategies: { PlanA: { tokenSaver: false } } });
  expect(JSON.stringify(changed.body)).not.toContain('private-fixture-value');
  expect(await resolveAutoModel({ messages: [{ content: 'Hello' }] }, raw)).toEqual({ model: rules.simple, taskClass: 'simple', source: 'rule' });
  expect(await resolveAutoModel({ tools: [{}] }, raw)).toEqual({ model: rules.coding, taskClass: 'coding', source: 'rule' });
  expect(await resolveAutoModel({ messages: [{ content: 'Explain this architecture' }] }, raw)).toEqual({ model: rules.reasoning, taskClass: 'reasoning', source: 'rule' });
  expect((await call('POST', '', request)).status).toBe(409);
  const restored = await call('POST', '', { rules: before.rules, expectedCurrent: changed.body.currentHash });
  expect(restored.status).toBe(200); expect((await call()).body.rules).toEqual(before.rules);
});
it('rolls back settings when the receipt cannot be recorded', async () => {
  const current = (await call()).body, before = fixture.db.get('SELECT data FROM settings').data, run = fixture.db.run.bind(fixture.db);
  vi.spyOn(fixture.db, 'run').mockImplementation((sql, values) => { if (sql.startsWith('INSERT INTO kv')) throw Error('private failure'); return run(sql, values); });
  expect((await call('POST', '', { rules, expectedCurrent: current.currentHash })).status).toBe(503);
  expect(fixture.db.get('SELECT data FROM settings').data).toBe(before);
});
it('survives disk reopen and reports post-commit flush uncertainty separately', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'auto-routing-')), file = join(directory, 'state.sqlite');
  fixture.db.close(); fixture.db = await createSqlJsAdapter(file); schema(fixture.db);
  try {
    const current = (await call()).body;
    const changed = await call('POST', '', { rules, expectedCurrent: current.currentHash });
    fixture.db.close(); fixture.db = await createSqlJsAdapter(file);
    expect((await call()).body.rules).toEqual(rules);
    expect((await call('GET', `receipts/${changed.body.receipt.id}`)).body).toEqual(changed.body.receipt);
    const flush = fixture.db.flush;
    fixture.db.flush = () => { throw Error('private disk failure'); };
    const uncertain = await call('POST', '', { rules: current.rules, expectedCurrent: changed.body.currentHash });
    expect(uncertain.status).toBe(207); expect(uncertain.body.persistence).toBe('unconfirmed');
    fixture.db.flush = flush;
  } finally { fixture.db.close(); fixture.db = await createNodeSqliteAdapter(':memory:'); rmSync(directory, { recursive: true, force: true }); }
});
