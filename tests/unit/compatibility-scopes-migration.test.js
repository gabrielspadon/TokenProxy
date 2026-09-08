import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir, db, migrate, tables, createSql, schemaVersion;
const original = process.env.DATA_DIR;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-compat-migration-'));
  process.env.DATA_DIR = dir; vi.resetModules();
  ({ runMigrationOnce: migrate } = await import('@/lib/db/migrate.js'));
  ({ TABLES: tables, buildCreateTableSql: createSql, SCHEMA_VERSION: schemaVersion } = await import('@/lib/db/schema.js'));
});
afterEach(() => {
  vi.restoreAllMocks(); db?.close(); db = null;
  fs.rmSync(dir, { recursive: true, force: true });
  if (original === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = original;
});
async function open(driver) {
  const factory = driver === 'sql.js'
    ? (await import('@/lib/db/adapters/sqljsAdapter.js')).createSqlJsAdapter
    : (await import('@/lib/db/adapters/betterSqliteAdapter.js')).createBetterSqliteAdapter;
  db = await factory(path.join(dir, 'source.sqlite'));
}
function seed() {
  db.exec(createSql('_meta', tables._meta));
  db.run("INSERT INTO _meta(key,value) VALUES('schemaVersion','1'),('backupSchemaVersion','28')");
  db.exec(createSql('compatibilityFixtures', tables.compatibilityFixtures));
  const legacy = { ...tables.compatibilityRuns, columns: { ...tables.compatibilityRuns.columns, scope: "TEXT NOT NULL CHECK (scope = 'local-translation')" } };
  db.exec(createSql('compatibilityRuns', legacy));
  db.exec('CREATE INDEX fixture_result_index ON compatibilityRuns(finishedAt,id)');
  db.exec('CREATE TABLE fixtureMutationAudit(id TEXT)');
  db.exec('CREATE TRIGGER fixture_result_update AFTER UPDATE ON compatibilityRuns BEGIN INSERT INTO fixtureMutationAudit(id) VALUES(NEW.id); END');
  db.run("INSERT INTO compatibilityFixtures VALUES('fixture',1,'installation-operator','Legacy','{}',?,0,?)", ['f'.repeat(64), '2026-09-01T00:00:00.000Z']);
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed-out', 'interrupted']) {
    db.run(`INSERT INTO compatibilityRuns(id,ownerScope,fixtureId,fixtureRevision,fixtureHash,scope,status,
      implementationVersion,processOwner,result,error,createdAt,startedAt,finishedAt)
      VALUES(?, 'installation-operator','fixture',1,?,'local-translation',?,'legacy-v1','old-owner',NULL,NULL,?,NULL,NULL)`,
    [status, 'f'.repeat(64), status, '2026-09-01T00:00:00.000Z']);
  }
  return db.all('SELECT * FROM compatibilityRuns ORDER BY id');
}

describe.each(['better-sqlite3', 'sql.js'])('compatibility scope migration on %s', driver => {
  it('preserves all historical runs, backup, indexes and triggers and retains controlled scopes after reopen', async () => {
    await open(driver); const before = seed();
    await migrate(db);
    expect(db.all('SELECT * FROM compatibilityRuns ORDER BY id')).toEqual(before);
    expect(db.all('SELECT * FROM fixtureMutationAudit')).toEqual([]);
    const backupDir = fs.readdirSync(path.join(dir, 'db/backups'));
    expect(backupDir).toHaveLength(1);
    const backup = new DatabaseSync(path.join(dir, 'db/backups', backupDir[0], 'data.sqlite'));
    try { expect(backup.prepare('SELECT * FROM compatibilityRuns ORDER BY id').all()).toEqual(before); }
    finally { backup.close(); }
    db.run("UPDATE compatibilityRuns SET scope='controlled-executor' WHERE id='queued'");
    db.run("UPDATE compatibilityRuns SET scope='controlled-gateway-routing' WHERE id='running'");
    expect(() => db.run("UPDATE compatibilityRuns SET scope='unbounded-inference' WHERE id='queued'")).toThrow();
    expect(db.all('SELECT * FROM fixtureMutationAudit')).toEqual([{ id: 'queued' }, { id: 'running' }]);
    expect(db.get("SELECT name FROM sqlite_master WHERE name='fixture_result_index'")).toBeTruthy();
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.get('PRAGMA integrity_check').integrity_check).toBe('ok');
    db.flush?.(); db.close(); await open(driver); await migrate(db);
    expect(db.get("SELECT scope FROM compatibilityRuns WHERE id='running'").scope).toBe('controlled-gateway-routing');
    expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe(String(schemaVersion));
    expect(fs.readdirSync(path.join(dir, 'db/backups'))).toHaveLength(1);
  });
  it('rolls back a failure after copying rows and can retry on the same adapter', async () => {
    await open(driver); const before = seed();
    const exec = db.exec.bind(db);
    const fail = vi.spyOn(db, 'exec').mockImplementation(sql => {
      if (sql.startsWith('ALTER TABLE compatibilityRuns_scope_v2')) throw new Error('Synthetic rename failure');
      return exec(sql);
    });
    await expect(migrate(db)).rejects.toThrow('Synthetic rename failure');
    expect(db.all('SELECT * FROM compatibilityRuns ORDER BY id')).toEqual(before);
    expect(db.get("SELECT value FROM _meta WHERE key='schemaVersion'").value).toBe('1');
    expect(db.get("SELECT name FROM sqlite_master WHERE name='compatibilityRuns_scope_v2'")).toBeFalsy();
    fail.mockRestore(); await migrate(db);
    expect(db.all('SELECT * FROM compatibilityRuns ORDER BY id')).toEqual(before);
  });
});
