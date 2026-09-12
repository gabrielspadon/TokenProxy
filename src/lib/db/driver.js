import { ensureDirs, hardenPermissions, DATA_FILE } from "./paths.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

// Why a link produced no adapter. The old failure said only that all four had
// failed, which points the reader at the wrong one: the reporter on #987 saw it
// with better-sqlite3 AND sql.js in the message, and sql.js is the link that is
// supposed to be unconditional, so "it failed too" is the whole diagnosis and
// the message withheld it. `skipped` marks a link that does not apply to this
// runtime at all (wrong engine, Node too old) — recorded for the final message,
// but not worth a warning on an otherwise healthy start.
function note(reasons, driver, reason, { skipped = false } = {}) {
  reasons.push(`${driver}: ${reason}`);
  if (!skipped) console.warn(`[DB] ${driver} unavailable: ${reason}`);
  return null;
}

async function tryBunSqlite(reasons) {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return note(reasons, "bun:sqlite", "not running under Bun", { skipped: true });
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(DATA_FILE);
  } catch (e) {
    return note(reasons, "bun:sqlite", e.message);
  }
}

async function tryBetterSqlite(reasons) {
  // Skip on Bun — better-sqlite3 native bindings unsupported
  if (process.versions.bun) return note(reasons, "better-sqlite3", "skipped under Bun (native bindings unsupported)", { skipped: true });
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(DATA_FILE);
  } catch (e) {
    // An optionalDependency, so absent whenever the install had no prebuilt
    // binary and no toolchain to compile one. That is expected, not a defect.
    return note(reasons, "better-sqlite3", e.message);
  }
}

async function tryNodeSqlite(reasons) {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return note(reasons, "node:sqlite", "not available under Bun", { skipped: true });
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    return note(reasons, "node:sqlite", `needs Node >= 22.5.0, this is ${process.versions.node}`, { skipped: true });
  }
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(DATA_FILE);
  } catch (e) {
    return note(reasons, "node:sqlite", e.message);
  }
}

async function trySqlJs(reasons) {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    // This link is the reason the chain is supposed to have no hole, and it is
    // the one that actually has one: sql.js is not pure JS, it is WASM with a
    // sidecar binary. The Next standalone trace picks up dist/sql-wasm.js and
    // NOT dist/sql-wasm.wasm (nothing statically requires it — the loader
    // readFileSync's a path it builds at runtime), so every packaged install
    // ships the loader without the module and this link dies on ENOENT. On a
    // host where better-sqlite3 also has no prebuilt binary, that leaves the
    // whole chain empty, which is exactly #987.
    const detail = /sql-wasm\.wasm/.test(e.message || "")
      ? `${e.message} — the packaged build shipped sql.js without its WASM binary, so this fallback cannot load`
      : e.message;
    return note(reasons, "sql.js", detail);
  }
}

async function initAdapter() {
  ensureDirs();
  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js
  //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js
  const reasons = [];
  let adapter = await tryBunSqlite(reasons);
  if (!adapter) adapter = await tryBetterSqlite(reasons);
  if (!adapter) adapter = await tryNodeSqlite(reasons);
  if (!adapter) adapter = await trySqlJs(reasons);
  if (!adapter) {
    throw new Error(
      `[DB] No SQLite driver available for ${DATA_FILE}. Each candidate and why it could not be used:\n`
      + reasons.map((r) => `  - ${r}`).join("\n")
      + `\nOn Node, either install a runtime with node:sqlite (Node >= 22.5.0) or make better-sqlite3 installable (build tools present).`
    );
  }

  // After the adapter has created data.sqlite (plus -wal/-shm), tighten modes
  // so the credential store is not world-readable. Also repairs existing installs.
  hardenPermissions();

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  try {
    await runMigrationOnce(adapter);
  } catch (error) {
    try { adapter.close?.(); } catch {}
    throw error;
  }
  return adapter;
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) {
    state.initPromise = initAdapter()
      .then((a) => { state.instance = a; return a; })
      .catch((error) => {
        // A temporary filesystem or migration fault must not poison this
        // process forever. The failed candidate is already closed above.
        state.initPromise = null;
        throw error;
      });
  }
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
