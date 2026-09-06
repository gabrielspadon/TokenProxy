// connectionsRepo maintenance surfaces: merge patches, conditional pool
// snapshot writes, bulk delete, cleanup of null fields, github-derived names,
// oauth dedup tie-breaks and the health-summary cause taxonomy. Runs against
// the per-file isolated DATA_DIR sqlite; no live data, no network.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let repo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-connrepo-'));
  process.env.DATA_DIR = tempDir;
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  vi.resetModules();
  const dbMod = await import('@/lib/db/index.js');
  await dbMod.initDb();
  repo = await import('@/lib/db/repos/connectionsRepo.js');
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe('mergeProviderConnectionData', () => {
  it('merges providerSpecificData key by key and keeps unnamed fields', async () => {
    const conn = await repo.createProviderConnection({
      provider: 'p-merge',
      authType: 'apikey',
      name: 'm-1',
      apiKey: 'k-1',
      providerSpecificData: { proxyPoolId: 'pool-A', keep: 1 },
    });
    const merged = await repo.mergeProviderConnectionData(conn.id, {
      name: 'renamed',
      providerSpecificData: { added: 2 },
    });
    expect(merged.name).toBe('renamed');
    expect(merged.providerSpecificData).toEqual({ proxyPoolId: 'pool-A', keep: 1, added: 2 });
    const read = await repo.getProviderConnectionById(conn.id);
    expect(read.providerSpecificData.added).toBe(2);
  });

  it('treats a non-object patch and a missing name as no-ops on those fields', async () => {
    const conn = await repo.createProviderConnection({
      provider: 'p-merge',
      authType: 'apikey',
      name: 'm-2',
      apiKey: 'k-2',
      providerSpecificData: ['not-an-object-target'],
    });
    const merged = await repo.mergeProviderConnectionData(conn.id, {
      providerSpecificData: ['ignored'],
    });
    expect(merged.name).toBe('m-2');
    expect(merged.providerSpecificData).toEqual({});
  });

  it('returns null for an unknown id', async () => {
    expect(await repo.mergeProviderConnectionData('missing-id', { name: 'x' })).toBeNull();
  });
});

describe('updateConnectionProxyPoolSnapshotIfBound', () => {
  it('writes the pair only while the expected pool still owns the row', async () => {
    const conn = await repo.createProviderConnection({
      provider: 'p-pool',
      authType: 'apikey',
      name: 'pool-1',
      apiKey: 'k',
      providerSpecificData: { proxyPoolId: 'pool-A' },
    });
    const updated = await repo.updateConnectionProxyPoolSnapshotIfBound(conn.id, 'pool-A', {
      proxyPoolId: 'pool-B',
      strictProxy: true,
    });
    expect(updated.providerSpecificData).toMatchObject({
      proxyPoolId: 'pool-B',
      strictProxy: true,
    });

    // Pool moved on: a stale writer must not win.
    const stale = await repo.updateConnectionProxyPoolSnapshotIfBound(conn.id, 'pool-A', {
      proxyPoolId: 'pool-C',
      strictProxy: false,
    });
    expect(stale).toBeNull();
    const read = await repo.getProviderConnectionById(conn.id);
    expect(read.providerSpecificData.proxyPoolId).toBe('pool-B');
  });

  it('refuses a row with no providerSpecificData and an unknown id', async () => {
    const bare = await repo.createProviderConnection({
      provider: 'p-pool',
      authType: 'apikey',
      name: 'pool-2',
      apiKey: 'k2',
    });
    expect(
      await repo.updateConnectionProxyPoolSnapshotIfBound(bare.id, 'pool-A', {
        proxyPoolId: 'pool-B',
        strictProxy: true,
      })
    ).toBeNull();
    expect(
      await repo.updateConnectionProxyPoolSnapshotIfBound('missing-id', 'pool-A', {
        proxyPoolId: 'pool-B',
        strictProxy: true,
      })
    ).toBeNull();
  });

  it('coerces a non-true strictProxy to false', async () => {
    const conn = await repo.createProviderConnection({
      provider: 'p-pool',
      authType: 'apikey',
      name: 'pool-3',
      apiKey: 'k3',
      providerSpecificData: { proxyPoolId: 'pool-A' },
    });
    const updated = await repo.updateConnectionProxyPoolSnapshotIfBound(conn.id, 'pool-A', {
      proxyPoolId: 'pool-B',
      strictProxy: 'yes',
    });
    expect(updated.providerSpecificData.strictProxy).toBe(false);
  });
});

