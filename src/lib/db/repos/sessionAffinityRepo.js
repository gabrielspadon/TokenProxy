import { getAdapter } from '../driver.js';

// Durable client-session to account affinity (Account Scheduling Contract rule
// 4). The point of a table rather than a Map is the restart: a pin that is only
// in memory is re-decided on every boot, and re-deciding on every boot is
// round-robin with extra steps.
//
// Keyed by (sessionHash, model). The hash is computed by the caller — nothing
// here ever sees a raw session identity, a credential, or a prompt body (rule 8).

function rowToPin(row) {
  if (!row) return null;
  return {
    connectionId: row.connectionId,
    providerNode: row.providerNode ?? null,
    pinnedAt: row.pinnedAt,
    expiresAt: row.expiresAt ?? null,
  };
}

// A pin past its TTL is not a pin. Returning it and letting the caller check
// would put the expiry rule in every call site, and the first one to forget it
// keeps a session on an account whose lease has lapsed. `sweepExpired` is the
// bulk cleanup; this is the per-read guard that does not depend on the sweep
// having run.
function isExpired(row, nowIso) {
  return typeof row?.expiresAt === 'string' && row.expiresAt !== '' && row.expiresAt <= nowIso;
}

export async function getPin(sessionHash, model, { now = new Date() } = {}) {
  if (!sessionHash || !model) return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT connectionId, providerNode, pinnedAt, expiresAt
     FROM sessionAffinity WHERE sessionHash = ? AND model = ?`,
    [sessionHash, model]
  );
  if (!row) return null;
  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  // Failure direction (issue 03): a missing, expired or malformed pin makes the
  // session NEW, so ranking runs and a fresh pin is created. It never fails the
  // request and never silently falls back to round-robin.
  if (isExpired(row, nowIso) || !row.connectionId) return null;
  return rowToPin(row);
}

// Upsert, because a repin targets a session that is already pinned by
// definition: rule 5 moves an existing session to another account, it does not
// create a second row for the same (session, model).
export async function setPin(sessionHash, model, connectionId, opts = {}) {
  if (!sessionHash || !model || !connectionId) return null;
  const { providerNode = null, expiresAt = null, now = new Date() } = opts;
  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  // pinnedAt is when THIS binding started, so a repin restamps it; lastSeenAt
  // tracks liveness and is restamped by touchPin without moving pinnedAt.
  const pinnedAt = opts.pinnedAt || nowIso;
  const db = await getAdapter();
  db.run(
    `INSERT INTO sessionAffinity(sessionHash, model, connectionId, providerNode, pinnedAt, expiresAt, lastSeenAt)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sessionHash, model) DO UPDATE SET
       connectionId = excluded.connectionId,
       providerNode = excluded.providerNode,
       pinnedAt = excluded.pinnedAt,
       expiresAt = excluded.expiresAt,
       lastSeenAt = excluded.lastSeenAt`,
    [sessionHash, model, connectionId, providerNode, pinnedAt, expiresAt, nowIso]
  );
  return { connectionId, providerNode, pinnedAt, expiresAt };
}

export async function clearPin(sessionHash, model) {
  if (!sessionHash || !model) return 0;
  const db = await getAdapter();
  const res = db.run(`DELETE FROM sessionAffinity WHERE sessionHash = ? AND model = ?`, [
    sessionHash,
    model,
  ]);
  return res?.changes ?? 0;
}

// Drain and exhaustion both need every session on one account released in one
// pass — idx_sa_conn exists for exactly this. The count is the caller's
// evidence of how many sessions the next selection has to re-rank.
export async function clearPinsForConnection(connectionId) {
  if (!connectionId) return 0;
  const db = await getAdapter();
  const res = db.run(`DELETE FROM sessionAffinity WHERE connectionId = ?`, [connectionId]);
  return res?.changes ?? 0;
}

// lastSeenAt only. Touching pinnedAt here would make an active session's pin
// look permanently new and defeat any age-based policy over it.
export async function touchPin(sessionHash, model, { now = new Date() } = {}) {
  if (!sessionHash || !model) return 0;
  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  const db = await getAdapter();
  const res = db.run(
    `UPDATE sessionAffinity SET lastSeenAt = ? WHERE sessionHash = ? AND model = ?`,
    [nowIso, sessionHash, model]
  );
  return res?.changes ?? 0;
}

// Live pins per connection for one model, the `pins` half of the scheduler's
// activeLoad (quotaRanking.js loadOf). ONE grouped SELECT rather than a query
// per candidate, because it runs inside selectAndReserve's transaction on
// every fresh pin. A NULL expiresAt is a live pin here for the same reason it
// survives the sweep below: "no TTL" means the pin ends only on exhaustion,
// reset, drain or a model-specific failure, so it is still holding its account.
// The statement is exported so schedulerRepos.js's synchronous facade issues
// the identical SQL instead of a second reading of "live".
export const ACTIVE_PINS_BY_CONNECTION_SQL =
  `SELECT connectionId, COUNT(*) AS pins FROM sessionAffinity
   WHERE model = ? AND (expiresAt IS NULL OR expiresAt > ?)
   GROUP BY connectionId`;

export function rowsToPinCounts(rows) {
  const out = {};
  for (const row of rows || []) {
    if (typeof row?.connectionId !== 'string' || row.connectionId === '') continue;
    const n = Number(row.pins);
    if (Number.isFinite(n) && n > 0) out[row.connectionId] = n;
  }
  return out;
}

export async function countActivePins(model, { now = new Date() } = {}) {
  if (!model) return {};
  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  const db = await getAdapter();
  return rowsToPinCounts(db.all(ACTIVE_PINS_BY_CONNECTION_SQL, [model, nowIso]));
}

// A NULL expiresAt is "no TTL" and must survive the sweep: those pins end only
// on exhaustion, reset, drain or a model-specific failure. `expiresAt <= ?`
// leaves NULL rows alone in SQL's three-valued logic, which is the behaviour
// wanted, and it is stated here so nobody "fixes" it into an IS NULL branch.
export async function sweepExpired(nowIso) {
  const cutoff = nowIso || new Date().toISOString();
  const db = await getAdapter();
  const res = db.run(`DELETE FROM sessionAffinity WHERE expiresAt IS NOT NULL AND expiresAt <= ?`, [
    cutoff,
  ]);
  return res?.changes ?? 0;
}
