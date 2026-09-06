/**
 * The bridge between what a provider reports and what the ranker can compare.
 *
 * `deriveQuotaSnapshot` (src/shared/utils/quotaPause.js) emits a PERCENTAGE per
 * window, which is all the pause gate ever needed: a threshold is a percentage
 * too, so the comparison is within one window and the unit cancels.
 *
 * Ranking is a different question. `rankAccounts` compares headroom ACROSS
 * windows and across accounts, and a percentage cannot do that: 10% of a 5h
 * window worth 300 units is 30 units, while 10% of a 30d window worth 90,000 is
 * 9,000. The ranker's contract is therefore absolute units
 * ({scope, remaining, limit, resetAt, observedAt, confidence}), and something
 * has to convert. This module is that something, and it is the only place the
 * two unit systems meet.
 *
 * Pure. No DB imports, no clock reads: `now` and `observedAt` are injected, so
 * a conversion is reproducible from the raw usage it was made from.
 *
 * THE HONESTY RULE. A provider that reports only a percentage has not told us
 * its total, and inventing one (a nominal 100, say) would hand the ranker a
 * fabricated number it cannot tell from a measured one — the 5h window above
 * would rank identically to the 30d window, which is the exact comparison the
 * absolute-unit contract exists to make possible. So a percentage-only window
 * is converted onto a synthetic scale AND carries `confidence: 'unknown'`,
 * which `rankAccounts` already bands at ordering key 1 so it never outranks a
 * measured window. The number is a placeholder; the confidence is the truth
 * about it, and the ranker reads both.
 */

// Synthetic denominator for a percentage-only window. Chosen as 100 so
// `remaining` reads back as the percentage itself — a stored row stays legible
// to a human, and nothing downstream can mistake the scale for a real token
// count. Every window carrying it is stamped 'unknown', which is what actually
// governs its rank.
const SYNTHETIC_LIMIT = 100;

// Confidence vocabulary, matching quotaRanking.js's CONFIDENCE_BAND keys
// exactly. Stated here rather than imported because it is the CONTRACT between
// the two modules, and a rename that broke it should break loudly.
export const CONFIDENCE = {
  FRESH: 'fresh',
  STALE: 'stale',
  UNKNOWN: 'unknown',
};

// Beyond this, a reading describes a window that has probably already rolled.
// It stays evidence, but demoted evidence: 'stale' bands below 'fresh' in the
// ranker without taking the account out of the cohort. 15 minutes is one
// quotaGuard cache TTL (2 min) with generous slack, so ordinary cache warmth
// never trips it.
const STALE_AFTER_MS = 15 * 60_000;

function finitePositive(value) {
  const n = finiteNonNegative(value);
  return n !== null && n > 0 ? n : null;
}

