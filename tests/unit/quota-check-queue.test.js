import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.DATA_DIR;
const now = Date.parse('2026-09-08T12:00:00.000Z');
const iso = value => new Date(value).toISOString();
const account = (id = 'account-one', provider = 'fixture-provider', cancelReason = null) => ({ id, provider, cancelReason });
let tempDir;
let db;
let replicaDb;
let queue;
let replica;
let createAdapter;
let createQuotaCheckQueue;
let runMigrationOnce;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-quota-queue-'));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  ({ createBetterSqliteAdapter: createAdapter } = await import('../../src/lib/db/adapters/betterSqliteAdapter.js'));
  ({ runMigrationOnce } = await import('../../src/lib/db/migrate.js'));
  ({ createQuotaCheckQueue } = await import('../../src/lib/db/repos/quotaCheckQueue.js'));
  db = createAdapter(path.join(tempDir, 'queue.sqlite'));
  await runMigrationOnce(db);
  queue = createQuotaCheckQueue(db);
  replicaDb = createAdapter(path.join(tempDir, 'queue.sqlite'));
  await runMigrationOnce(replicaDb);
  replica = createQuotaCheckQueue(replicaDb);
});

afterEach(() => {
  vi.restoreAllMocks();
  replicaDb?.close();
  db?.close();
  replicaDb = null;
  db = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function scheduledJob() {
  queue.reconcile([account()], now);
  const jobs = queue.due(10, now);
  expect(jobs).toHaveLength(1);
  return jobs[0];
}

function completion(overrides = {}) {
  return {
    nextCheckAt: iso(now + 60_000),
    reason: 'poll-not-before',
    targets: [],
    outcome: 'completed',
    ...overrides,
  };
}

function insertObservation({ id = 'a'.repeat(64), connectionId = 'account-one', provider = 'fixture-provider', scope = 'weekly' } = {}) {
  db.run(`INSERT INTO quotaObservations(
    id,connectionId,provider,scope,source,observationKind,resourceType,unit,
    remaining,"limit",percentage,resetAt,observedAt,capturedAt,confidence
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id, connectionId, provider, scope, 'fixture-test', 'provider-reported', 'requests',
    'requests', 40, 100, 60, iso(now + 60_000), iso(now), iso(now), 'reported',
  ]);
  return id;
}

describe('durable quota check queue', () => {
  it('preserves the exact next-check horizon when inventory is reconciled again', () => {
    const job = scheduledJob();
    const claim = queue.claim(job.id, now, 1_000);
    expect(queue.complete(claim, completion(), now + 1)).toBe(true);

    replica.reconcile([account()], now + 10_000);

    expect(replica.due(10, now + 59_999)).toEqual([]);
    expect(replica.due(10, now + 60_000)).toHaveLength(1);
    const { items, total } = replica.list({ connectionId: 'account-one' });
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ id: job.id, nextCheckAt: iso(now + 60_000), status: 'scheduled', reason: 'poll-not-before', lastOutcome: 'completed' });
  });

  it('allows only one adapter to claim a due job and hides its ownership secret from listings', () => {
    const job = scheduledJob();
    const claim = queue.claim(job.id, now, 1_000);

    expect(claim).toBeTruthy();
    expect(claim.checkId).toEqual(expect.any(String));
    expect(replica.claim(job.id, now, 1_000)).toBeNull();
    expect(queue.owns(claim, now + 999)).toBe(true);
    const listed = replica.list({ status: 'running' });
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({ id: job.id, connectionId: 'account-one', status: 'running' });
    expect(listed.items[0]).not.toHaveProperty('claimToken');
    expect(listed.items[0]).not.toHaveProperty('token');
  });

  it('renews a lease, reclaims its expiry, and refuses all writes from the stale owner', () => {
    const job = scheduledJob();
    const first = queue.claim(job.id, now, 1000);
    expect(queue.renew(first, now + 500, 1000)).toBe(true);
    expect(replica.claim(job.id, now + 1001, 1000)).toBeNull();
    expect(queue.owns(first, now + 1499)).toBe(true);
    expect(queue.owns(first, now + 1501)).toBe(false);

    const second = replica.claim(job.id, now + 1501, 1000);
    expect(second).toBeTruthy();
    expect(second.checkId).not.toBe(first.checkId);
    expect(queue.renew(first, now + 1502, 1000)).toBe(false);
    expect(queue.complete(first, completion(), now + 1502)).toBe(false);
    expect(replica.owns(second, now + 1502)).toBe(true);
    expect(replica.complete(second, completion({ outcome: 'failed', reason: 'retry-not-before' }), now + 1503)).toBe(true);
    expect(queue.list({ connectionId: 'account-one' }).items[0]).toMatchObject({ lastOutcome: 'failed', reason: 'retry-not-before' });
  });

  it('rejects completion at lease expiry even before another worker claims the job', () => {
    const job = scheduledJob();
    const claim = queue.claim(job.id, now, 1000);
    expect(queue.complete(claim, completion(), now + 1001)).toBe(false);
    expect(queue.renew(claim, now + 1001, 1000)).toBe(false);
    expect(replica.claim(job.id, now + 1001, 1000)).toBeTruthy();
  });

  it.each(['account-inactive', 'setting-disabled', 'auth-unsupported'])('cancels a running job for %s and re-enables the same account cleanly', reason => {
    const job = scheduledJob();
    const claim = queue.claim(job.id, now, 1_000);
    replica.reconcile([account('account-one', 'fixture-provider', reason)], now + 1);

    expect(queue.due(10, now + 2)).toEqual([]);
    expect(queue.owns(claim, now + 2)).toBe(false);
    expect(queue.complete(claim, completion(), now + 2)).toBe(false);
    expect(queue.list({ connectionId: 'account-one' }).items[0]).toMatchObject({ id: job.id, status: 'cancelled', cancelReason: reason });

    replica.reconcile([account()], now + 3);
    expect(queue.due(10, now + 3)).toHaveLength(1);
    expect(queue.list({ connectionId: 'account-one' }).items[0]).toMatchObject({ id: job.id, status: 'scheduled' });
  });

  it('cancels every outstanding job without allowing existing owners to finalize them', () => {
    queue.reconcile([account('account-one'), account('account-two')], now);
    const claim = queue.claim(queue.due(1, now)[0].id, now, 1_000);
    replica.cancelAll('setting-disabled', now + 1);

    expect(queue.due(10, now + 2)).toEqual([]);
    expect(queue.list({ status: 'cancelled' }).total).toBe(2);
    expect(queue.complete(claim, completion(), now + 2)).toBe(false);
  });

  it('applies scope and status filters before totals and pagination', () => {
    queue.reconcile([
      account('alpha-1', 'alpha'), account('alpha-2', 'alpha'), account('alpha-3', 'alpha'),
      account('beta-1', 'beta'), account('beta-2', 'beta'),
      account('alpha-cancelled', 'alpha', 'account-inactive'),
    ], now);

    const first = replica.list({ provider: 'alpha', status: 'scheduled', page: 1, pageSize: 2 });
    const second = replica.list({ provider: 'alpha', status: 'scheduled', page: 2, pageSize: 2 });
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map(job => job.connectionId)).size).toBe(3);
    expect([...first.items, ...second.items].every(job => job.provider === 'alpha' && job.status === 'scheduled')).toBe(true);
    expect(queue.list({ provider: 'beta', connectionId: 'alpha-1' })).toMatchObject({ items: [], total: 0 });
    expect(queue.due(2, now)).toHaveLength(2);
  });

  it('retains an exact prior observation and exposes its authoritative resource and unit', () => {
    const job = scheduledJob();
    const observationId = insertObservation();
    const claim = queue.claim(job.id, now, 1_000);
    const targets = [{ scope: 'weekly', observationId, resetAt: iso(now + 60_000) }];

    expect(queue.complete(claim, completion({ targets, reason: 'reset-not-before' }), now + 1)).toBe(true);

    expect(replica.list({ connectionId: 'account-one' }).items[0].targets).toEqual([
      { ...targets[0], resourceType: 'requests', unit: 'requests' },
    ]);
  });

  it.each([
    { connectionId: 'other-account' },
    { provider: 'other-provider' },
    { scope: 'monthly' },
  ])('refuses a target linked to a mismatched observation %j', mismatch => {
    const job = scheduledJob();
    const observationId = insertObservation(mismatch);
    const claim = queue.claim(job.id, now, 1_000);

    expect(() => queue.complete(claim, completion({ targets: [{ scope: 'weekly', observationId, resetAt: iso(now + 60_000) }] }), now + 1)).toThrow();

    expect(queue.owns(claim, now + 1)).toBe(true);
    expect(replica.list({ connectionId: 'account-one' }).items[0].status).toBe('running');
  });

  it('does not manufacture measurements when a target has no prior observation', () => {
    const job = scheduledJob();
    const claim = queue.claim(job.id, now, 1_000);
    expect(queue.complete(claim, completion({ targets: [{ scope: 'weekly', observationId: null, resetAt: null }] }), now + 1)).toBe(true);
    expect(replica.list({ connectionId: 'account-one' }).items[0].targets).toEqual([
      { scope: 'weekly', observationId: null, resetAt: null, resourceType: null, unit: null },
    ]);
  });

  it('refuses a reset timestamp that contradicts its linked prior observation', () => {
    const job = scheduledJob(), observationId = insertObservation();
    const claim = queue.claim(job.id, now, 1_000);
    expect(() => queue.complete(claim, completion({ targets: [{ scope: 'weekly', observationId, resetAt: iso(now + 99_000) }] }), now + 1)).toThrow('Quota reset does not match prior observation');
    expect(queue.owns(claim, now + 1)).toBe(true);
  });

  it('persists each cancellation transition and refuses cancellation by a stale claimant', () => {
    const job = scheduledJob(), first = queue.claim(job.id, now, 1_000);
    const second = replica.claim(job.id, now + 1_001, 1_000);
    expect(queue.cancel(first, 'scheduler-stopped', now + 1_002)).toBe(false);
    expect(replica.cancel(second, 'scheduler-stopped', now + 1_003)).toBe(true);
    queue.reconcile([account()], now + 1_004);
    queue.cancelAll('scheduler-stopped', now + 1_005);
    expect(db.all("SELECT * FROM quotaCheckEvents WHERE jobId=? AND eventType='cancelled'", [job.id])).toHaveLength(2);
  });

  it('persists the schedule, target links, and ownership expiry across adapter reopen', async () => {
    const job = scheduledJob();
    const observationId = insertObservation();
    const claim = queue.claim(job.id, now, 1_000);
    queue.complete(claim, completion({ targets: [{ scope: 'weekly', observationId, resetAt: iso(now + 60_000) }] }), now + 1);
    const before = queue.list({ connectionId: 'account-one' });
    replicaDb.close();
    replicaDb = null;
    db.close();
    db = null;

    db = createAdapter(path.join(tempDir, 'queue.sqlite'));
    await runMigrationOnce(db);
    queue = createQuotaCheckQueue(db);

    expect(queue.list({ connectionId: 'account-one' })).toEqual(before);
    expect(queue.due(10, now + 59_999)).toEqual([]);
    expect(queue.claim(job.id, now + 60_000, 1_000)).toBeTruthy();
  });
});
