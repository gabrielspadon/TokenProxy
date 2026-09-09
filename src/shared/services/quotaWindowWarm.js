/**
 * Quota-window warming plan — which of an account's windows are not running,
 * and whether it is worth one tiny request to start them.
 *
 * WHY THIS EXISTS. A provider's usage windows mostly do not start on a
 * schedule, they start on FIRST USE. An idle account therefore sits with its
 * clock stopped: the five-hour window does not begin counting until something
 * is sent, and the provider reports no window at all until then. Across a pool
 * that is expensive in a way that does not show up as an error anywhere. Ten
 * accounts whose windows all begin whenever a human happens to touch them give
 * you ten clocks bunched around working hours and long stretches where nothing
 * is accruing, instead of ten staggered clocks rolling continuously. The point
 * of warming is to keep every window rolling so the pool always has a window
 * about to reset, which is exactly the entitlement the scheduler ranks on.
 *
 * WHAT WAS BROKEN. The scheduler read ONE named window per provider and gave up
 * the moment that window had no reset timestamp:
 *
 *     const resetAt = quota?.resetAt;
 *     if (!resetAt) return;
 *
 * An idle window is precisely the case with no reset timestamp — Anthropic's
 * usage payload omits `five_hour` entirely until the window is running, so
 * `quotas["session (5h)"]` is undefined and the function returned. So the one
 * condition warming exists to fix was the one condition that disabled it, and
 * the window stayed cold until a person used the account by hand. Measured on
 * the RTX seam: one ping sent in thirty-six hours across ten enabled Claude
 * accounts, against seventeen "quota exhausted, skipped" decisions.
 *
 * Reading a single window was the second half of it. Claude meters a 5h window,
 * a 7d window and per-model 7d windows; the config named only `session (5h)`,
 * so nothing else was ever considered.
 *
 * Pure. No clock, no network, no database: `now` and the persisted state are
 * parameters, so a warming decision is reproducible from what it was handed and
 * a test needs no timers.
 */

import { windowHorizonMs } from '@/shared/utils/quotaRanking.js';

// Never warm the same window family more often than this, whatever its period
// says. A provider that will never report a window (a plan without that meter)
// otherwise looks permanently "not running" and would be pinged every tick.
export const MIN_WARM_INTERVAL_MS = 600_000;

// Fraction of a window's own period used as its warm interval. A 5h window
// admits a warm attempt at most every 25 minutes, a 7d window every 14 hours.
export const WARM_INTERVAL_DIVISOR = 12;

// A window we pinged and that STILL did not start is either not metered for
// this account or not startable by this request shape. Backing off to one
// attempt per period stops a pointless request every 25 minutes forever, while
// still recovering on its own if the account's plan changes.
export const UNSTARTED_BACKOFF_PERIODS = 1;

// Fallback period for a window whose name carries no parseable horizon.
export const DEFAULT_WINDOW_PERIOD_MS = 18_000_000; // 5h

/**
 * The period of one window family, in milliseconds.
 *
 * Config wins, because a provider is allowed to name a window something the
 * horizon parser cannot read ("Ratelimit"). Then the shared parser the ranker
 * already uses, so "session (5h)", "weekly (7d)" and "monthly (30d)" need no
 * configuration at all. Then a conservative default.
 */
export function windowPeriodMs(name, periods = {}) {
  const declared = Number(periods?.[name]);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const parsed = windowHorizonMs(name);
  // windowHorizonMs returns 1ms for a name it cannot read, which is not a
  // period. Anything under a minute is that sentinel.
  if (Number.isFinite(parsed) && parsed >= 60_000) return parsed;
  return DEFAULT_WINDOW_PERIOD_MS;
}

/**
 * A reset timestamp, rounded down to the minute.
 *
 * Providers jitter a reset by a second or two between reads, so the raw
 * timestamp is not a stable identity for "this instance of the window". The
 * minute is, and it is what stops a window being warmed twice because its
 * reported reset drifted by three seconds.
 */
export function normalizeResetKey(resetAt) {
  const ms = new Date(resetAt).getTime();
  if (!Number.isFinite(ms)) return typeof resetAt === 'string' ? resetAt : null;
  return new Date(Math.floor(ms / 60000) * 60000).toISOString();
}

function toMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** True when the provider says this window has nothing left in it. */
export function isWindowExhausted(quota) {
  if (!quota || quota.unlimited === true) return false;
  const remaining = toFiniteNumber(quota.remaining);
  if (remaining !== null) return remaining <= 0;
  const used = toFiniteNumber(quota.used);
  const total = toFiniteNumber(quota.total);
  return total !== null && total > 0 && used !== null && used >= total;
}

/**
 * Sort one account's window families into what is running, what is not, and
 * what is spent.
 *
 * `tracked` is the union of the families the provider config expects, the ones
 * present in this reading, and the ones we have warmed before. The expected set
 * is what makes an ABSENT window visible: a family missing from the payload is
 * the whole reason this module exists, and a payload-only view cannot see it.
 *
 * A SLIDING reset is the fourth way a clock can be stopped, and the only one
 * that looks healthy from a single reading. Some providers (Codex among them)
 * report a session window with a future reset even while the window is idle,
 * and push that reset forward as real time passes. One reading cannot tell that
 * apart from a window that is genuinely running, so it takes two: a reset that
 * has moved forward by more than `resetAtDriftMs` since we last saw it has been
 * sliding, which means nothing was ever counted against it.
 *
 * @param {{quotas: object, tracked: Iterable<string>, now: number,
 *   state?: object, resetAtDriftMs?: number}} input
 * @returns {{running: Array<{name: string, resetAt: number}>,
 *   notRunning: Array<{name: string, why: string}>,
 *   exhausted: Array<{name: string, resetAt: number|null}>}}
 */
export function classifyWindows({
  quotas = {},
  tracked = [],
  now,
  state = {},
  resetAtDriftMs = 0,
} = {}) {
  const nowMs = toMs(now) ?? 0;
  const running = [];
  const notRunning = [];
  const exhausted = [];

  for (const name of new Set(tracked)) {
    const quota = quotas?.[name];
    if (!quota) {
      // The payload does not carry this family at all. For every provider that
      // starts a window on first use, that IS the stopped clock.
      notRunning.push({ name, why: 'absent', resetAt: null });
      continue;
    }
    if (quota.unlimited === true) continue;

    const resetAt = toMs(quota.resetAt);
    if (resetAt === null) {
      notRunning.push({ name, why: 'no-reset', resetAt: null });
      continue;
    }
    if (resetAt <= nowMs) {
      // The window we last heard about has ended and the next one has not
      // begun, so the clock is stopped again.
      notRunning.push({ name, why: 'reset-elapsed', resetAt });
      continue;
    }
    if (isWindowExhausted(quota)) {
      exhausted.push({ name, resetAt });
      continue;
    }
    const lastSeenResetAt = toMs(stateFor(state, name).lastSeenResetAt);
    if (
      resetAtDriftMs > 0
      && lastSeenResetAt !== null
      && resetAt - lastSeenResetAt >= resetAtDriftMs
    ) {
      notRunning.push({ name, why: 'reset-slid', resetAt });
      continue;
    }
    running.push({ name, resetAt });
  }

  return { running, notRunning, exhausted };
}

/**
 * Per-window warm state, as persisted on the connection.
 * `{ [windowName]: { lastWarmedAt: ISO, unstartedSince: ISO|null } }`
 */
function stateFor(state, name) {
  const entry = state?.[name];
  return entry && typeof entry === 'object' ? entry : {};
}

/**
 * Is this family allowed a warm attempt right now?
 *
 * Two brakes. The interval brake keeps a family that will never report from
 * costing a request every tick. The unstarted brake is harder: a family we
 * already warmed and that did not start gets one attempt per period, because
 * repeating a request the provider evidently does not count is pure waste.
 */
