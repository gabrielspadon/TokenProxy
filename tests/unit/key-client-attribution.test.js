import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/dashboardGuard', () => ({
  hasValidCliToken: vi.fn(async (request) => request.headers.get('x-operator') === 'yes'),
  isLocalRequest: (request) => request.headers.get('x-peer') !== 'remote',
}));
vi.mock('@/lib/auth/dashboardSession', () => ({
  verifyDashboardAuthToken: vi.fn(async () => false),
}));
vi.mock('@/lib/auth/clientApiKey', () => ({
  resolveClientApiKey: vi.fn(async (request) => ({ valid: request.headers.has('x-inference') })),
}));
vi.mock('@/shared/utils/machineId', () => ({
  getConsistentMachineId: vi.fn(async () => 'fixture-machine'),
}));
import { initDb } from '@/lib/db/index.js';
import { getAdapter } from '@/lib/db/driver.js';
import { createApiKey } from '@/lib/db/repos/apiKeysRepo.js';
import { getKeyAttribution } from '@/lib/db/repos/keyAttributionRepo.js';
import * as list from '@/app/api/keys/route.js';

let db, key;
const request = () =>
  new Request('http://localhost/api/keys', { headers: { 'x-operator': 'yes' } });
const stat = (id, clientKeyId, clientTool, timestamp) =>
  db.run(
    `INSERT INTO requestStats(id, timestamp, status, clientKeyId, clientTool) VALUES(?, ?, 'success', ?, ?)`,
    [id, timestamp, clientKeyId, clientTool]
  );

beforeAll(async () => {
  await initDb();
  db = await getAdapter();
});
beforeEach(async () => {
  db.run('DELETE FROM apiKeys');
  db.run('DELETE FROM requestStats');
  key = await createApiKey('Client key', 'fixture-machine');
});

// The unknown path is the important one: attribution columns are nullable by
// design and historical rows keep their NULLs, so a key with nothing recorded
// must read as unknown rather than as a key nobody used.
it('reports no attribution at all for a key with no retained requests', async () => {
  expect(await getKeyAttribution()).toEqual({});
  const row = (await (await list.GET(request())).json()).keys[0];
  expect(row.attribution).toBeNull();
});

it('distinguishes a key whose requests named no client from one with no requests', async () => {
  stat('r1', key.id, null, '2026-01-01T00:00:00.000Z');
  const attribution = await getKeyAttribution();
  expect(attribution[key.id]).toMatchObject({
    attribution: 'unattributed',
    clientTool: null,
    requests: 1,
  });
  // Absent from the map entirely is the other answer, and it is not this one.
  expect(attribution[key.id]).not.toBeUndefined();
});

it('names the client from the most recent attributed request', async () => {
  stat('r1', key.id, 'claude-code', '2026-01-01T00:00:00.000Z');
  stat('r2', key.id, 'codex', '2026-02-01T00:00:00.000Z');
  stat('r3', key.id, 'claude-code', '2026-01-15T00:00:00.000Z');
  expect((await getKeyAttribution())[key.id]).toMatchObject({
    clientTool: 'codex',
    lastSeenAt: '2026-02-01T00:00:00.000Z',
    requests: 3,
    distinctClients: 2,
    attribution: 'observed',
  });
});

it('falls back to the last attributed client when the newest request named none', async () => {
  stat('r1', key.id, 'claude-code', '2026-01-01T00:00:00.000Z');
  stat('r2', key.id, null, '2026-03-01T00:00:00.000Z');
  // The label is the last one actually observed; the count still covers both.
  expect((await getKeyAttribution())[key.id]).toMatchObject({
    clientTool: 'claude-code',
    requests: 2,
    attribution: 'observed',
  });
});

it("never attributes one key's traffic to another", async () => {
  const other = await createApiKey('Other', 'fixture-machine');
  stat('r1', key.id, 'claude-code', '2026-01-01T00:00:00.000Z');
  const attribution = await getKeyAttribution();
  expect(attribution[key.id].clientTool).toBe('claude-code');
  expect(attribution[other.id]).toBeUndefined();
});

it('carries attribution on the keys list without disclosing the secret', async () => {
  stat('r1', key.id, 'claude-code', '2026-01-01T00:00:00.000Z');
  const response = await list.GET(request());
  expect(await response.clone().text()).not.toContain(key.key);
  expect((await response.json()).keys[0].attribution).toMatchObject({
    clientTool: 'claude-code',
    attribution: 'observed',
  });
});

// Attribution is evidence about the past, never a reason to withhold the
// controls an operator needs right now.
it('still serves the keys list when attribution cannot be read', async () => {
  db.run('DROP TABLE requestStats');
  try {
    const response = await list.GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).keys[0].attribution).toBeNull();
  } finally {
    // Restore for the rest of the suite; initDb recreates from the declarative schema.
    await initDb();
  }
});
