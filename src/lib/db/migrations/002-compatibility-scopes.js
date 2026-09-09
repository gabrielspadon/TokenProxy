import { COMPATIBILITY_TABLES } from '../compatibilitySchema.js';
import { buildCreateTableSql } from '../schema.js';

// Only the scope constraint changes. The outer migration transaction and
// mandatory pre-schema backup preserve all historical runs on failure.
const migration = {
  version: 2,
  name: 'compatibility-controlled-scopes',
  up(db) {
    const old = db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='compatibilityRuns'");
    if (!old || old.sql.includes("'controlled-executor'") && old.sql.includes("'controlled-gateway-routing'")) return;
    const definition = COMPATIBILITY_TABLES.compatibilityRuns;
    const columns = db.all('PRAGMA table_info(compatibilityRuns)').map(row => row.name);
    if (columns.length !== Object.keys(definition.columns).length || columns.some(name => !Object.hasOwn(definition.columns, name))) {
      throw new Error('Compatibility migration refuses an unrecognized source column set');
    }
    // This table has no inbound foreign keys in the supported schema. Refuse
    // extensions with inbound references instead of disabling their integrity checks.
    for (const row of db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
      const name = row.name.replaceAll('"', '""');
      if (db.all(`PRAGMA foreign_key_list("${name}")`).some(key => key.table === 'compatibilityRuns')) {
        throw new Error('Compatibility migration requires review of inbound foreign keys');
      }
    }
    const dependent = db.all("SELECT sql FROM sqlite_master WHERE tbl_name='compatibilityRuns' AND type IN ('index','trigger') AND sql IS NOT NULL");
    if (db.get("SELECT name FROM sqlite_master WHERE name='compatibilityRuns_scope_v2'")) throw new Error('Compatibility migration staging table already exists');
    db.exec(buildCreateTableSql('compatibilityRuns_scope_v2', definition));
    const names = columns.map(name => `"${name}"`).join(',');
    db.exec(`INSERT INTO compatibilityRuns_scope_v2(${names}) SELECT ${names} FROM compatibilityRuns`);
    const before = db.get('SELECT COUNT(*) AS n FROM compatibilityRuns').n;
    if (db.get('SELECT COUNT(*) AS n FROM compatibilityRuns_scope_v2').n !== before) throw new Error('Compatibility migration row count mismatch');
    db.exec('DROP TABLE compatibilityRuns');
    db.exec('ALTER TABLE compatibilityRuns_scope_v2 RENAME TO compatibilityRuns');
    for (const row of dependent) db.exec(row.sql);
    if (db.all('PRAGMA foreign_key_check(compatibilityRuns)').length) throw new Error('Compatibility migration foreign key validation failed');
  },
};

export default migration;