export function warmAllowed({ name, state, now, periods = {}, config = {}, resetKey = null } = {}) {
  const nowMs = toMs(now) ?? 0;
  const period = windowPeriodMs(name, periods);
  const minInterval = Math.max(
    Number(config.minWarmIntervalMs) || MIN_WARM_INTERVAL_MS,
    Math.floor(period / (Number(config.warmIntervalDivisor) || WARM_INTERVAL_DIVISOR)),
  );
  const entry = stateFor(state, name);
  const lastWarmedAt = toMs(entry.lastWarmedAt);
  const unstartedSince = toMs(entry.unstartedSince);
  const attemptedAt = toMs(entry.lastAttemptedAt);

  // An interrupted dispatch can already have spent quota. A restart or another
  // tick cannot authorize replay. Only a separately observed later reset cycle
  // can admit another warm; an absent reset is not evidence of such a cycle.
  if (['dispatching', 'uncertain'].includes(entry.lastAttemptOutcome)) {
    if (!resetKey || resetKey === entry.lastAttemptedResetKey ||
        toMs(resetKey) === null || attemptedAt === null || toMs(resetKey) <= attemptedAt) {
      return { allowed: false, reason: `warm-outcome-uncertain:${name}` };
    }
  }
  if (entry.lastAttemptOutcome === 'rejected' && attemptedAt !== null && nowMs - attemptedAt < minInterval) {
    return { allowed: false, reason: `attempted-recently:${name}` };
  }

  // ALREADY WARMED THIS INSTANCE of the window. Checked before the interval and
  // the backoff, because it is the strongest statement of the three: the reset
  // we are looking at is the one we already spent a request on, and a provider
  // that jitters its reported reset by a couple of seconds must not read as a
  // new window.
  if (resetKey && entry.lastWarmedResetKey && entry.lastWarmedResetKey === resetKey) {
    return { allowed: false, reason: `same-reset-warmed:${name}` };
  }

  if (unstartedSince !== null) {
    const backoff = period * (Number(config.unstartedBackoffPeriods) || UNSTARTED_BACKOFF_PERIODS);
    if (nowMs - unstartedSince < backoff) {
      return { allowed: false, reason: `unstarted-backoff:${name}` };
    }
    return { allowed: true, reason: `unstarted-retry:${name}` };
  }
  if (lastWarmedAt !== null && nowMs - lastWarmedAt < minInterval) {
    return { allowed: false, reason: `warmed-recently:${name}` };
  }
  return { allowed: true, reason: `due:${name}` };
}

/**
 * Decide whether to spend one warming request on this connection, and which
 * families it is meant to start.
 *
 * ONE REQUEST WARMS EVERY FAMILY, for every provider that meters an account
 * rather than a model: a single message counts against the 5h window and the
 * 7d window at once, so sending one is enough to start both clocks. A provider
 * that meters PER MODEL is the exception and says so with `pingPerWindow`,
 * because there each family needs its own poke.
 *
 * An exhausted family blocks the attempt. A request sent while the weekly
 * window is spent comes back 429 and starts nothing, so it is a wasted call
 * against an account that is already refusing.
 *
 * @returns {{shouldWarm: boolean, reason: string, targets: string[],
 *   running: Array<object>, exhausted: Array<object>, nextResetAt: number|null}}
 */
export function planWarm({
  quotas = {},
  expectedWindows = [],
  windowPeriodsMs = {},
  state = {},
  now,
  config = {},
} = {}) {
  const nowMs = toMs(now) ?? 0;
  const tracked = [
    ...expectedWindows,
    ...Object.keys(quotas || {}),
    ...Object.keys(state || {}),
  ];
  const { running, notRunning, exhausted } = classifyWindows({
    quotas,
    tracked,
    now: nowMs,
    state,
    resetAtDriftMs: Number(config.resetAtDriftMs) || 0,
  });
  const nextResetAt = running.length ? Math.min(...running.map((w) => w.resetAt)) : null;

  const base = { running, exhausted, nextResetAt };

  if (notRunning.length === 0) {
    return { shouldWarm: false, reason: 'every-window-running', targets: [], ...base };
  }
  if (exhausted.length > 0) {
    // Named rather than silent: an operator looking at a cold window needs to
    // know it is cold because another window is spent, not because warming is
    // broken.
    return {
      shouldWarm: false,
      reason: `blocked-by-exhausted:${exhausted.map((w) => w.name).join(',')}`,
      targets: [],
      ...base,
    };
  }

  const targets = [];
  const refusals = [];
  const resetKeys = {};
  for (const { name, resetAt } of notRunning) {
    const resetKey = resetAt ? normalizeResetKey(resetAt) : null;
    if (resetKey) resetKeys[name] = resetKey;
    const verdict = warmAllowed({
      name, state, now: nowMs, periods: windowPeriodsMs, config, resetKey,
    });
    if (verdict.allowed) targets.push(name);
    else refusals.push(verdict.reason);
  }

  if (targets.length === 0) {
    return {
      shouldWarm: false,
      reason: refusals.join(';') || 'no-target',
      targets: [],
      resetKeys,
      ...base,
    };
  }
  return {
    shouldWarm: true,
    reason: `cold:${notRunning.map((w) => `${w.name}(${w.why})`).join(',')}`,
    targets,
    resetKeys,
    ...base,
  };
}

