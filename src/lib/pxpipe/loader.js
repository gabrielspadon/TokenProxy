import { pathToFileURL } from "url";
import { getInstallInfo, libraryEntry } from "./install.js";
import { createPxpipeWorkerPool } from "./workerPool.mjs";
import { registerShutdownFlusher } from "../shutdown.js";

// Start/stop govern the installed module and its one reusable worker.
let cached = null;
let loadPromise = null;
let generation = 0;
let workerShutdown = Promise.resolve();
registerShutdownFlusher(async () => { unloadPxpipe(); await workerShutdown; }, 90);

export function getLoadedInfo() {
  return cached ? { loaded: true, version: cached.version, loadedAt: cached.loadedAt } : { loaded: false };
}

export async function loadPxpipe() {
  if (cached) return cached;
  if (loadPromise) return loadPromise;
  loadPromise = doLoad(generation).finally(() => { loadPromise = null; });
  return loadPromise;
}

async function doLoad(startedGeneration) {
  await workerShutdown;
  const info = getInstallInfo();
  if (!info.installed) {
    const err = new Error("PXPIPE is not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  // Cache-bust per version so Repair/upgrade takes effect without a server restart.
  const url = `${pathToFileURL(libraryEntry()).href}?v=${encodeURIComponent(info.version || "0")}`;
  const mod = await import(/* webpackIgnore: true */ url);
  if (generation !== startedGeneration) {
    throw Object.assign(new Error("PXPIPE load was stopped"), { code: "LOAD_CANCELLED" });
  }
  if (typeof mod.transformAnthropicMessages !== "function") {
    throw new Error("installed pxpipe package does not export transformAnthropicMessages");
  }
  const pool = createPxpipeWorkerPool({ entry: libraryEntry() });
  cached = { module: mod, version: info.version, loadedAt: Date.now(), pool, transform: input => pool.run(input) };
  return cached;
}

export function unloadPxpipe() {
  generation++;
  const wasLoaded = !!cached;
  if (cached?.pool) workerShutdown = cached.pool.close();
  cached = null;
  return wasLoaded;
}

// Transform function for the request pipeline; null when unavailable (fail-open).
// autoLoad controls whether a cold cache triggers a load (first request warms it).
export async function getTransform({ autoLoad = true } = {}) {
  try {
    if (!cached && !autoLoad) return null;
    const loaded = await loadPxpipe();
    return loaded.transform;
  } catch {
    return null;
  }
}

// Health self-test: run a tiny synthetic Claude request through the transformer.
// A healthy module parses it and answers with a machine-readable reason.
export async function selfTest() {
  const startedAt = Date.now();
  const loaded = await loadPxpipe();
  const body = new TextEncoder().encode(JSON.stringify({
    model: "claude-fable-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
  }));
  const result = await loaded.transform({ body, model: "claude-fable-5" });
  if (!result || typeof result.applied !== "boolean" || !(result.body instanceof Uint8Array)) {
    throw new Error("transform returned an unexpected shape");
  }
  return { ok: true, reason: result.reason, durationMs: Date.now() - startedAt };
}
