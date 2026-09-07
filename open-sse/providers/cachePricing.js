// Cache-aware cost arithmetic for the counterfactual dollar ledger.
//
// Two inputs decide what a billed token costs:
//   1. The model rate card from providers/pricing.js (per-1M-token USD), which
//      already carries per-model cache rates (`cached`, `cache_creation`) for
//      the providers that publish them (OpenAI per-model table, Gemini implicit
//      per-model discount, Anthropic 0.1x/1.25x). An explicit rate always wins.
//   2. A provider-keyed MULTIPLIER table for rate cards that lack explicit
//      cache rates: the multiplier scales the plain input rate. Providers
//      without a published cache policy degrade to {read: 1.0, write: 1.0},
//      i.e. cache tokens cost the same as uncached input (plain pricing, no
//      invented discount). The OpenAI read 0.5 and Gemini read 0.25 fallbacks
//      were removed: their discounts are per-model and live on the rate cards,
//      so a model missing them must not inherit a discount the provider never
//      stated — overstated savings are worse than none.
//
// `usage` MUST be canonical (canonicalizeUsage): prompt_tokens cache-inclusive,
// cached_tokens = cache-read portion, cache_creation_input_tokens = cache-write
// portion. Rates are per 1M tokens; outputs are USD.

// Cache multipliers on the plain input rate, keyed by provider id. `write` is
// the 5-minute cache tier everywhere that distinguishes tiers; the 1-hour tier
// (Anthropic 2.0x) is exported for consumers that know which tier was written.
// Only Anthropic publishes a flat policy for every model; every other provider
// falls through to DEFAULT_MULTIPLIERS.
export const CACHE_MULTIPLIERS = {
  anthropic: { read: 0.1, write: 1.25, write1h: 2.0 },
  claude: { read: 0.1, write: 1.25, write1h: 2.0 },
};

const DEFAULT_MULTIPLIERS = { read: 1.0, write: 1.0 };

export function cacheMultiplierFor(provider) {
  const key = String(provider || "").toLowerCase();
  return CACHE_MULTIPLIERS[key] || DEFAULT_MULTIPLIERS;
}

const PER_1M = 1_000_000;

function ratePerToken(usdPer1M) {
  return (Number.isFinite(Number(usdPer1M)) ? Number(usdPer1M) : 0) / PER_1M;
}

/**
 * Cost one canonical usage object against a rate card.
 *
 * @param {object} args
 * @param {object} args.pricing  rate card: {input, output, cached?, cache_creation?} per 1M
 * @param {object} args.usage    canonical usage (prompt/cache read/cache write/completion)
 * @param {object} [args.multipliers] from cacheMultiplierFor(); defaults to 1.0/1.0
 * @returns {{uncachedUsd, cacheReadUsd, cacheWriteUsd, outputUsd, totalUsd}}
 */
export function costForUsage({ pricing, usage, multipliers } = {}) {
  const mult = multipliers || DEFAULT_MULTIPLIERS;
  const inputRate = ratePerToken(pricing?.input);
  // Explicit per-model cache rates win; otherwise scale the input rate by the
  // provider multiplier. `??` not `||`: a 0.0 rate is a real rate.
  const readRate = pricing?.cached !== undefined ? ratePerToken(pricing.cached) : inputRate * mult.read;
  const writeRate = pricing?.cache_creation !== undefined ? ratePerToken(pricing.cache_creation) : inputRate * mult.write;
  const outputRate = ratePerToken(pricing?.output);

  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  const prompt = num(usage?.prompt_tokens);
  const cacheRead = num(usage?.cached_tokens);
  const cacheWrite = num(usage?.cache_creation_input_tokens);
  const output = num(usage?.completion_tokens);
  // prompt_tokens is cache-inclusive: charge each cache portion at its own rate.
  const uncachedInput = Math.max(0, prompt - cacheRead - cacheWrite);

  const uncachedUsd = uncachedInput * inputRate;
  const cacheReadUsd = cacheRead * readRate;
  const cacheWriteUsd = cacheWrite * writeRate;
  const outputUsd = output * outputRate;
  return {
    uncachedUsd,
    cacheReadUsd,
    cacheWriteUsd,
    outputUsd,
    totalUsd: uncachedUsd + cacheReadUsd + cacheWriteUsd + outputUsd,
  };
}
