import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { createSqlJsAdapter } from '../../src/lib/db/adapters/sqljsAdapter.js';
import { runMigrationOnce } from '../../src/lib/db/migrate.js';
import { REQUEST_REPLAY_COLUMNS } from '../../src/lib/db/replayEvidence.js';
import { CRITICAL_ACK_TABLES } from '../../src/lib/db/criticalAckSchema.js';
import { SCHEMA_VERSION } from '../../src/lib/db/schema.js';

let directory, db;
afterEach(() => {
  db?.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

describe.each([['native', createNodeSqliteAdapter], ['sql.js', createSqlJsAdapter]])('%s evidence schema', (_name, open) => {
  it('upgrades layout 40 atomically and restores a missing immutability trigger', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-evidence-schema-'));
    db = await open(path.join(directory, 'fixture.sqlite'));
    await runMigrationOnce(db);
    for (const table of Object.keys(CRITICAL_ACK_TABLES)) db.exec(`DROP TABLE ${table}`);
    for (const column of Object.keys(REQUEST_REPLAY_COLUMNS)) db.exec(`ALTER TABLE requestStats DROP COLUMN ${column}`);
    db.run("UPDATE _meta SET value='40' WHERE key='backupSchemaVersion'");
    db.run('INSERT INTO requestStats(id,timestamp,provider,status,promptTokens) VALUES(?,?,?,?,?)',
      ['legacy-evidence', '2026-09-12T00:00:00.000Z', 'codex', 'success', 20000]);
    const before = db.all('SELECT * FROM requestStats');
    const failing = { ...db, exec(sql) {
      if (sql.includes('CREATE TRIGGER IF NOT EXISTS critical_ack_markers_no_update')) throw new Error('fixture trigger failure');
      return db.exec(sql);
    } };
    await expect(runMigrationOnce(failing)).rejects.toThrow('fixture trigger failure');
    expect(db.all('SELECT * FROM requestStats')).toEqual(before);
    expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe('40');
    expect(db.get("SELECT name FROM sqlite_master WHERE name='criticalAckMarkers'")).toBeUndefined();

    await runMigrationOnce({ ...db });
    expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe(String(SCHEMA_VERSION));
    expect(db.get('SELECT id,promptTokens,replayDisposition,replaySource,replayStatus,replayObservedAt FROM requestStats'))
      .toEqual({ id: 'legacy-evidence', promptTokens: 20000, replayDisposition: null, replaySource: null, replayStatus: null, replayObservedAt: null });
    db.criticalTransaction(() => db.run('INSERT INTO _meta(key,value) VALUES(?,?)', ['fixture-ack', 'observed']));
    expect(() => db.run('UPDATE criticalAckMarkers SET mutationChanges=99')).toThrow('immutable');
    expect(() => db.run('DELETE FROM criticalAckMarkers')).toThrow('immutable');
    db.exec('DROP TRIGGER critical_ack_markers_no_update');
    await runMigrationOnce({ ...db });
    expect(() => db.run('UPDATE criticalAckMarkers SET mutationChanges=99')).toThrow('immutable');
  });
});
