import { randomUUID } from "node:crypto";

// Provider readers may return a cached object (including a stale-on-error result).
// Keep its original acquisition receipt instead of relabeling each cache hit as
// a new provider observation. Weak references do not prolong cache retention.
const receipts = new WeakMap();

export function withQuotaObservation(usage) {
  if (!usage || typeof usage !== "object" || !usage.quotas || usage.error || usage.expired || usage.message) return usage;
  let receipt = receipts.get(usage);
  if (!receipt) {
    receipt = Object.freeze({ id: randomUUID(), observedAt: new Date().toISOString(), source: "provider-usage" });
    receipts.set(usage, receipt);
  }
  return { ...usage, quotaObservation: receipt };
}
