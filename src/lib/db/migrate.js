import { TABLES, TRIGGERS, buildCreateTableSql, SCHEMA_VERSION } from "./schema.js";
import { MIGRATIONS, latestVersion } from "./migrations/index.js";
import { getMetaSync, setMetaSync } from "./helpers/metaStore.js";
import { makeBackupDir, backupDbLite, pruneOldBackups } from "./backup.js";
import { getAppVersion } from "./version.js";
import { economicsProjectionReady, ensureEconomicsProjection, ensureEconomicsProjectionIndexes } from './economicsProjectionSchema.js';

// Track per-adapter so reusing same adapter skips re-run, but new adapter
// (after reset) re-runs.
const _migratedAdapters = new WeakSet();

function isFreshDb(adapter) {
  return !adapter.get("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1");
}

function needsSchemaSync(adapter) {
  const objects = new Set(adapter.all("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')").map(row => row.name));
  for (const trigger of TRIGGERS) {
    const name = /CREATE TRIGGER IF NOT EXISTS (\w+)/i.exec(trigger)?.[1];
    if (!name || !objects.has(name)) return true;
  }
  for (const [tableName, def] of Object.entries(TABLES)) {
    if (!objects.has(tableName)) return true;
    const columns = new Set(adapter.all(`PRAGMA table_info(${tableName})`).map(row => row.name));
    if (Object.keys(def.columns).some(name => !columns.has(name.replace(/^"|"$/g, "")))) return true;
    for (const index of def.indexes || []) {
      const name = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/i.exec(index)?.[1];
      if (!name || !objects.has(name)) return true;
    }
  }
  return false;
}

// ─── Versioned migrations runner (skip-version safe) ─────────────────────
function runVersionedMigrations(adapter) {
  // Bootstrap _meta first so we can read schemaVersion
  adapter.exec(buildCreateTableSql("_meta", TABLES._meta));

  const current = parseInt(getMetaSync(adapter, "schemaVersion", "0"), 10) || 0;
  const target = latestVersion();
  if (current >= target) return { applied: 0, from: current, to: current };

  const pending = MIGRATIONS.filter((m) => m.version > current);
  let lastApplied = current;
  for (const m of pending) {
    adapter.transaction(() => {
      m.up(adapter);
      setMetaSync(adapter, "schemaVersion", m.version);
    });
    lastApplied = m.version;
    console.log(`[DB][migrate] applied #${m.version} ${m.name}`);
  }
  return { applied: pending.length, from: current, to: lastApplied };
}

// ─── Auto-sync (additive only): add missing tables/columns/indexes ───────
function syncSchemaFromTables(adapter) {
  for (const [tableName, def] of Object.entries(TABLES)) {
    // Create table if absent
    adapter.exec(buildCreateTableSql(tableName, def));

    // Diff columns
    const existing = adapter.all(`PRAGMA table_info(${tableName})`);
    const existingNames = new Set(existing.map((r) => r.name));
    for (const [colName, colDef] of Object.entries(def.columns)) {
      // A column whose name is a SQLite keyword is declared quoted in TABLES so
      // CREATE TABLE parses. PRAGMA table_info reports the bare name, so compare
      // unquoted or the column reads as missing on every boot and the ALTER
      // below fails with "duplicate column name" forever.
      if (!existingNames.has(colName.replace(/^"|"$/g, ""))) {
        // SQLite ADD COLUMN restrictions: no PRIMARY KEY / UNIQUE w/o NULL ok.
        // We strip PRIMARY KEY / UNIQUE since those are only valid at create time.
        const safeDef = colDef
          .replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "")
          .replace(/UNIQUE/i, "")
          .trim();
        try {
          adapter.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${safeDef}`);
          console.log(`[DB][sync] +column ${tableName}.${colName}`);
        } catch (e) {
          throw new Error(`[DB][sync] add column ${tableName}.${colName} failed: ${e.message}`, { cause: e });
        }
      }
    }

    // Indexes (idempotent)
    for (const idx of tableName === 'usageEconomicsProjection' ? [] : def.indexes || []) {
      try { adapter.exec(idx); }
      catch (e) { throw new Error(`[DB][sync] index for ${tableName} failed (${idx}): ${e.message}`, { cause: e }); }
    }
  }
}

// ─── Main entry ──────────────────────────────────────────────────────────
export async function runMigrationOnce(adapter) {
  if (_migratedAdapters.has(adapter)) return;
  const fresh = isFreshDb(adapter);
  const hasMeta = adapter.get("SELECT name FROM sqlite_master WHERE type='table' AND name='_meta'");
  const storedSchemaVer = hasMeta
    ? parseInt(getMetaSync(adapter, "backupSchemaVersion", "0"), 10) || 0 : 0;
  const migrationVersion = hasMeta ? parseInt(getMetaSync(adapter, "schemaVersion", "0"), 10) || 0 : 0;
  const schemaOutdated = storedSchemaVer < SCHEMA_VERSION || migrationVersion < latestVersion() || needsSchemaSync(adapter);
  const projectionHealthy = !fresh && economicsProjectionReady(adapter, { verifyIntegrity: true });
  const schemaChanging = !fresh && (schemaOutdated || !projectionHealthy);
  if (schemaChanging) {
    try {
      const backupDir = makeBackupDir(`schema-${storedSchemaVer}-to-${SCHEMA_VERSION}`);
      backupDbLite(adapter, backupDir);
      console.log(`[DB][migrate] pre-schema backup ${storedSchemaVer} → ${SCHEMA_VERSION}: ${backupDir}`);
    } catch (e) {
      throw new Error(`[DB][migrate] required pre-schema backup failed; migration stopped: ${e.message}`, { cause: e });
    }
  }

  // DDL and completion stamps share one transaction. A failure leaves the
  // original schema and version intact and can be retried on this adapter.
  adapter.transaction(() => {
    runVersionedMigrations(adapter);
    syncSchemaFromTables(adapter);
    for (const trigger of TRIGGERS) adapter.exec(trigger);
    ensureEconomicsProjection(adapter, { verifiedReady: projectionHealthy && !schemaOutdated });
    ensureEconomicsProjectionIndexes(adapter);
    setMetaSync(adapter, "backupSchemaVersion", SCHEMA_VERSION);
    const newVer = getAppVersion();
    if (getMetaSync(adapter, "appVersion", null) !== newVer) setMetaSync(adapter, "appVersion", newVer);
  });
  adapter.flush?.();
  _migratedAdapters.add(adapter);
  pruneOldBackups();
}
