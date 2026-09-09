// Read-only named quota projections. No writer, migration or application imports.
const DAY = 86_400_000;
export const QUOTA_HISTORY_DEFAULT_DAYS = 30;
export const QUOTA_HISTORY_MAX_PAGE = 200;
const text = (v) => typeof v === "string" && v.length <= 512 && v.trim() ? v : null;
const date = (v) => typeof v === "string" && v.trim() && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

export function parseQuotaHistoryQuery(params, { now = Date.now() } = {}) {
  const kind = params.get("kind") ?? "observations";
  const allowed = new Set(["kind","timeField","start","end","since","until","page","pageSize",
    "connectionId","provider","scope","source","unit","resourceType", ...(kind === "checks" ? ["eventType","checkId","jobId","outcome","targetModel","observationId"] : ["observationKind","id"])]);
  const seen = new Set();
  for (const [key] of params) {
    if (!allowed.has(key) || seen.has(key)) throw new TypeError("Unknown or duplicate history parameter");
    seen.add(key);
  }
  if (!["observations", "checks"].includes(kind)) throw new TypeError("Invalid history kind");
  const timeField = params.get("timeField") ?? "capturedAt";
  if (!["capturedAt", "observedAt"].includes(timeField)) throw new TypeError("Invalid history time field");
  const integer = (key, fallback, max) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) throw new TypeError(`Invalid ${key}`);
    return Number(raw);
  };
  const pageSize = integer("pageSize", 50, QUOTA_HISTORY_MAX_PAGE);
  const page = integer("page", 1, Number.MAX_SAFE_INTEGER);
  if (pageSize < 1 || page < 1 || !Number.isSafeInteger((page - 1) * pageSize)) throw new TypeError("Invalid pagination");
  const bound = (canonical, alias, fallback) => {
    if (params.has(canonical) && params.has(alias)) throw new TypeError("Conflicting time keys");
    if (!params.has(canonical) && !params.has(alias)) return fallback;
    const raw = params.get(canonical) ?? params.get(alias);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
      throw new TypeError("History bounds require an explicit UTC offset");
    }
    const [year, month, day] = raw.slice(0, 10).split("-").map(Number);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
      throw new TypeError("Invalid calendar date");
    }
    return date(raw);
  };
  const start = bound("start", "since", new Date(now - QUOTA_HISTORY_DEFAULT_DAYS * DAY).toISOString());
  const end = bound("end", "until", new Date(now).toISOString());
  if (!start || !end || start >= end) throw new TypeError("Invalid history time range");
  const filters = {};
  for (const key of ["connectionId", "provider", "scope", "source", "unit", "resourceType", ...(kind === "checks" ? ["eventType", "checkId", "jobId", "outcome", "targetModel", "observationId"] : ["observationKind","id"])]) {
    if (!params.has(key)) continue;
    const value = text(params.get(key));
    if (!value) throw new TypeError(`Invalid ${key}`);
    filters[key] = value;
  }
  return { kind,timeField,start,end,pageSize,page,filters,defaultHorizonDays: params.has("start") || params.has("since") ? null : QUOTA_HISTORY_DEFAULT_DAYS };
}


export function validateQuotaHistoryQuery(input) {
  if (input?.operation === "quota-history-summary" && Object.keys(input).length === 1) return input;
  if (!input || input.operation !== "quota-history" ||
      Object.keys(input).some(key => !["operation","kind","timeField","start","end","pageSize","page","filters","defaultHorizonDays"].includes(key)) ||
      !input.filters || typeof input.filters !== "object" || Array.isArray(input.filters) ||
      Object.values(input.filters).some(value => typeof value !== "string") ||
      ![null, QUOTA_HISTORY_DEFAULT_DAYS].includes(input.defaultHorizonDays)) throw new TypeError("Invalid quota history operation");
  const params = new URLSearchParams({ ...input.filters, kind: input.kind, timeField: input.timeField,
    start: input.start, end: input.end, pageSize: input.pageSize, page: input.page });
  const query = parseQuotaHistoryQuery(params);
  if (Object.keys(query.filters).length !== Object.keys(input.filters).length) throw new TypeError("Invalid quota history dimensions");
  return { operation: "quota-history", ...query, defaultHorizonDays: input.defaultHorizonDays };
}

export function readQuotaHistorySummary(db) {
  return {
    observationCount: db.get("SELECT COUNT(*) AS total FROM quotaObservations").total,
    checkEventCount: db.get("SELECT COUNT(*) AS total FROM quotaCheckEvents").total,
  };
}

export function readQuotaHistory(db, query) {
  const { kind, timeField, start, end, pageSize, page, filters } = query;
  const offset = (page - 1) * pageSize;
  const table = kind === "checks" ? "quotaCheckEvents" : "quotaObservations";
  const clauses = [`${timeField} >= ?`, `${timeField} < ?`];
  const values = [start,end];
  for (const [key,value] of Object.entries(filters)) { clauses.push(`${key} = ?`); values.push(value); }
  const where = clauses.join(" AND ");

  const total = db.get(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`, values).total;
  const items = db.all(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${timeField} DESC, id DESC LIMIT ? OFFSET ?`, [...values,pageSize,offset]);
  return { items,total,page,pageSize,pages: Math.ceil(total / pageSize),hasMore: offset + items.length < total,kind,filters,
    timeRange: { field: timeField,start,end,endExclusive: true,defaultHorizonDays: query.defaultHorizonDays },
    retention: { mode: "indefinite",automaticDeletion: false },mode: "passive" };
}
