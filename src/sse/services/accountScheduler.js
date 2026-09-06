/**
 * Atomic select-and-reserve — Account Scheduling Contract rule 6: "Keep
 * selection and reservation in one transaction. Concurrent requests must not
 * all observe the same final slot and over-admit it."
 *
 * The whole decision — eligibility, ranking, pin resolution, reservation and
 * receipt construction — runs inside ONE `repos.transaction(fn)` call. Split
 * across two, a second request can rank against the same evidence the first
 * one already spent and take the same final slot.
 *
 * `repos` is INJECTED, so nothing here imports the DB barrel and a unit test
 * passes an in-memory fake. The injected surface is deliberately four methods:
 *   transaction(fn)                      -> fn's return value, synchronously
 *   getPin({sessionHash, model})         -> {connectionId} | null
 *   setPin({sessionHash, model, connectionId, at})
 *   touchPin({sessionHash, model, at})   -> lastSeenAt on a reused pin
 *   countActivePins({model, now})        -> {connectionId: livePins} for load spread
 *   recordSwitch(receipt)                -> persistence of rule 8's receipt
 * Everything else the scheduler needs is a parameter, because a scheduler that
 * reaches for state it was not handed is not reproducible from its inputs.
 *
 * Ranking is quotaRanking.js's job and capacity is accountCapacity.js's job.
 * Neither rule is restated here.
 */

import {
  rankAccounts,
  normalizeAccountWindows,
  effectiveResetAt,
} from '@/shared/utils/quotaRanking.js';
import { buildSwitchReceipt } from '@/shared/utils/switchReceipt.js';
import { decideRepin, TRIGGERS } from '@/shared/utils/repinPolicy.js';

// overlay-spec §4: a local admission refusal always carries a nonzero
// retry-after, so a caller is never told to retry with no delay hint at all.
const RETRY_AFTER_SECONDS = 1;

// The transaction body is synchronous on every SQLite adapter in
// src/lib/db/adapters/ (better-sqlite3, bun:sqlite, node:sqlite, sql.js all
// take a sync fn). Nothing below awaits, which is what keeps the read of a
// free slot and the taking of it indivisible.
function runInTransaction(repos, fn) {
  if (typeof repos?.transaction !== 'function') {
    throw new TypeError('selectAndReserve requires an injected repos.transaction(fn)');
  }
  return repos.transaction(fn);
}

/**
 * The soonest projected reset across a candidate set, as an ISO string, or null
 * when no candidate carries a readable deadline. This is the honest answer to
 * "when should the caller come back" once every account is depleted; the
 * one-second admission floor is for a capacity wait, not for an empty pool.
 */
function earliestReset(candidates, nowMs) {
  let soonest = null;
  for (const account of candidates) {
    const norm = normalizeAccountWindows(account?.windows);
    if (!norm.ok) continue;
    for (const w of norm.windows) {
      const at = effectiveResetAt(w.resetAt, w.horizonMs, nowMs);
      if (at === null) continue;
      if (soonest === null || at < soonest) soonest = at;
    }
  }
  return soonest === null ? null : new Date(soonest).toISOString();
}

// connectionId -> {pins, inFlight} for every candidate, the shape
// rankAccounts's `activeLoad` takes. Fails open on a repos or registry that
// cannot count: a missing method reads as zero on that axis, so the spread
// degrades to the other axis rather than to a throw inside the transaction.
function activeLoadFor(candidates, model, nowMs, registry, repos) {
  const pins = typeof repos?.countActivePins === 'function'
    ? repos.countActivePins({ model, now: nowMs }) ?? {}
    : {};
  const inFlightOf = typeof registry?.inFlight === 'function'
    ? (id) => registry.inFlight(id)
    : () => 0;
  const load = new Map();
  for (const { id } of candidates) {
    load.set(id, {
      pins: Object.hasOwn(pins, id) ? Number(pins[id]) || 0 : 0,
      inFlight: Number(inFlightOf(id)) || 0,
    });
  }
  return load;
}

