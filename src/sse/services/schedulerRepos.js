/**
 * The synchronous repos facade `selectAndReserve` requires.
 *
 * THE PROBLEM. Every repo in src/lib/db/repos/ is `async`, because each one
 * starts with `await getAdapter()`. `selectAndReserve` runs its whole decision
 * inside `repos.transaction(fn)`, and `db.transaction(fn)` is SYNCHRONOUS on
 * every adapter (src/lib/db/adapters/betterSqliteAdapter.js:44 is
 * `transaction(fn) { return db.transaction(fn)(); }`). An `await` inside a
 * better-sqlite3 transaction body does not suspend the transaction — it returns
 * a pending promise to the transaction wrapper, which commits immediately, so
 * the read of a free slot and the taking of it stop being indivisible. That is
 * exactly the over-admission rule 6 exists to prevent.
 *
 * THE FIX, which is the pattern this repo already documents at
 * src/lib/db/index.js:139 ("Resolved before the transaction: db.transaction()
 * is synchronous"): resolve the adapter ONCE, before the transaction opens, and
 * hand the scheduler a facade whose four methods are plain synchronous
 * functions closing over that resolved adapter. `await` disappears from the
 * transaction body because the only thing that needed awaiting already happened.
 *
 * The SQL below is deliberately the same SQL the async repos issue, and that
 * duplication is the point rather than an oversight: those repos are the async
 * API for everything outside a transaction (the dashboard, the admin surface,
 * the sweeps), and this is the synchronous API for the one caller that cannot
 * await. Wrapping the async repos here is not possible; re-deriving the
 * statements is what makes the transaction real.
 */

// randomUUID is imported statically: a dynamic import inside recordSwitch would
// be an await in the transaction body, which is the whole thing this module
// exists to avoid.
import { randomUUID } from 'node:crypto';
import { getAdapter } from '@/lib/db/driver.js';
import {
  ACTIVE_PINS_BY_CONNECTION_SQL,
  rowsToPinCounts,
} from '@/lib/db/repos/sessionAffinityRepo.js';

// HOW A PIN DIES. Nothing evicted sessionAffinity before this: both writers
// wrote `expiresAt` NULL, so `sweepExpired` matched nothing and the live table
// held 138 rows, 138 of them NULL, going back to the day the table was created.
// That was survivable while the key was one row per (session, model). It is not
// survivable now that the key carries the CACHE PREFIX (cachePrefixDigest.js),
// because cardinality became one row per agent per model and every abandoned
// agent leaves one behind forever.
//
// IDLE, not age. touchPin slides the stamp on every reused pin, so a long
// conversation keeps its account for as long as it is live and only an
// ABANDONED pin ages out. Expiring a busy session on a fixed age would force a
// repin mid-conversation and re-prime the provider-side cache the pin exists to
// protect, which is the failure this whole file guards against.
//
// A DAY, not an hour. The horizon has to clear the longest gap a session may
// legitimately sit idle and still be the same session; an hour does not, and
// setting it there expired pins the affinity suite asserts survive a quiet hour
// (affinity-state-exit, operator-pin-affinity, scheduler-wiring). This is
// garbage collection for agents that are never coming back, not a lease.
const PIN_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

// A pin past its TTL is not a pin — the same rule sessionAffinityRepo.js:41
// enforces, restated here because this facade issues its own SQL. Failure
// direction (issue 03): a missing, expired or malformed pin makes the session
// read as NEW so ranking runs. It never falls through to arbitrary order.
function livePin(row, nowIso) {
  if (!row) return null;
  if (typeof row.connectionId !== 'string' || row.connectionId === '') return null;
  if (typeof row.expiresAt === 'string' && row.expiresAt !== '' && row.expiresAt <= nowIso) return null;
  return { connectionId: row.connectionId, pinnedAt: row.pinnedAt ?? null };
}

/**
 * Build the six-method surface `selectAndReserve` is documented to take.
 *
 * @param {{now?: Date|number}} [options] - injected clock for the TTL check and
 *   for `lastSeenAt`, so a scheduling decision stays reproducible.
 * @returns {Promise<{transaction: Function, getPin: Function, setPin: Function,
 *   touchPin: Function, countActivePins: Function, recordSwitch: Function}>}
 *   every method SYNCHRONOUS. The promise is the adapter resolution, and it is
 *   resolved before the transaction opens.
 */
