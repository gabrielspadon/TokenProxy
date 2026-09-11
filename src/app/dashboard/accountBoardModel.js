import {
  accountControlId,
  accountControlState,
  accountWindowStale,
  accountWindowTime,
  accountWindows,
} from './accountControlPanelModel';
import { groupQuotaProducts } from './quotaProductGroups';

// One glance answers "how many accounts can take work right now". Every account
// lands in exactly one bucket; the order here is the order the strip renders.
export const BUCKETS = [
  { id: 'ready', label: 'Ready', tone: 'positive' },
  { id: 'low', label: 'Low quota', tone: 'ember' },
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

export function liveWindows(account, now) {
  return accountWindows(account).filter(
    (window) =>
      !window.unlimited && Number.isFinite(window.remaining) && !accountWindowStale(window, now)
  );
}

export function accountBucket(account, now) {
  const state = accountControlState(account, now);
  if (state === 'Paused' || state === 'Quota pause') return 'paused';
  if (state === 'Draining' || state === 'Cooldown' || state === 'Needs attention')
    return 'attention';
  const live = liveWindows(account, now);
  if (live.some((window) => window.remaining <= Math.max(LOW_REMAINING, window.threshold || 0)))
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
  if (accountWindows(account).some((window) => accountWindowStale(window, now))) return 'unknown';
  return state === 'Unknown' ? 'unknown' : 'ready';
}

// --- capacity axis -----------------------------------------------------------
// The buckets above answer "what is this account's health". They cannot answer
// "what can take work now, and when does more arrive", because a seat at 4% and
// a seat at 67% are both `ready`. These read the same windows on the capacity
// axis instead; nothing here replaces a bucket, both are exported.

export const CAPACITY = [
  { id: 'serving', label: 'Serving now', tone: 'positive' },
  { id: 'returns', label: 'Capacity returns', tone: 'ember' },
  { id: 'no-evidence', label: 'No quota evidence', tone: 'slate' },
];

/**
 * Which capacity state one account is in.
 *
 * A window with headroom is the only thing that licenses `serving`. Every live
 * window depleted is `returns`, because the capacity exists and its arrival is
 * known. No readable window is `no-evidence`: that account is not depleted, it
 * is unmeasured, and saying so is what tells a dead integration apart from an
 * exhausted one.
 */
export function accountCapacity(account, now) {
  const live = liveWindows(account, now);
  if (live.length === 0) return 'no-evidence';
  return live.every((window) => window.remaining <= 0) ? 'returns' : 'serving';
}

/**
 * When capacity returns, as epoch ms, or null.
 *
 * The LATEST reset among depleted windows, not the earliest: an account is
 * usable only once every exhausted window has rolled, so a 5h window reopening
 * while the weekly stays empty changes nothing.
 */
export function capacityReturnsAt(account, now) {
  const times = liveWindows(account, now)
    .filter((window) => window.remaining <= 0)
    .map((window) => Date.parse(window.resetAt))
    .filter((time) => Number.isFinite(time) && time > now);
  return times.length ? Math.max(...times) : null;
}

export function capacitySummary(accounts, now) {
  const counts = Object.fromEntries(CAPACITY.map((item) => [item.id, 0]));
  for (const account of accounts) counts[accountCapacity(account, now)] += 1;
  return counts;
}

// --- login grouping ----------------------------------------------------------
// One login can hold several DISTINCT upstream accounts, a personal seat and an
// organisation seat. Verified 2026-09-11 across seven logins: every pair held
// two different weekly windows, four days apart in one case, which a single
// account cannot do. Grouped for reading, never merged, because collapsing them
// would hide real capacity. Grouping is by the typed NAME because that is the
// only identity these rows carry: claude connections store no email (14 of 14
// null) and no upstream account id, unlike every other provider.
const SEAT_SUFFIX = /\s*\(([^)]+)\)\s*$/;

