// Counterfactual dollar-cost ledger repo. Writes are best-effort by contract:
// every exported write path swallows its own errors and returns a status, so a
// ledger failure can never block or alter the client response. All SQL is
// parameterized.
//
// Baseline estimator (documented for every consumer): the pre-saver serialized
// request body tokenized at ~4 chars/token, rounded up. baselineUsd costs that
// full estimate as uncached input; actualUsd costs provider-reported usage with
// cache multipliers (see open-sse/providers/cachePricing.js). Rows for unknown
// models (no rate card) or estimated usage (not provider-reported) are skipped,
// never guessed.

import { getAdapter } from "../driver.js";
import { canonicalizeUsage } from "../../../../open-sse/utils/usageTracking.js";
import { cacheMultiplierFor, costForUsage } from "../../../../open-sse/providers/cachePricing.js";
import { getPricingForModel } from "./pricingRepo.js";

const CHARS_PER_TOKEN = 4;

// Serialized string length / 4, rounded up; null when there is nothing to
// tokenize. String length (UTF-16 code units) matches estimateInputTokens
// (open-sse/utils/usageTracking.js) and the token-saver events sink convention.
export function estimateBaselineTokens(serialized) {
  if (typeof serialized !== "string" || serialized.length === 0) return null;
  return Math.ceil(serialized.length / CHARS_PER_TOKEN);
}

/**
 * Build one ledger row from the counterfactual inputs, or null when a row
 * cannot be computed truthfully: no rid, no model, no pre-saver body, no
 * provider-reported usage (estimated usage is not actual), or no rate card.
 */
export async function computeCostLedgerEntry({ rid, sid, provider, model, preSaverSerialized, usage, now } = {}) {
  if (typeof rid !== "string" || !rid) return null;
  if (!model || typeof model !== "string") return null;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  if (usage.estimated === true) return null; // only provider-reported usage is "actual"
  const canonical = canonicalizeUsage(usage);
  if (!canonical) return null;
  // Reported zeros in both directions are not a measurement, they are an
  // absent one: costed against a priced baseline the row would claim the whole
  // prompt as savings. Same skip as the estimated-usage path.
  if (canonical.prompt_tokens === 0 && canonical.completion_tokens === 0) return null;
  const baselineTokens = estimateBaselineTokens(preSaverSerialized);
  if (baselineTokens === null) return null;
  // Operator overrides merge over the built-in catalog in pricingRepo.
  const pricing = await getPricingForModel(provider, model);
  const inputRate = Number(pricing?.input);
  const outputRate = Number(pricing?.output);
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return null;

  const outputTokens = canonical.completion_tokens;
  const baselineUsd = baselineTokens * (inputRate / 1e6) + outputTokens * (outputRate / 1e6);
  const actualUsd = costForUsage({
    pricing,
    usage: canonical,
    multipliers: cacheMultiplierFor(provider),
  }).totalUsd;
  // Attribution split of savedUsd: the saver component prices the ACTUAL usage
  // as if fully uncached and subtracts it from the baseline, so only the
  // pre-saver body shrink moves it; the cache component is what the provider
  // discount took off that actual usage. saver + cache = savedUsd exactly.
  const actualUncachedUsd =
    canonical.prompt_tokens * (inputRate / 1e6) + outputTokens * (outputRate / 1e6);

  return {
    id: rid,
    ts: typeof now === "string" && now ? now : new Date().toISOString(),
    sid: typeof sid === "string" && sid ? sid : null,
    provider: typeof provider === "string" && provider ? provider : null,
    model,
    baselineUsd,
    actualUsd,
    savedUsd: baselineUsd - actualUsd,
    saverSavedUsd: baselineUsd - actualUncachedUsd,
    cacheSavedUsd: actualUncachedUsd - actualUsd,
    inputTokens: canonical.prompt_tokens,
    cacheReadTokens: canonical.cached_tokens,
    cacheWriteTokens: canonical.cache_creation_input_tokens,
    outputTokens,
  };
}

