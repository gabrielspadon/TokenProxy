/**
 * Compound quota-window ranking — the native replacement for static priority
 * and round-robin account selection (RECONCILIATION.md, Account Scheduling
 * Contract rules 1-3; docs/reconciliation/overlay-spec.md §1).
 *
 * Pure. No DB imports, no provider imports, no wall-clock reads: the caller
 * injects `now`, so a ranking test is deterministic and a ranking decision is
 * reproducible from its recorded inputs. This is a NEW concern beside
 * quotaPause.js, which stays a fail-open per-window pause check and is not
 * touched by anything here.
 *
 * The invariant, in one line: burn the entitlement that is about to be wasted
 * first, ordered by the subscription's MAIN quota (its longest horizon, the one
 * that actually constrains the plan) rather than by whichever short window
 * happens to reset next. Configured priority breaks ties only.
 *
 * Window records use the contract's normalized shape, which is also the
 * `quotaWindows` table shape in src/lib/db/schema.js:
 *   { scope, remaining, limit, resetAt, observedAt, confidence }
 * `remaining` and `limit` are absolute units. A percentage cannot compare
 * headroom across a 5h window of 300 units and a 30d window of 90,000.
 *
 * PER-ACCOUNT EVIDENCE, NOT A COHORT SHAPE (2026-09-04). This module used to
 * refuse to rank unless every account in the cohort reported the byte-identical
 * set of window names, and to fail one account closed for one unreadable
 * window. On a real pool neither holds: ten Claude connections on the same
 * provider reported four different shapes (weekly-only, session+weekly,
 * session-only, and no evidence at all), because plan tier and recent usage
 * both change which windows a provider bothers to report, and an account that
 * has not touched its 5h window in the current period reports no 5h window at
 * all. The gate therefore fired on roughly a third of live switches, and the
 * receipts recorded it: `trigger = cohort-degraded`, with the pool walked in
 * connection-list order. Worse, the degraded path handed the caller
 * `eligible: []` while still offering every record in `ranked`, so the
 * scheduler selected accounts whose quota was provably at its limit and paid a
 * 429 to find out.
 *
 * So: each account is ranked on ITS OWN windows, missing or unreadable evidence
 * ranks an account last without taking it out of service, and hard eligibility
 * is enforced on every path there is. `degraded` now means only "no account
 * anywhere had orderable evidence", and even then nothing ineligible is
 * offered, because there is nothing left to be ineligible against.
 */

// Horizon in milliseconds, keyed by the parenthetical duration a provider
// appends to a window name ("session (5h)", "weekly (7d)", "monthly (30d)").
// Values follow overlay-spec §1 exactly.
const UNIT_MS = {
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000,
  month: 2_592_000_000,
  y: 31_536_000_000,
  year: 31_536_000_000,
};

// Fallback horizon by bare window name when no parenthetical is present.
const BARE_NAME_MS = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
  monthly: 2_592_000_000,
  annual: 31_536_000_000,
  yearly: 31_536_000_000,
};

// A scope naming a specific model or feature is a sub-quota, not whole-account
// entitlement. It is tolerated and ignored for ranking (§1 window
// classification) rather than failing the account.
const SCOPED_MARKERS = /\b(per[-_ ]?model|per[-_ ]?feature|model|feature|tool|agent)\b/i;

// `\b` treats `_` as a word character, so `\bsession\b` could not see the name
// inside `spark_session` and codex's spark sub-quota landed as an UNCLASSIFIABLE
// scope. An underscore separates two names here exactly as a space does, so the
// boundary is spelled against the alphabet the names are actually built from.
const GENERAL_NAMES =
  /(?<![a-z0-9])(session|rate[-_ ]?limit|hourly|daily|weekly|monthly|annual|yearly)(?![a-z0-9])/i;

const PARENTHETICAL_DURATION = /\(\s*\d+(?:\.\d+)?\s*[a-z]+\s*\)/i;

