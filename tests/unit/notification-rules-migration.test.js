// Schema 14 → 16 lands the notification rule tables additively, with the
// pre-change safety backup taken before the schema mutates. Same isolation
// pattern as operation-events-migration.test.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-notifmig-'));
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

describe('schema 16: notification rules', () => {
  // This suite owns the notification-rules contract, not the current schema
  // number. Asserting an exact SCHEMA_VERSION here made every later additive
  // bump look like a notification-rules regression, so the assertion is on
  // what schema 16 actually landed: the tables exist, and the version is at
  // or past the one that introduced them.
  it('notification rules are present from schema 16 onwards, with 15 reserved', async () => {
    const { SCHEMA_VERSION, TABLES } = await import('@/lib/db/schema.js');
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(16);
    expect(SCHEMA_VERSION).not.toBe(15);
    expect(TABLES.notificationRules).toBeDefined();
    expect(TABLES.notificationRuleVersions).toBeDefined();
    expect(TABLES.notificationRuleEvents).toBeDefined();
    // 15 must not have been consumed by this change.
    const { MIGRATIONS } = await import('@/lib/db/migrations/index.js');
    expect(MIGRATIONS.some((migration) => migration.version === 15)).toBe(false);
  });

  it('upgrading a version-14 database takes a backup before creating the tables', async () => {
    const { getAdapter } = await import('@/lib/db/driver.js');
    const db = await getAdapter();
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      ['{"keep":"me"}']
    );
    db.run(`UPDATE _meta SET value = '14' WHERE key = 'backupSchemaVersion'`);
    db.exec(`DROP TABLE notificationRules`);
    db.exec(`DROP TABLE notificationRuleVersions`);
    db.exec(`DROP TABLE notificationRuleEvents`);
    db.flush?.();
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: boot2 } = await import('@/lib/db/driver.js');
    const db2 = await boot2();

    const backupsDir = path.join(tempDir, 'db', 'backups');
    // The backup is named for the span it crosses, so its upper bound is the
    // CURRENT schema version rather than 16 forever.
    const { SCHEMA_VERSION } = await import('@/lib/db/schema.js');
    const backups = fs
      .readdirSync(backupsDir)
      .filter((name) => name.startsWith(`schema-14-to-${SCHEMA_VERSION}`));
    expect(backups).toHaveLength(1);
    expect(fs.existsSync(path.join(backupsDir, backups[0], 'data.sqlite'))).toBe(true);

    for (const table of [
      'notificationRules',
      'notificationRuleVersions',
      'notificationRuleEvents',
    ]) {
      expect(
        db2.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table])?.name
      ).toBe(table);
    }
    // Pre-existing data survived the upgrade.
    expect(JSON.parse(db2.get(`SELECT data FROM settings WHERE id=1`).data)).toEqual({
      keep: 'me',
    });
    // The backup advances to the CURRENT schema version, not 16 forever.
    expect(db2.get(`SELECT value FROM _meta WHERE key='backupSchemaVersion'`).value).toBe(
      String(SCHEMA_VERSION)
    );
  });

  it('creates the constraint that prevents duplicate concurrent firings', async () => {
    const { getAdapter } = await import('@/lib/db/driver.js');
    const db = await getAdapter();
    const indexes = db
      .all(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notificationRuleEvents'`
      )
      .map((row) => row.name);
    expect(indexes).toContain('idx_nre_open');

    const insert = (id, outcome, acknowledgedAt = null) =>
      db.run(
        `INSERT INTO notificationRuleEvents(id, ruleId, ruleRevision, scopeKey, firedAt,
           breachStartedAt, observedValue, evidence, outcome, acknowledgedAt)
         VALUES(?, 'rule-1', 1, 'conn-1', '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z', 5, '{"kind":"quotaObservation","refs":[]}', ?, ?)`,
        [id, outcome, acknowledgedAt]
      );

    insert('a', 'firing');
    // A second OPEN alert on the same rule and scope is refused by the index.
    expect(() => insert('b', 'firing')).toThrow();
    // Once the first is acknowledged, the slot is free again.
    db.run(
      `UPDATE notificationRuleEvents SET outcome='acknowledged', acknowledgedAt='2026-01-01T01:00:00.000Z' WHERE id='a'`
    );
    expect(() => insert('c', 'firing')).not.toThrow();
  });

  it('enforces the scope, cooldown and acknowledgement invariants in the schema itself', async () => {
    const { getAdapter } = await import('@/lib/db/driver.js');
    const db = await getAdapter();
    const rule = (id, scopeKind, scopeId, cooldown = 3600) =>
      db.run(
        `INSERT INTO notificationRules(id, name, scopeKind, scopeId, conditionKind, threshold,
           durationSeconds, cooldownSeconds, enabled, revision, createdAt, updatedAt)
         VALUES(?, 'n', ?, ?, 'quota_risk', 10, 600, ?, 1, 1,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        [id, scopeKind, scopeId, cooldown]
      );
    // A global rule carries no subject; a scoped rule must carry one.
    expect(() => rule('g', 'global', null)).not.toThrow();
    expect(() => rule('g2', 'global', 'conn-1')).toThrow();
    expect(() => rule('c1', 'connection', null)).toThrow();
    // A cooldown below the floor cannot be stored at all.
    expect(() => rule('c2', 'connection', 'conn-1', 30)).toThrow();
    // An acknowledged alert without its timestamp is not representable.
    expect(() =>
      db.run(
        `INSERT INTO notificationRuleEvents(id, ruleId, ruleRevision, scopeKey, firedAt,
           breachStartedAt, observedValue, evidence, outcome)
         VALUES('x', 'g', 1, 'k', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
           1, '{}', 'acknowledged')`
      )
    ).toThrow();
  });
});
