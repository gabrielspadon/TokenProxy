import { expect, it } from 'vitest';
import { createBetterSqliteAdapter } from '@/lib/db/adapters/betterSqliteAdapter.js';
import { runMigrationOnce } from '@/lib/db/migrate.js';
import { TABLES, SCHEMA_VERSION, buildCreateTableSql } from '@/lib/db/schema.js';
import { join } from 'node:path';

it('migrates actual version10 pins without changing binding, deadlines or inventing control history', async () => {
  expect(process.env.DATA_DIR).toMatch(/tokenproxy-test-file-/);
  const file = join(process.env.DATA_DIR, 'pin-v10.sqlite'), db = createBetterSqliteAdapter(file);
  db.exec(buildCreateTableSql('_meta', TABLES._meta));
  db.run("INSERT INTO _meta(key,value) VALUES('schemaVersion','1'),('backupSchemaVersion','10')");
  const oldColumns = { ...TABLES.sessionAffinity.columns }; delete oldColumns.operatorExpiresAt;
  db.exec(buildCreateTableSql('sessionAffinity', { ...TABLES.sessionAffinity, columns: oldColumns }));
  const pin = ['a'.repeat(64), 'claude-fable-5', 'kept-account', null, '2026-09-01T00:00:00.000Z', null, '2026-09-06T00:00:00.000Z'];
  db.run('INSERT INTO sessionAffinity(sessionHash,model,connectionId,providerNode,pinnedAt,expiresAt,lastSeenAt) VALUES(?,?,?,?,?,?,?)', pin);
  await runMigrationOnce(db);
  const after = db.get('SELECT * FROM sessionAffinity');
  expect(after).toEqual(Object.fromEntries(['sessionHash','model','connectionId','providerNode','pinnedAt','expiresAt','lastSeenAt','operatorExpiresAt'].map((key, i) => [key, i === 7 ? null : pin[i]])));
  expect(db.get('SELECT COUNT(*) AS n FROM sessionPinActions').n).toBe(0);
  expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe(String(SCHEMA_VERSION));
  db.close();
  const reopened = createBetterSqliteAdapter(file);
  expect(reopened.get('SELECT * FROM sessionAffinity')).toEqual(after);
  reopened.close();
});
