import { randomUUID, createHash } from "node:crypto";
import { saveRequestStats } from "../../../src/lib/db/repos/requestStatsRepo.js";

export function createContextTelemetry(fields) {
  const requestId = randomUUID();
  const routingHash = /^[a-f0-9]{32,64}$/.test(fields.sessionHash || "") ? fields.sessionHash : null;
  return { ...fields, requestId,
    sessionHash: routingHash || createHash("sha256").update(requestId).digest("hex"),
    identitySource: routingHash ? "routing" : "request",
    logicalRequestId: fields.logicalRequestId || requestId,
  };
}

export function recordContextAttempt(contextTelemetry, fields) {
  return saveRequestStats({ id: contextTelemetry.requestId, timestamp: contextTelemetry.timestamp,
    contextTelemetry, provider: fields.provider, model: fields.model, connectionId: fields.connectionId,
    status: fields.status || "pending", tokens: fields.tokens ?? null, latency: fields.latency });
}

export function recordContextFailure(contextTelemetry, { provider, model, connectionId, requestStartTime, status = "error", tokens = null }) {
  if (!contextTelemetry) return;
  return recordContextAttempt(contextTelemetry, { provider, model, connectionId, status, tokens,
    latency: { total: Date.now() - requestStartTime } });
}
