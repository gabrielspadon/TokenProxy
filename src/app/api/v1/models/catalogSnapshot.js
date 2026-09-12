import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

const SNAPSHOT_FILE = path.join(DATA_DIR, "model-list-snapshot.json");
const SCHEMA = 1;

const state = (globalThis.__tokenproxyPublicModelCatalog ??= {
  loaded: false,
  entries: {},
  updatedAt: null,
  refreshes: new Map(),
  wholeRefresh: null,
  lastError: null,
  timer: null,
});

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

function connectionRevision(connection) {
  const relevant = {
    id: connection?.id,
    provider: connection?.provider,
    accessToken: connection?.accessToken,
    refreshToken: connection?.refreshToken,
    apiKey: connection?.apiKey,
    expiresAt: connection?.expiresAt,
    providerSpecificData: connection?.providerSpecificData,
  };
  return createHash("sha256").update(canonical(relevant)).digest("hex");
}

const entryKey = (providerId, connection) => `${providerId}:${connection?.id || "default"}`;

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
  if (!entry || entry.revision !== connectionRevision(connection) || !Array.isArray(entry.models)) return null;
  return { models: entry.models.map((model) => ({ ...model })) };
}

export function refreshLiveCatalog(providerId, connection, resolver) {
  load();
  const key = entryKey(providerId, connection);
  const revision = connectionRevision(connection);
  const flightKey = `${key}:${revision}`;
  if (state.refreshes.has(flightKey)) return state.refreshes.get(flightKey);
  const refresh = (async () => {
    try {
      const result = await resolver();
      if (Array.isArray(result?.models) && result.models.length > 0) {
        const publishedRevision = connectionRevision(connection);
        writeAtomic({
          ...state.entries,
          [key]: { revision: publishedRevision, models: result.models },
        });
      }
      return result;
    } finally {
      state.refreshes.delete(flightKey);
    }
  })();
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

export function refreshPublicModelCatalogWith(builder, { reason = "explicit" } = {}) {
  if (state.wholeRefresh) return state.wholeRefresh;
  const refresh = (async () => {
    try {
      const models = await builder();
      if (!Array.isArray(models)) throw new TypeError("model catalog builder did not return an array");
      state.lastError = null;
      console.log(`[model-list] refresh complete reason=${reason} models=${models.length}`);
      return { refreshed: true, models: models.length, updatedAt: state.updatedAt };
    } catch (error) {
      state.lastError = "catalog refresh failed";
      console.warn(`[model-list] refresh failed reason=${reason} type=${error?.name || "Error"}`);
      return { refreshed: false, error: state.lastError };
    } finally {
      state.wholeRefresh = null;
    }
  })();
  state.wholeRefresh = refresh;
  return refresh;
}

export function startPublicModelCatalogRefresh(builder, {
  startupDelayMs = 60_000,
  intervalMs = 15 * 60_000,
} = {}) {
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
    wholeRefresh: null,
    lastError: null,
    timer: null,
  });
  try { fs.rmSync(SNAPSHOT_FILE, { force: true }); } catch {}
}
