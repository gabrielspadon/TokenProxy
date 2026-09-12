#!/usr/bin/env node

// Postinstall: warm up SQLite deps into ~/.tokenproxy/runtime so normal CLI startup
// never attempts to install the optional native accelerator. Failure is non-fatal.
const { ensureSqliteRuntime } = require("./sqliteRuntime");
const { ensureTrayRuntime } = require("./trayRuntime");

try {
  const sqlite = ensureSqliteRuntime({ silent: false, installBetterSqlite: true });
  if (sqlite.betterSqlite) {
    console.log("[tokenproxy] native SQLite runtime validated");
  } else if (sqlite.sqlJs) {
    console.warn("[tokenproxy] native SQLite runtime unavailable; bundled fallback remains available");
  } else {
    console.warn("[tokenproxy] SQLite runtime unavailable; startup will use another supported driver if present");
  }
} catch (e) {
  console.warn(`[tokenproxy] runtime warm-up skipped: ${e.message}`);
}

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[tokenproxy] tray runtime skipped: ${e.message}`);
}

process.exit(0);
