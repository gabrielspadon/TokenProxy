import { createContextTelemetry, recordContextAttempt } from "open-sse/handlers/chatCore/contextTelemetry.js";
import { beginBudgetDispatch, observeBudgetResponse } from "./budgetDispatch.js";
import { markBudgetUncertain } from "../../lib/db/repos/budgetRepo.js";
import { captureUsagePricing } from "../../lib/db/repos/usagePricing.js";

// Media cores call beforeDispatch only after validation and request construction.
// It also separates an authentication retry from the rejected physical attempt.
export function createUsageAttemptTracker(identity, fields, credentials) {
  let current = null;
  const finish = async (result) => {
    if (!current) return;
    if (current.budgetReservationId) await markBudgetUncertain(current.budgetReservationId, result.success ? "awaiting-complete-usage" : "failed-attempt");
    await recordContextAttempt(current, { ...fields, status: result.success ? "success" : "error", tokens: result.usage ?? null });
  };
  return {
    get contextTelemetry() { return current; },
    async beforeDispatch(wire) {
      if (current) await finish({ success: false });
      current = createContextTelemetry({ ...identity, timestamp: new Date().toISOString(),
        dispatchCoverage: "executor-invocation",
        sessionHash: credentials?.sessionHash, sessionIdentitySource: credentials?.sessionIdentitySource, stages: [] });
      current.pricingSnapshot = await captureUsagePricing(fields.provider, fields.model);
      await beginBudgetDispatch(current, fields.apiKey, wire);
      current.dispatchCoverage = "physical-dispatch";
      await recordContextAttempt(current, fields);
    },
    afterDispatch: (result) => observeBudgetResponse(current, result),
    finish,
  };
}
