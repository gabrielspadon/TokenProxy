import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createNodeSqliteAdapter } from '@/lib/db/adapters/nodeSqliteAdapter.js';
import { createBetterSqliteAdapter } from '@/lib/db/adapters/betterSqliteAdapter.js';
import { createSqlJsAdapter } from '@/lib/db/adapters/sqljsAdapter.js';
import { runMigrationOnce } from '@/lib/db/migrate.js';
import { SCHEMA_VERSION } from '@/lib/db/schema.js';

let db;
afterEach(() => {
  db?.close(); db = null;
  fs.rmSync(path.join(process.env.DATA_DIR, 'db'), { recursive: true, force: true });
});

it.each([
  ['node:sqlite', createNodeSqliteAdapter],
  ['better-sqlite3', createBetterSqliteAdapter],
  ['sql.js', createSqlJsAdapter],
])('preserves historical unknowns and readable pre-change evidence using %s', async (_name, create) => {
  const directory = path.join(process.env.DATA_DIR, 'db');
  fs.mkdirSync(directory, { recursive: true });
  db = await create(path.join(directory, 'data.sqlite'));
  db.exec(`CREATE TABLE _meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO _meta VALUES('schemaVersion','3'),('backupSchemaVersion','34');
    CREATE TABLE requestStats(id TEXT PRIMARY KEY,timestamp TEXT NOT NULL);
    CREATE TABLE usageHistory(id INTEGER PRIMARY KEY,timestamp TEXT NOT NULL);
    CREATE TABLE contextStages(requestId TEXT NOT NULL,ordinal INTEGER NOT NULL,stage TEXT NOT NULL,
      beforeBytes INTEGER NOT NULL,afterBytes INTEGER NOT NULL,deltaBytes INTEGER NOT NULL,
      outcome TEXT NOT NULL,risk TEXT NOT NULL,PRIMARY KEY(requestId,ordinal));`);
  db.run('INSERT INTO requestStats VALUES(?,?)', ['historical-request', '2026-09-05T12:00:00Z']);
  db.run('INSERT INTO usageHistory VALUES(?,?)', [41, '2026-09-05T12:00:00Z']);
  db.run('INSERT INTO contextStages VALUES(?,?,?,?,?,?,?,?)', ['historical-request', 0, 'rtk', 100, 80, -20, 'applied', 'low']);
  await runMigrationOnce(db);
  expect(db.get('SELECT dataOrigin,originReceiptId FROM requestStats')).toEqual({ dataOrigin: 'unknown', originReceiptId: null });
  expect(db.get('SELECT dataOrigin,originReceiptId FROM usageHistory')).toEqual({ dataOrigin: 'unknown', originReceiptId: null });
  expect(db.get('SELECT beforeBytes,afterBytes,deltaBytes,durationMs,durationSource FROM contextStages'))
    .toEqual({ beforeBytes: 100, afterBytes: 80, deltaBytes: -20, durationMs: null, durationSource: 'unknown' });
  expect(db.get('SELECT COUNT(*) AS n FROM telemetryQuarantineRows').n).toBe(0);
  expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe(String(SCHEMA_VERSION));
  const backups = fs.readdirSync(path.join(directory, 'backups'));
  expect(backups).toHaveLength(1);
  const backup = new DatabaseSync(path.join(directory, 'backups', backups[0], 'data.sqlite'), { readOnly: true });
  try {
    expect(backup.prepare('SELECT * FROM requestStats').all()).toEqual([{ id: 'historical-request', timestamp: '2026-09-05T12:00:00Z' }]);
    expect(backup.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
  } finally { backup.close(); }
  expect(() => db.run('UPDATE requestStats SET dataOrigin=?', ['client-claimed-production'])).toThrow();
  expect(() => db.run('UPDATE contextStages SET durationMs=?', [-1])).toThrow();
  db.run(`INSERT INTO logicalRequestOutcomes(logicalRequestId,state,firstObservedAt,clockDomain,updatedAt)
    VALUES(?,?,?,?,?)`, ['logical-one', 'pending', '2026-09-12T12:00:00Z', 'owned-clock', '2026-09-12T12:00:00Z']);
  db.run(`INSERT INTO frontRequestOutcomes(frontIngressId,logicalRequestId,state,firstObservedAt,clockDomain,receiptId,updatedAt)
    VALUES(?,?,?,?,?,?,?)`, ['front-one', 'logical-one', 'pending', '2026-09-12T12:00:00Z', 'front-clock', 'receipt-one', '2026-09-12T12:00:00Z']);
  expect(() => db.run(`INSERT INTO frontRequestOutcomes(frontIngressId,logicalRequestId,state,firstObservedAt,clockDomain,receiptId,updatedAt)
    VALUES(?,?,?,?,?,?,?)`, ['front-two', 'logical-one', 'pending', '2026-09-12T12:00:00Z', 'front-clock', 'receipt-two', '2026-09-12T12:00:00Z'])).toThrow();
  expect(db.get('SELECT state FROM logicalRequestOutcomes').state).toBe('pending');
});
