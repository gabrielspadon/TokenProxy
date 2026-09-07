/**
 * Cache-prefix stabilization telemetry + adaptive TTL (context-tuning suite,
 * task 6).
 *
 * TELEMETRY ONLY. Nothing in this module rewrites, reorders, or strips
 * request bytes: a changed early prefix is reported, never repaired
 * (rewriting changes model behavior; ruled out by research). The one adaptive
 * knob is the cache breakpoint TTL, and it only ever selects between the two
 * policies the anchoring code already stamps.
 *
 * Three pieces:
 *
 *   topLevelKeySpans(serialized)
 *     Shallow structural sketch of one serialized request body: each
 *     top-level key with the byte offset and length of its serialized value
 *     plus a digest of that value. The sketch is what the per-session ring
 *     retains — digests and lengths, never body bytes (multi-MB bodies times
 *     thousands of sessions was the ceBodies T-F1 OOM lesson).
 *
 *   volatileFieldReport(bodies)
 *     Compares consecutive bodies of one session (strings or sketches) and
 *     ranks the top-level keys whose serialized value changed while their
 *     position was early (value starts before the last 25% of the body) and
 *     the majority of the other keys stayed stable — the divergence sources
 *     that invalidate the provider's cached prefix (a `metadata` mtime, a
 *     `system` timestamp). Report only.
 *
 *   chooseCacheTtl(sessionIntervals)
 *     Picks the breakpoint TTL for the session from measured inter-request
 *     gaps: "1h" only with >= 3 gap samples whose p90 exceeds 20 minutes
 *     (the 5m breakpoint demonstrably expires between requests), else "5m",
 *     which is byte-identical to the legacy anchoring policy.
 */

import { createHash } from "node:crypto";

// Rolling window for the epoch hit-rate mean: ce/prevBytes of the session's
// last 20 tracked requests.
export const EPOCH_RATE_WINDOW = 20;
// Adaptive TTL rule constants: enough samples to call a cadence, and the gap
// past which a 5m breakpoint provably does not survive between requests.
export const CACHE_TTL_MIN_SAMPLES = 3;
export const CACHE_TTL_1H_GAP_MS = 20 * 60 * 1000;
// A key counts as early — its change invalidates cached prefix — when its
// serialized value starts before the last quarter of the body.
const EARLY_KEY_FRACTION = 0.75;
const VOLATILE_TOP_K = 3;
// "changed while others stayed stable": at least half of the other keys
// present in both bodies kept their value, else the whole body moved and no
// single key is the divergence source. A body with one key is vacuously
// stable.
const MAJORITY_STABLE_FRACTION = 0.5;

function digestValue(serialized) {
  return createHash("sha1").update(serialized).digest("base64");
}

/**
 * Shallow sketch of a serialized JSON body: top-level key spans with byte
 * offsets, lengths, and value digests. Returns null for anything that is not
 * a serialized plain object. Offsets are computed from the canonical
 * re-serialization, which is byte-identical for JSON.stringify-produced
 * bodies (the only kind the hot path sketches).
 */
