/**
 * Repin decision — Account Scheduling Contract rules 4 and 5
 * (RECONCILIATION.md), the policy layer above the ranker.
 *
 * Pure. No DB imports, no clock reads: the caller injects `now`, so a repin
 * decision is reproducible from the evidence it was made on, which is the same
 * evidence the switch receipt stores.
 *
 * src/shared/utils/quotaRanking.js is the ONLY ranking authority here. This
 * module never orders accounts itself; it asks `rankAccounts` who is eligible
 * and who ranks ahead, and adds the one thing ranking cannot express: WHETHER a
 * pin should move at all.
 *
 * THE POLICY, and why it changed (2026-09-04).
 *
 * A switch is not free. Moving a live session to another account abandons that
 * account's prompt-cache prefix, so the next request re-primes the whole
 * conversation at full input price. The operator therefore pays cash for every
 * switch, and the only switch worth paying for is one that buys entitlement we
 * would otherwise have lost.
 *
 * So a HEALTHY pin is never surrendered. Not to an account that edged ahead on
 * ranking, and not to an account that just reset either. The decision point is
 * DEPLETION: when the pinned account can no longer serve, we choose again, and
 * at that moment the ranker is asked fresh — which is what folds a
 * just-restocked account back into the choice and puts it first if its own
 * projected deadline lands before the next candidate's. That is rule 5's
 * "return to the earliest restored account" read the way it maximizes
 * entitlement: earliest by DEADLINE, since the deadline is what decides whose
 * tokens get wasted, not by an operator-declared account order.
 *
 * The previous implementation did two things this one deliberately does not.
 * It preempted a healthy pin whenever some account had become eligible since
 * `pinnedAt`, which spent a cache re-prime on a session that was serving
 * perfectly well. And it decided which account to move to by CONFIGURED
 * PRIORITY, falling back to the account's index in the connection list when no
 * priority was set — which is the common case, so "earliest restored" quietly
 * meant "whichever restored account happens to sit higher in the DB listing".
 * That contradicts rule 3, which fixes priority as a tie-break only, and it
 * both refused genuine returns (a restocked account whose 5h window expires in
 * an hour, sitting low in the list) and forced pointless ones (a restocked
 * account with a week of runway, sitting high in the list).
 *
 * `pinnedAt` still has one job, and it is observability only: it labels a move
 * that landed on an account which had restocked since the pin was made as
 * `reset` rather than `exhaustion`, so the receipt says which of rule 5's two
 * cases an incident review is looking at. It never decides the move.
 */

import { rankAccounts } from './quotaRanking.js';

// Trigger vocabulary, shared with the accountSwitches table in
// src/lib/db/schema.js so a decision and its receipt say the same word.
export const TRIGGERS = {
  INITIAL_PIN: 'initial-pin',
  EXHAUSTION: 'exhaustion',
  RESET: 'reset',
  UNAVAILABLE: 'unavailable',
};

const keep = (pin, reason) => ({
  action: 'keep',
  connectionId: pin?.connectionId ?? null,
  to: pin?.connectionId ?? null,
  from: pin?.connectionId ?? null,
  trigger: null,
  reason,
});

// `to` mirrors `connectionId` so a printer reads one vocabulary across all
// three actions. The module stays pure: it returns the verdict, it never
// prints it (docs/logging-design.md step 3.2).
const none = (reason) => ({
  action: 'none',
  connectionId: null,
  to: null,
  from: null,
  trigger: null,
  reason,
});

const move = (from, to, trigger, reason) => ({
  action: 'repin',
  connectionId: to,
  to: to ?? null,
  from: from ?? null,
  trigger,
  reason,
});

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Was `targetId` ineligible when this pin was made, and eligible now? Used
 * ONLY to label the receipt: a move onto an account that restocked in the
 * meantime is rule 5's return, and reads as `reset`; anything else is plain
 * `exhaustion`. Any doubt resolves to false, because mislabelling a switch as a
 * reset when it was not is worse than the reverse.
 */
function restockedSincePin(pin, cohort, targetId, nowMs, model) {
  const pinnedAtMs = toMs(pin?.pinnedAt);
  if (pinnedAtMs === null || pinnedAtMs > nowMs) return false;
  try {
    const atPin = rankAccounts(cohort, {
      now: pinnedAtMs,
      previousPinId: pin?.connectionId ?? null,
      model,
    });
    // A baseline with no evidence reads as "nothing was eligible back then",
    // which would make every account look restored. Refuse to label.
    if (atPin.degraded) return false;
    return !atPin.eligible.some((r) => r.id === targetId);
  } catch {
    return false;
  }
}