/** The login an account belongs to, and its seat name within that login. */
export function accountSeat(account) {
  const full = String(account.displayName || account.name || accountControlId(account));
  const match = SEAT_SUFFIX.exec(full);
  return match
    ? { login: full.slice(0, match.index), seat: match[1] }
    : { login: full, seat: null };
}

/** Accounts grouped by login, each group keeping its own distinct seats. */
export function groupBySeat(accounts) {
  const groups = new Map();
  for (const account of accounts) {
    const { login, seat } = accountSeat(account);
    const key = `${account.provider}::${login}`;
    if (!groups.has(key)) groups.set(key, { key, login, provider: account.provider, seats: [] });
    groups.get(key).seats.push({ ...account, seatLabel: seat });
  }
  return [...groups.values()].sort(
    (a, b) => a.login.localeCompare(b.login) || a.provider.localeCompare(b.provider)
  );
}

/**
 * The capacity state of a whole login, from its seats.
 *
 * A login can serve work if ANY of its seats can, so one serving seat makes the
 * group serving even beside a drained twin. `returns` needs at least one
 * depleted seat and no serving one; a group with neither is `no-evidence`.
 * This is the only place the two axes are combined, and it is deliberately not
 * a merge: the seats stay listed separately underneath.
 */
export function groupCapacity(group, now) {
  const states = group.seats.map((seat) => accountCapacity(seat, now));
  if (states.includes('serving')) return 'serving';
  return states.includes('returns') ? 'returns' : 'no-evidence';
}

/**
 * When a drained login can work again, as epoch ms, or null.
 *
 * The EARLIEST return among its depleted seats, which is the opposite of the
 * rule inside one account. Within an account every exhausted window must roll
 * before it is usable; across seats the first seat to come back is enough,
 * because the other seat was never what the work was waiting on.
 */
export function groupReturnsAt(group, now) {
  const times = group.seats
    .map((seat) => capacityReturnsAt(seat, now))
    .filter((time) => Number.isFinite(time));
  return times.length ? Math.min(...times) : null;
}

// The word beside the dot. Buckets are coarse on purpose; the word keeps the
// specific gate when there is one, so "Draining" and "Cooldown" stay distinct.
export function accountStateWord(account, now) {
  const state = accountControlState(account, now);
  const bucket = accountBucket(account, now);
  if (bucket === 'low') return 'Low quota';
  if (state === 'Needs attention') return 'Attention';
  if (state === 'Enabled' || state === 'Not checked') return 'Ready';
  return state;
}

export function fleetSummary(accounts, now) {
  const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, 0]));
  for (const account of accounts) counts[accountBucket(account, now)] += 1;
  return counts;
}

// The two axes filter independently and compose, because they answer different
// questions: a `returns` account can also be `paused`, and an operator narrowing
// to one is not asking to leave the other behind.
export function filterAccounts(accounts, { query = '', bucket = null, capacity = null }, now) {
  const needle = query.trim().toLowerCase();
  return accounts.filter(
    (account) =>
      (!bucket || accountBucket(account, now) === bucket) &&
      (!capacity || accountCapacity(account, now) === capacity) &&
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

// The window a person watches first: the least remaining among fresh, known,
// limited windows. Null when nothing fresh is known.
export function headroomOf(account, now) {
  const values = liveWindows(account, now).map((window) => window.remaining);
  return values.length ? Math.min(...values) : null;
}

// Everyday card order inside a bucket: most headroom first, unknown last, then name.
export function orderCards(accounts, now) {
  const name = (account) =>
    String(account.displayName || account.name || accountControlId(account));
  return [...accounts].sort((a, b) => {
    const ha = headroomOf(a, now),
      hb = headroomOf(b, now);
    if (ha === null && hb !== null) return 1;
    if (hb === null && ha !== null) return -1;
    return (hb ?? 0) - (ha ?? 0) || name(a).localeCompare(name(b));
  });
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
