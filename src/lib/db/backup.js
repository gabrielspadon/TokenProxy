// DB safety backups — taken ONLY before a schema change (see migrate.js).
//
// ⚠️ AGENT/DEV NOTES:
// - A required backup must succeed before schema migration starts.
// - Every table, including requestDetails and legacy archives, is retained.
// - Recovery is manual (restore the complete SQLite snapshot).
// - Only the newest KEEP_BACKUPS are kept; older ones are pruned automatically.
import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR, ensureDirs, chmodQuiet, SECRET_DIR_MODE, SECRET_FILE_MODE } from "./paths.js";
import { timestampSlug, getAppVersion } from "./version.js";
import { PRAGMA_SQL } from "./schema.js";

const KEEP_BACKUPS = 3;

export function makeBackupDir(label) {
  ensureDirs();
  const ver = getAppVersion();
  const slug = `${label}-${ver}-${timestampSlug()}`;
  const dir = fs.mkdtempSync(path.join(BACKUPS_DIR, `${slug}-`));
  chmodQuiet(dir, SECRET_DIR_MODE);
  return dir;
}

// Keep the exported name for callers, but the snapshot is now complete.
// Serializing the open connection includes committed WAL data. Older native
// node:sqlite releases have no serialize method, so use SQLite's snapshot API
// VACUUM INTO there. sql.js attachments live in its virtual filesystem; export
// must explicitly publish their bytes to the host filesystem instead.
export function backupDbLite(adapter, destDir, destName = "data.sqlite") {
  const dest = path.join(destDir, destName);
  const pending = `${dest}.pending`;
  if (fs.existsSync(dest)) throw new Error(`Backup already exists: ${dest}`);
  const fd = fs.openSync(pending, "wx", SECRET_FILE_MODE);
  try {
    if (adapter.driver === "sql.js") {
      let data;
      try { data = adapter.raw.export(); }
      finally { adapter.raw.exec(PRAGMA_SQL); }
      fs.writeFileSync(fd, data);
    } else if (typeof adapter.raw?.serialize === "function") {
      fs.writeFileSync(fd, adapter.raw.serialize());
    } else {
      adapter.run("VACUUM main INTO ?", [pending]);
    }
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(pending, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(pending, dest);
  if (process.platform !== "win32") {
    const directory = fs.openSync(destDir, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  return dest;
}

export function pruneOldBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(BACKUPS_DIR, e.name, "data.sqlite")))
    .map((e) => ({ name: e.name, full: path.join(BACKUPS_DIR, e.name), mtime: fs.statSync(path.join(BACKUPS_DIR, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of entries.slice(KEEP_BACKUPS)) {
    try { fs.rmSync(old.full, { recursive: true, force: true }); } catch {}
  }
}
