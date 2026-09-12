import fs from "node:fs";
import { dirname } from "node:path";
import { createHash } from 'node:crypto';
import initSqlJs from "sql.js";
import { PRAGMA_SQL } from "../schema.js";
import { registerShutdownFlusher } from "../../shutdown.js";
import { createCriticalAckJournal, criticalAckFailure } from './criticalAckJournal.js';
import { acquireSqlJsWriterAdmission } from './writerAdmission.js';

let SQL = null;
const POST_RENAME_PUBLICATION = Symbol("sqljs.postRenamePublication");

async function loadSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs();
  return SQL;
}

export async function createSqlJsAdapter(filePath) {
  const SQLLib = await loadSql();
  const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  let db = new SQLLib.Database(buf);
  db.exec(PRAGMA_SQL);
  db.exec('PRAGMA query_only=ON');
  // Schema is created/synced by migrate.js after adapter init

  let dirty = false;
  let saveTimer = null;
  let admission = null;
  let publishedDigest = null;
  let staleError = null;
  let closed = false;
  const SAVE_DEBOUNCE_MS = 100;

  const digest = (bytes) => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
  function hasUncheckpointedSidecar() {
    return ['-wal', '-journal'].some((suffix) => {
      try { return fs.statSync(filePath + suffix).size > 0; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
  }
  function snapshotChanged() {
    return Object.assign(new Error('Database snapshot changed outside its writer owner; do not replay the mutation'), {
      code: 'DB_SNAPSHOT_STALE', retryable: false, committed: false,
    });
  }
  function snapshotBytes() {
    try {
      if (!fs.lstatSync(filePath).isFile()) throw Object.assign(new Error('Snapshot is not a regular database file'), { code: 'DB_SNAPSHOT_STALE', retryable: false, committed: false });
      return fs.readFileSync(filePath);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  function promoteWriter() {
    if (closed) throw new Error('Database adapter is closed');
    if (staleError) throw staleError;
    if (admission) return;
    const acquired = acquireSqlJsWriterAdmission(filePath);
    try {
      if (hasUncheckpointedSidecar()) throw snapshotChanged();
      // This adapter may have served reads while another owner published.
      // Acquire first, then load that owner's latest committed snapshot.
      const bytes = snapshotBytes();
      const fresh = new SQLLib.Database(bytes);
      try { fresh.exec(PRAGMA_SQL); }
      catch (error) { fresh.close(); throw error; }
      db.close();
      db = fresh;
      publishedDigest = digest(bytes);
      admission = acquired;
    } catch (error) { acquired.release(); throw error; }
  }

  function assertSnapshotCurrent() {
    if (staleError) throw staleError;
    try {
      admission.assertOwned();
      if (hasUncheckpointedSidecar() || digest(snapshotBytes()) !== publishedDigest) throw snapshotChanged();
    } catch (error) {
      if (['DB_SNAPSHOT_STALE', 'DB_WRITER_OWNERSHIP_LOST', 'DB_WRITER_OWNERSHIP_INVALID'].includes(error.code)) staleError = error;
      throw error;
    }
  }

  function persist({ syncDirectory = false } = {}) {
    assertSnapshotCurrent();
    let data;
    try { data = Buffer.from(db.export()); }
    finally {
      // sql.js export closes and reopens its native connection, resetting
      // connection-scoped pragmas, including foreign-key enforcement.
      db.exec(PRAGMA_SQL);
    }
    const tmp = filePath + ".tmp";
    let fd = null;
    let createdTemp = false;
    let published = false;
    try {
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC
        | (fs.constants.O_NOFOLLOW || 0);
      fd = fs.openSync(tmp, flags, 0o600);
      createdTemp = true;
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, filePath); // atomic on POSIX; no torn file on crash
      published = true;
      publishedDigest = digest(data);
      if (syncDirectory && process.platform !== "win32") {
        const directory = fs.openSync(dirname(filePath), "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } catch (error) {
      // renameSync has already made the exported database authoritative. A
      // later directory open/fsync/close error makes crash durability
      // uncertain, but rolling the live adapter back would make it disagree
      // with the database every new reader can already open.
      if (published && error && (typeof error === "object" || typeof error === "function")) {
        error[POST_RENAME_PUBLICATION] = true;
      }
      throw error;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (createdTemp && !published) {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
    dirty = false;
  }

  // Explicit publication needs an observable persistence failure. Ordinary
  // callers retain the debounced path; this barrier also syncs the renamed
  // directory entry on POSIX. Windows supports the file fsync only here.
  function flush() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (dirty) persist({ syncDirectory: true });
  }

  function scheduleSave() {
    dirty = true;
    if (criticalActive) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) {
        try {
          persist();
        } catch (e) {
          console.error("[sqljs] save failed:", e);
        }
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function paramsObj(params) {
    if (!params || (Array.isArray(params) && params.length === 0))
      return undefined;
    return params;
  }

  function run(sql, params = []) {
    promoteWriter();
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      stmt.step();
      const changes = db.getRowsModified();
      const lastInsertRowid =
        db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ??
        null;
      scheduleSave();
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    promoteWriter();
    db.exec(sql);
    scheduleSave();
  }

  let transactionDepth = 0;
  let criticalActive = false;
  const acknowledgments = createCriticalAckJournal({ databaseFile: filePath, driver: 'sql.js', db: { exec, get, run } });

  function criticalError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function isThenable(value) {
    return value !== null
      && (typeof value === "object" || typeof value === "function")
      && typeof value.then === "function";
  }

  function transaction(fn) {
    if (criticalActive) {
      throw criticalError("CRITICAL_TRANSACTION_NESTED", "A critical sql.js transaction cannot contain another transaction");
    }
    promoteWriter();
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${sp}`);
    transactionDepth += 1;
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      scheduleSave();
      return result;
    } catch (e) {
      try {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
      } catch {}
      throw e;
    } finally {
      transactionDepth -= 1;
    }
  }

  function close() {
    if (closed) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (dirty) persist();
    db.close();
    closed = true;
    admission?.release();
  }

  const flushOnShutdown = () => {
    try { close(); } catch {}
  };
  registerShutdownFlusher(flushOnShutdown, 100);

  function criticalTransaction(fn) {
    if (typeof fn !== "function") throw new TypeError("criticalTransaction requires a function");
    if (["[object AsyncFunction]", "[object AsyncGeneratorFunction]"].includes(Object.prototype.toString.call(fn))) {
      throw criticalError("CRITICAL_TRANSACTION_ASYNC", "A critical sql.js transaction callback must be synchronous");
    }
    if (criticalActive || transactionDepth > 0) {
      throw criticalError("CRITICAL_TRANSACTION_NESTED", "A critical sql.js transaction must be the outermost transaction");
    }
    promoteWriter();
    assertSnapshotCurrent();

    // sql.js commits to memory only. Preserve an exact pre-write image so a
    // failed file publication can also roll back the live adapter state.
    let before;
    try { before = Buffer.from(db.export()); }
    finally { db.exec(PRAGMA_SQL); }
    const dirtyBefore = dirty;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const sp = `critical_${Math.random().toString(36).slice(2)}`;
    let open = false;
    let committed = false;
    let acknowledgment;
    criticalActive = true;
    try {
      db.exec(`SAVEPOINT ${sp}`);
      open = true;
      acknowledgment = acknowledgments.prepare();
      const result = fn();
      if (isThenable(result)) {
        throw criticalError("CRITICAL_TRANSACTION_ASYNC", "A critical sql.js transaction callback must be synchronous");
      }
      acknowledgments.mark(acknowledgment);
      db.exec(`RELEASE ${sp}`);
      open = false;
      dirty = true;
      persist({ syncDirectory: true });
      committed = true;
      acknowledgments.acknowledge(acknowledgment);
      return result;
    } catch (error) {
      if (open) {
        try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
      }
      if (committed || error?.[POST_RENAME_PUBLICATION]) {
        dirty = false;
        const commitState = committed ? 'committed' : 'uncertain';
        acknowledgments.failed(acknowledgment, commitState);
        throw criticalAckFailure(error, acknowledgment, commitState);
      }
      try { db.close(); } catch {}
      db = new SQLLib.Database(before);
      db.exec(PRAGMA_SQL);
      dirty = dirtyBefore;
      acknowledgments.failed(acknowledgment, 'rolled-back');
      throw error;
    } finally {
      criticalActive = false;
      if (dirtyBefore && dirty && !saveTimer) scheduleSave();
    }
  }

  const adapter = { driver: "sql.js", run, get, all, exec, transaction, criticalTransaction, flush, close };
  Object.defineProperty(adapter, "raw", { enumerable: true, get: () => db });
  return adapter;
}