/**
 * Fold the outcome of a warm attempt into the per-window state.
 *
 * `started` is the set of families that carried a reset timestamp on the
 * verification read. A family that was warmed and did NOT start records
 * `unstartedSince`, which is what puts it on the slow backoff; one that started
 * clears it, so a family that begins being metered later recovers on its own.
 */
/**
 * Stamp the reset timestamp we just observed for every running family, which is
 * what the next tick's slide detection compares against. Called every tick,
 * warm or not: without a previous observation a sliding window is
 * indistinguishable from a running one.
 */
export function recordSeen({ state = {}, running = [] } = {}) {
  const next = { ...state };
  for (const { name, resetAt } of running) {
    next[name] = {
      ...stateFor(state, name),
      lastSeenResetAt: new Date(resetAt).toISOString(),
    };
  }
  return next;
}

/**
 * Did the warms we already sent actually start their clocks?
 *
 * A 2xx from the warming request says the request was ACCEPTED. It does not say
 * the provider counted it against a window, and those are different facts: a
 * plan that does not meter a given family will happily answer a request that
 * starts nothing. So the warm has to be checked, and the honest check is
 * whether the family is reporting a running window afterwards.
 *
 * The check is DEFERRED to a later tick rather than done by sleeping after the
 * request. A scheduler that sleeps four seconds twice per warm blocks its own
 * loop, needs a second usage read it would otherwise get for free, and makes
 * every test that touches it wait in real time. The next tick reads usage
 * anyway, so that read is the verification.
 *
 * `verifyAfterMs` is the grace period: usage endpoints lag their own metering,
 * so a family warmed seconds ago and not yet reporting is not evidence of
 * anything.
 *
 * @returns {{state: object, started: string[], stillCold: string[], changed: boolean}}
 */
export function reconcileWarmOutcome({
  state = {},
  running = [],
  notRunning = [],
  now,
  verifyAfterMs = 90_000,
} = {}) {
  const nowMs = toMs(now) ?? Date.now();
  const runningNames = new Set(running.map((w) => w.name));
  const coldNames = new Set(notRunning.map((w) => w.name));
  const next = { ...state };
  const started = [];
  const stillCold = [];
  let changed = false;

  for (const [name, entry] of Object.entries(state || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const warmedAt = toMs(entry.lastWarmedAt);
    if (warmedAt === null) continue;

    if (runningNames.has(name)) {
      started.push(name);
      // A family that is metered again clears its backoff on its own, so a
      // plan change or a provider fixing its reporting recovers without
      // anyone touching anything.
      if (entry.unstartedSince) {
        next[name] = { ...entry, unstartedSince: null };
        changed = true;
      }
      continue;
    }
    if (!coldNames.has(name)) continue;
    if (nowMs - warmedAt < verifyAfterMs) continue;

    stillCold.push(name);
    if (!entry.unstartedSince) {
      next[name] = { ...entry, unstartedSince: new Date(nowMs).toISOString() };
      changed = true;
    }
  }

  return { state: next, started, stillCold, changed };
}

export function recordWarm({ state = {}, targets = [], started = [], resetKeys = {}, now } = {}) {
  const nowIso = new Date(toMs(now) ?? Date.now()).toISOString();
  const startedSet = new Set(started);
  const next = { ...state };
  for (const name of targets) {
    const entry = { ...stateFor(state, name), lastWarmedAt: nowIso };
    if (resetKeys[name]) entry.lastWarmedResetKey = resetKeys[name];
    // A fresh warm is PENDING, not failed. reconcileWarmOutcome decides on a
    // later tick whether the clock started; marking it unstarted here would put
    // every warm on the slow backoff before the provider had a chance to
    // report. `started` is honoured when a caller already knows the answer.
    if (startedSet.has(name)) entry.unstartedSince = null;
    next[name] = entry;
  }
  return next;
}