function finiteNonNegative(value) {
  // Match the numeric wire types accepted by usage/shared.js toFiniteNumber.
  // Number(null), Number('') and Number(false) are zero, but none is a reading.
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isoOrNull(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Absolute units for one window, and how much to trust them.
 *
 * The raw quota entry is preferred over the derived percentage whenever it
 * carries a real total, because `used`/`total` ARE the absolute units and
 * re-deriving them from a rounded percentage would throw away precision the
 * provider already gave us. `deriveQuotaSnapshot` rounds to whole percent, so a
 * 90,000-unit window round-trips through the percentage with a 450-unit error.
 */
function absoluteUnits(rawQuota) {
  const total = finitePositive(rawQuota?.total);
  if (total !== null) {
    // `remaining` is authoritative when present; otherwise total - used.
    const remaining = finiteNonNegative(rawQuota?.remaining);
    if (remaining !== null) {
      return { remaining: Math.min(remaining, total), limit: total, measured: true };
    }
    const used = finiteNonNegative(rawQuota?.used);
    if (used !== null) {
      return { remaining: Math.max(0, total - used), limit: total, measured: true };
    }
  }
  return null;
}

/**
 * Convert one snapshot window (percentage) plus its raw quota entry (possibly
 * absolute) into the ranker's window shape.
 *
 * @returns {object|null} null when there is not enough evidence for a window at
 *   all — no reset instant, or no numbers. A window with no parseable resetAt
 *   is dropped rather than defaulted, because `normalizeAccountWindows` treats a
 *   general window with no reset evidence as unusable and would take the whole
 *   ACCOUNT out of ranking (quotaRanking.js:90). Dropping the one window it
 *   cannot read leaves the account ranked on the windows it can.
 */
export function toRankerWindow(snapshotWindow, rawQuota, { observedAt, now } = {}) {
  if (!snapshotWindow || typeof snapshotWindow !== 'object') return null;
  const scope = String(snapshotWindow.key ?? '').trim();
  if (!scope) return null;

  // An unlimited window constrains nothing, so ranking on it is ranking on a
  // number that will never bind. It is dropped rather than given a fake ceiling.
  if (snapshotWindow.unlimited === true) return null;

  const resetAt = isoOrNull(snapshotWindow.resetAt);
  if (resetAt === null) return null;

  const measured = absoluteUnits(rawQuota);
  const observedIso = isoOrNull(observedAt) ?? new Date(Number(now) || Date.now()).toISOString();

  // Freshness is about the READING, not the window: a two-hour-old percentage
  // is weak evidence whatever window it describes.
  const observedMs = Date.parse(observedIso);
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const aged = Number.isFinite(observedMs) && nowMs - observedMs > STALE_AFTER_MS;

  if (measured) {
    return {
      scope,
      remaining: measured.remaining,
      limit: measured.limit,
      resetAt,
      observedAt: observedIso,
      confidence: aged ? CONFIDENCE.STALE : CONFIDENCE.FRESH,
    };
  }

  const pct = finiteNonNegative(snapshotWindow.remainingPercentage);
  if (pct === null) return null;

  // Percentage-only. The scale is synthetic and says so through `confidence`,
  // which is the field the ranker bands on. Never 'fresh': the number is not a
  // measurement, however recently it was read.
  return {
    scope,
    remaining: Math.max(0, Math.min(SYNTHETIC_LIMIT, pct)),
    limit: SYNTHETIC_LIMIT,
    resetAt,
    observedAt: observedIso,
    confidence: CONFIDENCE.UNKNOWN,
  };
}

/**
 * Every rankable window for one account, from one quota read.
 *
 * @param {object|null} snapshot - `deriveQuotaSnapshot` output
 *   ({windows, fetchedAt}), the percentage-scale per-window gating snapshot.
 * @param {object|null} rawUsage - the provider's own usage payload, when the
 *   caller still has it. Its `quotas` entries carry the absolute totals the
 *   snapshot dropped, so passing it is what upgrades a window from 'unknown'
 *   to 'fresh'. Optional: absent, every window converts on the synthetic scale.
 * @param {{now?: number}} [options]
 * @returns {Array<object>} ranker-shaped windows, possibly empty. Empty is a
 *   valid answer meaning "no usable quota evidence", and the caller persists it
 *   as such rather than inventing one.
 */
export function toRankerWindows(snapshot, rawUsage = null, { now } = {}) {
  const list = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  if (list.length === 0) return [];

  // The raw payload keys quotas by window name, in either of the two shapes
  // deriveQuotaSnapshot accepts. Index it once rather than scanning per window.
  const rawByKey = new Map();
  const quotas = rawUsage?.quotas;
  if (quotas && typeof quotas === 'object') {
    const entries = Array.isArray(quotas) ? quotas : Object.entries(quotas);
    for (const entry of entries) {
      const [key, q] = Array.isArray(entry) ? entry : [entry?.name, entry];
      if (q && typeof q === 'object') rawByKey.set(String(key ?? q.name ?? ''), q);
    }
  }

  const out = [];
  for (const w of list) {
    const converted = toRankerWindow(w, rawByKey.get(String(w?.key ?? '')) ?? null, {
      observedAt: snapshot?.fetchedAt,
      now,
    });
    if (converted) out.push(converted);
  }
  return out;
}
