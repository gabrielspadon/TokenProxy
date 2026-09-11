import { classifyWindow } from '@/shared/utils/quotaRanking';
import {
  accountControlId,
  accountControlState,
  accountWindowObservationStale,
  accountWindowStale,
  accountWindowTime,
  accountWindows,
} from './accountControlPanelModel';
import { groupQuotaProducts } from './quotaProductGroups';

// One glance answers "how many accounts can take work right now". Every account
// lands in exactly one bucket; the order here is the order the strip renders.
// `depleted` is its own word because `low` used to hold both nineteen percent
// and nothing at all, and those are different problems with different answers.
export const BUCKETS = [
  { id: 'ready', label: 'Ready', tone: 'positive' },
  { id: 'low', label: 'Low quota', tone: 'ember' },
  { id: 'depleted', label: 'Out of quota', tone: 'refusal' },
  { id: 'paused', label: 'Paused', tone: 'slate' },
  { id: 'attention', label: 'Attention', tone: 'refusal' },
  { id: 'unknown', label: 'Unknown', tone: 'slate' },
];

export const SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'reset', label: 'Next reset' },
  { value: 'headroom', label: 'Least headroom' },
  { value: 'attempts', label: 'Most attempts' },
];

// The low line, in remaining percent. One constant so the fleet strip and the
// meter cannot disagree about the same window: the bucket compared against 10
// while the meter compared against 20.
export const LOW_REMAINING = 20;

// The windows the low line is read from: current, readable, limited, and the
// account's OWN entitlement. A sub-quota was included here, so an account whose
// Codex Spark lane was empty reported "Low quota" beside a plan-wide window at
// 52%. Same classifier the router uses (src/shared/utils/quotaRanking.js:132).
// Observation age only. `accountWindowStale` also folds in "the reset passed",
// which would drop exactly the windows that have just been handed a fresh
// period; windowHeadroom below already answers that question, and answering it
// twice is what made a replenished account read as unmeasured.
export function liveWindows(account, now) {
  return accountWindows(account).filter(
    (window) =>
      !window.unlimited &&
      Number.isFinite(window.remaining) &&
      classifyWindow(window.key) === 'general' &&
      !accountWindowObservationStale(window, now)
  );
}

export function accountBucket(account, now) {
  const state = accountControlState(account, now);
  if (state === 'Paused' || state === 'Quota pause') return 'paused';
  if (state === 'Draining' || state === 'Cooldown' || state === 'Needs attention')
    return 'attention';
  // Nothing left is its own answer, ahead of the low line. Both fell into `low`
  // before, so an account at 0% and one at 19% carried the same word.
  if (accountDepleted(account, now)) return 'depleted';
  const live = liveWindows(account, now);
  // Headroom, not the stored number: a replenished window is full, so it is not
  // the thing dragging an account onto the low line.
  if (
    live.some(
      (window) => windowHeadroom(window, now) <= Math.max(LOW_REMAINING, window.threshold || 0)
    )
  )
    return 'low';
  if (live.length > 0) return state === 'Unknown' ? 'unknown' : 'ready';
  // No LIVE window. An unlimited one is still evidence of capacity, so that
  // stays ready, and a window present but unreadable means the account WAS
  // measured. What must not stay ready is evidence that has aged out: `ready`
  // claims the account can take work and nothing supports it. Measured
  // 2026-09-11, ten of thirty-one windows sat inside the fifteen-minute line,
  // so two accounts in the SAME state sorted differently on refresh timing.
  if (accountWindows(account).some((window) => window.unlimited)) {
    return state === 'Unknown' ? 'unknown' : 'ready';
  }
  if (accountWindows(account).some((window) => accountWindowObservationStale(window, now)))
    return 'unknown';
  // The terminal case: no readable window at all. This returned `ready`, which
  // is the board asserting capacity from an absence of evidence. Only a proof
  // earns the word now, and the absence itself is `unknown`.
  return accountProven(account) && state !== 'Unknown' ? 'ready' : 'unknown';
}

// --- what the router actually believes ---------------------------------------
// The board used to read a window's stored `remaining` as its current headroom.
// The router does not: it projects the period forward first, and the two
// disagree on exactly the accounts an operator cares about. Everything below
// is the router's own rule, restated in the units the board holds (percent
// remaining rather than absolute units), with the source of each cited.

// The scale a stored reading is on. `accountWindows` normalizes every provider
// to percent remaining, so a full window is 100.
const FULL = 100;

