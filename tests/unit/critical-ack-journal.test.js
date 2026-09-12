import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { createBetterSqliteAdapter } from '../../src/lib/db/adapters/betterSqliteAdapter.js';
import { createSqlJsAdapter } from '../../src/lib/db/adapters/sqljsAdapter.js';
import { captureCriticalAcknowledgments, recoverCriticalAcknowledgment, criticalAckDigest,
  criticalAckCanonicalJson, validateCriticalAcknowledgmentCapture, getCriticalAcknowledgmentRuntime } from '../../src/lib/db/adapters/criticalAckJournal.js';

const factories = { node: createNodeSqliteAdapter, better: createBetterSqliteAdapter, sqljs: createSqlJsAdapter };
let directory;
const adapters = [];
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'tokenproxy-ack-test-'));
  vi.stubEnv('TP_BUILD_SHA', 'a'.repeat(40));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (adapters.length) adapters.pop().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
async function fixture(kind) {
  const databaseFile = join(directory, `${kind}.sqlite`);
  const db = await factories[kind](databaseFile);
  adapters.push(db);
  db.exec('CREATE TABLE business(id INTEGER PRIMARY KEY, value TEXT)');
  db.flush?.();
  return { db, databaseFile, journal: `${databaseFile}.critical-acks`, capture: () => captureCriticalAcknowledgments({ databaseFile, db }) };
}
function failAckPublication(journal) {
  const link = fs.linkSync.bind(fs);
  return vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
    if (String(target).startsWith(join(journal, 'ack-'))) throw Object.assign(new Error('synthetic storage failure'), { code: 'ENOSPC' });
    return link(source, target);
  });
}

