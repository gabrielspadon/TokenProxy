import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.DATA_DIR;
const outcomeColumns = ['targetModel', 'outcome', 'resourceType', 'unit', 'observationId', 'jobId'];
const historicalCheck = {
  id: 'historical-check',
  checkId: 'historical-cycle',
  connectionId: 'fixture-account',
  provider: 'fixture-provider',
  scope: 'weekly',
  source: 'auto-ping',
  eventType: 'warm-recorded',
  scheduledFor: '2024-01-01T12:00:00.000Z',
  resetAt: '2024-01-01T12:00:00.000Z',
  observedAt: null,
  capturedAt: '2024-01-01T12:01:00.000Z',
  code: 'legacy-warm-result',
};

let tempDir;
let db;
let runMigrationOnce;
let schemaVersion;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-quota-outcomes-'));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  ({ runMigrationOnce } = await import('../../src/lib/db/migrate.js'));
  ({ SCHEMA_VERSION: schemaVersion } = await import('../../src/lib/db/schema.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  db = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function open(driver) {
  const factory = driver === 'better-sqlite3'
    ? (await import('../../src/lib/db/adapters/betterSqliteAdapter.js')).createBetterSqliteAdapter
    : (await import('../../src/lib/db/adapters/sqljsAdapter.js')).createSqlJsAdapter;
  db = await factory(path.join(tempDir, 'source.sqlite'));
}

function seedLegacyCheck() {
  db.exec(`
    CREATE TABLE _meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE quotaCheckEvents(
      id TEXT PRIMARY KEY, checkId TEXT NOT NULL, connectionId TEXT NOT NULL,
      provider TEXT, scope TEXT, source TEXT NOT NULL, eventType TEXT NOT NULL,
      scheduledFor TEXT, resetAt TEXT, observedAt TEXT, capturedAt TEXT NOT NULL, code TEXT
    );
  `);
  db.run('INSERT INTO _meta(key,value) VALUES(?,?)', ['schemaVersion', '1']);
  db.run('INSERT INTO _meta(key,value) VALUES(?,?)', ['backupSchemaVersion', '22']);
  db.run(`INSERT INTO quotaCheckEvents(
    id,checkId,connectionId,provider,scope,source,eventType,
    scheduledFor,resetAt,observedAt,capturedAt,code
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, Object.values(historicalCheck));
}

function backupDirectories() {
  return fs.readdirSync(path.join(tempDir, 'db', 'backups'));
}

describe.each(['better-sqlite3', 'sql.js'])('quota outcome migration with %s', driver => {
  it('backs up the original schema, preserves unknown history, and persists exact new outcomes across reopen', async () => {
    await open(driver);
    seedLegacyCheck();
    const oldSchema = db.all('PRAGMA table_info(quotaCheckEvents)');
    const oldRows = db.all('SELECT * FROM quotaCheckEvents');

    await runMigrationOnce(db);

    expect(schemaVersion).toBeGreaterThanOrEqual(23);
    expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe(String(schemaVersion));
    const unknownOutcome = Object.fromEntries(outcomeColumns.map(name => [name, null]));
    expect(db.get('SELECT * FROM quotaCheckEvents WHERE id=?', [historicalCheck.id]))
      .toEqual({ ...historicalCheck, ...unknownOutcome });
    const addedColumns = db.all('PRAGMA table_info(quotaCheckEvents)').filter(column => outcomeColumns.includes(column.name));
    expect(addedColumns.map(column => column.name).sort()).toEqual([...outcomeColumns].sort());
    for (const column of addedColumns) {
      expect(column).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    }

    const backups = backupDirectories();
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(path.join(tempDir, 'db', 'backups', backups[0], 'data.sqlite'));
    try {
      expect(backup.prepare('SELECT * FROM quotaCheckEvents').all()).toEqual(oldRows);
      expect(backup.prepare('PRAGMA table_info(quotaCheckEvents)').all()).toEqual(oldSchema);
      expect(backup.prepare("SELECT value FROM _meta WHERE key='backupSchemaVersion'").get().value).toBe('22');
      expect(backup.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
    } finally {
      backup.close();
    }

    const observationId = 'a'.repeat(64);
    db.run(`INSERT INTO quotaObservations(
      id,connectionId,provider,scope,source,observationKind,resourceType,unit,
      remaining,"limit",percentage,resetAt,observedAt,capturedAt,confidence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      observationId, 'fixture-account', 'fixture-provider', 'weekly', 'fixture-test',
      'provider-reported', 'requests', 'requests', 40, 100, 60,
      '2026-09-15T00:00:00.000Z', '2026-09-08T12:00:00.000Z', '2026-09-08T12:00:01.000Z', 'reported',
    ]);
    const acceptedCheck = {
      ...historicalCheck,
      id: 'accepted-check',
      checkId: 'accepted-cycle',
      eventType: 'warm-outcome',
      capturedAt: '2026-09-08T12:00:02.000Z',
      code: null,
      targetModel: 'fixture-model',
      outcome: 'accepted',
      resourceType: 'requests',
      unit: 'requests',
      observationId,
    };
    db.run(`INSERT INTO quotaCheckEvents(
      id,checkId,connectionId,provider,scope,source,eventType,
      scheduledFor,resetAt,observedAt,capturedAt,code,
      targetModel,outcome,resourceType,unit,observationId
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, Object.values(acceptedCheck));

    const schemaAfterMigration = db.all('PRAGMA table_info(quotaCheckEvents)');
    await runMigrationOnce(db);
    db.close();
    db = null;
    await open(driver);
    await runMigrationOnce(db);

    expect(db.get('SELECT * FROM quotaCheckEvents WHERE id=?', [acceptedCheck.id])).toEqual({ ...acceptedCheck, jobId: null });
    expect(db.get('SELECT * FROM quotaCheckEvents WHERE id=?', [historicalCheck.id]))
      .toEqual({ ...historicalCheck, ...unknownOutcome });
    expect(db.get(`SELECT o.id,o.connectionId,o.provider,o.scope,o.resourceType,o.unit
      FROM quotaCheckEvents c JOIN quotaObservations o ON o.id=c.observationId WHERE c.id=?`, [acceptedCheck.id]))
      .toEqual({ id: observationId, connectionId: 'fixture-account', provider: 'fixture-provider', scope: 'weekly', resourceType: 'requests', unit: 'requests' });
    expect(db.all('PRAGMA table_info(quotaCheckEvents)')).toEqual(schemaAfterMigration);
    expect(db.get('SELECT COUNT(*) AS count FROM quotaCheckEvents').count).toBe(2);
    expect(backupDirectories()).toEqual(backups);
    expect(db.get('PRAGMA integrity_check').integrity_check).toBe('ok');
  });

  it('stops before changing quota history when the required backup cannot be persisted', async () => {
    await open(driver);
    seedLegacyCheck();
    const oldSchema = db.all('PRAGMA table_info(quotaCheckEvents)');
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('fixture backup fsync failed'); });

    await expect(runMigrationOnce(db)).rejects.toThrow('required pre-schema backup failed; migration stopped');
    fsync.mockRestore();

    expect(db.all('PRAGMA table_info(quotaCheckEvents)')).toEqual(oldSchema);
    expect(db.all('SELECT * FROM quotaCheckEvents')).toEqual([historicalCheck]);
    expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe('22');
    await runMigrationOnce(db);
    expect(db.get('SELECT outcome,observationId FROM quotaCheckEvents WHERE id=?', [historicalCheck.id]))
      .toEqual({ outcome: null, observationId: null });
  });
});