/**
 * Has this window's period already rolled over?
 *
 * A recorded reset at or before `now` means the provider has handed the account
 * a whole fresh period, so the depleted reading that predates it describes a
 * period that no longer exists. This is the router's rule at
 * src/shared/utils/quotaRanking.js:292, and the provider-side exhaustion check
 * refuses to call a model exhausted past its reset for the same reason at
 * open-sse/services/accountFallback.js:290.
 */
export function windowReplenished(window, now) {
  const resetAt = Date.parse(window.resetAt);
  return Number.isFinite(resetAt) && resetAt <= now;
}

/**
 * What this window has left RIGHT NOW, in percent, or null when unreadable.
 *
 * src/shared/utils/quotaRanking.js:295 in the board's units: a replenished
 * window reads full, never the zero on record. Reading that zero as depletion
 * is what parked replenished accounts beside genuinely exhausted ones.
 */
export function windowHeadroom(window, now) {
  if (window.unlimited) return FULL;
  if (!Number.isFinite(window.remaining)) return null;
  return windowReplenished(window, now) ? FULL : window.remaining;
}

/**
 * An account's GENERAL windows, the ones that constrain the whole connection.
 *
 * A sub-quota (`spark_weekly`, `weekly opus (7d)`) is not the account's
 * entitlement and must never bench it, which is why the router classifies
 * before it ranks (src/shared/utils/quotaRanking.js:132). Same classifier here,
 * so the board and the router cannot disagree about which windows count.
 */
export function generalWindows(account, now) {
  return accountWindows(account).filter(
    (window) => classifyWindow(window.key) === 'general' && windowHeadroom(window, now) !== null
  );
}

/**
 * How much the board is entitled to claim about this account.
 *
 * The router's two bands, in order: completeness first, then confidence
 * (src/shared/utils/quotaRanking.js:323 and :312). No readable general window
 * is `unknown`. A general window we could not read, or a reading older than the
 * observation line, is `stale`. Everything readable and current is `fresh`.
 * The worst window sets the band, exactly as `bandOf` takes the maximum.
 */
export function accountEvidence(account, now) {
  const general = accountWindows(account).filter(
    (window) => classifyWindow(window.key) === 'general'
  );
  const readable = general.filter((window) => windowHeadroom(window, now) !== null);
  if (readable.length === 0) return 'unknown';
  if (readable.length < general.length) return 'stale';
  return readable.some((window) => accountWindowObservationStale(window, now)) ? 'stale' : 'fresh';
}

/**
 * Is this account out of quota right now?
 *
 * ANY general window at or below zero, not every one. The router's rule 2 is
 * that every KNOWN hard window must have headroom, so a single exhausted weekly
 * takes the connection out of service however full its five-hour window reads
 * (src/shared/utils/quotaRanking.js:296, `if (effectiveRemaining <= 0) usable
 * = false`). The board's old rule was `every`, which is why an account the
 * router refuses to select still rendered as serving.
 */
export function accountDepleted(account, now) {
  const general = generalWindows(account, now);
  return general.length > 0 && general.some((window) => windowHeadroom(window, now) <= 0);
}

// An operator's own gate, or a recorded fault. None of these is serving traffic,
// whatever the quota says.
const HELD_STATES = new Set(['Paused', 'Quota pause', 'Draining', 'Cooldown', 'Needs attention']);

export function accountHeld(account, now) {
  return HELD_STATES.has(accountControlState(account, now));
}

/**
 * With no quota reading to show, has this account been PROVEN to work?
 *
 * Two proofs, and nothing else: it served a request that did not fail, or its
 * connection test passed. `status: 'healthy'` is exactly the latter — it is
 * only reached once a probe has run and did not come back degraded
 * (src/lib/admin/project.js:104-112). Being enabled is not a proof, and
 * `unqualified` is the recorded "nothing has established this works".
 */
export function accountProven(account) {
  const records = Number(account.activity?.records);
  const failed = Number(account.activity?.failed) || 0;
  if (Number.isFinite(records) && records > failed) return true;
  return account.status === 'healthy';
}

// --- the sections the board renders ------------------------------------------
// State first, identity second. Grouping by login put a drained seat and a full
// one under one heading, which is the reading an operator has to undo by hand
// before the board answers anything. Every account lands in exactly one
// section, and the order here is the order they render.

