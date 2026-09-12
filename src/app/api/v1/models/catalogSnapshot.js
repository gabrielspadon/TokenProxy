import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { credentialRevision } from "open-sse/services/tokenRefresh/credentialRevision.js";

const SNAPSHOT_FILE = path.join(DATA_DIR, "model-list-snapshot.json");
const SCHEMA = 1;
const CONNECTION_REFRESH_TIMEOUT_MS = 10_000;
const WHOLE_REFRESH_TIMEOUT_MS = 12_000;

const state = (globalThis.__tokenproxyPublicModelCatalog ??= {
  loaded: false,
  entries: {},
  updatedAt: null,
  refreshes: new Map(),
  generations: new Map(),
  wholeRefresh: null,
  wholeGeneration: 0,
  lastError: null,
  timer: null,
});
state.generations ??= new Map();
state.wholeGeneration ??= 0;

const entryKey = (providerId, connection) => `${providerId}:${connection?.id || "default"}`;

function deadlineError() {
  const error = new Error("catalog refresh deadline exceeded");
  error.code = "CATALOG_REFRESH_TIMEOUT";
  return error;
}

function withOwnerDeadline(promise, timeoutMs, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(deadlineError());
      reject(deadlineError());
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function classifyCatalogFailure(error) {
  if (error?.code === "CATALOG_REFRESH_TIMEOUT") return "deadline";
  if (error instanceof TypeError) return "invalid-result";
  return "request-failed";
}

const refreshReason = (value) => (value === "background" ? "background" : "explicit");

function load() {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
    if (parsed?.schema === SCHEMA && parsed.entries && typeof parsed.entries === "object") {
      state.entries = parsed.entries;
      state.updatedAt = parsed.updatedAt || null;
    }
  } catch {
    state.entries = {};
  }
}

function writeAtomic(entries) {
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  const temporary = `${SNAPSHOT_FILE}.${process.pid}.tmp`;
  const snapshot = { schema: SCHEMA, updatedAt: new Date().toISOString(), entries };
  fs.writeFileSync(temporary, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, SNAPSHOT_FILE);
  state.entries = entries;
  state.updatedAt = snapshot.updatedAt;
}

export function readLiveCatalog(providerId, connection) {
  load();
  const entry = state.entries[entryKey(providerId, connection)];
  if (!entry || entry.revision !== credentialRevision(connection) || !Array.isArray(entry.models))
    return null;
  return { models: entry.models.map((model) => ({ ...model })) };
}

export function refreshLiveCatalog(
  providerId,
  connection,
  resolver,
  {
    currentRevision = async () => credentialRevision(connection),
    signal,
    timeoutMs = CONNECTION_REFRESH_TIMEOUT_MS,
  } = {}
) {
  load();
  const key = entryKey(providerId, connection);
  const revision = credentialRevision(connection);
  const flightKey = `${key}:${revision}`;
  if (state.refreshes.has(flightKey)) return state.refreshes.get(flightKey);
  const generation = (state.generations.get(key) || 0) + 1;
  state.generations.set(key, generation);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const work = (async () => {
    controller.signal.throwIfAborted();
    const result = await resolver(controller.signal);
    controller.signal.throwIfAborted();
    if (Array.isArray(result?.models) && result.models.length > 0) {
      const publishedRevision = credentialRevision(connection);
      const authoritativeRevision = await currentRevision();
      if (
        !controller.signal.aborted &&
        state.generations.get(key) === generation &&
        authoritativeRevision === publishedRevision
      ) {
        writeAtomic({
          ...state.entries,
          [key]: { revision: publishedRevision, models: result.models },
        });
      }
    }
    return result;
  })();
  let refresh;
  refresh = withOwnerDeadline(work, timeoutMs, controller).finally(() => {
    signal?.removeEventListener("abort", abort);
    if (state.refreshes.get(flightKey) === refresh) state.refreshes.delete(flightKey);
  });
  state.refreshes.set(flightKey, refresh);
  return refresh;
}

export function getPublicModelCatalogState() {
  load();
  return {
    available: Object.keys(state.entries).length > 0,
    running: state.refreshes.size > 0 || Boolean(state.wholeRefresh),
    updatedAt: state.updatedAt,
    lastError: state.lastError,
    file: SNAPSHOT_FILE,
  };
}

export function refreshPublicModelCatalogWith(
  builder,
  { reason = "explicit", timeoutMs = WHOLE_REFRESH_TIMEOUT_MS } = {}
) {
  if (state.wholeRefresh) return state.wholeRefresh;
  const safeReason = refreshReason(reason);
  const generation = state.wholeGeneration + 1;
  state.wholeGeneration = generation;
  const controller = new AbortController();
  let refresh;
  refresh = withOwnerDeadline(
    Promise.resolve().then(() => builder(controller.signal)),
    timeoutMs,
    controller
  )
    .then((models) => {
      if (!Array.isArray(models))
        throw new TypeError("model catalog builder did not return an array");
      state.lastError = null;
      console.log(`[model-list] refresh complete reason=${safeReason} models=${models.length}`);
      return { refreshed: true, models: models.length, updatedAt: state.updatedAt };
    })
    .catch((error) => {
      state.lastError = "catalog refresh failed";
      console.warn(
        `[model-list] refresh failed reason=${safeReason} class=${classifyCatalogFailure(error)}`
      );
      return { refreshed: false, error: state.lastError };
    })
    .finally(() => {
      if (state.wholeRefresh === refresh && state.wholeGeneration === generation) {
        state.wholeRefresh = null;
      }
    });
  state.wholeRefresh = refresh;
  return refresh;
}

export function startPublicModelCatalogRefresh(
  builder,
  { startupDelayMs = 60_000, intervalMs = 15 * 60_000 } = {}
) {
  if (state.timer || process.env.NEXT_PHASE?.includes("build")) return;
  const schedule = (delay) => {
    state.timer = setTimeout(async () => {
      await refreshPublicModelCatalogWith(builder, { reason: "background" });
      schedule(intervalMs);
    }, delay);
    state.timer.unref?.();
  };
  schedule(startupDelayMs);
}

export function resetPublicModelCatalogForTests() {
  if (state.timer) clearTimeout(state.timer);
  Object.assign(state, {
    loaded: true,
    entries: {},
    updatedAt: null,
    refreshes: new Map(),
    generations: new Map(),
    wholeRefresh: null,
    wholeGeneration: state.wholeGeneration + 1,
    lastError: null,
    timer: null,
  });
  try {
    fs.rmSync(SNAPSHOT_FILE, { force: true });
  } catch {}
}