/**
 * Decide what happens to one session's pin.
 *
 * @param {{
 *   pin: {connectionId: string, pinnedAt?: string}|null,
 *   accounts: Array<{id: string, priority?: number, windows: Array<object>}>,
 *   now: number|Date,
 *   unavailableIds?: Iterable<string>,
 *   activeLoad?: Map<string, {pins: number, inFlight: number}>|Record<string, object>|null
 * }} input
 *   `activeLoad` is handed straight to rankAccounts, which reads it for a
 *   NEW pin only (headroom floor, then live pins plus open leases). With an
 *   existing pin the ranker ignores it, so nothing below moves a session
 *   because its account got busy.
 *   `unavailableIds` carries what quota windows cannot show — a drained
 *   account, an unhealthy connection, one that just failed for this model.
 *   Those accounts leave the cohort entirely rather than being ranked and
 *   rejected, because an account that cannot serve is not failover inventory
 *   for this decision.
 * @returns {{
 *   action: 'keep'|'repin'|'none', connectionId: string|null,
 *   to: string|null, from: string|null, trigger: string|null, reason: string
 * }}
 *   `repin` covers the first pin too (`from` null, trigger `initial-pin`), so a
 *   caller has one write path rather than two. `none` means nothing can serve
 *   this session right now and the caller queues or fails over; it never means
 *   "silently pick something".
 */
export function decideRepin({ pin, accounts, now, unavailableIds = [], activeLoad = null, model = null } = {}) {
  const unavailable = new Set(unavailableIds);
  const cohort = (Array.isArray(accounts) ? accounts : []).filter((a) => !unavailable.has(a?.id));
  const pinnedId = pin?.connectionId ?? null;

  if (cohort.length === 0) return none('no-accounts');

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const ranked = rankAccounts(cohort, { now: nowMs, previousPinId: pinnedId, activeLoad, model });
  const winner = ranked.winner?.id ?? null;
  const pinned = ranked.ranked.find((r) => r.id === pinnedId);
  if (pinned?.hardBlocked) {
    return winner
      ? move(pinnedId, winner, TRIGGERS.UNAVAILABLE, 'pinned-entitlement-unavailable')
      : none('no-eligible-account');
  }

  // Checked before the degraded gate below, because stickiness to an account
  // that has left the cohort is not stickiness, it is routing to nothing.
  const pinnedGone = pinnedId && !cohort.some((a) => a?.id === pinnedId);
  if (pinnedGone) {
    return winner
      ? move(pinnedId, winner, TRIGGERS.UNAVAILABLE, 'pinned-connection-unavailable')
      : none(ranked.reason || 'no-eligible-account');
  }

  // A degraded pool means no account anywhere reported a deadline, so there is
  // no urgency evidence to act on. Rule 4's failure direction is
  // previous-pin-first, and moving a session on an absence of evidence is the
  // exact spray rule 5 forbids. Note this is an ORDERING degradation only:
  // rankAccounts still enforces eligibility, so `winner` below is never an
  // account we know to be depleted.
  if (ranked.degraded) {
    if (pinnedId) return keep(pin, `ranking-degraded:${ranked.reason}`);
    return winner
      ? move(null, winner, TRIGGERS.INITIAL_PIN, `no-existing-pin:${ranked.reason}`)
      : none(ranked.reason);
  }

  if (!pinnedId) {
    return winner
      ? move(null, winner, TRIGGERS.INITIAL_PIN, 'no-existing-pin')
      : none(ranked.reason || 'no-eligible-account');
  }

  // FAIL OPEN WHEN THE WHOLE POOL READS DEPLETED. Quota evidence is a
  // snapshot, and for most providers a percentage-only one carried at
  // `confidence: unknown` that can be hours old. Refusing the request on that
  // reading is a self-inflicted outage: the upstream is the authority on
  // whether it will serve, not our last snapshot of it. So hold the session
  // where it is and let the provider answer. If it really is out, the 429
  // cascade excludes it, the pool shrinks, and the caller ends up with the real
  // rate-limit answer and a real reset time rather than one we guessed.
  //
  // This is the ONE case where the decision names an account the ranker calls
  // ineligible, and it names exactly one: the pin. It is not a licence for the
  // scheduler to walk the pool in list order, which is the failure this policy
  // layer exists to prevent.
  if (ranked.eligible.length === 0) {
    return keep(pin, `all-depleted-holding-pin:${ranked.reason || 'all-depleted'}`);
  }

  // THE DECISION POINT. The pinned account still has headroom, so it keeps the
  // session: no ranking outcome and no other account's reset takes a healthy
  // pin, because the switch would cost a full cache re-prime and buy nothing.
  if (ranked.eligible.some((r) => r.id === pinnedId)) {
    return keep(pin, 'pin-healthy');
  }

  // The pinned account is depleted. Choose again from scratch: `winner` is the
  // eligible account whose main-quota deadline lands soonest, which is exactly
  // where an account that restocked while this session was living elsewhere
  // belongs — ahead of the next candidate when its own deadline comes first,
  // behind it when it does not.
  if (!winner) return none(ranked.reason || 'no-eligible-account');
  const returning = restockedSincePin(pin, cohort, winner, nowMs, model);
  return move(
    pinnedId,
    winner,
    returning ? TRIGGERS.RESET : TRIGGERS.EXHAUSTION,
    returning ? 'pinned-window-exhausted:returning-to-restored' : 'pinned-window-exhausted',
  );
}