export const SECTIONS = [
  {
    id: 'serving',
    label: 'Serving now',
    tone: 'positive',
    note: 'Quota confirmed. These take work.',
  },
  {
    id: 'resting',
    label: 'Cooling down',
    tone: 'ember',
    note: 'Out of quota or held back. Each card leads with when it returns.',
  },
  {
    id: 'unverified',
    label: 'Unverified',
    tone: 'slate',
    note: 'No quota evidence and nothing has proved these work.',
  },
];

/**
 * The one section an account belongs to.
 *
 * Depleted or held is `resting`, because both answer "not now, and here is
 * when". An account with no evidence at all is `unverified` UNLESS something
 * proves it works, which is the only thing that earns it a place beside
 * accounts whose quota is known.
 */
export function accountSection(account, now) {
  if (accountHeld(account, now) || accountDepleted(account, now)) return 'resting';
  return accountEvidence(account, now) === 'unknown' && !accountProven(account)
    ? 'unverified'
    : 'serving';
}

export function sectionSummary(accounts, now) {
  const counts = Object.fromEntries(SECTIONS.map((item) => [item.id, 0]));
  for (const account of accounts) counts[accountSection(account, now)] += 1;
  return counts;
}

/**
 * When this account can work again, as epoch ms, or null.
 *
 * The LATEST reset among its exhausted windows, not the earliest: it is usable
 * only once every exhausted window has rolled, so a 5h window reopening while
 * the weekly stays empty changes nothing. A recorded cooldown is a deadline of
 * the same kind and joins the same maximum.
 */
export function accountReturnsAt(account, now) {
  const times = generalWindows(account, now)
    .filter((window) => windowHeadroom(window, now) <= 0)
    .map((window) => Date.parse(window.resetAt));
  const cooldown = Date.parse(account.rateLimitedUntil);
  if (Number.isFinite(cooldown)) times.push(cooldown);
  const future = times.filter((time) => Number.isFinite(time) && time > now);
  return future.length ? Math.max(...future) : null;
}

// --- seat labels -------------------------------------------------------------
// One login can hold several DISTINCT upstream accounts, a personal seat and an
// organisation seat. Verified 2026-09-11 across seven logins: every pair held
// two different weekly windows, four days apart in one case, which a single
// account cannot do. The seat is kept as a LABEL on the card rather than as a
// nested group, so the relationship survives while the nesting that made the
// board hard to read does not.
const SEAT_SUFFIX = /\s*\(([^)]+)\)\s*$/;

/** The login an account belongs to, and its seat name within that login. */
export function accountSeat(account) {
  const full = String(account.displayName || account.name || accountControlId(account));
  const match = SEAT_SUFFIX.exec(full);
  return match
    ? { login: full.slice(0, match.index), seat: match[1] }
    : { login: full, seat: null };
}

/**
 * The word beside the dot on a card.
 *
 * Read from the BUCKET, never decided again. The chip and the health strip used
 * to be computed by separate code, so the same account could be counted under
 * one word in the strip and show another on its card. One function answers
 * both; the word only adds the specific gate, which the coarse bucket drops.
 */
export function accountStateWord(account, now) {
  const state = accountControlState(account, now);
  const bucket = accountBucket(account, now);
  if (bucket === 'paused' || bucket === 'attention')
    return state === 'Needs attention' ? 'Attention' : state;
  if (bucket === 'depleted') return 'Out of quota';
  if (bucket === 'low') return 'Low quota';
  if (bucket === 'unknown') return 'Unknown';
  return state === 'Enabled' || state === 'Not checked' ? 'Ready' : state;
}

export function fleetSummary(accounts, now) {
  const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, 0]));
  for (const account of accounts) counts[accountBucket(account, now)] += 1;
  return counts;
}

// The two axes filter independently and compose, because they answer different
// questions: a `resting` account can also be `paused`, and an operator narrowing
// to one is not asking to leave the other behind.
export function filterAccounts(accounts, { query = '', bucket = null, section = null }, now) {
  const needle = query.trim().toLowerCase();
  return accounts.filter(
    (account) =>
      (!bucket || accountBucket(account, now) === bucket) &&
      (!section || accountSection(account, now) === section) &&
      (!needle ||
        `${account.displayName || account.name || ''} ${account.email || ''} ${account.provider} ${accountControlId(account)}`
          .toLowerCase()
          .includes(needle))
  );
}

