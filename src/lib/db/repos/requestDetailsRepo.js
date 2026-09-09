import { logOutput } from '../../../../open-sse/utils/asyncLogOutput.js';
import { boundedLogRecord } from '../../../../open-sse/utils/boundedLogRecord.js';
import { redactSecrets, stripSensitiveHeaders } from "../../../../open-sse/utils/redact.js";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { saveRequestStats } from "./requestStatsRepo.js";
import { registerShutdownFlusher } from "../../shutdown.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
let retainedBytes = 0;
let pendingAdmissions = 0;
let droppedRecords = 0;
let shuttingDown = false;
let shutdownExpired = false;
const boundedSetting = (value, fallback, max) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;

let cachedConfig = null;
let cachedConfigTs = 0;

/**
 * Read an env flag that is only a signal when the operator actually set it.
 * An unset or empty value returns null so the next source in the precedence
 * chain decides, instead of being read as `false`.
 */
function explicitEnvFlag(env, name) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return null;
  return raw.trim().toLowerCase() === "true";
}

/**
 * Resolve whether request details are recorded, in precedence order:
 *
 *   1. OBSERVABILITY_ENABLED — the variable named after this feature, and the one
 *      `.env.example` ships as `true`. It used to be unreachable: `getSettings()`
 *      merges defaults, so `settings.enableObservability` is ALWAYS a boolean and
 *      the `typeof … === "boolean"` guard below it never yielded to the env value.
 *   2. ENABLE_REQUEST_LOGS — the older override, kept so existing deployments that
 *      force it on keep working. It only decides when the variable above is unset;
 *      it is documented for the `logs/` files, and `.env.example` ships it as
 *      `false`, so letting it hard-disable the dashboard toggle meant a stock
 *      `.env` silently defeated both documented ways of turning details on.
 *   3. The dashboard toggle (`enableObservability`), which stays the default-off
 *      answer when neither variable is set.
 *
 * @param {object} settings  merged settings row
 * @param {object} env       process.env, injectable for tests
 */
