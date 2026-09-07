import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.DATA_DIR;
let tempDir, db, runMigrationOnce, backupDbLite, makeBackupDir, TABLES, buildCreateTableSql, SCHEMA_VERSION;
beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-migration-safety-'));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  ({ runMigrationOnce } = await import('../../src/lib/db/migrate.js'));
  ({ backupDbLite, makeBackupDir } = await import('../../src/lib/db/backup.js'));
  ({ TABLES, buildCreateTableSql, SCHEMA_VERSION } = await import('../../src/lib/db/schema.js'));
});
afterEach(() => {
  vi.restoreAllMocks();
  db?.close?.();
  db = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function open(driver = 'node:sqlite') {
  const modules = {
    'node:sqlite': () => import('../../src/lib/db/adapters/nodeSqliteAdapter.js').then(module => module.createNodeSqliteAdapter),
    'better-sqlite3': () => import('../../src/lib/db/adapters/betterSqliteAdapter.js').then(module => module.createBetterSqliteAdapter),
    'sql.js': () => import('../../src/lib/db/adapters/sqljsAdapter.js').then(module => module.createSqlJsAdapter),
  };
  const factory = await modules[driver]();
  db = await factory(path.join(tempDir, 'source.sqlite'));
  return db;
}

function legacyUsage() {
  db.exec('CREATE TABLE usageHistory(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp TEXT NOT NULL,provider TEXT,model TEXT,cost REAL)');
  db.run('INSERT INTO usageHistory(id,timestamp,provider,model,cost) VALUES(?,?,?,?,?)', [71, '2023-11-14T00:00:00Z', 'legacy', 'model', 1.25]);
}

describe('complete pre-schema backup', () => {
  it.each(['node:sqlite', 'better-sqlite3', 'sql.js', 'native-without-serialize'])('publishes all data and schema independently with %s', async driver => {
    await open(driver === 'native-without-serialize' ? 'node:sqlite' : driver);
    const backupAdapter = driver === 'native-without-serialize' ? { ...db, raw: {} } : db;
    db.exec('CREATE TABLE requestDetails(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE archivedSource(id INTEGER PRIMARY KEY AUTOINCREMENT,detailId TEXT REFERENCES requestDetails(id)); CREATE TABLE audit(value TEXT)');
    db.run('INSERT INTO requestDetails(id,data) VALUES(?,?)', ['old-detail', '{"preserved":true}']);
    db.run('INSERT INTO archivedSource(id,detailId) VALUES(?,?)', [700, 'old-detail']);
    db.run('DELETE FROM archivedSource WHERE id=?', [700]);
    db.run('INSERT INTO archivedSource(id,detailId) VALUES(?,?)', [71, 'old-detail']);
    db.exec('CREATE INDEX archive_detail ON archivedSource(detailId); CREATE VIEW archiveView AS SELECT * FROM archivedSource; CREATE TRIGGER archiveAudit AFTER INSERT ON archivedSource BEGIN INSERT INTO audit(value) VALUES(new.detailId); END');
    const before = db.all('SELECT * FROM requestDetails');
    const dir = makeBackupDir('complete');
    const backup = backupDbLite(backupAdapter, dir);
    db.run('UPDATE requestDetails SET data=?', ['changed-after-backup']);
    const restored = new DatabaseSync(backup);
    try {
      expect(restored.prepare('SELECT * FROM requestDetails').all()).toEqual(before);
      expect(restored.prepare('SELECT * FROM archiveView').all()).toEqual([{ id: 71, detailId: 'old-detail' }]);
      expect(restored.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('archivedSource').seq).toBe(700);
      expect(restored.prepare("SELECT name FROM sqlite_master WHERE name IN ('archive_detail','archiveAudit')").all()).toHaveLength(2);
      expect(restored.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.get('PRAGMA foreign_keys').foreign_keys).toBe(1);
      if (process.platform !== 'win32') expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    } finally { restored.close(); }
    expect(() => backupDbLite(backupAdapter, dir)).toThrow('already exists');
  });

  it('stops before any schema write if the required backup cannot be published', async () => {
    await open();
    legacyUsage();
    const rows = db.all('SELECT * FROM usageHistory');
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('fixture disk sync failed'); });
    await expect(runMigrationOnce(db)).rejects.toThrow('required pre-schema backup failed; migration stopped');
    sync.mockRestore();
    expect(db.get("SELECT name FROM sqlite_master WHERE name='_meta'")).toBeUndefined();
    expect(db.all('SELECT * FROM usageHistory')).toEqual(rows);
    await runMigrationOnce(db);
    expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe(String(SCHEMA_VERSION));
  });
});