// Flat window lines for one row. Product groups (Codex Spark, a Claude model
// allowance) prefix their label so the line still reads on its own.
export function windowLines(account) {
  return groupQuotaProducts(account.provider, accountWindows(account)).flatMap((group) =>
    group.windows.map((window) => ({
      ...window,
      product: group.id,
      label:
        group.id === 'general' || group.label === window.label
          ? window.label
          : `${group.label} · ${window.label}`,
    }))
  );
}

// The reset column, short enough for a card line: "in 1h 35m", "passed", or
// nothing when no reset time is known (the value column already says so).
export function resetShort(window, now) {
  const time = accountWindowTime(window.resetAt, now, true);
  if (!time.absolute) return '';
  return time.label.startsWith('Resets in ') ? `in ${time.label.slice(10)}` : 'passed';
}

// The window a person watches first: the least room left across this account's
// general windows, replenishment already applied. Null when none is readable.
export function headroomOf(account, now) {
  const values = generalWindows(account, now).map((window) => windowHeadroom(window, now));
  return values.length ? Math.min(...values) : null;
}

const accountName = (account) =>
  String(account.displayName || account.name || accountControlId(account));
// Numeric collation, because these names end in a digit far more often than
// not: a plain compare orders spadon+10 through +14 ahead of spadon+2.
const byName = (a, b) => accountName(a).localeCompare(accountName(b), undefined, { numeric: true });

// Most room first, an account with no reading last, then name. The everyday
// order wherever cards are grouped by something other than a return time.
export function orderCards(accounts, now) {
  const room = (account) => headroomOf(account, now) ?? -1;
  return [...accounts].sort((a, b) => room(b) - room(a) || byName(a, b));
}

/**
 * Card order WITHIN one section, keyed to what that section is for.
 *
 * Serving is ordered by headroom, because the seat that can absorb the most
 * work is the one to reach for. Cooling down is ordered by return time, soonest
 * first, because that is the one the operator is waiting on. Unverified has
 * nothing to rank on, so it is alphabetical. Insertion order orders nothing.
 */
export function orderSection(accounts, section, now) {
  if (section === 'serving') return orderCards(accounts, now);
  if (section === 'resting') {
    const at = (account) => accountReturnsAt(account, now) ?? Number.POSITIVE_INFINITY;
    return [...accounts].sort((a, b) => at(a) - at(b) || byName(a, b));
  }
  return [...accounts].sort(byName);
}

// Bar colour scale. Depleted is nothing left; low is at or under the larger of
// 20% and the account's own auto-pause threshold; warn is at or under half.
export function windowLevel(window) {
  if (window.unlimited || !Number.isFinite(window.remaining)) return null;
  if (window.remaining <= 0) return 'depleted';
  if (window.remaining <= Math.max(LOW_REMAINING, window.threshold || 0)) return 'low';
  if (window.remaining <= 50) return 'warn';
  return 'good';
}

export const windowHiddenId = (account, key) => `${accountControlId(account)}\u0000${key}`;

// Lines to draw for one account. A window the person hid stays hidden until
// they show it again. Inside one product, a depleted longer window (weekly,
// monthly) makes its shorter windows (session, hourly) meaningless, so those
// hide themselves and return once the longer window has room again.
export function visibleWindowLines(account, hiddenIds, now) {
  const lines = windowLines(account);
  const depletedOrder = {};
  for (const line of lines) {
    if (windowLevel(line) === 'depleted' && !accountWindowStale(line, now))
      depletedOrder[line.product] = Math.max(depletedOrder[line.product] ?? -1, line.order);
  }
  const shown = [];
  const hidden = [];
  for (const line of lines) {
    if (hiddenIds.has(windowHiddenId(account, line.key)))
      hidden.push({ ...line, reason: 'manual' });
    else if (line.order < (depletedOrder[line.product] ?? -1))
      hidden.push({ ...line, reason: 'depleted' });
    else shown.push(line);
  }
  return { shown, hidden };
}

export function providerList(accounts) {
  return [...new Set(accounts.map((account) => account.provider).filter(Boolean))].sort();
}

// How a provider entry can be credentialed, derived from the registry entry.
export function credentialModes(entry) {
  if (Array.isArray(entry.authModes) && entry.authModes.length) return entry.authModes;
  const modes = [];
  if (entry.hasOAuth) modes.push('oauth');
  if (entry.noAuth) modes.push('none');
  else if (entry.authType === 'cookie') modes.push('cookie');
  else modes.push('apikey');
  return modes;
}
