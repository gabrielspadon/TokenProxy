import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createNodeSqliteAdapter } from '../../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { TABLES, buildCreateTableSql } from '../../../src/lib/db/schema.js';
import { CONFIG_VERSION_TABLES } from '../../../src/lib/db/configVersionSchema.js';
import {
  GET,
  POST,
  PATCH,
} from '../../../src/app/api/admin/configuration-domains/[[...path]]/route.js';

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
    `http://127.0.0.1/api/admin/configuration-domains${path ? '/' + path : ''}`,
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
it('authenticates before any domain read and never accepts an inference credential', async () => {
  fixture.operator = false;
  fixture.inference = true;
  expect((await call('GET')).status).toBe(403);
  expect(fixture.reads).toBe(0);
});
it('runs real domain snapshot/draft/activation/selection/rollback and rejects stale writes', async () => {
  const current = (await call('GET')).body;
  expect(current.coverage.scope).toBe('configuration-domains-v1');
  const document = structuredClone(current.document);
  document.network.settings.connectTimeoutMs = 7000;
  const created = await call('POST', 'drafts', { document, expectedCurrent: current.currentHash });
  expect(created.status).toBe(201);
  expect(
    (await call('POST', `drafts/${created.body.id}/validate`, { expectedRevision: 1 })).body.valid
  ).toBe(true);
  const activated = await call('POST', `drafts/${created.body.id}/activate`, {
    expectedRevision: 1,
    expectedCurrent: current.currentHash,
  });
  expect(activated.status).toBe(200);
  expect(
    (
      await call('POST', `drafts/${created.body.id}/activate`, {
        expectedRevision: 1,
        expectedCurrent: current.currentHash,
      })
    ).status
  ).toBe(409);
  const baseline = created.body.receipt.beforeVersionId;
  const selected = await call('POST', `versions/${baseline}/restore`, {
    expectedCurrent: activated.body.currentHash,
    paths: ['/network/settings/connectTimeoutMs'],
  });
  expect(selected.status).toBe(201);
  expect(selected.body.diff).toHaveLength(1);
  expect(
    (
      await call('POST', `versions/${baseline}/restore`, {
        expectedCurrent: activated.body.currentHash,
        paths: ['/network'],
      })
    ).status
  ).toBe(400);
  expect(
    (
      await call('POST', `versions/${baseline}/rollback`, {
        expectedCurrent: activated.body.currentHash,
      })
    ).status
  ).toBe(200);
  const receipts = (await call('GET', 'receipts')).body.receipts;
  expect(receipts.some((row) => row.outcome === 'staged')).toBe(true);
  expect(receipts.some((row) => row.outcome === 'conflict')).toBe(true);
});
it('refuses secret fields, oversized input, wrong scope, and unsupported paths without copying request data', async () => {
  const current = (await call('GET')).body;
  const document = structuredClone(current.document);
  document.network.settings.outboundProxyUrl = 'DO-NOT-PERSIST';
  const result = await call('POST', 'drafts', { document, expectedCurrent: current.currentHash });
  expect(result.status).toBe(400);
  expect(JSON.stringify(result.body)).not.toContain('DO-NOT-PERSIST');
  expect(fixture.db.all('SELECT id FROM configVersions')).toEqual([]);
  expect((await call('POST', 'drafts', {}, 'x'.repeat(263000))).status).toBe(413);
  expect((await call('POST', 'drafts/dispatch', {})).status).toBe(404);
  const { createConfigurationDraft, getCurrentConfiguration } =
    await import('../../../src/lib/db/repos/configVersionsRepo.js');
  const routing = await getCurrentConfiguration();
  const draft = await createConfigurationDraft({
    document: routing.document,
    expectedCurrent: routing.currentHash,
  });
  expect((await call('GET', `drafts/${draft.id}`)).status).toBe(404);
  expect((await call('GET', `versions/${draft.version.id}`)).status).toBe(404);
});