describe('atomic additive schema migration', () => {
  it('backs up missing schema objects even when the stored version already matches', async () => {
    await open();
    await runMigrationOnce(db);
    db.exec('DROP INDEX idx_uh_completion');
    await runMigrationOnce({ ...db });
    expect(db.get("SELECT name FROM sqlite_master WHERE name='idx_uh_completion'")).toBeTruthy();
    const backups = fs.readdirSync(path.join(tempDir, 'db', 'backups'));
    expect(backups).toHaveLength(1);
    const beforeRepair = new DatabaseSync(path.join(tempDir, 'db', 'backups', backups[0], 'data.sqlite'));
    try {
      expect(beforeRepair.prepare("SELECT name FROM sqlite_master WHERE name='idx_uh_completion'").get()).toBeUndefined();
    } finally { beforeRepair.close(); }
  });

  it.each(['node:sqlite', 'better-sqlite3', 'sql.js'])('upgrades an unversioned populated predecessor without losing rows using %s', async driver => {
    await open(driver);
    legacyUsage();
    const before = db.all('SELECT * FROM usageHistory');
    await runMigrationOnce(db);
    const row = db.get('SELECT * FROM usageHistory');
    expect(row).toMatchObject(before[0]);
    expect(row.completionId).toBeNull();
    expect(row.requestId).toBeNull();
    expect(db.all("SELECT name FROM sqlite_master WHERE name='idx_uh_completion'")).toHaveLength(1);
    const backupDirs = fs.readdirSync(path.join(tempDir, 'db', 'backups'));
    expect(backupDirs).toHaveLength(1);
    const backup = new DatabaseSync(path.join(tempDir, 'db', 'backups', backupDirs[0], 'data.sqlite'));
    try {
      expect(backup.prepare('SELECT * FROM usageHistory').all()).toEqual(before);
      expect(backup.prepare("SELECT name FROM sqlite_master WHERE name='_meta'").get()).toBeUndefined();
    } finally { backup.close(); }
  });

  it('rolls back failed column expansion and can retry on the same adapter', async () => {
    await open();
    legacyUsage();
    const exec = db.exec.bind(db);
    const fail = vi.spyOn(db, 'exec').mockImplementation(sql => {
      if (sql.startsWith('ALTER TABLE usageHistory ADD COLUMN requestId ')) throw new Error('fixture column blocked');
      return exec(sql);
    });
    await expect(runMigrationOnce(db)).rejects.toThrow('add column usageHistory.requestId failed');
    expect(db.get("SELECT name FROM sqlite_master WHERE name='_meta'")).toBeUndefined();
    expect(db.all('PRAGMA table_info(usageHistory)').map(column => column.name)).toEqual(['id', 'timestamp', 'provider', 'model', 'cost']);
    expect(db.get('SELECT COUNT(*) AS count FROM usageHistory').count).toBe(1);
    fail.mockRestore();
    await runMigrationOnce(db);
    expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe(String(SCHEMA_VERSION));
  });

  it('refuses an unenforceable unique index without deleting duplicates or stamping completion', async () => {
    await open();
    for (const [name, definition] of Object.entries(TABLES)) db.exec(buildCreateTableSql(name, definition));
    db.run('INSERT INTO _meta(key,value) VALUES(?,?)', ['schemaVersion', '1']);
    db.run('INSERT INTO _meta(key,value) VALUES(?,?)', ['backupSchemaVersion', '1']);
    for (let i = 0; i < 2; i++) db.run('INSERT INTO usageHistory(timestamp,requestId) VALUES(?,?)', ['2023-11-14T00:00:00Z', 'legacy-duplicate']);
    await expect(runMigrationOnce(db)).rejects.toThrow('index for usageHistory failed');
    expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe('1');
    expect(db.get('SELECT COUNT(*) AS count FROM usageHistory').count).toBe(2);
    expect(db.get("SELECT name FROM sqlite_master WHERE name='idx_uh_ts'")).toBeUndefined();
  });
});