/**
 * A general period name QUALIFIED by anything else names a sub-quota of that
 * period, never the account's entitlement in it. Anthropic reports the per-model
 * branches of one weekly plan as `weekly opus (7d)` and `weekly sonnet (7d)`
 * beside the plan-wide `weekly (7d)` (open-sse/services/usage/claude.js), and
 * codex reports its spark lane as `spark_session` / `spark_weekly`. Ranking any
 * of those as general let ONE model's exhausted sub-quota set `usable = false`
 * for the whole connection, taking it out of service for every other model.
 */
function isQualifiedPeriod(name) {
  const bare = name.replace(PARENTHETICAL_DURATION, '');
  const period = GENERAL_NAMES.exec(bare);
  if (!period) return false;
  return bare.replace(period[0], '').replace(/[^a-z0-9]+/gi, '') !== '';
}

// Below this a "horizon" is the 1 ms unknown-shape fallback, not a period. Both
// forward projection and reset ordering need a real period to mean anything, so
// a window this short is carried as unreadable rather than trusted.
const MIN_REAL_HORIZON_MS = 60_000;

/**
 * Horizon of a window in milliseconds. A parenthetical duration wins over the
 * bare name so `session (5h)` is 5h and not the 1 ms unknown fallback.
 * Unknown shapes get 1 ms, which sorts them last among general windows without
 * discarding them.
 */
export function windowHorizonMs(scope) {
  const name = String(scope ?? '');
  const paren = /\(\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*\)/i.exec(name);
  if (paren) {
    const unit = UNIT_MS[paren[2].toLowerCase()];
    if (unit) return Number(paren[1]) * unit;
  }
  const bare = GENERAL_NAMES.exec(name);
  if (bare) {
    const ms = BARE_NAME_MS[bare[1].toLowerCase().replace(/[-_ ]/g, '')];
    if (ms) return ms;
  }
  return 1;
}

/**
 * GENERAL (whole-account entitlement, ranked) vs SCOPED (sub-quota, ignored)
 * vs null (neither vocabulary — carried as unreadable, never fatal).
 */
export function classifyWindow(scope) {
  const name = String(scope ?? '').trim();
  if (!name) return null;
  if (SCOPED_MARKERS.test(name) && !GENERAL_NAMES.test(name)) return 'scoped';
  if (isQualifiedPeriod(name)) return 'scoped';
  if (GENERAL_NAMES.test(name)) return 'general';
  if (PARENTHETICAL_DURATION.test(name)) return 'general';
  return null;
}

