import Database from "better-sqlite3";
import { PRAGMA_SQL } from "../schema.js";
import { registerShutdownFlusher } from "../../shutdown.js";
import { createTransactionController } from "./criticalTransaction.js";

// Periodic checkpoint to keep WAL file small (avoid huge -wal/-shm growth)
const CHECKPOINT_INTERVAL_MS = 60 * 1000;

export function createBetterSqliteAdapter(filePath) {
  const db = new Database(filePath);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  const stmtCache = new Map();

  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  const transactions = createTransactionController({
    exec: (sql) => db.exec(sql),
    readSynchronous: () => db.pragma("synchronous", { simple: true }),
    isInTransaction: () => db.inTransaction,
  });

  // Checkpoint committed WAL frames without waiting for readers.
  const checkpointTimer = setInterval(() => {
    // Never wait on an analytics snapshot from the request-serving thread.
    try { db.pragma("wal_checkpoint(PASSIVE)"); } catch {}
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }

  // Ensure WAL is flushed and -wal/-shm files removed on shutdown
  registerShutdownFlusher(gracefulClose, 100);

  return {
    driver: "better-sqlite3",
    run(sql, params = []) { return prepare(sql).run(...params); },
    get(sql, params = []) { return prepare(sql).get(...params); },
    all(sql, params = []) { return prepare(sql).all(...params); },
    exec(sql) { return db.exec(sql); },
    transaction(fn) { return transactions.transaction(() => db.transaction(fn)()); },
    criticalTransaction: transactions.criticalTransaction,
    checkpoint() { try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {} },
    close() {
      clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
