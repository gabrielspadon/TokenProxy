// Read-only named operation-event projections for the bounded analytics
// worker. Same contract as quotaHistoryQueries: every supported filter is
// applied before stable pagination, never after a page is cut.
const DAY = 86_400_000;
export const OPERATION_EVENTS_DEFAULT_DAYS = 30;
export const OPERATION_EVENTS_MAX_PAGE = 200;

const FILTERS = [
  "eventId", "operationId", "phase", "state", "source", "actorClass",
  "subjectKind", "subjectId", "provider", "connectionId",
];
const text = (v) => (typeof v === "string" && v.length <= 512 && v.trim() ? v : null);

export function parseOperationEventsQuery(params, { now = Date.now() } = {}) {
  const allowed = new Set(["start", "end", "page", "pageSize", ...FILTERS]);
  const seen = new Set();
  for (const [key] of params) {
    if (!allowed.has(key) || seen.has(key)) throw new TypeError("Unknown or duplicate operation events parameter");
    seen.add(key);
  }
  const integer = (key, fallback, max) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) throw new TypeError(`Invalid ${key}`);
    return Number(raw);
  };
  const pageSize = integer("pageSize", 50, OPERATION_EVENTS_MAX_PAGE);
  const page = integer("page", 1, Number.MAX_SAFE_INTEGER);
  if (pageSize < 1 || page < 1 || !Number.isSafeInteger((page - 1) * pageSize)) throw new TypeError("Invalid pagination");
  const bound = (key, fallback) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
      throw new TypeError("Operation events bounds require an explicit UTC offset");
    }
    return new Date(raw).toISOString();
  };
  const start = bound("start", new Date(now - OPERATION_EVENTS_DEFAULT_DAYS * DAY).toISOString());
  const end = bound("end", new Date(now).toISOString());
  if (start >= end) throw new TypeError("Invalid operation events time range");
  const filters = {};
  for (const key of FILTERS) {
    if (!params.has(key)) continue;
    const value = text(params.get(key));
    if (!value) throw new TypeError(`Invalid ${key}`);
    if (key === 'eventId' && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new TypeError('Invalid eventId');
    filters[key] = value;
  }
  return { start, end, page, pageSize, filters };
}

export function validateOperationEventsQuery(input) {
  if (
    input?.operation !== "operation-events" ||
    Object.keys(input).some((key) => !["operation", "start", "end", "page", "pageSize", "filters"].includes(key)) ||
    !input.filters || typeof input.filters !== "object" || Array.isArray(input.filters) ||
    Object.keys(input.filters).some((key) => !FILTERS.includes(key)) ||
    Object.values(input.filters).some((value) => typeof value !== "string")
  ) throw new TypeError("Invalid operation events operation");
  const params = new URLSearchParams({
    ...input.filters, start: input.start, end: input.end,
    page: input.page, pageSize: input.pageSize,
  });
  return { operation: "operation-events", ...parseOperationEventsQuery(params) };
}

export function readOperationEvents(db, query) {
  const { start, end, page, pageSize, filters } = query;
  const offset = (page - 1) * pageSize;
  const clauses = ["capturedAt >= ?", "capturedAt < ?"];
  const values = [start, end];
  for (const [key, value] of Object.entries(filters)) {
    clauses.push(`${key === 'eventId' ? 'id' : key} = ?`);
    values.push(value);
  }
  const where = clauses.join(" AND ");
  const total = db.get(`SELECT COUNT(*) AS total FROM operationEvents WHERE ${where}`, values).total;
  const items = db.all(
    `SELECT *, (SELECT json_object('id', terminal.id, 'state', terminal.state, 'capturedAt', terminal.capturedAt)
       FROM operationEvents terminal WHERE terminal.operationId = operationEvents.operationId
       AND terminal.phase = operationEvents.phase AND terminal.state != 'started' LIMIT 1) AS terminalReceipt
     FROM operationEvents WHERE ${where} ORDER BY capturedAt DESC, id DESC LIMIT ? OFFSET ?`,
    [...values, pageSize, offset]
  ).map((row) => ({ ...row, details: JSON.parse(row.details), terminalReceipt: row.terminalReceipt ? JSON.parse(row.terminalReceipt) : null }));
  return {
    items, total, page, pageSize,
    pages: Math.ceil(total / pageSize),
    hasMore: offset + items.length < total,
    filters,
    timeRange: { field: "capturedAt", start, end, endExclusive: true },
  };
}