export function resolveObservabilityEnabled(settings, env = process.env) {
  const fromFeatureFlag = explicitEnvFlag(env, "OBSERVABILITY_ENABLED");
  if (fromFeatureFlag !== null) return fromFeatureFlag;

  const fromRequestLogs = explicitEnvFlag(env, "ENABLE_REQUEST_LOGS");
  if (fromRequestLogs !== null) return fromRequestLogs;

  return settings?.enableObservability === true;
}

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    cachedConfig = {
      enabled: resolveObservabilityEnabled(settings),
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
    cachedConfig.maxRecords = boundedSetting(cachedConfig.maxRecords, DEFAULT_MAX_RECORDS, 10000);
    cachedConfig.batchSize = boundedSetting(cachedConfig.batchSize, DEFAULT_BATCH_SIZE, 100);
    cachedConfig.flushIntervalMs = boundedSetting(cachedConfig.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 60000);
    cachedConfig.maxJsonSize = boundedSetting(cachedConfig.maxJsonSize, DEFAULT_MAX_JSON_SIZE, 65536);
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

/**
 * Whether request details are being recorded right now.
 *
 * v0.5.50 made observability opt-in, so an install that used to fill the Usage
 * "Details" tab now records nothing — and `getRequestDetails` answers an empty
 * page either way, which reads as a broken tab rather than a disabled feature
 * (#3106). Callers expose this beside the (empty) results so the difference is
 * visible.
 */
export async function isObservabilityEnabled() {
  return (await getObservabilityConfig()).enabled;
}

let writeBuffer = [];
let flushTimer = null;
let flushPromise = null;

// Diagnostic overflow is lossy. Count and byte bounds include in-flight records;
// accounting remains independent. Count overflow keeps the newest pending rows.
const BUFFER_BATCHES = 10;

function capWriteBuffer(config) {
  const limit = Math.max(config.maxRecords, config.batchSize * BUFFER_BATCHES);
  while (writeBuffer.length > limit) { retainedBytes -= writeBuffer.shift()._retainedBytes; droppedRecords++; }
}

// Header dropping now reads open-sse/utils/redact.js's single key list, which
// requestLogger.js reads too. The two lists had already drifted apart ("secret"
// was in one and not the other), and drift in this direction is silent.
const sanitizeHeaders = stripSensitiveHeaders;

export const __test__ = {
  sanitizeHeaders, redactAndTruncate, bufferSize: () => writeBuffer.length,
  bufferStatus: () => ({ retainedBytes, pendingAdmissions, droppedRecords, maxBytes: MAX_BUFFER_BYTES }),
  shutdown: () => _shutdownHandler(),
  dispose: async () => { await _shutdownHandler(); unregisterShutdown(); },
};

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

/**
 * Redact FIRST, then truncate. The other order is what shipped: the preview is a
 * raw 200-char slice of the serialized body, so an `Authorization` header echoed
 * back in a provider error message landed in the DB inside `_preview` even when
 * the body itself was too big to store. Redacting first means the preview is cut
 * from already-scrubbed text.
 *
 * A body that will not serialize (a BigInt, a getter that throws) is dropped to
 * the failure marker rather than persisted: the closed direction.
 */
function redactAndTruncate(obj, maxSize) {
  const safe = boundedLogRecord(obj, { maxBytes: maxSize });
  let str;
  try {
    str = JSON.stringify(safe ?? {});
  } catch {
    return { redacted: true, reason: "redaction failed" };
  }
  if (Buffer.byteLength(str) > maxSize) {
    return { _truncated: true, _retainedSize: Buffer.byteLength(str), _preview: str.substring(0, 200) };
  }
  return safe ?? {};
}

function flushToDatabase() {
  if (flushPromise) return flushPromise;
  if (writeBuffer.length === 0) return Promise.resolve();
  flushPromise = writeBufferedDetails().finally(() => { flushPromise = null; });
  return flushPromise;
}

async function writeBufferedDetails() {
  try {
    // Small transactions bound synchronous SQLite work per event-loop turn.
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, 20);
      try {
      const db = await getAdapter();
      const config = await getObservabilityConfig();
      if (shutdownExpired) { droppedRecords += items.length; continue; }
      db.transaction(() => {
        for (const item of items) {
          if (!item.id) item.id = generateDetailId(item.model);
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

          const record = {
            id: item.id,
            provider: item.provider || null,
            model: item.model || null,
            connectionId: item.connectionId || null,
            timestamp: item.timestamp,
            status: item.status || null,
            latency: item.latency || {},
            tokens: item.tokens || {},
            request: redactAndTruncate(item.request, config.maxJsonSize),
            providerRequest: redactAndTruncate(item.providerRequest, config.maxJsonSize),
            providerResponse: redactAndTruncate(item.providerResponse, config.maxJsonSize),
            response: redactAndTruncate(item.response, config.maxJsonSize),
            // The receipt is counts today, but it is persisted next to the bodies and
            // read by the same projections, so it goes through the same walk.
            pxpipe: item.pxpipe ? redactSecrets(item.pxpipe) : undefined,
          };

          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
            [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)]
          );
        }

        const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
        if (cnt && cnt.c > config.maxRecords) {
          db.run(
            `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
            [cnt.c - config.maxRecords]
          );
        }
      }); } catch (error) { droppedRecords += items.length; throw error; } finally { retainedBytes -= items.reduce((sum, item) => sum + item._retainedBytes, 0); }
      if (writeBuffer.length) await new Promise(setImmediate);
    }
  } catch (e) {
    logOutput(`[requestDetailsRepo] Batch write failed ${e?.code || 'sink-error'}`, 2);
  }
}

function prepareDetail(detail) {
  const { request, providerRequest, providerResponse, response, ...metadata } = detail;
  const statsPromise = saveRequestStats(metadata).catch(() => logOutput('[requestStats] save failed', 2));
  let safe = null;
  let bytes = 0;
  if (!shuttingDown && pendingAdmissions < 256 && retainedBytes < MAX_BUFFER_BYTES - 65536) {
    safe = boundedLogRecord({ ...metadata, request, providerRequest, providerResponse, response }, { maxBytes: 32768, maxNodes: 1024 });
    bytes = Buffer.byteLength(JSON.stringify(safe)) + 256;
    if (bytes <= MAX_BUFFER_BYTES - retainedBytes) { retainedBytes += bytes; pendingAdmissions++; }
    else { safe = null; bytes = 0; droppedRecords++; }
  } else droppedRecords++;
  return { statsPromise, safe, bytes };
}

export async function saveRequestDetail(detail) {
  if (!detail.id) detail.id = generateDetailId(detail.model);
  // Accounting keeps its existing contract; payload bodies never enter that promise.
  const prepared = prepareDetail(detail);
  const { statsPromise, safe } = prepared;
  let bytes = prepared.bytes;
  // Do not hold a caller's response object across asynchronous configuration reads.
  detail = null;
  if (safe) {
    try {
      const config = await getObservabilityConfig();
      if (config.enabled && !shuttingDown) {
        safe._retainedBytes = bytes;
        writeBuffer.push(safe);
        bytes = 0;
        capWriteBuffer(config);
        if (writeBuffer.length >= config.batchSize) {
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          void flushToDatabase();
        } else if (!flushTimer) {
          flushTimer = setTimeout(() => { flushTimer = null; void flushToDatabase(); }, config.flushIntervalMs);
          flushTimer.unref?.();
        }
      }
    } finally { pendingAdmissions--; retainedBytes -= bytes; }
  }
  await statsPromise;
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getDistinctProviders() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT provider FROM requestDetails WHERE provider IS NOT NULL ORDER BY provider ASC`);
  return rows.map((r) => r.provider);
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

const _shutdownHandler = async () => {
  shuttingDown = true;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  let timer;
  await Promise.race([flushToDatabase(), new Promise(resolve => { timer = setTimeout(() => { shutdownExpired = true; resolve(); }, 1000); })]);
  clearTimeout(timer);
  if (shutdownExpired) {
    for (const item of writeBuffer.splice(0)) { retainedBytes -= item._retainedBytes; droppedRecords++; }
  }
  return { drained: retainedBytes === 0, retainedBytes, droppedRecords };
};

// Each module instance owns its buffer; all flush before adapters close at priority 100.
const unregisterShutdown = registerShutdownFlusher(_shutdownHandler, 0);