export async function createSchedulerRepos({ now = Date.now() } = {}) {
  // The one await. Everything returned below is synchronous by construction.
  const db = await getAdapter();
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const nowIso = new Date(nowMs).toISOString();
  const expiresAtIso = new Date(nowMs + PIN_IDLE_TTL_MS).toISOString();

  return {
    transaction(fn) {
      return db.transaction(fn);
    },

    getPin({ sessionHash, model } = {}) {
      if (!sessionHash || !model) return null;
      const row = db.get(
        `SELECT connectionId, pinnedAt, expiresAt FROM sessionAffinity
         WHERE sessionHash = ? AND model = ?`,
        [sessionHash, model]
      );
      return livePin(row, nowIso);
    },

    // Upsert, matching sessionAffinityRepo.setPin: a repin targets a session
    // that is already pinned by definition, so a second row for one
    // (session, model) would be two answers to a question with one answer.
    setPin({ sessionHash, model, connectionId, at } = {}) {
      if (!sessionHash || !model || !connectionId) return null;
      const pinnedAt = typeof at === 'string' && at !== '' ? at : nowIso;
      db.run(
        `INSERT INTO sessionAffinity(sessionHash, model, connectionId, providerNode, pinnedAt, expiresAt, lastSeenAt)
         VALUES(?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(sessionHash, model) DO UPDATE SET
           connectionId = excluded.connectionId,
           pinnedAt = excluded.pinnedAt,
           expiresAt = excluded.expiresAt,
           lastSeenAt = excluded.lastSeenAt`,
        [sessionHash, model, connectionId, pinnedAt, expiresAtIso, nowIso]
      );
      // The sweep rides the write that creates the row rather than a timer: a
      // timer is one more thing to start, to stop on shutdown and to reason
      // about under hot reload, and this runs on first-pin and repin only, not
      // on the pin-hit path that carries 99% of requests. idx_sa_expires makes
      // it an index scan over rows that are already dead. A NULL stamp is "no
      // TTL" and SQL's three-valued logic leaves those rows alone, which is
      // what the operator-cleared and drain paths rely on.
      db.run(`DELETE FROM sessionAffinity WHERE expiresAt IS NOT NULL AND expiresAt <= ?`, [
        nowIso,
      ]);
      return { connectionId, pinnedAt, expiresAt: expiresAtIso };
    },

    // lastSeenAt and the idle stamp, never pinnedAt. A same-account
    // re-selection is not a new binding, so pinnedAt must not move: decideRepin
    // re-ranks at the pin's own timestamp, and restamping it every request would
    // make a settled pin look permanently new and defeat rule 5. This is the
    // only write a reused pin produces, which is what makes a live session
    // distinguishable from an abandoned one and from a writer never reached.
    touchPin({ sessionHash, model, at } = {}) {
      if (!sessionHash || !model) return 0;
      const seenAt = typeof at === 'string' && at !== '' ? at : nowIso;
      const res = db.run(
        `UPDATE sessionAffinity SET lastSeenAt = ?, expiresAt = ? WHERE sessionHash = ? AND model = ?`,
        [seenAt, expiresAtIso, sessionHash, model]
      );
      return res?.changes ?? 0;
    },

    // Live pins per connection for `model`: connectionId -> count, zero rows
    // absent. The `pins` half of the scheduler's activeLoad, read inside the
    // transaction on a fresh pin only (accountScheduler.js), so two agents
    // arriving together see each other's pin rather than both landing on the
    // same idle account. Same SQL as sessionAffinityRepo.countActivePins.
    countActivePins({ model, now } = {}) {
      if (!model) return {};
      const cutoff = now instanceof Date
        ? now.toISOString()
        : typeof now === 'number'
          ? new Date(now).toISOString()
          : typeof now === 'string' && now !== '' ? now : nowIso;
      return rowsToPinCounts(db.all(ACTIVE_PINS_BY_CONNECTION_SQL, [model, cutoff]));
    },

    // Append-only, matching accountSwitchRepo.recordSwitch. The receipt arrives
    // from buildSwitchReceipt, whose `at` is this module's `switchedAt`; the
    // rename happens here rather than in the scheduler because the column name
    // is this layer's concern.
    recordSwitch(receipt) {
      if (!receipt || typeof receipt !== 'object') return null;
      const { sessionHash, model, toConnectionId } = receipt;
      // The three fields with no defensible default — a receipt missing any of
      // them cannot answer "which session, on which model, went where".
      if (!sessionHash || !model || !toConnectionId) return null;
      const id = receipt.id || randomUUID();
      db.run(
        `INSERT INTO accountSwitches(id, sessionHash, model, fromConnectionId, toConnectionId,
           trigger, reason, windows, switchedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          sessionHash,
          model,
          receipt.fromConnectionId ?? null,
          toConnectionId,
          receipt.trigger || 'unknown',
          receipt.reason ?? null,
          receipt.windows == null ? null : JSON.stringify(receipt.windows),
          receipt.switchedAt || receipt.at || nowIso,
        ]
      );
      return { ...receipt, id };
    },
  };
}