/**
 * Select an account for one request and reserve a slot on it, atomically.
 *
 * @param {object} input
 * @param {string} input.sessionHash - hashed client session identity.
 * @param {string} input.model
 * @param {Array<object>} input.accounts - candidate connections, each carrying
 *   `id` and optionally `priority` and `maxConcurrent`.
 * @param {Record<string, Array<object>>|Array<object>} input.windows - quota
 *   windows keyed by connection id. An array is accepted only when it is the
 *   already-per-account `windows` field on each account.
 * @param {number|Date} input.now - REQUIRED and injected; no clock is read.
 * @param {{reserve: Function, release: Function}} input.registry - a lease
 *   registry from createLeaseRegistry.
 * @param {object} input.repos - injected persistence (see module docstring).
 *   `touchPin` is optional: a caller that does not supply it loses only the
 *   liveness stamp, never the selection. `countActivePins` is optional too: a
 *   repos without it spreads new pins by open leases alone.
 * @returns {{connection: object, lease: object, receipt: object|null, reason: string}
 *   | {unavailable: true, retryAfter: number, reason: string}}
 */
export function selectAndReserve({
  sessionHash,
  model,
  accounts,
  windows,
  now,
  registry,
  repos,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('selectAndReserve requires an injected numeric or Date `now`');
  }
  if (typeof registry?.reserve !== 'function' || typeof registry?.release !== 'function') {
    throw new TypeError('selectAndReserve requires an injected lease registry');
  }

  // Windows may arrive as a by-connection map or already attached to each
  // account. Resolving before the transaction keeps the transaction body free
  // of shape-guessing.
  const windowsFor = (account) => {
    if (windows && !Array.isArray(windows) && typeof windows === 'object') {
      return windows[account.id] ?? account.windows ?? [];
    }
    return account?.windows ?? [];
  };

  const candidates = (Array.isArray(accounts) ? accounts : [])
    .filter((a) => a && typeof a.id === 'string' && a.id !== '')
    .map((a) => ({ ...a, windows: windowsFor(a) }));

  return runInTransaction(repos, () => {
    if (candidates.length === 0) {
      return {
        unavailable: true,
        retryAfter: RETRY_AFTER_SECONDS,
        reason: 'no-accounts',
        trace: [{ cls: 'SEL', verdict: 'refused', fields: { why: 'no-accounts' } }],
      };
    }

    // Rule 4: the pin is read INSIDE the transaction. Read outside it, a
    // concurrent repin lands between the read and the reservation and two
    // requests for one session pin to two different accounts.
    const pin = typeof repos.getPin === 'function' ? repos.getPin({ sessionHash, model }) : null;
    const previousPinId = typeof pin?.connectionId === 'string' ? pin.connectionId : null;

    // Active load for every NEW PLACEMENT. The ranker orders on quota evidence,
    // which every fresh pin reads identically, so per-agent affinity keys alone
    // put every agent on the one best-evidenced account and drove it into its
    // upstream rate limit while accounts with headroom idled. Live pins for
    // this model come from the same transaction (a concurrent first pin is
    // visible, not raced), open leases from the registry.
    //
    // Handed over unconditionally, because the ranker decides where it applies
    // and the pinned case is not the same as the no-pin case: a HEALTHY pin
    // ignores it entirely (moving a settled session would throw away the
    // provider-side cache the pin exists to keep), while a pin whose account
    // has gone unusable is a fresh placement and must spread, or every agent
    // depleting together rebuilds the concentration one account over.
    // ponytail: one grouped COUNT per request over a table bounded by live
    // agents times models. Make it conditional on the pin's usability if that
    // read ever shows up in a profile.
    const activeLoad = activeLoadFor(candidates, model, nowMs, registry, repos);

    const { ranked, eligible, degraded, reason: rankReason, trace: rankingTrace } = rankAccounts(candidates, { now: nowMs, previousPinId, activeLoad });

    // Rule 4 (keep a healthy pin) AND rule 5 (atomically return to the
    // earliest account that restored while a later one was serving) are
    // decideRepin's job (repinPolicy.js) — "is the pin still eligible" can
    // only express rule 4. Only decideRepin re-asks the ranker at the pin's
    // own timestamp to tell a genuine reset apart from an account that was
    // merely available all along, which is what keeps rule 5 from spraying a
    // session across every account that ever edges ahead on ranking.
    // The same activeLoad the ranker saw: the policy re-asks the ranker, and
    // its INITIAL_PIN answer is what the slot walk below puts first, so a
    // policy ranking without the load would undo the spread it just computed.
    const repin = decideRepin({ pin, accounts: candidates, now: nowMs, activeLoad });
    // The repin verdict as a trace entry, in the design's vocabulary. The
    // scheduler never prints: auth.js walks `trace` and calls decide().
    // pin-hit is NOMINAL (row 29: silent, carried to the caller for REQ sel=).
    const id8 = (v) => String(v ?? '').slice(0, 8);
    const SEL_TRIGGER = {
      [TRIGGERS.INITIAL_PIN]: 'initial-pin',
      [TRIGGERS.RESET]: 'quota-reset',
      [TRIGGERS.UNAVAILABLE]: 'unavailable',
    };
    // action 'none' contributes nothing on the success path: a degraded
    // cohort still serves from the fallback order, so a refusal line here
    // would describe a refusal that never happened. The refusal entries are
    // added at the two exits that actually refuse (below).
    const repinTrace = repin.action === 'keep'
      ? [{ cls: 'SEL', verdict: 'pin-hit', fields: { conn: id8(repin.to), why: repin.reason } }]
      : repin.action === 'none'
        ? []
        : [{
            cls: 'SEL',
            verdict: repin.trigger === TRIGGERS.EXHAUSTION ? 'pin-expired' : 'repin',
            fields: {
              from: repin.from ? id8(repin.from) : 'none',
              to: id8(repin.to),
              trigger: SEL_TRIGGER[repin.trigger] ?? repin.trigger,
              why: repin.reason,
            },
          }];
    // ELIGIBILITY IS NOT NEGOTIABLE, degraded or not. This read `degraded ?
    // ranked : eligible`, and `ranked` carries every record including the ones
    // whose quota is provably at its limit, so a pool whose accounts disagreed
    // about window shape (the common case: ten Claude connections reported four
    // shapes) selected depleted accounts and paid a 429 to discover it.
    // rankAccounts now degrades ORDERING only and still answers `eligible`
    // truthfully, so there is one list to walk.
    const order = eligible;
    const decidedId = repin.connectionId;
    // The policy layer may NAME one account the ranker calls ineligible: the
    // all-depleted hold, where every reading says depleted and the pin is held
    // so the upstream — not an aging snapshot — decides. That is a decision
    // about one specific account, so it is looked up in `ranked` only after
    // `eligible` misses, and everything else that gets tried still comes from
    // `eligible`. The old code took `ranked` wholesale whenever the pool
    // degraded, which is how list order replaced quota order.
    const decided = decidedId
      ? order.find((r) => r.id === decidedId) ?? ranked.find((r) => r.id === decidedId) ?? null
      : null;
    const preferred = decided
      ? [decided, ...order.filter((r) => r.id !== decidedId)]
      : order;

    if (preferred.length === 0) {
      const detail = rankReason ? `:${rankReason}` : '';
      return {
        unavailable: true,
        retryAfter: RETRY_AFTER_SECONDS,
        reason: `no-eligible-account${detail}`,
        degraded,
        // Every account is out of headroom, and the ranker knows when the first
        // of them comes back. Handing that up is what lets the caller quote a
        // real reset instead of the one-second floor.
        earliestResetAt: earliestReset(candidates, nowMs),
        trace: [
          ...(rankingTrace || []),
          ...repinTrace,
          { cls: 'SEL', verdict: 'refused', fields: { why: 'none-eligible' } },
        ],
      };
    }

    // Walk the ranked order and take the first slot that is actually free.
    // Reservation is what proves availability; a capacity READ followed by a
    // separate take is the over-admission this rule exists to prevent.
    // Slot-walk skips are folded for the caller: who was tried and refused,
    // max 3, the rest counted (docs/logging-design.md row 28).
    const skipped = [];
    for (const record of preferred) {
      const lease = registry.reserve(record.id);
      if (!lease) {
        skipped.push(`${String(record.id).slice(0, 8)}:capacity`);
        continue;
      }

      const switched = previousPinId !== null && previousPinId !== record.id;
      const isFirstPin = previousPinId === null;

      if (switched || isFirstPin) {
        if (typeof repos.setPin === 'function') {
          repos.setPin({
            sessionHash,
            model,
            connectionId: record.id,
            at: new Date(nowMs).toISOString(),
          });
        }
      } else if (typeof repos.touchPin === 'function') {
        // A settled session takes THIS branch and no other, for every request
        // after its first. Writing nothing here meant one session produced one
        // row-write for its whole life, so a gateway serving off a live pin left
        // sessionAffinity untouched and lastSeenAt could not tell a reused pin
        // from a writer that was never reached. pinnedAt deliberately does not
        // move: it is when this binding started and decideRepin re-ranks at it.
        repos.touchPin({ sessionHash, model, at: new Date(nowMs).toISOString() });
      }

      // Rule 8: a receipt for every switch, including the first pin, which is
      // a switch from nothing. A same-account re-selection is not a switch and
      // gets no receipt — a receipt per request would bury the switches.
      let receipt = null;
      if (switched || isFirstPin) {
        receipt = buildSwitchReceipt({
          from: previousPinId,
          to: record.id,
          windows: record.account?.windows ?? [],
          trigger: isFirstPin ? 'first-pin' : repin.trigger || TRIGGERS.EXHAUSTION,
          model,
          sessionHash,
          now: nowMs,
        });
        if (typeof repos.recordSwitch === 'function') {
          // The recorded row's id is what SEL.repin references as rcpt= — the
          // receipt content lives in accountSwitches once, never duplicated
          // into the log line.
          const recorded = repos.recordSwitch(receipt);
          if (recorded?.id) receipt = { ...receipt, id: recorded.id };
        }
      }

      const skippedTrace = skipped.length
        ? [{
            cls: 'SEL',
            verdict: 'skipped',
            fields: {
              alt: skipped.slice(0, 3),
              ...(skipped.length > 3 ? { more: skipped.length - 3 } : {}),
            },
          }]
        : [];

      return {
        connection: record.account,
        lease,
        receipt,
        reason: isFirstPin ? 'first-pin' : switched ? 'repin' : 'pinned',
        repin,
        skipped,
        trace: [...(rankingTrace || []), ...repinTrace, ...skippedTrace],
      };
    }

    // Every eligible account is at capacity. overlay-spec §4: this is a WAIT
    // condition with a nonzero retry-after, not a hard failure — the caller
    // queues and retries rather than seeing a 503 while entitlement is free.
    return {
      unavailable: true,
      retryAfter: RETRY_AFTER_SECONDS,
      reason: 'at-capacity',
      trace: [
        ...(rankingTrace || []),
        ...repinTrace,
        ...(skipped.length
          ? [{
              cls: 'SEL',
              verdict: 'skipped',
              fields: {
                alt: skipped.slice(0, 3),
                ...(skipped.length > 3 ? { more: skipped.length - 3 } : {}),
              },
            }]
          : []),
        {
          cls: 'SEL',
          verdict: 'refused',
          fields: { why: repin.action === 'none' ? 'none-eligible' : 'lease-refused' },
        },
      ],
    };
  });
}
