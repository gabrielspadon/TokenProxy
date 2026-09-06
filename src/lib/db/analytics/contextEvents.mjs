import { ContextQueryError, parseContextFilter, validId } from "./contextQueries.mjs";
const EVENT_TYPES = ["compaction", "handoff", "task_start", "task_outcome"];
const OWN_KEYS = ["type", "sessionId", "requestId", "logicalRequestId", "clientKeyId", "clientRef", "clientSessionRef", "taskRef", "projectRef"];
const BASE_KEYS = ["provider", "model", "connectionId", "clientTool", "projectLabel", "from", "to", "until", "page", "pageSize"];
export function parseContextEventFilter(params) {
  for (const name of params.keys()) if (![...BASE_KEYS, ...OWN_KEYS].includes(name)) throw new ContextQueryError("Invalid event filter");
  const filter = parseContextFilter(params);
  for (const name of OWN_KEYS) {
    const value = params.get(name);
    if (value === null) continue;
    if (name === "type" && !EVENT_TYPES.includes(value)) throw new ContextQueryError("Invalid event type");
    if (name === "sessionId") { filter.sessionId = validId(value); continue; }
    if (!value || value.length > 200 || /[\x00-\x1f]/.test(value)) throw new ContextQueryError("Invalid event filter");
    filter[name] = value;
  }
  return filter;
}
export function validateContextEventQuery(query) {
  if (!query || query.operation !== "events" || Object.keys(query).some((key) => !["operation", "filter"].includes(key))
    || !query.filter || typeof query.filter !== "object" || Array.isArray(query.filter)
    || Object.values(query.filter).some((value) => !["string", "number"].includes(typeof value))) throw new ContextQueryError("Invalid event query");
  return { operation: "events", filter: parseContextEventFilter(new URLSearchParams(query.filter)) };
}
export function publicContextEvent(row) {
  const event = {};
  for (const field of ["id", "clientEventId", "occurredAt", "recordedAt", "type", "clientKeyId", "clientRef", "clientSessionRef", "taskRef", "projectRef", "targetClientRef", "targetTaskRef", "requestId", "logicalRequestId", "contextSessionId", "outcome", "beforeTokens", "afterTokens", "tokenMeasurementMethod"]) event[field] = row[field] ?? null;
  return { ...event, source: "client-reported", providerVerified: false, tokenUnits: "client-reported tokens", linkStatus: row.requestId ? "owned-request" : "unlinked" };
}
export function readContextEvents(db, filter = {}) {
  const conditions = [], args = [];
  for (const name of OWN_KEYS) if (filter[name] != null) { conditions.push(`e.${name === "sessionId" ? "contextSessionId" : name}=?`); args.push(filter[name]); }
  for (const name of ["provider", "model", "connectionId", "clientTool"]) if (filter[name]) { conditions.push(`r.${name}=?`); args.push(filter[name]); }
  if (filter.projectLabel) { conditions.push("s.projectLabel=?"); args.push(filter.projectLabel); }
  for (const [field, operator] of [["from", ">="], ["to", "<="], ["until", "<"]]) if (filter[field]) { conditions.push(`e.occurredAt${operator}?`); args.push(filter[field]); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const join = "FROM contextClientEvents e LEFT JOIN requestStats r ON r.id=e.requestId LEFT JOIN contextSessions s ON s.id=e.contextSessionId";
  const totalItems = db.get(`SELECT COUNT(*) AS n ${join} ${where}`, args).n;
  const page = filter.page || 1, pageSize = filter.pageSize || 50;
  const rows = db.all(`SELECT e.*,r.provider,r.model,r.connectionId ${join} ${where} ORDER BY e.occurredAt DESC,e.id DESC LIMIT ? OFFSET ?`, [...args,pageSize,(page-1)*pageSize]);
  return { view: "client-events", events: rows.map((row) => ({ ...publicContextEvent(row), provider: row.provider ?? null, model: row.model ?? null, connectionId: row.connectionId ?? null })),
    pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems/pageSize), hasNext: page*pageSize<totalItems, hasPrev: page>1 },
    definitions: { occurredAt: "Client-reported event time; scope filters apply here.", recordedAt: "Gateway receipt time.", source: "Explicit authenticated client report, not proof of a provider action.", routing: "Observed only through an owned request link. Unlinked events have unknown routing.", identities: "Installation- and API-key-scoped opaque references. No inferred client, task or project hierarchy." } };
}
