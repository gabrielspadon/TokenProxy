import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: async request => request.headers.get('x-operator') === 'fixture' ? null : new Response(null, { status: 401 }) }));
import { getAdapter } from '@/lib/db/driver.js';
import { DATA_FILE } from '@/lib/db/paths.js';
import { createApiKey, updateApiKey } from '@/lib/db/repos/apiKeysRepo.js';
import * as projection from '@/lib/db/repos/keyUsageRepo.js';
import { createContextAnalyticsClient } from '@/lib/db/analytics/client.js';
import { readKeyUsage, validateKeyUsageQuery } from '@/lib/db/analytics/keyUsageQueries.mjs';
import { GET } from '@/app/api/keys/route.js';

let db, key;
const operator = () => new Request('http://localhost/api/keys', { headers: { 'x-operator': 'fixture' } });
beforeAll(async () => { db = await getAdapter(); });
beforeEach(async () => {
  vi.restoreAllMocks(); db.run('DELETE FROM usageHistory'); db.run('DELETE FROM apiKeys');
  key = await createApiKey('Fixture key', 'fixture-machine');
});
afterAll(async () => { vi.restoreAllMocks(); await globalThis._contextAnalytics?.client.close(); });
function usage(credential, input, output, cost) {
  db.run('INSERT INTO usageHistory(timestamp,apiKey,promptTokens,completionTokens,cost) VALUES(?,?,?,?,?)',
    ['2026-09-06T12:00:00.000Z', credential, input, output, cost]);
}

it('queries complete recorded history off-thread with public stable IDs and unknown counts', async () => {
  const empty = await createApiKey('No usage', 'fixture-machine');
  usage(key.key, 12, 4, 0.25); usage(key.key, null, 5, null); usage('deleted-credential-fixture', 999, 999, 999);
  const result = await projection.getKeyUsageSnapshot();
  expect(result.scope).toBe('retained-history-for-current-credential');
  expect(result.totals[key.id]).toMatchObject({ requests: 2, promptTokens: 12, completionTokens: 9, costUsd: .25,
    unknownPromptRows: 1, unknownCompletionRows: 0, unknownCostRows: 1 });
  expect(result.totals[empty.id]).toMatchObject({ requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
  expect(result.freshness.source).toBe('committed-sqlite');
  expect(JSON.stringify(result)).not.toContain(key.key);
  expect(JSON.stringify(result)).not.toContain('deleted-credential-fixture');
  expect(Object.keys(result.totals).sort()).toEqual([key.id,empty.id].sort());
  expect(readKeyUsage(db).totals).toEqual(result.totals);
});

it('keeps all-missing fields unknown and never infers a rotated credential match', async () => {
  usage(key.key, null, null, null);
  expect((await projection.getKeyUsageSnapshot()).totals[key.id]).toMatchObject({ requests: 1, promptTokens: null, completionTokens: null, costUsd: null });
  db.run('UPDATE apiKeys SET key=? WHERE id=?', ['rotated-fixture', key.id]);
  const result = await projection.getKeyUsageSnapshot();
  expect(result.totals[key.id].requests).toBe(0);
  expect(result.scope).toBe('retained-history-for-current-credential');
});

it('reports historical zero prices without pricing provenance separately', async () => {
  usage(key.key, 4, 2, 0);
  const result = await projection.getKeyUsageSnapshot();
  expect(result.totals[key.id]).toMatchObject({ costUsd: 0, unknownCostRows: 0, ambiguousZeroCostRows: 1 });
});

it('makes persisted sql.js freshness explicit without reading its writer memory', async () => {
  usage(key.key, 20, 2, .1); db.checkpoint();
  const file = join(process.env.DATA_DIR, 'key-history-snapshot.sqlite');
  copyFileSync(DATA_FILE,file);
  usage(key.key, 300, 30, 3);
  const client = createContextAnalyticsClient({ file, driver: 'sql.js' });
  try {
    const result = await client.run({ operation: 'key-usage' });
    expect(result.totals[key.id].requests).toBe(1);
    expect(result.freshness.source).toBe('last-persisted-snapshot');
    expect(Number.isFinite(Date.parse(result.freshness.persistedAt))).toBe(true);
  } finally { await client.close(); }
});

it('returns current controls and budget despite a stalled optional historical query', async () => {
  await updateApiKey(key.id, { maxCostUsd: 10 });
  let signal;
  vi.spyOn(projection, 'getKeyUsageSnapshot').mockImplementation(options => {
    signal = options.signal;
    return new Promise((resolve,reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const started = performance.now();
  const response = await GET(operator());
  expect(performance.now()-started).toBeLessThan(1500);
  expect(signal.aborted).toBe(true);
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(body).toMatchObject({ usageState: 'unavailable', usageFreshness: null });
  expect(body.keys[0]).toMatchObject({ id: key.id, isActive: true, maxCostUsd: 10, usage: null, budget: { capped: true } });
  expect(JSON.stringify(body)).not.toContain(key.key);
});

it('connects the real worker result through the protected listing', async () => {
  usage(key.key, 30, 3, .2);
  await projection.getKeyUsageSnapshot();
  const response = await GET(operator()), body = await response.json();
  expect(body).toMatchObject({ usageState: 'available', usageScope: 'retained-history-for-current-credential' });
  expect(body.keys[0].usage).toMatchObject({ requests: 1, promptTokens: 30, completionTokens: 3, costUsd: .2 });
  expect((await GET(new Request('http://localhost/api/keys'))).status).toBe(401);
});

it('accepts no caller SQL, credential or path and bounds the output population', () => {
  for (const query of [{ operation: 'sql' }, { operation: 'key-usage', sql: 'SELECT key FROM apiKeys' }, { operation: 'key-usage', file: '/private' }]) {
    expect(() => validateKeyUsageQuery(query)).toThrow();
  }
  expect(() => readKeyUsage({ get: () => ({ count: 5001 }), all: () => { throw new Error('Must not query'); } })).toThrow('population exceeds limit');
});
