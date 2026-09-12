import { Worker } from "node:worker_threads";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { registerShutdownFlusher } from "../../shutdown.js";

const MAX_QUEUED = 8;
const MAX_SUBSCRIBERS = 64;
const QUERY_TIMEOUT_MS = 15000;
export class ContextAnalyticsError extends Error {}

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
// Version the actual persisted source, including WAL writes and sql.js atomic
// replacements. Missing file metadata disables completed-result reuse.
export function analyticsDataVersion(file) {
  if (!file) return null;
  try {
    const stamp = path => { const s = statSync(path, { bigint: true }); return [s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String); };
    const parts = [stamp(file)];
    try { parts.push(stamp(`${file}-wal`)); } catch (error) { if (error.code !== 'ENOENT') return null; }
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  } catch { return null; }
}

function workerPath() {
  for (const root of [process.cwd(), resolve(process.cwd(), "..")]) {
    const file = resolve(root, "src/lib/db/analytics/worker.mjs");
    if (existsSync(file)) return file;
  }
  throw new ContextAnalyticsError("Context analytics runtime is missing.");
}

export function createContextAnalyticsClient({ file, driver, timeoutMs = QUERY_TIMEOUT_MS, maxQueued = MAX_QUEUED, workerFactory, version = () => analyticsDataVersion(file), now = Date.now, monotonic = () => performance.now(), cacheTtlMs = 1000, maxCacheBytes = 8 * 1024 * 1024, maxCacheEntries = 32, traceLifecycle = false } = {}) {
  const jobs = new Map(), queue = [], cache = new Map();
  let cacheBytes = 0, lastScope = null, cacheEpoch = 0;
  const dropCache = key => { const entry = cache.get(key); if (entry) { cacheBytes -= entry.bytes; cache.delete(key); } };
  const invalidate = () => { cacheEpoch++; cache.clear(); cacheBytes = 0; };
  let worker, active, sequence = 0, closed = false, terminating = false;
  const unavailable = () => new ContextAnalyticsError("Context analytics is temporarily unavailable. Please retry.");
  function finish(job, error, result) {
    clearTimeout(job.timer);
    jobs.delete(job.key);
    if (!error && result && typeof result === 'object') {
      const queueDurationMs = Math.max(0, (job.startedAt ?? monotonic()) - job.enqueuedAt);
      const executionDurationMs = Math.max(0, monotonic() - (job.startedAt ?? job.enqueuedAt));
      result.freshness = {
        ...result.freshness,
        cacheHit: false,
        queueDurationMs,
        executionDurationMs,
        computationQueueDurationMs: queueDurationMs,
        computationExecutionDurationMs: executionDurationMs,
        serviceDeadlineMs: timeoutMs,
        delivery: 'computed',
      };
    }
    if (!error && job.subscribers.size && job.epoch === cacheEpoch && job.version !== null && job.version === version()) {
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes <= maxCacheBytes) {
        dropCache(job.key);
        while (cache.size && (cache.size >= maxCacheEntries || cacheBytes + bytes > maxCacheBytes)) dropCache(cache.keys().next().value);
        cache.set(job.key, { result: structuredClone(result), bytes, at: now() }); cacheBytes += bytes;
      }
    }
    for (const subscriber of job.subscribers) {
      subscriber.cleanup();
      if (error) subscriber.reject(error); else subscriber.resolve(result);
    }
    job.subscribers.clear();
  }
  function failWorker() {
    if (!worker || terminating) return;
    const failed = worker;
    terminating = true;
    if (active) { finish(active, unavailable()); active = null; }
    // Do not spawn another worker until the previous native query has stopped.
    Promise.resolve(failed.terminate()).catch(() => {}).finally(() => {
      if (worker === failed) worker = null;
      terminating = false;
      pump();
    });
  }
  function pump() {
    if (closed || active || terminating || !queue.length) return;
    let index = queue.findIndex(job => job.scope !== lastScope);
    if (index < 0) index = 0;
    active = queue.splice(index, 1)[0]; lastScope = active.scope; active.startedAt = monotonic();
    try {
      if (!worker) {
        worker = workerFactory ? workerFactory() : new Worker(workerPath(), {
          workerData: { file, driver, traceLifecycle }, env: {}, execArgv: process.execArgv.filter((arg) => arg === "--experimental-sqlite"),
          resourceLimits: { maxOldGenerationSizeMb: 192 },
        });
        const current = worker;
        worker.on("message", ({ id, error, result, lifecycle, snapshotStartedAt }) => {
          if (worker !== current || !active || active.id !== id) return;
          if (lifecycle === 'snapshot-started') {
            for (const subscriber of active.subscribers) {
              try { subscriber.onComputationStarted?.({ snapshotStartedAt }); } catch {}
            }
            current.postMessage({ id, lifecycle: 'snapshot-continue' });
            return;
          }
          finish(active, error ? unavailable() : null, result);
          active = null;
          current.unref();
          pump();
        });
        worker.on("error", () => { if (worker === current) failWorker(); });
        worker.on("exit", () => { if (worker === current && !terminating) failWorker(); });
      }
      worker.ref();
      worker.postMessage({ id: active.id, query: active.query });
    } catch {
      finish(active, unavailable()); active = null;
      if (worker) failWorker(); else queueMicrotask(pump);
    }
  }
  function run(query, { signal, authorizedScope = 'server', onComputationStarted } = {}) {
    if (closed || signal?.aborted) return Promise.reject(unavailable());
    const deliveryStartedAt = monotonic();
    const dataVersion = version();
    const scope = String(authorizedScope);
    const key = JSON.stringify([scope, canonical(query), dataVersion, cacheEpoch]);
    const cached = cache.get(key);
    for (const [id, entry] of cache) if (now() - entry.at >= cacheTtlMs) dropCache(id);
    if (cached && now() - cached.at < cacheTtlMs) {
      const result=structuredClone(cached.result);
      result.freshness={...result.freshness,cacheHit:true,delivery:'cache-hit',cacheAgeMs:Math.max(0,now()-cached.at),
        queueDurationMs:0,executionDurationMs:Math.max(0,monotonic()-deliveryStartedAt)};
      return Promise.resolve(result);
    }
    let job = jobs.get(key);
    if (!job && (queue.length >= maxQueued || queue.filter(item => item.scope === scope).length >= Math.max(1, Math.ceil(maxQueued / 2)))) return Promise.reject(unavailable());
    if (job?.subscribers.size >= MAX_SUBSCRIBERS) return Promise.reject(unavailable());
    if (!job) {
      job = { id: ++sequence, key, query, scope, version: dataVersion, epoch: cacheEpoch, subscribers: new Set(), enqueuedAt: monotonic() };
      jobs.set(key, job); queue.push(job);
      job.timer = setTimeout(() => {
        if (active === job) failWorker();
        else { queue.splice(queue.indexOf(job), 1); finish(job, unavailable()); }
      }, timeoutMs);
      job.timer.unref?.();
    }
    const result = new Promise((resolveResult, reject) => {
      const subscriber = { resolve: resolveResult, reject, onComputationStarted,
        cleanup: () => signal?.removeEventListener("abort", abort) };
      function abort() {
        subscriber.cleanup(); job.subscribers.delete(subscriber); reject(unavailable());
        if (!job.subscribers.size) {
          if (active === job) failWorker();
          else {
            const index=queue.indexOf(job); if(index>=0)queue.splice(index,1);
            finish(job, unavailable());
          }
        }
      }
      job.subscribers.add(subscriber);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    pump();
    return result;
  }
  function close() {
    closed = true; invalidate();
    for (const job of jobs.values()) finish(job, unavailable());
    queue.length = 0; active = null;
    return worker?.terminate();
  }
  return { run, close, invalidate, status: () => ({ active: Boolean(active), queued: queue.length, cached: cache.size, cacheBytes }) };
}

export function readContextAnalytics(query, { file, driver, signal, authorizedScope = 'server' } = {}) {
  const key = JSON.stringify([file, driver]);
  if (globalThis._contextAnalytics?.key !== key) {
    globalThis._contextAnalytics?.client.close();
    const client = createContextAnalyticsClient({ file, driver });
    globalThis._contextAnalytics = { key, client };
    registerShutdownFlusher(() => client.close(), 90);
  }
  return globalThis._contextAnalytics.client.run(query, { signal, authorizedScope });
}
