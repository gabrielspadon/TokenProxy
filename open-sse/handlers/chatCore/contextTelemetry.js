import { randomUUID, createHash } from "node:crypto";
import { saveRequestStats } from "../../../src/lib/db/repos/requestStatsRepo.js";
import { captureUsagePricing } from "../../../src/lib/db/repos/usagePricing.js";
import { markBudgetUncertain } from "../../../src/lib/db/repos/budgetRepo.js";

export function createContextTelemetry(fields) {
  const requestId = randomUUID();
  const routingHash = /^[a-f0-9]{32,64}$/.test(fields.sessionHash || "") ? fields.sessionHash : null;
  return { ...fields, requestId,
    stages: fields.stages?.map(stage => stage.outcomeSource === "execution"
      ? { ...stage, executionRequestId: stage.executionRequestId || requestId } : stage),
    handoffs: fields.handoffs?.map(item => ({ ...item, executionRequestId: item.executionRequestId || requestId })),
    attempt: typeof fields.nextAttempt === "function" ? fields.nextAttempt() : fields.attempt ?? 1,
    sessionHash: routingHash || createHash("sha256").update(requestId).digest("hex"),
    identitySource: routingHash ? (["explicit", "inferred"].includes(fields.sessionIdentitySource) ? fields.sessionIdentitySource : "routing") : "request",
    logicalRequestId: fields.logicalRequestId || requestId,
  };
}

export async function nextContextAttempt(previous, fields) {
  await recordContextFailure(previous, fields);
  const next = createContextTelemetry({ ...previous, pricingSnapshot: undefined, budgetReservationId: undefined,
    structures: previous.structures?.filter((value) => value.boundary !== "physical-dispatch"),
    dispatchCoverage: fields.dispatchCoverage ?? previous.dispatchCoverage,
    timestamp: new Date().toISOString(), attempt: previous.attempt + 1 });
  next.identitySource = previous.identitySource;
  await recordContextAttempt(next, fields);
  return next;
}

export async function recordContextAttempt(contextTelemetry, fields) {
  if (contextTelemetry.budgetReservationId && ["error", "aborted", "cancelled"].includes(fields.status)) {
    await markBudgetUncertain(contextTelemetry.budgetReservationId, fields.status);
  }
  if (!contextTelemetry.pricingSnapshot) {
    contextTelemetry.pricingSnapshot = await captureUsagePricing(fields.provider, fields.model);
  }
  return saveRequestStats({ id: contextTelemetry.requestId, timestamp: contextTelemetry.timestamp,
    contextTelemetry, provider: fields.provider, model: fields.model, connectionId: fields.connectionId,
    status: fields.status || "pending", tokens: fields.tokens ?? null, latency: fields.latency });
}

export function recordContextFailure(contextTelemetry, { provider, model, connectionId, requestStartTime, status = "error", tokens = null }) {
  if (!contextTelemetry) return;
  return recordContextAttempt(contextTelemetry, { provider, model, connectionId, status, tokens,
    latency: { total: Date.now() - requestStartTime } });
}
