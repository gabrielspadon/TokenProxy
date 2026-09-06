import './aliases.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
if (!process.env.BENCH_RUN_ID || !process.env.DATA_DIR) throw new Error('Explicit benchmark DATA_DIR required');
const { getAdapter } = await import('../../../src/lib/db/driver.js');
const { createProviderNode } = await import('../../../src/lib/db/repos/nodesRepo.js');
const { createProviderConnection } = await import('../../../src/lib/db/repos/connectionsRepo.js');
const { createApiKey } = await import('../../../src/lib/db/repos/apiKeysRepo.js');
const { updateSettings } = await import('../../../src/lib/db/repos/settingsRepo.js');
const { createDashboardAuthToken } = await import('../../../src/lib/auth/dashboardSession.js');
const db = await getAdapter();
assert.notEqual(db.driver, 'sql.js', 'This baseline requires a native SQLite driver');
assert.equal(db.get('SELECT count(*) AS n FROM providerConnections').n, 0, 'Refuse a populated database');
const origin = `http://127.0.0.1:${process.env.BENCH_PROVIDER_PORT}`;
for (const [prefix, type] of [['bench-openai', 'openai-compatible'], ['bench-claude', 'anthropic-compatible']]) {
  const id = `${type}-${process.env.BENCH_RUN_ID}-${prefix}`;
  await createProviderNode({ id, prefix, type, name: prefix, apiType: 'chat', baseUrl: `${origin}/v1` });
  for (let i = 0; i < 2; i++) await createProviderConnection({ provider: id, authType: 'apikey', name: `${prefix}-${i}`, apiKey: `controlled-${i}`, isActive: true, testStatus: 'active', providerSpecificData: { baseUrl: `${origin}/v1`, maxConcurrent: 128 } });
}
await updateSettings({ requireApiKey: true, requireLogin: true, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false, contextStructureEnabled: true, storeRequestDetails: false, backgroundTokenRefreshEnabled: false });
const key = await createApiKey('isolated-performance', 'controlled-benchmark-machine');
const operator = await createDashboardAuthToken({ benchmark: process.env.BENCH_RUN_ID });
const stats = { driver: db.driver, sqlite: db.get('SELECT sqlite_version() AS version').version, journal: db.get('PRAGMA journal_mode'), connections: db.get('SELECT count(*) AS n FROM providerConnections').n };
writeFileSync(join(process.env.DATA_DIR, 'fixture-auth.json'), JSON.stringify({ key: key.key, operator, stats }), { mode: 0o600 });
db.close();
process.disconnect?.();