describe.each(Object.keys(factories))('%s critical acknowledgments', (kind) => {
  it('retains independent full-row receipts before return and reconciles after reopen', async () => {
    const { db, databaseFile, journal, capture } = await fixture(kind);
    const values = ['private credential fixture', 'private SQL parameter'];
    for (const [index, value] of values.entries()) {
      expect(db.criticalTransaction(() => {
        db.run('INSERT INTO business VALUES (?, ?)', [index + 1, value]);
        return index;
      })).toBe(index);
      const current = capture();
      expect(current.failures).toEqual([]);
      expect(current.unobservable).toEqual([]);
      expect(validateCriticalAcknowledgmentCapture(current)).toBe(current);
      expect(current.counters).toMatchObject({ ackEligible: index + 1, missingReceipts: 0, unresolvedIntents: 0 });
    }
    const before = capture();
    expect(before.acknowledgmentScope).toBe('durable-before-return');
    expect(before.callerObserved).toBeNull();
    expect(before.database.markers.map((marker) => marker.mutationChanges)).toEqual([1, 1]);
    expect(before.database.markers[1].previousMarkerSha256).toBe(before.database.markers[0].markerSha256);
    expect(before.journal.records.map((receipt) => receipt.marker)).toEqual(before.database.markers);
    for (const name of fs.readdirSync(journal)) {
      const content = fs.readFileSync(join(journal, name), 'utf8');
      for (const value of values) expect(content).not.toContain(value);
      expect(content).not.toContain('INSERT INTO');
      if (process.platform !== 'win32') expect(fs.statSync(join(journal, name)).mode & 0o077).toBe(0);
    }
    const reopened = await factories[kind](databaseFile);
    adapters.push(reopened);
    const after = captureCriticalAcknowledgments({ databaseFile, db: reopened });
    expect(after.database).toEqual(before.database);
    expect(after.journal).toEqual(before.journal);
    expect(reopened.all('SELECT * FROM business')).toHaveLength(2);
  });

  it('reports a committed, non-retryable ACK failure and repairs only the receipt', async () => {
    const { db, databaseFile, journal, capture } = await fixture(kind);
    const blocker = failAckPublication(journal);
    let callbackRuns = 0;
    let failure;
    try {
      db.criticalTransaction(() => { callbackRuns += 1; db.run('INSERT INTO business VALUES (1, ?)', ['committed']); });
    } catch (error) { failure = error; }
    blocker.mockRestore();
    expect(failure).toMatchObject({ code: 'CRITICAL_TRANSACTION_ACK_UNCONFIRMED', committed: true,
      commitState: 'committed', acknowledgmentState: 'unknown', retryable: false });
    expect(callbackRuns).toBe(1);
    expect(db.get('SELECT value FROM business')).toEqual({ value: 'committed' });
    expect(capture().counters).toMatchObject({ committedMarkers: 1, ackEligible: 0, failedAttempts: 1, missingReceipts: 1 });
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(databaseFile, { readOnly: true });
    const readOnly = { get: (sql, params = []) => raw.prepare(sql).get(...params) };
    try {
      const first = recoverCriticalAcknowledgment({ databaseFile, db: readOnly, transactionId: failure.transactionId });
      const second = recoverCriticalAcknowledgment({ databaseFile, db: readOnly, transactionId: failure.transactionId });
      expect(second).toEqual(first);
      expect(first.marker.transactionId).toBe(failure.transactionId);
      expect(callbackRuns).toBe(1);
      expect(raw.prepare('SELECT COUNT(*) AS n FROM business').get().n).toBe(1);
    } finally { raw.close(); }
    expect(capture().counters).toMatchObject({ ackEligible: 1, missingReceipts: 0, unresolvedIntents: 0, failedAttempts: 1 });
    expect(capture().failures).toEqual([]);
  });

  it.runIf(kind !== 'sqljs')('never replays a mutation after a lost native COMMIT result', async () => {
    const { db, capture } = await fixture(kind);
    const execute = db.raw.exec.bind(db.raw);
    const lostResult = vi.spyOn(db.raw, 'exec').mockImplementation((sql) => {
      const result = execute(sql);
      if (sql === 'COMMIT') throw new Error('synthetic lost commit result');
      return result;
    });
    const mutation = vi.fn(() => db.run('INSERT INTO business VALUES (1, ?)', ['committed']));
    expect(() => db.criticalTransaction(mutation)).toThrow(expect.objectContaining({
      code: 'CRITICAL_TRANSACTION_ACK_UNCONFIRMED', commitState: 'uncertain', committed: null,
      retryable: false, acknowledgmentState: 'unknown',
    }));
    lostResult.mockRestore();
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(db.get('SELECT value FROM business')).toEqual({ value: 'committed' });
    expect(capture().counters).toMatchObject({ committedMarkers: 1, ackEligible: 0, missingReceipts: 1 });
    expect(db.get('PRAGMA synchronous').synchronous).toBe(1);
  });

  it('rolls back business failures but retains their failed intent independently', async () => {
    const { db, capture } = await fixture(kind);
    db.criticalTransaction(() => db.run('INSERT INTO business VALUES (1, ?)', ['previous']));
    const epoch = capture().epoch;
    expect(() => db.criticalTransaction(() => {
      db.run('INSERT INTO business VALUES (2, ?)', ['rolled-back']);
      throw new Error('business rejection');
    })).toThrow('business rejection');
    expect(db.all('SELECT * FROM business')).toHaveLength(1);
    expect(capture()).toMatchObject({ epoch, counters: { createdIntents: 2, committedMarkers: 1, ackEligible: 1,
      failedAttempts: 1, unresolvedIntents: 0, missingReceipts: 0 } });
    db.criticalTransaction(() => db.run('INSERT INTO business VALUES (3, ?)', ['next']));
    expect(capture().database.markers.map((marker) => marker.sequence)).toEqual([1, 2]);
  });

  it('never invokes a mutation when the external intent cannot be persisted', async () => {
    const { db, databaseFile } = await fixture(kind);
    const write = fs.writeFileSync.bind(fs);
    const fault = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, ...args) => {
      if (typeof target === 'number') throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
      return write(target, ...args);
    });
    const mutation = vi.fn(() => db.run('INSERT INTO business VALUES (1, ?)', ['must-not-run']));
    expect(() => db.criticalTransaction(mutation)).toThrow();
    fault.mockRestore();
    expect(mutation).not.toHaveBeenCalled();
    expect(db.all('SELECT * FROM business')).toEqual([]);
    expect(getCriticalAcknowledgmentRuntime({ databaseFile }).counters).toMatchObject({
      startedAttempts: 1, createdIntents: 0, acknowledgedReturnsEligible: 0, failedAttempts: 1, omittedAttempts: 1,
    });
  });

  it('keeps markers immutable and detects absent receipt or tampered source', async () => {
    const { db, journal, capture } = await fixture(kind);
    db.criticalTransaction(() => db.run('INSERT INTO business VALUES (1, ?)', ['retained']));
    expect(() => db.run('DELETE FROM criticalAckMarkers')).toThrow('immutable');
    expect(() => db.run('UPDATE criticalAckMarkers SET mutationChanges = 99')).toThrow('immutable');
    const name = fs.readdirSync(journal).find((value) => value.startsWith('ack-'));
    const file = join(journal, name);
    const bytes = fs.readFileSync(file);
    fs.unlinkSync(file);
    expect(capture().unobservable).toContain('missing-receipts');
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const record = JSON.parse(bytes);
    record.marker.mutationChanges += 1;
    fs.writeFileSync(file, criticalAckCanonicalJson(record) + '\n');
    expect(capture().unobservable).toContain('source-invalid-or-unreadable');
  });
});

it('makes missing sources, unknown build identities, and capture bounds explicit', async () => {
  vi.stubEnv('TP_BUILD_SHA', 'unknown');
  const { db, capture } = await fixture('node');
  expect(capture().unobservable).toContain('source-unavailable');
  db.criticalTransaction(() => {});
  expect(capture().unobservable).toContain('build-identity:1');
  expect(capture().database.markers[0].mutationChanges).toBe(0);
  const bounded = captureCriticalAcknowledgments({ databaseFile: join(directory, 'node.sqlite'), db, maxRecords: 0 });
  expect(bounded.unobservable).toContain('source-invalid-or-unreadable');
});

