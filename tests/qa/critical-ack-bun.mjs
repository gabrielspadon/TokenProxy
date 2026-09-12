import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunSqliteAdapter } from '../../src/lib/db/adapters/bunSqliteAdapter.js';
import { captureCriticalAcknowledgments, validateCriticalAcknowledgmentCapture } from '../../src/lib/db/adapters/criticalAckJournal.js';

if (!process.versions.bun) throw new Error('Run with bun tests/qa/critical-ack-bun.mjs');
const directory = fs.mkdtempSync(join(tmpdir(), 'tokenproxy-bun-ack-'));
const databaseFile = join(directory, 'fixture.sqlite');
const previousBuild = process.env.TP_BUILD_SHA;
process.env.TP_BUILD_SHA = 'a'.repeat(40);
const link = fs.linkSync;
let db;
try {
  db = await createBunSqliteAdapter(databaseFile);
  db.exec('CREATE TABLE business (value INTEGER)');
  assert.equal(db.criticalTransaction(() => {
    assert.equal(db.get('PRAGMA synchronous').synchronous, 2);
    db.run('INSERT INTO business VALUES (?)', [1]);
    return 71;
  }), 71);
  const capture = captureCriticalAcknowledgments({ databaseFile, db });
  validateCriticalAcknowledgmentCapture(capture);
  assert.equal(capture.counters.ackEligible, 1);
  assert.equal(capture.database.markers[0].driver, 'bun:sqlite');
  assert.equal(db.get('PRAGMA synchronous').synchronous, 1);
  assert.throws(() => db.criticalTransaction(() => db.transaction(() => {})), { code: 'CRITICAL_TRANSACTION_NESTED' });
  fs.linkSync = (source, target) => {
    if (String(target).includes('/ack-')) throw new Error('synthetic receipt publication failure');
    return link(source, target);
  };
  assert.throws(() => db.criticalTransaction(() => db.run('INSERT INTO business VALUES (?)', [2])), {
    code: 'CRITICAL_TRANSACTION_ACK_UNCONFIRMED', committed: true, retryable: false, acknowledgmentState: 'unknown',
  });
  fs.linkSync = link;
  db.close();
  db = await createBunSqliteAdapter(databaseFile);
  assert.deepEqual(db.all('SELECT value FROM business ORDER BY value'), [{ value: 1 }, { value: 2 }]);
  assert.equal(captureCriticalAcknowledgments({ databaseFile, db }).counters.missingReceipts, 1);
  console.log(JSON.stringify({ kind: 'critical-ack-bun-test', bun: process.versions.bun, passed: true,
    checks: ['durable-return', 'native-marker', 'mode-restoration', 'nested-rejection', 'postcommit-no-replay', 'restart-reconciliation'] }));
} finally {
  fs.linkSync = link;
  db?.close();
  if (previousBuild === undefined) delete process.env.TP_BUILD_SHA;
  else process.env.TP_BUILD_SHA = previousBuild;
  fs.rmSync(directory, { recursive: true, force: true });
}
