import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const original = process.env.DATA_DIR;
let root, db, migrate, schemaVersion;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-project-migration-'));
  process.env.DATA_DIR = root; vi.resetModules();
  ({ runMigrationOnce: migrate } = await import('@/lib/db/migrate.js'));
  ({ SCHEMA_VERSION: schemaVersion } = await import('@/lib/db/schema.js'));
});
afterEach(() => {
  db?.close(); db = null; fs.rmSync(root, { recursive: true, force: true });
  if (original === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = original;
});
async function open(driver) {
  const factory = driver === 'better-sqlite3' ? (await import('@/lib/db/adapters/betterSqliteAdapter.js')).createBetterSqliteAdapter : (await import('@/lib/db/adapters/sqljsAdapter.js')).createSqlJsAdapter;
  db = await factory(path.join(root, 'source.sqlite'));
}
describe.each(['better-sqlite3', 'sql.js'])('project attribution migration with %s', driver => {
  it('preserves unknown legacy quantities and reservations, then retains exact new project identities across reopen', async () => {
    await open(driver);
    const { TABLES, buildCreateTableSql } = await import('@/lib/db/schema.js');
    const { BUDGET_TABLES } = await import('@/lib/db/budgetSchema.js');
    const { USAGE_PROJECT_COLUMNS } = await import('@/lib/db/projectSchema.js');
    db.exec('CREATE TABLE _meta(key TEXT PRIMARY KEY,value TEXT)');
    db.exec(buildCreateTableSql('usageHistory', { ...TABLES.usageHistory, columns: Object.fromEntries(Object.entries(TABLES.usageHistory.columns).filter(([name]) => !(name in USAGE_PROJECT_COLUMNS))) }));
    db.exec(buildCreateTableSql('apiKeyBudgetReservations', BUDGET_TABLES.apiKeyBudgetReservations));
    db.run('INSERT INTO _meta(key,value) VALUES(?,?)', ['schemaVersion','1']);
    db.run('INSERT INTO _meta(key,value) VALUES(?,?)', ['backupSchemaVersion','21']);
    db.run('INSERT INTO usageHistory(timestamp,cost) VALUES(?,?)', ['2026-09-01T00:00:00.000Z',0]);
    db.run('INSERT INTO usageHistory(timestamp,cost) VALUES(?,?)', ['2026-09-01T00:01:00.000Z',null]);
    db.run('INSERT INTO apiKeyBudgetReservations(requestId,apiKeyId,state,reservedCompletionTokens,createdAt,updatedAt,policy) VALUES(?,?,?,?,?,?,?)', ['legacy-attempt','legacy-key','uncertain',100,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','strict']);
    await migrate(db);
    expect(schemaVersion).toBeGreaterThanOrEqual(22);
    expect(db.all('SELECT cost,projectId,projectRef,taskRef,clientKeyId,projectBindingId,projectPolicyRevision FROM usageHistory ORDER BY id')).toEqual([0,null].map(cost => ({cost,projectId:null,projectRef:null,taskRef:null,clientKeyId:null,projectBindingId:null,projectPolicyRevision:null})));
    expect(db.get('SELECT state,reservedCompletionTokens,projectReservedCompletionTokens,projectId FROM apiKeyBudgetReservations')).toEqual({state:'uncertain',reservedCompletionTokens:100,projectReservedCompletionTokens:null,projectId:null});
    expect(db.get('SELECT COUNT(*) AS n FROM projects').n).toBe(0);
    const ref = `ctx1_${'a'.repeat(64)}`, task = `ctx1_${'b'.repeat(64)}`;
    db.run('INSERT INTO usageHistory(timestamp,cost,projectId,clientKeyId,clientIdentitySource,projectRef,taskRef,projectBindingId,projectPolicyRevision) VALUES(?,?,?,?,?,?,?,?,?)', ['2026-09-08T12:00:00.000Z',1,'project-id','key-id','client-reported',ref,task,'binding-id',3]);
    await db.flush?.(); db.close(); db = null; await open(driver); await migrate(db);
    expect(db.get('SELECT projectId,projectRef,taskRef,projectBindingId,projectPolicyRevision FROM usageHistory WHERE projectId=?',['project-id'])).toEqual({projectId:'project-id',projectRef:ref,taskRef:task,projectBindingId:'binding-id',projectPolicyRevision:3});
    expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(3);
    expect(db.get('PRAGMA integrity_check').integrity_check).toBe('ok');
    expect(fs.readdirSync(path.join(root,'db','backups')).filter(name => name.startsWith(`schema-21-to-${schemaVersion}-`))).toHaveLength(1);
  });
});
