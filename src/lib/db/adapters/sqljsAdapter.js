import fs from "node:fs";
import { dirname } from "node:path";
import initSqlJs from "sql.js";
import { PRAGMA_SQL } from "../schema.js";
import { registerShutdownFlusher } from "../../shutdown.js";

let SQL = null;

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
  // Schema is created/synced by migrate.js after adapter init

  let dirty = false;
  let saveTimer = null;
  const SAVE_DEBOUNCE_MS = 100;

  function persist({ syncDirectory = false } = {}) {
    let data;
    try { data = Buffer.from(db.export()); }
    finally {
      // sql.js export closes and reopens its native connection, resetting
      // connection-scoped pragmas, including foreign-key enforcement.
      db.exec(PRAGMA_SQL);
    }
    const tmp = filePath + ".tmp";
    let fd = null;
    let published = false;
    try {
      fd = fs.openSync(tmp, "w", 0o600);
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, filePath); // atomic on POSIX; no torn file on crash
      published = true;
      if (syncDirectory && process.platform !== "win32") {
        const directory = fs.openSync(dirname(filePath), "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (!published) {
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
    db.exec(sql);
    scheduleSave();
  }

  let transactionDepth = 0;
  let criticalActive = false;

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
    if (saveTimer) clearTimeout(saveTimer);
    if (dirty) persist();
    db.close();
  }

  const flushOnShutdown = () => {
    if (dirty)
      try {
        persist();
      } catch {}
  };
  registerShutdownFlusher(flushOnShutdown, 100);

  function criticalTransaction(fn) {
    if (typeof fn !== "function") throw new TypeError("criticalTransaction requires a function");
    if (Object.prototype.toString.call(fn) === "[object AsyncFunction]") {
      throw criticalError("CRITICAL_TRANSACTION_ASYNC", "A critical sql.js transaction callback must be synchronous");
    }
    if (criticalActive || transactionDepth > 0) {
      throw criticalError("CRITICAL_TRANSACTION_NESTED", "A critical sql.js transaction must be the outermost transaction");
    }

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
    criticalActive = true;
    try {
      db.exec(`SAVEPOINT ${sp}`);
      open = true;
      const result = fn();
      if (isThenable(result)) {
        throw criticalError("CRITICAL_TRANSACTION_ASYNC", "A critical sql.js transaction callback must be synchronous");
      }
      db.exec(`RELEASE ${sp}`);
      open = false;
      dirty = true;
      persist({ syncDirectory: true });
      return result;
    } catch (error) {
      if (open) {
        try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
      }
      try { db.close(); } catch {}
      db = new SQLLib.Database(before);
      db.exec(PRAGMA_SQL);
      dirty = dirtyBefore;
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