export function topLevelKeySpans(serialized) {
  if (typeof serialized !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const spans = [];
  let offset = 1; // past "{"
  for (const [key, value] of Object.entries(parsed)) {
    const keyTokenBytes = Buffer.byteLength(JSON.stringify(key), "utf8");
    const valueSerialized = JSON.stringify(value);
    const valueLength =
      valueSerialized === undefined ? 0 : Buffer.byteLength(valueSerialized, "utf8");
    const valueStart = offset + keyTokenBytes + 1; // +1 for ":"
    spans.push({
      key,
      valueStart,
      valueLength,
      digest: valueSerialized === undefined ? null : digestValue(valueSerialized),
    });
    offset = valueStart + valueLength + 1; // +1 for "," or "}"
  }
  return { length: Buffer.byteLength(serialized, "utf8"), spans };
}

function asSketch(body) {
  if (typeof body === "string") return topLevelKeySpans(body);
  if (body && typeof body === "object" && Array.isArray(body.spans)) return body;
  return null;
}

/**
 * Compare consecutive bodies of one session and rank the early divergence
 * sources. Each entry may be a serialized body string or a topLevelKeySpans
 * sketch (the hot path stores sketches; the strings form exists for tests
 * and one-off analysis). Never mutates its input.
 *
 * @returns {{pairs: number, keys: Array<{key, changes, changedBytes, keptBytes, votes}>, volatileKeys: string[]}}
 *   keys is sorted by changedBytes desc; volatileKeys is the top 3 key names
 *   among keys that changed in an early position while the majority of the
 *   other keys stayed stable.
 */
export function volatileFieldReport(bodies) {
  const sketches = (Array.isArray(bodies) ? bodies : []).map(asSketch);
  const stats = new Map();
  let pairs = 0;
  for (let i = 1; i < sketches.length; i++) {
    const prev = sketches[i - 1];
    const next = sketches[i];
    if (!prev || !next) continue;
    pairs += 1;
    const prevByKey = new Map(prev.spans.map((s) => [s.key, s]));
    const nextByKey = new Map(next.spans.map((s) => [s.key, s]));
    const allKeys = [];
    const seen = new Set();
    for (const s of [...prev.spans, ...next.spans]) {
      if (!seen.has(s.key)) {
        seen.add(s.key);
        allKeys.push(s.key);
      }
    }
    // Majority-stable is measured on the keys present in both bodies: a key
    // appearing or disappearing says nothing about the stability of others.
    const shared = allKeys.filter((k) => prevByKey.has(k) && nextByKey.has(k));
    for (const key of allKeys) {
      const a = prevByKey.get(key);
      const b = nextByKey.get(key);
      const changed = (a?.digest ?? null) !== (b?.digest ?? null);
      const entry = stats.get(key) || { key, changes: 0, changedBytes: 0, keptBytes: 0, votes: 0 };
      if (changed) {
        entry.changes += 1;
        entry.changedBytes += Math.abs((a?.valueLength ?? 0) - (b?.valueLength ?? 0));
        const position = b ?? a;
        const bodyLength = (b ? next : prev).length;
        const early = position.valueStart < bodyLength * EARLY_KEY_FRACTION;
        const others = shared.filter((k) => k !== key);
        const othersStable = others.filter(
          (k) => prevByKey.get(k).digest === nextByKey.get(k).digest,
        ).length;
        const majorityStable =
          others.length === 0 || othersStable / others.length >= MAJORITY_STABLE_FRACTION;
        if (early && majorityStable) entry.votes += 1;
      } else {
        entry.keptBytes += b?.valueLength ?? a?.valueLength ?? 0;
      }
      stats.set(key, entry);
    }
  }
  const keys = [...stats.values()].sort((x, y) => y.changedBytes - x.changedBytes);
  const volatileKeys = keys
    .filter((k) => k.votes > 0)
    .slice(0, VOLATILE_TOP_K)
    .map((k) => k.key);
  return { pairs, keys, volatileKeys };
}

/**
 * Push one ce/prevBytes sample onto the session's rolling ring (cap
 * EPOCH_RATE_WINDOW) and return the rolling mean, or undefined when the ring
 * is empty. Non-finite samples are ignored — a request with no previous body
 * is not a 0% hit.
 */
export function recordEpochRate(rates, rate, window = EPOCH_RATE_WINDOW) {
  if (!Array.isArray(rates)) return undefined;
  if (Number.isFinite(rate)) {
    rates.push(rate);
    while (rates.length > window) rates.shift();
  }
  if (rates.length === 0) return undefined;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

/**
 * Per-session breakpoint TTL from measured inter-request gaps (ms). "1h" only
 * with >= CACHE_TTL_MIN_SAMPLES samples whose p90 exceeds 20 minutes — the
 * cadence at which a 5m breakpoint expires between requests. Everything else
 * is "5m", the existing default. Non-finite and negative gaps are dropped.
 */
export function chooseCacheTtl(sessionIntervals) {
  const gaps = (Array.isArray(sessionIntervals) ? sessionIntervals : [])
    .filter((g) => Number.isFinite(g) && g >= 0)
    .sort((a, b) => a - b);
  if (gaps.length < CACHE_TTL_MIN_SAMPLES) return "5m";
  const p90 = gaps[Math.ceil(gaps.length * 0.9) - 1];
  return p90 > CACHE_TTL_1H_GAP_MS ? "1h" : "5m";
}