function parseResetAt(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function finiteNonNegative(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Project a recorded reset forward onto the period that is running NOW.
 *
 * A window whose recorded `resetAt` has already elapsed has replenished, and
 * the recorded instant is then the WRONG ordering key: it is the smallest
 * number in the pool, so a just-replenished account sorted to the very front
 * as though its entitlement were the most urgent there is, when in truth it had
 * just been handed a fresh period and was the LEAST urgent. Projecting the
 * instant forward by whole horizons puts the account where its real next
 * deadline belongs.
 *
 * Returns null when there is no real period to project by, which is the
 * caller's signal to treat the reading as unreadable rather than to invent a
 * deadline for it.
 *
 * @param {number} resetAt - recorded reset, epoch ms
 * @param {number} horizonMs
 * @param {number} nowMs
 * @returns {number|null}
 */
export function effectiveResetAt(resetAt, horizonMs, nowMs) {
  if (!Number.isFinite(resetAt) || !Number.isFinite(nowMs)) return null;
  if (resetAt > nowMs) return resetAt;
  if (!Number.isFinite(horizonMs) || horizonMs < MIN_REAL_HORIZON_MS) return null;
  const periods = Math.floor((nowMs - resetAt) / horizonMs) + 1;
  return resetAt + periods * horizonMs;
}

/**
 * Normalize one account's raw windows into general windows, structurally.
 *
 * Now-independent on purpose: projection and eligibility both need `now` and
 * both live in rankAccounts, so this stays reproducible from the rows alone.
 *
 * One unreadable window no longer fails the account. It is counted, and the
 * count is what drops the account behind every fully-readable one at ordering
 * key 1 — a connection we cannot fully read is a worse bet than one we can, and
 * it is not a connection we are entitled to take out of service.
 *
 * @returns {{ok: true, windows: Array<object>, unreadable: number,
 *   reasons: Array<string>} | {ok: false, reason: string, unreadable: number,
 *   reasons: Array<string>}}
 */
export function normalizeAccountWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return { ok: false, reason: 'no-windows', unreadable: 0, reasons: [], blocked: false };
  }
  const general = [];
  const reasons = [];
  let unreadable = 0;
  // A window that positively states a ceiling of zero or less is not an
  // unreadable window, it is a statement that this account has no entitlement
  // in that window at all. Failing open on it would route traffic to an
  // account the provider has told us cannot serve. Kept separate from
  // `unreadable`, which is an absence of evidence rather than evidence of
  // absence, and which must never take an account out of service.
  let blocked = false;
  for (const w of windows) {
    if (!w || typeof w !== 'object') {
      unreadable += 1;
      reasons.push('malformed-window');
      continue;
    }
    const kind = classifyWindow(w.scope);
    if (kind === null) {
      unreadable += 1;
      reasons.push(`unclassifiable-scope:${w.scope}`);
      continue;
    }
    if (kind === 'scoped') continue;

    const remaining = finiteNonNegative(w.remaining);
    const limit = finiteNonNegative(w.limit);
    const declaredLimit = Number(w.limit);
    const resetAt = parseResetAt(w.resetAt);
    if (Number.isFinite(declaredLimit) && declaredLimit <= 0) {
      blocked = true;
      reasons.push(`bad-limit:${w.scope}`);
      continue;
    }
    if (remaining === null || limit === null || limit <= 0 || resetAt === null) {
      unreadable += 1;
      if (remaining === null) reasons.push(`bad-remaining:${w.scope}`);
      if (limit === null || limit <= 0) reasons.push(`bad-limit:${w.scope}`);
      if (resetAt === null) reasons.push(`bad-resetAt:${w.scope}`);
      continue;
    }

    general.push({
      scope: String(w.scope),
      horizonMs: windowHorizonMs(w.scope),
      remaining,
      limit,
      resetAt,
      observedAt: parseResetAt(w.observedAt),
      confidence: typeof w.confidence === 'string' ? w.confidence : 'unknown',
    });
  }
  if (general.length === 0) {
    // Name the actual defect when there is one. "no-general-windows" is true
    // but useless on a connection whose single window had an unparseable reset:
    // the operator needs to know WHICH reading is broken, and `reasons[0]` is
    // the first one we could not read.
    return {
      ok: false, reason: reasons[0] ?? 'no-general-windows', unreadable, reasons, blocked,
    };
  }

  // Longest horizon first. The head of this array is the subscription's MAIN
  // quota — the branch that actually constrains the plan — and it is the
  // primary deadline key, so a constraining 30d window can never be overridden
  // by a 5h window's sooner reset.
  general.sort((a, b) => b.horizonMs - a.horizonMs || a.scope.localeCompare(b.scope));
  return { ok: true, windows: general, unreadable, reasons, blocked };
}

/**
 * Resolve one account's structural windows against `nowMs`.
 *
 * `orderable` holds the windows that carry a real deadline, longest horizon
 * first. A window whose recorded reset has elapsed and whose horizon is unknown
 * cannot be projected, so it is expired evidence: it neither orders the account
 * nor holds it back, and it counts as unreadable.
 */
function resolveWindows(structural, nowMs) {
  const orderable = [];
  let unreadable = structural.unreadable ?? 0;
  let usable = !structural.blocked;

  for (const w of structural.ok ? structural.windows : []) {
    const effective = effectiveResetAt(w.resetAt, w.horizonMs, nowMs);
    if (effective === null) {
      unreadable += 1;
      continue;
    }
    const replenished = w.resetAt <= nowMs;
    // Eligibility, Scheduling Contract rule 2: every KNOWN hard window must
    // have headroom. A replenished window has a whole fresh period, so the
    // depleted reading that predates its reset is stale evidence about a period
    // that no longer exists. The spec's predicate is `used < total`, which in
    // absolute units is exactly `remaining > 0` — adding a `remaining < limit`
    // clause would silently also encode `used > 0` and make a never-touched
    // account with full headroom permanently ineligible, the single most usable
    // account there is. Keep it on one operand.
    const effectiveRemaining = replenished ? w.limit : w.remaining;
    if (effectiveRemaining <= 0) usable = false;
    orderable.push({ ...w, effectiveResetAt: effective, effectiveRemaining, replenished });
  }

  orderable.sort((a, b) => b.horizonMs - a.horizonMs || a.scope.localeCompare(b.scope));
  return { orderable, unreadable, usable };
}