// Upsert one row. One completed request owns its rid, so a second completion
// for the same rid (account-fallback attempt) replaces the first.
export async function recordCostLedger(entry) {
  try {
    if (!entry || typeof entry.id !== "string" || !entry.id) return false;
    const db = await getAdapter();
    db.run(
      `INSERT INTO costLedger(id, ts, sid, provider, model, baselineUsd, actualUsd, savedUsd, saverSavedUsd, cacheSavedUsd, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, sid=excluded.sid, provider=excluded.provider,
         model=excluded.model, baselineUsd=excluded.baselineUsd, actualUsd=excluded.actualUsd,
         savedUsd=excluded.savedUsd, saverSavedUsd=excluded.saverSavedUsd, cacheSavedUsd=excluded.cacheSavedUsd,
         inputTokens=excluded.inputTokens, cacheReadTokens=excluded.cacheReadTokens,
         cacheWriteTokens=excluded.cacheWriteTokens, outputTokens=excluded.outputTokens`,
      [entry.id, entry.ts, entry.sid, entry.provider, entry.model, entry.baselineUsd, entry.actualUsd,
        // A caller omitting the split columns stores 0/0, the same "unknown
        // decomposition" marker pre-split rows carry.
        entry.savedUsd, entry.saverSavedUsd ?? 0, entry.cacheSavedUsd ?? 0, entry.inputTokens,
        entry.cacheReadTokens, entry.cacheWriteTokens, entry.outputTokens],
    );
    return true;
  } catch {
    return false;
  }
}

// Compute + persist in one call. Returns the row when written, null when
// skipped or the write failed — the caller never needs the distinction.
// In-flight writes are tracked by rid: the onReqSummary listener in chatCore
// reads the session rollup the moment a request completes, while saveUsageStats
// fires this write async — without a handle on it the rollup lagged one
// request behind its own savings.
const pendingWrites = new Map();

export function recordCostLedgerForRequest(args) {
  const rid = typeof args?.rid === "string" && args.rid ? args.rid : null;
  const write = (async () => {
    try {
      const entry = await computeCostLedgerEntry(args);
      if (!entry) return null;
      return (await recordCostLedger(entry)) ? entry : null;
    } catch {
      return null;
    }
  })();
  if (rid) {
    pendingWrites.set(rid, write);
    write.then(() => {
      if (pendingWrites.get(rid) === write) pendingWrites.delete(rid);
    });
  }
  return write;
}

// The pending write for one rid (never rejects — the write swallows its own
// errors), or an already-resolved null when none is in flight.
export function waitForLedgerWrite(rid) {
  return pendingWrites.get(rid) || Promise.resolve(null);
}

// Session rollup for the MCP context_status entry, decomposed by attribution:
// saverSavedUsd is what the savers cut over the window (baseline minus the
// actual usage priced fully uncached), cacheSavedUsd is the provider cache
// discount on top of that. Null (not 0) when the read itself failed, so a
// broken DB never reports a fake "saved nothing".
export async function sumSavedUsdSince(sid, sinceIso) {
  try {
    if (typeof sid !== "string" || !sid || typeof sinceIso !== "string" || !sinceIso) return null;
    const db = await getAdapter();
    const row = db.get(
      `SELECT COALESCE(SUM(saverSavedUsd), 0) AS saver, COALESCE(SUM(cacheSavedUsd), 0) AS cache
       FROM costLedger WHERE sid = ? AND ts >= ?`,
      [sid, sinceIso],
    );
    const saverSavedUsd = Number(row?.saver);
    const cacheSavedUsd = Number(row?.cache);
    if (!row || !Number.isFinite(saverSavedUsd) || !Number.isFinite(cacheSavedUsd)) return null;
    return { saverSavedUsd, cacheSavedUsd };
  } catch {
    return null;
  }
}
