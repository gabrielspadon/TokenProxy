// Schema 13 → 14 lands operationEvents additively, with the pre-change safety
// backup taken before the schema mutates. Same isolation pattern as
// db-migration-chain.test.js: fresh DATA_DIR per test, module reset per boot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-opmig-'));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe('schema 14: operation events', () => {
  // operationEvents landed at 14 and the table is what this file is about, so
  // the version is asserted as "at least 14, never 15", which keeps the
  // reservation guarded without breaking on every later additive bump.
  it('keeps operationEvents present and 15 reserved for project budgets', async () => {
    const { SCHEMA_VERSION, TABLES } = await import('@/lib/db/schema.js');
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
    expect(SCHEMA_VERSION).not.toBe(15);
    expect(TABLES.operationEvents).toBeDefined();
  });

  it('upgrading a version-13 database takes a backup before creating operationEvents', async () => {
    // The backup directory is named for the version pair it spans, so it is
    // derived rather than written down: hardcoding the target made this test
    // fail on a later additive bump that changed nothing it is testing.
    const { SCHEMA_VERSION } = await import('@/lib/db/schema.js');
    // Boot 1: current schema, then rewind the stored backup version to 13 and
    // drop the table, simulating a database written by the version-13 build.
    const { getAdapter } = await import('@/lib/db/driver.js');
    const db = await getAdapter();
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      ['{"keep":"me"}']
    );
    db.run(`UPDATE _meta SET value = '13' WHERE key = 'backupSchemaVersion'`);
    db.exec(`DROP TABLE operationEvents`);
    db.flush?.();
    db.close?.();

    // Boot 2: migration must back up first, then add the table additively.
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: boot2 } = await import('@/lib/db/driver.js');
    const db2 = await boot2();

    const backupsDir = path.join(tempDir, 'db', 'backups');
    const backups = fs
      .readdirSync(backupsDir)
      .filter((name) => name.startsWith(`schema-13-to-${SCHEMA_VERSION}`));
    expect(backups).toHaveLength(1);
    expect(fs.existsSync(path.join(backupsDir, backups[0], 'data.sqlite'))).toBe(true);

    const table = db2.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='operationEvents'`
    );
    expect(table?.name).toBe('operationEvents');
    // The unique start/terminal indexes exist on the migrated database too.
    const indexes = db2
      .all(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='operationEvents'`)
      .map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_operation_events_start', 'idx_operation_events_terminal'])
    );
    // Pre-existing data survived.
    expect(JSON.parse(db2.get(`SELECT data FROM settings WHERE id=1`).data)).toEqual({
      keep: 'me',
    });
    expect(db2.get(`SELECT value FROM _meta WHERE key='backupSchemaVersion'`).value).toBe(
      String(SCHEMA_VERSION)
    );
  });
});
