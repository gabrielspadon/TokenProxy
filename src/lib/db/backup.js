// DB safety backups — taken ONLY before a schema change (see migrate.js).
//
// ⚠️ AGENT/DEV NOTES:
// - Backups are a best-effort safety net before schema migrations. There is NO
//   automated restore path; recovery is manual (copy a backup file back).
// - Backups intentionally EXCLUDE the `requestDetails` table (observability log,
//   auto-pruned, non-critical) so a multi-hundred-MB DB backs up as a few MB.
// - Only the newest KEEP_BACKUPS are kept; older ones are pruned automatically.
import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR, ensureDirs, chmodQuiet, SECRET_DIR_MODE, SECRET_FILE_MODE } from "./paths.js";
import { timestampSlug, getAppVersion } from "./version.js";

const KEEP_BACKUPS = 3;

// Tables excluded from safety backups (large, non-critical, reproducible).
const BACKUP_EXCLUDE_TABLES = ["requestDetails"];

export function makeBackupDir(label) {
  ensureDirs();
  const ver = getAppVersion();
  const slug = `${label}-${ver}-${timestampSlug()}`;
  const dir = path.join(BACKUPS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
  return dir;
}

// Lightweight DB backup via ATTACH: create an empty sqlite file, copy every
// table EXCEPT the excluded ones into it. Avoids duplicating the huge
// observability log, so the backup stays small regardless of DB size.
export function backupDbLite(adapter, destDir, destName = "data.sqlite") {
  const dest = path.join(destDir, destName);
  try { fs.rmSync(dest, { force: true }); } catch {}
  fs.writeFileSync(dest, "", { flag: "wx", mode: SECRET_FILE_MODE });
  adapter.run("ATTACH DATABASE ? AS bak", [dest]);
  try {
    const excluded = new Set(BACKUP_EXCLUDE_TABLES);
    const tables = adapter
      .all(`SELECT name, sql FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .filter((t) => !excluded.has(t.name));
    const pending = new Map(tables.map((t) => [t.name, t]));
    const ordered = [];
    const visiting = new Set();
    function visit(name) {
      if (!pending.has(name)) return;
      if (visiting.has(name)) throw new Error("Cannot back up cyclic foreign keys");
      visiting.add(name);
      for (const { parent } of adapter.all('SELECT "table" AS parent FROM pragma_foreign_key_list(?)', [name])) {
        if (parent !== name) visit(parent);
      }
      ordered.push(pending.get(name));
      pending.delete(name);
      visiting.delete(name);
    }
    for (const t of tables) visit(t.name);

    adapter.transaction(() => {
      // Create every referenced table before copying rows, then insert parents
      // before children. SQLite can retain deferred violations across ATTACH.
      for (const t of tables) {
        const createSql = t.sql.replace(/CREATE TABLE\s+/i, "CREATE TABLE bak.");
        adapter.exec(createSql);
      }
      for (const t of ordered) {
        const identifier = `"${t.name.replace(/"/g, '""')}"`;
        adapter.exec(`INSERT INTO bak.${identifier} SELECT * FROM main.${identifier}`);
      }
    });
  } finally {
    try { adapter.exec("DETACH DATABASE bak"); } catch {}
    chmodQuiet(dest, SECRET_FILE_MODE);
  }
  // SQLite creates the attached file itself, so it lands at 0644 under the
  // default umask even though it contains a full copy of the credential tables.
  chmodQuiet(dest, SECRET_FILE_MODE);
  return dest;
}

export function pruneOldBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, full: path.join(BACKUPS_DIR, e.name), mtime: fs.statSync(path.join(BACKUPS_DIR, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of entries.slice(KEEP_BACKUPS)) {
    try { fs.rmSync(old.full, { recursive: true, force: true }); } catch {}
  }
}
