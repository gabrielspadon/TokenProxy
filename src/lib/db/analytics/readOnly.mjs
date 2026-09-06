import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";

const MAX_FALLBACK_BYTES = 128 * 1024 * 1024;
let sqlJs;

function nativeAdapter(db, prepare = (sql) => db.prepare(sql)) {
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
  return {
    get: (sql, params = []) => prepare(sql).get(...params),
    all: (sql, params = []) => prepare(sql).all(...params),
    exec: (sql) => db.exec(sql), close: () => db.close(),
    source: "committed-sqlite", persistedAt: null,
  };
}

// This module deliberately never imports the application's writer adapter.
// An sql.js writer atomically replaces its file, so open each snapshot anew.
export async function openAnalyticsReadOnly(file, writerDriver) {
  if (writerDriver !== "sql.js") {
    if (writerDriver === "bun:sqlite" && process.versions.bun) {
      const { Database } = await import("bun:sqlite");
      const db = new Database(file, { readonly: true, create: false });
      return nativeAdapter(db, (sql) => db.query(sql));
    }
    if (writerDriver === "node:sqlite") {
      const { DatabaseSync } = await import("node:sqlite");
      return nativeAdapter(new DatabaseSync(file, { readOnly: true }));
    }
    // Never mix two SQLite libraries against the same file in one process.
    // Their independent lock registries can invalidate the writer's WAL map.
    if (writerDriver !== "better-sqlite3") throw new Error("Unsupported analytics driver");
    const { default: Database } = await import("better-sqlite3");
    return nativeAdapter(new Database(file, { readonly: true, fileMustExist: true }));
  }
  if (!sqlJs) sqlJs = import("sql.js").then(({ default: initialize }) => initialize());
  const SQL = await sqlJs;
  const descriptor = openSync(file, "r");
  let info, bytes;
  try {
    info = fstatSync(descriptor);
    if (info.size > MAX_FALLBACK_BYTES) throw new Error("Persisted snapshot exceeds fallback limit");
    bytes = readFileSync(descriptor);
  } finally { closeSync(descriptor); }
  const db = new SQL.Database(bytes);
  db.exec("PRAGMA query_only=ON");
  function all(sql, params = [], first = false) {
    const statement = db.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) { rows.push(statement.getAsObject()); if (first) break; }
      return rows;
    } finally { statement.free(); }
  }
  return {
    get: (sql, params) => all(sql, params, true)[0], all,
    exec: (sql) => db.exec(sql), close: () => db.close(),
    source: "last-persisted-snapshot", persistedAt: info.mtime.toISOString(),
  };
}