describe('bulk delete and explicit reorder', () => {
  it('deletes every row of a provider and reports the count', async () => {
    await repo.createProviderConnection({
      provider: 'p-bulk',
      authType: 'apikey',
      name: 'b-1',
      apiKey: '1',
    });
    await repo.createProviderConnection({
      provider: 'p-bulk',
      authType: 'apikey',
      name: 'b-2',
      apiKey: '2',
    });
    expect(await repo.deleteProviderConnectionsByProvider('p-bulk')).toBe(2);
    expect(await repo.deleteProviderConnectionsByProvider('p-bulk')).toBe(0);
    expect(await repo.getProviderConnections({ provider: 'p-bulk' })).toEqual([]);
  });

  it('reorderProviderConnections renumbers priorities from 1', async () => {
    const a = await repo.createProviderConnection({
      provider: 'p-reord',
      authType: 'apikey',
      name: 'r-1',
      apiKey: '1',
    });
    const b = await repo.createProviderConnection({
      provider: 'p-reord',
      authType: 'apikey',
      name: 'r-2',
      apiKey: '2',
    });
    // Distinct priorities exercise the first sort key. Each priority update
    // renumbers the provider, so the LAST write decides the raw values the
    // explicit call below sees: b low first, then a high, leaves b ahead.
    await repo.updateProviderConnection(b.id, { priority: 10 });
    await repo.updateProviderConnection(a.id, { priority: 40 });
    await repo.reorderProviderConnections('p-reord');
    const list = await repo.getProviderConnections({ provider: 'p-reord' });
    expect(list.map((c) => c.priority)).toEqual([1, 2]);
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });

  it('breaks a full priority+updatedAt tie deterministically by id', async () => {
    const x = await repo.createProviderConnection({
      provider: 'p-tie',
      authType: 'apikey',
      name: 't-1',
      apiKey: '1',
    });
    const y = await repo.createProviderConnection({
      provider: 'p-tie',
      authType: 'apikey',
      name: 't-2',
      apiKey: '2',
    });
    // Every repo write path renumbers as it goes, so an actual tie on both
    // priority and updatedAt (#1181's shape: two adjacent dashboard writes in
    // the same millisecond) can only be staged with raw column writes.
    const { getAdapter } = await import('@/lib/db/driver.js');
    const db = await getAdapter();
    const stamp = '2026-01-02T03:04:05.000Z';
    for (const id of [x.id, y.id]) {
      db.run(`UPDATE providerConnections SET priority = ?, updatedAt = ? WHERE id = ?`, [
        5,
        stamp,
        id,
      ]);
    }
    await repo.reorderProviderConnections('p-tie');
    const list = await repo.getProviderConnections({ provider: 'p-tie' });
    const expected = [x.id, y.id].sort((a, b) => String(a).localeCompare(String(b)));
    expect(list.map((c) => c.id)).toEqual(expected);
  });
});

describe('cleanupProviderConnections', () => {
  it('strips explicit nulls and empty providerSpecificData, counting each removal', async () => {
    const conn = await repo.createProviderConnection({
      provider: 'p-clean',
      authType: 'apikey',
      name: 'c-1',
      apiKey: 'k',
    });
    // Nulls cannot arrive through create (it filters them), so write them raw.
    await repo.updateProviderConnection(conn.id, {
      lastError: null,
      testStatus: null,
      providerSpecificData: {},
    });
    const cleaned = await repo.cleanupProviderConnections();
    // Not asserted to be idempotent-to-zero: the null email COLUMN is
    // re-materialized by rowToConn on every read, so oauth rows without an
    // email re-count on every sweep. This row's fields stay gone, though.
    expect(cleaned).toBeGreaterThanOrEqual(3);
    const read = await repo.getProviderConnectionById(conn.id);
    expect('lastError' in read).toBe(false);
    expect('providerSpecificData' in read).toBe(false);
  });
});

describe('github-derived connection names', () => {
  it('prefers githubLogin, then githubEmail, then email, then githubName', async () => {
    const byLogin = await repo.createProviderConnection({
      provider: 'github',
      authType: 'oauth',
      accessToken: 't',
      providerSpecificData: { githubLogin: 'octo', githubEmail: 'ge@x', githubName: 'Octo Cat' },
    });
    expect(byLogin.name).toBe('octo');
    const byGhName = await repo.createProviderConnection({
      provider: 'github',
      authType: 'oauth',
      accessToken: 't2',
      providerSpecificData: { githubName: 'Only Name' },
    });
    expect(byGhName.name).toBe('Only Name');
  });
});

