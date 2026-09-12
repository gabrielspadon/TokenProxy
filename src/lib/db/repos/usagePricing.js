import { createHash } from "node:crypto";
import { calculateCostFromTokens } from "open-sse/providers/pricing.js";
import { getPricingRecordForModel } from "./pricingRepo.js";
import { resolveCacheTokens } from "../../../../open-sse/utils/usageTracking.js";

const RATE_FIELDS = ["input", "output", "cached", "cache_creation", "reasoning"];
const COST_FIELDS = ["cost_usd", "cost_in_usd", "cost_in_usd_ticks"];
const CALCULATOR_VERSION = "cache-inclusive-usd-v2";
function amount(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Capture this before generation. Completion must never read mutable prices.
export async function captureUsagePricing(provider, model) {
  const capturedAt = new Date().toISOString();
  let record;
  try { record = await getPricingRecordForModel(provider, model); }
  catch { record = { rates: null, source: "unavailable" }; }
  const rates = record.rates ? Object.fromEntries(RATE_FIELDS
    .filter((key) => Object.hasOwn(record.rates, key))
    .map((key) => [key, amount(record.rates[key])])) : null;
  const descriptor = { provider: provider || null, model: model || null, currency: "USD", unit: "per-million-tokens",
    calculatorVersion: CALCULATOR_VERSION, source: record.source, rates };
  const id = createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
  return Object.freeze({ ...descriptor, rates: rates ? Object.freeze(rates) : null, id, capturedAt });
}

export function persistUsagePricing(db, snapshot) {
  if (!snapshot || !/^[a-f0-9]{64}$/.test(snapshot.id || "")) return null;
  db.run(`INSERT INTO usageRateSnapshots(id,provider,model,currency,unit,calculatorVersion,source,rates,capturedAt)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
  [snapshot.id, snapshot.provider, snapshot.model, snapshot.currency, snapshot.unit, snapshot.calculatorVersion,
    snapshot.source, JSON.stringify(snapshot.rates), snapshot.capturedAt]);
  return snapshot.id;
}

export function usageQuantityPresence(tokens) {
  const present = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  // Capture cache presence from the RAW tokens, before canonicalizeUsage
  // synthesizes a 0 that reads identically to a reported one. An explicit
  // false flag on a re-presented object stays false rather than being revived.
  const cache = resolveCacheTokens(tokens || {});
  const observedCache = (flag, value) => tokens?.estimated !== true
    && tokens?.[flag] !== false && present(value);
  return { input: present(tokens?.prompt_tokens ?? tokens?.input_tokens), output: present(tokens?.completion_tokens ?? tokens?.output_tokens),
    cacheRead: observedCache('cache_read_tokens_present', cache.read),
    cacheWrite: observedCache('cache_write_tokens_present', cache.write) };
}

export function priceUsage(tokens, snapshot, quantityComplete = true) {
  const usage = tokens || {};
  const rates = snapshot?.rates;
  const tokenOnly = { ...usage };
  for (const key of COST_FIELDS) delete tokenOnly[key];
  // Invalid or incomplete rate cards are unknown, including partial operator cards.
  const validRates = rates && amount(rates.input) !== null && amount(rates.output) !== null
    && Object.values(rates).every((v) => amount(v) !== null);
  const estimatedCostUsd = validRates && quantityComplete ? amount(calculateCostFromTokens(tokenOnly, rates)) : null;
  let reportedCostUsd = null, costEvidence = null;
  if (usage.estimated !== true) {
    const reported = ["cost_usd", "cost_in_usd"].map((field) => [field, amount(usage[field])]).filter(([, value]) => value !== null);
    if (reported.length === 2 && reported[0][1] !== reported[1][1]) {
      // Two reported USD amounts that disagree are not one reported amount.
      // Keep both as evidence, leave the reported amount unknown, and let the
      // separately labelled application estimate stand on its own.
      costEvidence = { source: "upstream-usage", currency: "USD", conflict: Object.fromEntries(reported) };
    } else if (reported.length) {
      const [field, value] = reported[0];
      reportedCostUsd = value;
      costEvidence = { field, currency: "USD", source: "upstream-usage" };
    }
    // The generic usage extractor has no provider contract for the tick scale.
    // Preserve the observation without turning the legacy divisor into evidence.
    if (!costEvidence && amount(usage.cost_in_usd_ticks) !== null) {
      costEvidence = { field: "cost_in_usd_ticks", source: "upstream-usage", unit: "unverified-ticks", rawValue: amount(usage.cost_in_usd_ticks) };
    }
  }
  return { estimatedCostUsd, reportedCostUsd, costEvidence,
    cost: reportedCostUsd ?? estimatedCostUsd,
    costSource: reportedCostUsd !== null ? "provider-reported" : estimatedCostUsd !== null ? "application-estimate" : "unknown" };
}
