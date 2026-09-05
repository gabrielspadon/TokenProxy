// MCP context_status state: the sid-keyed self-sizing telemetry snapshot the
// /api/v1/mcp context_status tool serves back to a model. One JSON file under
// DATA_DIR/token-saver/, LRU-capped at 512 sessions, atomic tmp+rename writes,
// mode 0600 (same discipline as tokenSaver/events.js). Telemetry only: the
// entry carries byte/token counts and flags, never prompts or bodies.
// Every operation is best-effort async fs — a failure here must never reach
// the request path, so all throws are swallowed inside this module.

import fs from "node:fs/promises";
import path from "node:path";
// RELATIVE, not '@/': chatCore.js reaches this module under plain node, where
// the alias does not resolve (same rule as decide.js).
import { DATA_DIR } from "../../../src/lib/dataDir.js";

const MAX_ENTRIES = 512;
// Unique tmp names per concurrent writer in this process: a shared
// "${file}.tmp" made two writers overwrite each other's staging file.
let tmpCounter = 0;
const STORE_DIR = path.join(DATA_DIR, "token-saver");
const FILE_NAME = "context-status.json";
const SID_RE = /^[a-f0-9]{8}$/;

let _dirOverride = null;
export function __setContextStatusDirForTest(dir) {
  _dirOverride = dir || null;
}

function baseDir() {
  return _dirOverride || STORE_DIR;
}

function storeFile() {
  return path.join(baseDir(), FILE_NAME);
}

function clampInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

// Signed variant: saveBytes is a whole-body delta (negative = saved), same
// discipline as the tokenSaver events sink — growth is reported, not clamped.
function clampSignedInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

// Strict allowlist, mirroring the tokenSaver events sink: unknown fields are
// dropped, numbers are clamped nonnegative, no free text beyond rid.
function sanitize(entry) {
  const out = { sid: entry.sid };
  const rid = typeof entry.rid === "string" ? entry.rid : "";
  if (rid && /^[0-9a-f]{1,32}$/.test(rid)) out.rid = rid.slice(0, 8);
  for (const key of ["ctxTokens", "ctxTokensActual", "ceBytes"]) {
    const v = clampInt(entry[key]);
    if (v !== undefined) out[key] = v;
  }
  const saveBytes = clampSignedInt(entry.saveBytes);
  if (saveBytes !== undefined) out.saveBytes = saveBytes;
  if (entry.compactHint === true) out.compactHint = true;
  const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : "";
  // ISO-shaped AND parseable, else the field is dropped: a free-text or
  // garbage timestamp would poison the freshest-entry comparison in the
  // MCP route's resolveOwnStatus.
  if (
    updatedAt &&
    updatedAt.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(updatedAt) &&
    Number.isFinite(Date.parse(updatedAt))
  ) {
    out.updatedAt = updatedAt;
  }
  return out;
}

async function readAll() {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(storeFile(), "utf8"));
  } catch {
    return []; // absent or corrupt file: start empty, never throw
  }
  const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
  const out = [];
  for (const e of list) {
    if (e && typeof e === "object" && SID_RE.test(String(e.sid || ""))) {
      out.push(sanitize(e));
    }
  }
  return out;
}

async function writeAll(entries) {
  const tmp = `${storeFile()}.${process.pid}.${tmpCounter++}.tmp`;
  await fs.mkdir(baseDir(), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify({ v: 1, entries }), "utf8");
  try {
    await fs.chmod(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  await fs.rename(tmp, storeFile());
  try {
    await fs.chmod(storeFile(), 0o600);
  } catch {
    /* best-effort */
  }
}

// In-process write serialization: every write chains onto the tail, so two
// concurrent writers in this process can no longer interleave their
// read-merge-rename cycles (last write wins, both merges observed). Readers
// await the tail for read-after-write consistency.
// ponytail: single in-module chain; cross-process races keep the ENOENT retry.
let writeQueue = Promise.resolve();

// Upsert one session's telemetry. LRU: the rewritten entry moves to the tail
// (newest), the oldest head drops once the cap is exceeded. Order in the file
// IS the recency order.
export function writeContextStatus(sid, fields = {}) {
  try {
    if (!SID_RE.test(String(sid || ""))) return;
    // One full attempt is read entries, apply this write, rename. An
    // interleaved writer can win the rename in between (ENOENT on ours);
    // retry once from a fresh read so the update is never lost silently.
    const applyOnce = async () => {
      const entries = await readAll();
      // Merge over the session's existing entry: the pre-dispatch write
      // carries the estimate and the cache epoch, the post-response write
      // carries only what the provider reported, and a reader needs both.
      const existing = entries.find((e) => e.sid === sid) || {};
      // A completion write belongs to one request. When a newer request of
      // the same session has already written its own row, a late completion
      // for the older one is dropped rather than merged over it, or the row
      // would carry one request's estimate beside another's billed size.
      if (
        fields.ctxTokensActual !== undefined &&
        existing.rid && fields.rid &&
        existing.rid !== String(fields.rid).slice(0, 8)
      ) return;
      const next = sanitize({ ...existing, ...fields, sid, updatedAt: new Date().toISOString() });
      const rest = entries.filter((e) => e.sid !== sid);
      rest.push(next);
      while (rest.length > MAX_ENTRIES) rest.shift();
      await writeAll(rest);
    };
    writeQueue = writeQueue.then(async () => {
      try {
        await applyOnce();
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
        await applyOnce();
      }
    }).catch(() => {
      /* telemetry must never break the request path */
    });
  } catch {
    /* telemetry must never break the request path */
  }
}

export async function readContextStatus(sid) {
  try {
    if (!SID_RE.test(String(sid || ""))) return null;
    await writeQueue;
    const entries = await readAll();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].sid === sid) return entries[i];
    }
  } catch {
    /* best-effort */
  }
  return null;
}

// Full snapshot, newest last. Used by the MCP route when scanning candidates
// and by tests.
export async function readAllContextStatuses() {
  try {
    await writeQueue;
    return await readAll();
  } catch {
    return [];
  }
}