it('rejects fabricated counters or incomplete retained inventories at the collector boundary', async () => {
  const { db, capture, databaseFile } = await fixture('node');
  const before = getCriticalAcknowledgmentRuntime({ databaseFile });
  expect(before).toMatchObject({ schemaVersion: 1, buildSha: 'a'.repeat(40), counters: { startedAttempts: 0, omittedAttempts: 0 } });
  db.criticalTransaction(() => db.run('INSERT INTO business VALUES (1, ?)', ['committed']));
  const value = capture();
  const fabricated = structuredClone(value);
  fabricated.counters.ackEligible += 1;
  expect(() => validateCriticalAcknowledgmentCapture(fabricated)).toThrow('counters mismatch');
  const missing = structuredClone(value);
  missing.journal.inventory.pop();
  expect(() => validateCriticalAcknowledgmentCapture(missing)).toThrow('inventory mismatch');
  const after = getCriticalAcknowledgmentRuntime({ databaseFile });
  expect(after.processInstanceId).toBe(before.processInstanceId);
  expect(after.enabledAt).toBe(before.enabledAt);
  expect(after.counters).toMatchObject({ startedAttempts: 1, createdIntents: 1, acknowledgedReturnsEligible: 1, omittedAttempts: 0 });
});

it.runIf(process.platform !== 'win32')('rejects symlink journals before executing a callback', async () => {
  const { db, journal } = await fixture('node');
  const victim = join(directory, 'victim');
  fs.mkdirSync(victim, { mode: 0o700 });
  fs.symlinkSync(victim, journal);
  const callback = vi.fn();
  expect(() => db.criticalTransaction(callback)).toThrow();
  expect(callback).not.toHaveBeenCalled();
  expect(fs.readdirSync(victim)).toEqual([]);
});

it('refuses a restored database that would reuse an already acknowledged sequence', async () => {
  const { db, databaseFile, capture } = await fixture('sqljs');
  db.criticalTransaction(() => db.run('INSERT INTO business VALUES (1, ?)', ['before']));
  const oldBytes = fs.readFileSync(databaseFile);
  db.criticalTransaction(() => db.run('INSERT INTO business VALUES (2, ?)', ['after']));
  expect(capture().counters.ackEligible).toBe(2);
  db.close();
  fs.writeFileSync(databaseFile, oldBytes);
  const stale = await createSqlJsAdapter(databaseFile);
  adapters.push(stale);
  const callback = vi.fn();
  expect(() => stale.criticalTransaction(callback)).toThrow('already been acknowledged');
  expect(callback).not.toHaveBeenCalled();
  const snapshot = captureCriticalAcknowledgments({ databaseFile, db: stale });
  expect(snapshot.failures).toContain('missing-marker:2');
});

it.each(['before-receipt', 'after-receipt'])('retains honest evidence across an owned process exit %s', async (phase) => {
  const databaseFile = join(directory, 'child.sqlite');
  const adapterUrl = new URL('../../src/lib/db/adapters/nodeSqliteAdapter.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import {createNodeSqliteAdapter} from ${JSON.stringify(adapterUrl)};
    const file = process.argv[1];
    const db = await createNodeSqliteAdapter(file);
    db.exec('CREATE TABLE business (id INTEGER)');
    const link = fs.linkSync.bind(fs);
    fs.linkSync = (source, target) => {
      if (${JSON.stringify(phase)} === 'before-receipt' && target.includes('/ack-')) process.exit(41);
      return link(source, target);
    };
    const sync = fs.fsyncSync.bind(fs);
    fs.fsyncSync = (fd) => {
      sync(fd);
      if (${JSON.stringify(phase)} === 'after-receipt' && fs.fstatSync(fd).isDirectory()
          && fs.readdirSync(file + '.critical-acks').some(name => name.startsWith('ack-'))) process.exit(42);
    };
    db.criticalTransaction(() => db.run('INSERT INTO business VALUES (1)'));
    process.exit(99);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, databaseFile], {
    env: { ...process.env, TP_BUILD_SHA: 'a'.repeat(40) }, timeout: 15_000, encoding: 'utf8',
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(phase === 'before-receipt' ? 41 : 42);
  const db = await createNodeSqliteAdapter(databaseFile);
  adapters.push(db);
  const snapshot = captureCriticalAcknowledgments({ databaseFile, db });
  expect(db.get('SELECT COUNT(*) AS n FROM business').n).toBe(1);
  expect(snapshot.database.markers).toHaveLength(1);
  expect(snapshot.counters.ackEligible).toBe(phase === 'before-receipt' ? 0 : 1);
  expect(snapshot.callerObserved).toBeNull();
  if (phase === 'before-receipt') expect(snapshot.unobservable).toContain('missing-receipts');
  else expect(snapshot.unobservable).toEqual([]);
});

it('uses deterministic field-order independent full-row digests', () => {
  expect(criticalAckDigest({ b: 2, a: 1 })).toBe(criticalAckDigest({ a: 1, b: 2 }));
  expect(criticalAckDigest({ a: 1 })).not.toBe(criticalAckDigest({ a: '1' }));
});
