// One data directory per test FILE.
//
// vitest.config.js sets test.env.DATA_DIR from a single mkdtempSync evaluated
// once when the config module loads, so every worker inherited the SAME path.
// src/lib/dataDir.js reads DATA_DIR at import time, which means the 25 test
// files that never assign their own -- and every file that imports anything
// touching the db before it assigns one -- opened one shared data.sqlite from
// several forks at once.
//
// Concurrent writers on one SQLite file is what surfaced as "database is
// locked" on an unrelated case each run, and as a regression-gate failure set
// that changed between identical runs over an unchanged tree. The gate is a
// pass/fail predicate for several checks, so a varying set makes those verdicts
// coin flips rather than evidence.
//
// setupFiles runs inside the worker before the test file's own imports, so an
// assignment here lands before any module reads DATA_DIR. A file that sets its
// own DATA_DIR later still wins for whatever it imports after that point; this
// only removes the shared default that made files collide.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.env.TOKENPROXY_TEST_DATA_ROOT;
if (!root?.trim()) {
  throw new Error("[DATA_DIR] test setup requires TOKENPROXY_TEST_DATA_ROOT from the explicit Vitest config");
}
mkdirSync(root, { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(root, "file-"));
process.env.DATA_DIR = dir;

// Per-file directories would otherwise accumulate one tree per file per run on
// top of the per-run trees the config already leaves behind.
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a still-open handle must never fail the run.
  }
});
