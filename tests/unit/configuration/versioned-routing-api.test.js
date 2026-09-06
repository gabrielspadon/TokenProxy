import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createNodeSqliteAdapter } from '../../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { TABLES, buildCreateTableSql } from '../../../src/lib/db/schema.js';
import { CONFIG_VERSION_TABLES } from '../../../src/lib/db/configVersionSchema.js';
import { GET, POST, PATCH } from '../../../src/app/api/admin/configuration/[[...path]]/route.js';

const fixture = vi.hoisted(() => ({
  db: null,
  operator: false,
  inference: false,
  loopback: true,
  reads: 0,
}));
vi.mock('../../../src/lib/db/driver.js', () => ({
  getAdapter: async () => {
    fixture.reads++;
    return fixture.db;
  },
}));
vi.mock('@/dashboardGuard', () => ({
  hasValidCliToken: async () => fixture.operator,
  isLocalRequest: () => fixture.loopback,
}));
vi.mock('@/lib/auth/dashboardSession', () => ({ verifyDashboardAuthToken: async () => false }));
vi.mock('@/lib/auth/clientApiKey', () => ({
  resolveClientApiKey: async () => ({ valid: fixture.inference }),
}));
vi.mock('@/lib/db/repos/apiKeysRepo.js', () => ({ validateApiKey: vi.fn() }));
vi.mock('@/lib/admin/authzLog.js', () => ({ logAdminAuthz: vi.fn() }));
beforeEach(async () => {
  Object.assign(fixture, { operator: true, inference: false, loopback: true, reads: 0 });
  fixture.db = await createNodeSqliteAdapter(':memory:');
  for (const [name, def] of Object.entries({ ...TABLES, ...CONFIG_VERSION_TABLES })) {
    fixture.db.exec(buildCreateTableSql(name, def));
    for (const sql of def.indexes || []) fixture.db.exec(sql);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.db.close();
});
async function call(method, path = '', body, raw) {
  const request = new NextRequest(
    `http://127.0.0.1/api/admin/configuration${path ? '/' + path : ''}`,
    {
      method,
      ...(method === 'GET'
        ? {}
        : { body: raw ?? JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }
  );
  const response = await { GET, POST, PATCH }[method](request, {
    params: Promise.resolve({ path: path ? path.split('?')[0].split('/') : [] }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
const document = {
  combos: [{ id: 'plan-1', name: 'work', kind: null, models: ['openai/gpt-4o'] }],
  aliases: {},
  settings: { comboStrategy: 'fallback' },
};
// Driver-agnostic full-content snapshot: node:sqlite's DatabaseSync has no serialize(),
// so read every user table's rows through the adapter instead of a byte-level dump.
function snapshot(db) {
  const tables = db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return Object.fromEntries(tables.map(({ name }) => [name, db.all(`SELECT * FROM "${name}"`)]));
}

it.each([
  [false, false, true, 'GET', '', 401],
  [false, true, true, 'GET', 'versions', 403],
  [false, false, true, 'POST', 'drafts', 401],
  [false, true, true, 'POST', 'drafts', 403],
  [true, false, false, 'POST', 'drafts', 403],
])(
  'refuses auth class %s/%s loopback %s for %s %s before config access',
  async (operator, inference, loopback, method, path, status) => {
    Object.assign(fixture, { operator, inference, loopback });
    const before = snapshot(fixture.db);
    const result = await call(method, path, { document });
    expect(result.status).toBe(status);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(fixture.reads).toBe(0);
    expect(snapshot(fixture.db)).toEqual(before);
  }
);
it('executes actual authenticated create/revise/validate/activate/conflict/rollback/read/audit', async () => {
  const current = await call('GET');
  expect(current.status).toBe(200);
  const created = await call('POST', 'drafts', {
    document,
    expectedCurrent: current.body.currentHash,
  });
  expect(created.status).toBe(201);
  expect(created.body.receipt.provenance).toEqual({
    source: 'admin.configuration',
    actorClass: 'operator',
    actorId: null,
  });
  const id = created.body.id;
  const revisedDoc = structuredClone(document);
  revisedDoc.settings.comboStrategy = 'round-robin';
  expect(
    (await call('PATCH', `drafts/${id}`, { document: revisedDoc, expectedRevision: 1 })).status
  ).toBe(200);
  expect((await call('POST', `drafts/${id}/validate`, { expectedRevision: 2 })).body.valid).toBe(
    true
  );
  const activated = await call('POST', `drafts/${id}/activate`, {
    expectedRevision: 2,
    expectedCurrent: current.body.currentHash,
  });
  expect(activated.status).toBe(200);
  expect((await call('GET')).body.document.settings.comboStrategy).toBe('round-robin');
  expect(
    (
      await call('POST', `drafts/${id}/activate`, {
        expectedRevision: 2,
        expectedCurrent: current.body.currentHash,
      })
    ).status
  ).toBe(409);
  const beforeVersion = created.body.version.parentVersionId;
  const rollback = await call('POST', `versions/${beforeVersion}/rollback`, {
    expectedCurrent: activated.body.currentHash,
  });
  expect(rollback.status).toBe(200);
  expect(rollback.body.version.id).toBeGreaterThan(activated.body.version.id);
  expect((await call('GET')).body.document.combos).toEqual([]);
  const audit = await call('GET', 'receipts?limit=1');
  expect(audit.body.receipts).toHaveLength(1);
  expect(audit.body.receipts[0].action).toBe('rollback');
  expect((await call('GET', 'versions?limit=1')).body.versions).toHaveLength(1);
});
it.each([
  ['drafts', { document, expectedCurrent: 'a'.repeat(64), password: 'secret' }, 400],
  ['drafts', { document }, 400],
  ['drafts', null, 400],
])('refuses malformed fields before state access', async (path, body, status) => {
  expect((await call('POST', path, body)).status).toBe(status);
  expect(fixture.reads).toBe(0);
});
it('bounds bytes before parsing and never reflects a secret-bearing malformed payload', async () => {
  const result = await call('POST', 'drafts', {}, 'x'.repeat(262145));
  expect(result.status).toBe(413);
  expect(fixture.reads).toBe(0);
  const secret = await call('POST', 'drafts', {}, '{"password":"top-secret"');
  expect(secret.status).toBe(400);
  expect(JSON.stringify(secret.body)).not.toContain('top-secret');
});
it('does not expose raw database failure messages', async () => {
  vi.spyOn(fixture.db, 'all').mockImplementation(() => {
    throw new Error('Bearer credentials-at-host.invalid');
  });
  const result = await call('GET');
  expect(result.status).toBe(500);
  expect(result.body.code).toBe('configuration_unavailable');
  expect(JSON.stringify(result.body)).not.toContain('credentials');
});
it('has no mutable history endpoint', async () => {
  expect((await call('PATCH', 'versions/1', { document })).status).toBe(404);
  expect((await call('PATCH', 'receipts/1', { details: {} })).status).toBe(404);
  expect(fixture.reads).toBe(0);
});