// Rule 2: unknown evidence must not outrank fresh known evidence, but it must
// not take the account offline either. Confidence is a BAND applied after the
// evidence band; inside a band the reset keys below apply unchanged.
const CONFIDENCE_BAND = { fresh: 0, stale: 1, unknown: 2 };
const BAND_NAME = ['fresh', 'stale', 'unknown'];
function bandOf(orderable) {
  if (orderable.length === 0) return CONFIDENCE_BAND.unknown;
  return orderable.reduce((worst, w) => Math.max(worst, CONFIDENCE_BAND[w.confidence] ?? 2), 0);
}

// Ordering key 1. Evidence completeness replaces the old cohort shape gate:
// instead of refusing to rank a mixed pool, an account we can read fully goes
// ahead of one we can read partly, which goes ahead of one we cannot read at
// all. Nothing here makes an account ineligible.
function evidenceBandOf(orderable, unreadable) {
  if (orderable.length === 0) return 2;
  return unreadable > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Decision trace. rankAccounts stays pure: it RETURNS {cls, verdict, fields}
// entries (docs/logging-design.md rows 18-24) and never imports
// observability/decide.js. auth.js walks the trace and prints it.
// ---------------------------------------------------------------------------

// Evidence age, folded into alt tokens as a short duration (30m, 2h, 3d).
function ageToken(observedAts, nowMs) {
  const finite = observedAts.filter(Number.isFinite);
  if (!finite.length || !Number.isFinite(nowMs)) return null;
  const mins = Math.max(0, Math.round((nowMs - Math.max(...finite)) / 60_000));
  if (mins <= 0) return null;
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const soonestResetOf = (windows) => {
  const resets = (windows || []).map((w) => w.resetAt).filter(Number.isFinite);
  return resets.length ? new Date(Math.min(...resets)).toISOString() : null;
};

const minRemainingOf = (windows) => {
  const rems = (windows || []).map((w) => w.remaining).filter(Number.isFinite);
  return rems.length ? Math.min(...rems) : null;
};

// Shape fingerprint for the cohort gate (§1): comparing accounts whose window
// sets differ is worse than not ranking them at all.
function priorityOf(account) {
  const p = Number(account?.priority);
  return Number.isFinite(p) ? p : Number.POSITIVE_INFINITY;
}

/**
 * Rank accounts for one provider node.
 *
 * @param {Array<{id: string, priority?: number, windows: Array<object>}>} accounts
 * @param {{now: number|Date, previousPinId?: string|null}} options
 *   `now` is REQUIRED and injected — this module never reads the clock.
 * @returns {{
 *   ranked: Array<object>, eligible: Array<object>, ineligible: Array<object>,
 *   winner: object|null, degraded: boolean, reason: string|null
 * }}
 *   `degraded` true means no account carried orderable quota evidence, so the
 *   order is previous-pin-then-priority rather than deadline-driven. It does
 *   NOT relax eligibility: `eligible` is authoritative on every path, and a
 *   caller must never reach into `ranked` to find something to send. Every
 *   account is present in `ranked` either way, because a non-winning account
 *   stays failover inventory (§10) rather than being deactivated.
 */
export function rankAccounts(accounts, { now, previousPinId = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('rankAccounts requires an injected numeric or Date `now`');
  }
  const list = Array.isArray(accounts) ? accounts : [];

  // Trace helpers, built from the same records the ordering reads so the
  // printed line and the decision can never disagree. `id8` keeps a connection
  // id short enough to sit on one log line.
  const id8 = (v) => String(v ?? '').slice(0, 8);
  const altToken = (r) => {
    const band = BAND_NAME[r.band] ?? 'unknown';
    const age = ageToken((r.windows || []).map((w) => w.observedAt), nowMs);
    return `${id8(r.id)}:${band}${age ? `:${age}` : ''}`;
  };
  // Which ordering key actually decided, named by replaying the comparator
  // against the runner-up. Reporting the key the sort USED, rather than the
  // first key that differs on paper, is what keeps the printed line honest
  // when two accounts tie on everything down to declaration order.
  const decidedKey = (a, b) => {
    if (a.usable !== b.usable) return 'eligibility';
    // Completeness (how much we could read) and confidence (how fresh what we
    // read is) are both the evidence axis, and the printed line has one name
    // for it. Minting a second enum would split a key the log format cannot
    // tell apart anyway.
    if (a.evidenceBand !== b.evidenceBand || a.band !== b.band) return 'evidence-band';
    if (a.bindingResetAt !== b.bindingResetAt) return 'reset-horizon';
    if (a.soonestResetAt !== b.soonestResetAt) return 'reset-horizon';
    if ((a.id === previousPinId) !== (b.id === previousPinId)) return 'pinned-continuity';
    if (a.priority !== b.priority) return 'configured-priority';
    return 'fallback-order';
  };
  const winTrace = (winner, all) => {
    const runnerUp = all.find((r) => r.usable && r.id !== winner.id);
    // Key order is the printed order (decide.js walks Object.keys), and the
    // golden capture in tests/__fixtures__ is the format contract, so this is
    // conn/key/win/alt exactly as §3.4 of docs/logging-design.md shows it.
    // The winner's own confidence band is deliberately absent: `key` already
    // says `evidence-band` whenever the band is what decided, and printing it
    // unconditionally spends bytes on every nominal line to say `fresh`.
    const fields = {
      conn: id8(winner.id),
      key: runnerUp ? decidedKey(winner, runnerUp) : 'fallback-order',
      win: true,
      alt: all.filter((r) => r.id !== winner.id).slice(0, 3).map(altToken),
    };
    const rem = minRemainingOf(winner.windows);
    if (rem !== null) fields.rem = rem;
    const reset = soonestResetOf(winner.windows);
    if (reset) fields.reset = reset;
    return { cls: 'SEL', verdict: 'win', fields };
  };

  // Row 19 of docs/logging-design.md still owes the operator the offending id
  // and the reason a reading could not be used. It is no longer a GATE — the
  // cohort shape check that used to refuse the whole pool is gone, and an
  // account we cannot read is ranked last and still served — so this is a
  // report emitted BESIDE the ordering verdict rather than instead of it.
  // First offender only: the rest are named by their `alt` band tokens, and a
  // per-account entry each would push the line past its byte budget.
  const evidenceTrace = (all) => {
    const bad = all.find((r) => !r.valid || r.unreadable > 0);
    if (!bad) return [];
    const why = bad.valid
      ? String(bad.reason || '').replace(/^partial-evidence:/, '').split(',')[0]
      : bad.reason;
    return [{ cls: 'RANK', verdict: 'invalid-record', fields: { conn: id8(bad.id), why } }];
  };

  const records = list.map((account, index) => {
    const structural = normalizeAccountWindows(account?.windows);
    const { orderable, unreadable, usable } = resolveWindows(structural, nowMs);
    return {
      id: account?.id,
      account,
      index,
      priority: priorityOf(account),
      windows: orderable,
      // `valid` and `reason` are diagnostics now, never gates: an account with
      // no readable window is ranked last and still served.
      valid: structural.ok,
      reason: structural.ok
        ? (unreadable > 0 ? `partial-evidence:${structural.reasons.join(',')}` : null)
        : structural.reason,
      unreadable,
      usable,
      evidenceBand: evidenceBandOf(orderable, unreadable),
      band: bandOf(orderable),
      // The subscription's main-quota deadline, and the nearest deadline of any
      // kind. Infinity when there is no orderable evidence, which parks the
      // account behind everything that has a real deadline.
      bindingResetAt: orderable.length ? orderable[0].effectiveResetAt : Number.POSITIVE_INFINITY,
      soonestResetAt: orderable.length
        ? Math.min(...orderable.map((w) => w.effectiveResetAt))
        : Number.POSITIVE_INFINITY,
    };
  });

  if (records.length === 0) {
    return {
      ranked: [], eligible: [], ineligible: [], winner: null,
      degraded: false, reason: 'empty-cohort',
      trace: [{ cls: 'RANK', verdict: 'degraded', fields: { win: false, why: 'empty-cohort' } }],
    };
  }

  const stickyThenDeclared = (a, b) => {
    const ap = a.id === previousPinId ? 0 : 1;
    const bp = b.id === previousPinId ? 0 : 1;
    return ap - bp || (a.priority - b.priority) || (a.index - b.index);
  };

  // Nothing anywhere carries a deadline, so there is no urgency to order by.
  // Previous-pin-then-priority is the §1 failure direction, and it is an
  // ORDERING fallback only — every record here is `usable`, because a record
  // with no readable window has nothing that could prove it depleted.
  const anyEvidence = records.some((r) => r.windows.length > 0);
  if (!anyEvidence) {
    const ranked = [...records].sort(stickyThenDeclared);
    const eligible = ranked.filter((r) => r.usable);
    return {
      ranked,
      eligible,
      ineligible: ranked.filter((r) => !r.usable),
      winner: eligible[0] || null,
      degraded: true,
      reason: 'no-quota-evidence',
      // Every record on this path has unreadable evidence by construction, so
      // evidenceTrace always names one and its reason — strictly more than a
      // generic `why=no-quota-evidence` would. The outcome line follows: a
      // fallback order that still hands out a slot is a serve, not a refusal.
      trace: [
        ...evidenceTrace(ranked),
        ...(eligible[0]
          ? [winTrace(eligible[0], ranked)]
          : [{
              cls: 'RANK',
              verdict: 'depleted',
              fields: { win: false, alt: ranked.map(altToken), reset: null },
            }]),
      ],
    };
  }

  // Ordering keys, in order:
  //   0. usable before depleted
  //   1. evidence completeness (full read, partial read, no read)
  //   2. confidence band (rule 2: unknown never outranks fresh known evidence,
  //      but never goes offline either)
  //   3. the MAIN quota's projected reset, soonest first — the subscription
  //      branch that constrains the plan, so entitlement about to be wasted is
  //      spent first and a short window cannot overspend a longer one
  //   4. the nearest deadline of any horizon, soonest first — immediate
  //      pressure, once the main quotas tie
  //   5. previous pin (stickiness; never round-robin)
  //   6. configured priority, lowest wins, missing = unbounded — TIE-BREAK ONLY
  //   7. original index, so the sort is total and therefore deterministic
  const ranked = [...records].sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    if (a.evidenceBand !== b.evidenceBand) return a.evidenceBand - b.evidenceBand;
    if (a.band !== b.band) return a.band - b.band;
    if (a.bindingResetAt !== b.bindingResetAt) return a.bindingResetAt - b.bindingResetAt;
    if (a.soonestResetAt !== b.soonestResetAt) return a.soonestResetAt - b.soonestResetAt;
    return stickyThenDeclared(a, b);
  });

  const eligible = ranked.filter((r) => r.usable);
  return {
    ranked,
    eligible,
    ineligible: ranked.filter((r) => !r.usable),
    winner: eligible[0] || null,
    degraded: false,
    reason: eligible.length === 0 ? 'all-depleted' : null,
    trace: [
      ...evidenceTrace(ranked),
      ...(eligible[0]
        ? [winTrace(eligible[0], ranked)]
        : [{
            cls: 'RANK',
            verdict: 'depleted',
            fields: {
              win: false,
              alt: ranked.map(altToken),
              reset: soonestResetOf(ranked.flatMap((r) => r.windows)),
            },
          }]),
    ],
  };
}

/**
 * Convenience wrapper: the winning account id, or null when nothing is
 * eligible. Callers that need the reason or the failover inventory use
 * rankAccounts directly.
 */
export function selectAccount(accounts, options) {
  return rankAccounts(accounts, options).winner?.id ?? null;
}
