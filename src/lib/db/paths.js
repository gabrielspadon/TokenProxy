import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "../dataDir.js";

export const DB_DIR = path.join(DATA_DIR, "db");
export const DATA_FILE = path.join(DB_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DB_DIR, "backups");
export const SECRET_KEY_FILE = path.join(DB_DIR, "secret.key");
// The DB holds provider OAuth access/refresh tokens and plaintext client API
// keys, so it is at least as sensitive as auth/cli-secret and jwt-secret (both
// already written with mode 0o600). Without an explicit mode it inherits the
// process umask — 022 on most systems — leaving it world-readable at 0644.
export const SECRET_DIR_MODE = 0o700;
export const SECRET_FILE_MODE = 0o600;

// chmod is a no-op for our purposes on Windows (ACL-based, only the read-only
// bit maps through), so restrict tightening to POSIX platforms.
const isPosix = process.platform !== "win32";

// Best-effort: a Docker bind mount may be owned by another uid, and failing to
// tighten permissions must never prevent the app from starting.
export function chmodQuiet(target, mode) {
  if (!isPosix) return;
  try {
    fs.chmodSync(target, mode);
  } catch {}
}

// The data directory is mode 0700 and its files 0600, which is right for a
// store holding OAuth refresh tokens and plaintext API keys. It also means that
// starting the server once under sudo leaves everything owned by root, and
// every later start as the normal user fails on the first read. That surfaced
// as a bare "Internal server error" on the providers page with nothing naming
// the cause, and the reporter's own note that they had used sudo was the only
// clue in the report (#1983).
//
// Nothing here can fix the ownership, and changing it silently would be worse
// than failing. What it can do is fail with the sentence that ends the
// investigation.
const PERMISSION_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

export function describePathFailure(error, target) {
  if (!PERMISSION_CODES.has(error?.code)) return error;
  const who = typeof process.getuid === "function"
    ? `uid ${process.getuid()}`
    : `user ${process.env.USERNAME || process.env.USER || "unknown"}`;
  const detail = new Error(
    `Cannot use the TokenProxy data directory at ${target}: ${error.code}. `
    + `This process is running as ${who}. The most common cause is starting the `
    + `server once with sudo, which leaves the directory owned by root, and then `
    + `starting it again as your normal user. Either run as the owner, or hand the `
    + `directory back with: sudo chown -R $(id -u):$(id -g) ${DATA_DIR}`,
  );
  detail.code = error.code;
  detail.cause = error;
  return detail;
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
    } catch (error) {
      throw describePathFailure(error, dir);
    }
  }
}

// Repair permissions on every startup. Creating new files with the right mode
// only protects fresh installs; existing installs already have 0755 dirs and a
// 0644 DB on disk, and SQLite writes in place so those modes persist forever.
export function hardenPermissions() {
  if (!isPosix) return;
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    if (fs.existsSync(dir)) chmodQuiet(dir, SECRET_DIR_MODE);
  }
  // -wal and -shm are created by SQLite itself, so they inherit the umask too.
  for (const file of [SECRET_KEY_FILE, ...["", "-wal", "-shm"].map((suffix) => `${DATA_FILE}${suffix}`)]) {
    if (fs.existsSync(file)) chmodQuiet(file, SECRET_FILE_MODE);
  }
}
