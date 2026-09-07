import { createHmac, randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { DATA_FILE } from "../paths.js";
import { readContextAnalytics } from "../analytics/client.js";
import { parseContextFilter } from "../analytics/contextQueries.mjs";
import { publicContextEvent } from "../analytics/contextEvents.mjs";
import { getSettings } from "./settingsRepo.js";
import { retentionDays } from "./contextRepo.js";
import { ContextEvidenceError, contextClientKey, contextEvidenceKey, contextRef, rawContextId } from "./contextEvidenceRepo.js";
import { CONTEXT_EVENT_TYPES, CONTEXT_EVENT_OUTCOMES, CONTEXT_TOKEN_METHODS } from "../../../../open-sse/config/contextEvidence.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const INPUTS = new Set(["eventId", "occurredAt", "type", "clientId", "clientSessionId", "taskId", "projectId", "targetClientId", "targetTaskId", "outcome", "beforeTokens", "afterTokens", "tokenMeasurementMethod", "requestId", "logicalRequestId", "sessionId"]);
const fields = { clientRef: "clientId", clientSessionRef: "clientSessionId", taskRef: "taskId", projectRef: "projectId" };

function normalizedEvent(body, keyId, key, now, days) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((name) => !INPUTS.has(name))) throw new ContextEvidenceError("Invalid event fields");
  if (!UUID.test(body.eventId || "") || !CONTEXT_EVENT_TYPES.includes(body.type)) throw new ContextEvidenceError("Invalid event id or type");
  let occurredAt;
  try { occurredAt = parseContextFilter(new URLSearchParams({ from: body.occurredAt })).from; }
  catch { throw new ContextEvidenceError("occurredAt must be a valid timestamp with a timezone"); }
  if (Date.parse(occurredAt) > now + 300000 || (days !== null && Date.parse(occurredAt) < now - days * 86400000)) throw new ContextEvidenceError("Event timestamp is outside the retained observation window");
  const clientId = rawContextId(body.clientId, true);
  const result = { clientKeyId: keyId, clientEventId: body.eventId.toLowerCase(), occurredAt, type: body.type, source: "client-reported" };
  for (const [field, input] of Object.entries(fields)) result[field] = contextRef(key, keyId, clientId, field, rawContextId(body[input]));
  const targetClientId = rawContextId(body.targetClientId), targetTaskId = rawContextId(body.targetTaskId);
  if (body.type !== "handoff" && (targetClientId || targetTaskId)) throw new ContextEvidenceError("Only handoff events accept a target");
  if (body.type === "handoff" && !targetClientId) throw new ContextEvidenceError("Handoff requires an explicit target client");
  result.targetClientRef = contextRef(key, keyId, targetClientId, "clientRef", targetClientId);
  result.targetTaskRef = contextRef(key, keyId, targetClientId, "taskRef", targetTaskId);
  if (body.type === "task_outcome" && !CONTEXT_EVENT_OUTCOMES.includes(body.outcome)) throw new ContextEvidenceError("Task outcome is required");
  if (body.outcome != null && (body.type !== "task_outcome" || !CONTEXT_EVENT_OUTCOMES.includes(body.outcome))) throw new ContextEvidenceError("Invalid outcome");
  if (["task_start", "task_outcome"].includes(body.type) && !result.taskRef) throw new ContextEvidenceError("Task events require an explicit task");
  result.outcome = body.outcome ?? null;
  for (const name of ["beforeTokens", "afterTokens"]) {
    const value = body[name];
    if (value != null && (!Number.isSafeInteger(value) || value < 0 || body.type !== "compaction")) throw new ContextEvidenceError("Invalid client-reported token count");
    result[name] = value ?? null;
  }
  const hasTokens = result.beforeTokens !== null || result.afterTokens !== null;
  if ((hasTokens || body.tokenMeasurementMethod != null) && (!CONTEXT_TOKEN_METHODS.includes(body.tokenMeasurementMethod) || body.type !== "compaction")) throw new ContextEvidenceError("Client token measurements require a declared method");
  result.tokenMeasurementMethod = body.tokenMeasurementMethod ?? null;
  for (const name of ["requestId", "logicalRequestId"]) {
    if (body[name] != null && !UUID.test(body[name])) throw new ContextEvidenceError("Invalid request link");
    result[name] = body[name]?.toLowerCase() ?? null;
  }
  if (body.sessionId != null && (!Number.isSafeInteger(body.sessionId) || body.sessionId < 1)) throw new ContextEvidenceError("Invalid session link");
  result.contextSessionId = body.sessionId ?? null;
  if (!result.requestId && (result.logicalRequestId || result.contextSessionId)) throw new ContextEvidenceError("Logical and session links require an exact request id");
  return result;
}

export async function ingestContextEvent(apiKey, body, { now = Date.now() } = {}) {
  const db = await getAdapter(), keyId = contextClientKey(db, apiKey);
  if (!keyId) throw new ContextEvidenceError("A valid client API key is required", 401);
  const key = contextEvidenceKey(db), days = retentionDays(await getSettings());
  const event = normalizedEvent(body, keyId, key, now, days);
  const payloadHash = createHmac("sha256", key).update("client-event-v1\0").update(JSON.stringify(event)).digest("hex");
  return db.transaction(() => {
    const existing = db.get("SELECT * FROM contextClientEvents WHERE clientKeyId=? AND clientEventId=?", [keyId, event.clientEventId]);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new ContextEvidenceError("Event id was already used for different evidence", 409);
      return { event: publicContextEvent(existing), duplicate: true };
    }
    if (event.requestId) {
      const request = db.get("SELECT * FROM requestStats WHERE id=? AND clientKeyId=?", [event.requestId, keyId]);
      const conflictingIdentity = request && Object.keys(fields).some((field) => request[field] && event[field] && request[field] !== event[field]);
      if (!request || conflictingIdentity || (event.logicalRequestId && event.logicalRequestId !== request.logicalRequestId)
        || (event.contextSessionId && event.contextSessionId !== request.contextSessionId)) throw new ContextEvidenceError("Request link is unavailable", 404);
      event.logicalRequestId = request.logicalRequestId;
      event.contextSessionId = request.contextSessionId;
    }
    const row = { id: randomUUID(), ...event, recordedAt: new Date(now).toISOString(), payloadHash };
    const keys = Object.keys(row);
    db.run(`INSERT INTO contextClientEvents(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`, Object.values(row));
    // Event-only installations still enforce the same bounded retention policy.
    if (days !== null) db.run("DELETE FROM contextClientEvents WHERE occurredAt<?", [new Date(now - days * 86400000).toISOString()]);
    return { event: publicContextEvent(row), duplicate: false };
  });
}

export async function getContextEvents(filter, options = {}) {
  const db = await getAdapter();
  return readContextAnalytics({ operation: "events", filter }, { ...options, file: DATA_FILE, driver: db.driver });
}