describe('oauth dedup workspace tie-breaks', () => {
  const base = { provider: 'p-oauth', authType: 'oauth', email: 'same@x', accessToken: 't' };

  it('keeps a workspace-bearing login separate from a bare-email row', async () => {
    const bare = await repo.createProviderConnection({ ...base });
    const withWs = await repo.createProviderConnection({
      ...base,
      providerSpecificData: { chatgptAccountId: 'ws-1' },
    });
    expect(withWs.id).not.toBe(bare.id);
    // And the mirror direction: bare incoming does not collapse onto ws row.
    const bareAgain = await repo.createProviderConnection({ ...base, name: 'explicit' });
    expect(bareAgain.id).toBe(bare.id); // both bare rows match
  });

  it('keeps username-bearing and username-less identities apart, matches equal usernames', async () => {
    const u1 = await repo.createProviderConnection({
      provider: 'p-user',
      authType: 'oauth',
      email: 'u@x',
      accessToken: 't',
      providerSpecificData: { username: 'alice' },
    });
    const u1Again = await repo.createProviderConnection({
      provider: 'p-user',
      authType: 'oauth',
      email: 'u@x',
      accessToken: 't2',
      providerSpecificData: { username: 'alice' },
    });
    expect(u1Again.id).toBe(u1.id);
    const u2 = await repo.createProviderConnection({
      provider: 'p-user',
      authType: 'oauth',
      email: 'u@x',
      accessToken: 't3',
      providerSpecificData: { username: 'bob' },
    });
    expect(u2.id).not.toBe(u1.id);
    const bare = await repo.createProviderConnection({
      provider: 'p-user',
      authType: 'oauth',
      email: 'u@x',
      accessToken: 't4',
    });
    expect(bare.id).not.toBe(u1.id);
  });

  it('matches workspace rows on chatgptAccountId when both sides carry one', async () => {
    const ws = await repo.createProviderConnection({
      provider: 'p-ws',
      authType: 'oauth',
      email: 'w@x',
      accessToken: 't',
      providerSpecificData: { chatgptAccountId: 'ws-A' },
    });
    const same = await repo.createProviderConnection({
      provider: 'p-ws',
      authType: 'oauth',
      email: 'w@x',
      accessToken: 't2',
      providerSpecificData: { chatgptAccountId: 'ws-A' },
    });
    expect(same.id).toBe(ws.id);
    const other = await repo.createProviderConnection({
      provider: 'p-ws',
      authType: 'oauth',
      email: 'w@x',
      accessToken: 't3',
      providerSpecificData: { chatgptAccountId: 'ws-B' },
    });
    expect(other.id).not.toBe(ws.id);
  });
});

describe('degradation cause taxonomy', () => {
  it('classifies each persisted failure into its stable cause class', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const rows = [
      { name: 'd-rate', rateLimitedUntil: future, expectCause: 'rate_limited' },
      { name: 'd-429', errorCode: 429, expectCause: 'rate_limited' },
      { name: 'd-auth', testStatus: 'expired', expectCause: 'authentication' },
      { name: 'd-401', errorCode: 401, expectCause: 'authentication' },
      { name: 'd-unav', testStatus: 'unavailable', expectCause: 'unavailable' },
      { name: 'd-test', testStatus: 'error', expectCause: 'connection_test' },
      { name: 'd-up', errorCode: 599, expectCause: 'upstream_error' },
    ];
    for (const { name, expectCause, ...fields } of rows) {
      await repo.createProviderConnection({
        provider: `prov-${name}`,
        authType: 'apikey',
        name,
        apiKey: 'k',
        ...fields,
      });
      const summary = await repo.getUpstreamHealthSummary();
      const entry = summary.degradedProviders.find((p) => p.provider === `prov-${name}`);
      expect(entry?.likelyCauses, name).toContain(expectCause);
    }
    const counts = await repo.getUpstreamHealthCounts();
    expect(counts.degraded).toBeGreaterThanOrEqual(rows.length);
    expect(counts.total).toBeGreaterThanOrEqual(counts.degraded);
  });
});
