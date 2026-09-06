import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { registerShutdownFlusher } from "../../shutdown.js";

const MAX_QUEUED = 8;
const MAX_SUBSCRIBERS = 64;
const QUERY_TIMEOUT_MS = 15000;
export class ContextAnalyticsError extends Error {}

function workerPath() {
  for (const root of [process.cwd(), resolve(process.cwd(), "..")]) {
    const file = resolve(root, "src/lib/db/analytics/worker.mjs");
    if (existsSync(file)) return file;
  }
  throw new ContextAnalyticsError("Context analytics runtime is missing.");
}

export function createContextAnalyticsClient({ file, driver, timeoutMs = QUERY_TIMEOUT_MS, maxQueued = MAX_QUEUED, workerFactory } = {}) {
  const jobs = new Map(), queue = [];
  let worker, active, sequence = 0, closed = false, terminating = false;
  const unavailable = () => new ContextAnalyticsError("Context analytics is temporarily unavailable. Please retry.");
  function finish(job, error, result) {
    clearTimeout(job.timer);
    jobs.delete(job.key);
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
    active = queue.shift();
    try {
      if (!worker) {
        worker = workerFactory ? workerFactory() : new Worker(workerPath(), {
          workerData: { file, driver }, env: {}, execArgv: process.execArgv.filter((arg) => arg === "--experimental-sqlite"),
          resourceLimits: { maxOldGenerationSizeMb: 192 },
        });
        const current = worker;
        worker.on("message", ({ id, error, result }) => {
          if (worker !== current || !active || active.id !== id) return;
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
  function run(query, { signal } = {}) {
    if (closed || signal?.aborted) return Promise.reject(unavailable());
    const key = JSON.stringify(query);
    let job = jobs.get(key);
    if (!job && queue.length >= maxQueued) return Promise.reject(unavailable());
    if (job?.subscribers.size >= MAX_SUBSCRIBERS) return Promise.reject(unavailable());
    if (!job) {
      job = { id: ++sequence, key, query, subscribers: new Set() };
      jobs.set(key, job); queue.push(job);
      job.timer = setTimeout(() => {
        if (active === job) failWorker();
        else { queue.splice(queue.indexOf(job), 1); finish(job, unavailable()); }
      }, timeoutMs);
      job.timer.unref?.();
    }
    const result = new Promise((resolveResult, reject) => {
      const subscriber = { resolve: resolveResult, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
      function abort() {
        subscriber.cleanup(); job.subscribers.delete(subscriber); reject(unavailable());
        if (!job.subscribers.size && active !== job) {
          queue.splice(queue.indexOf(job), 1); finish(job, unavailable());
        }
        // A running synchronous SQLite query finishes off-thread or is stopped
        // by its deadline. Its abandoned result is discarded, never cached.
      }
      job.subscribers.add(subscriber);
      signal?.addEventListener("abort", abort, { once: true });
    });
    pump();
    return result;
  }
  function close() {
    closed = true;
    for (const job of jobs.values()) finish(job, unavailable());
    queue.length = 0; active = null;
    return worker?.terminate();
  }
  return { run, close };
}

export function readContextAnalytics(query, { file, driver, signal } = {}) {
  const key = JSON.stringify([file, driver]);
  if (globalThis._contextAnalytics?.key !== key) {
    globalThis._contextAnalytics?.client.close();
    const client = createContextAnalyticsClient({ file, driver });
    globalThis._contextAnalytics = { key, client };
    registerShutdownFlusher(() => client.close(), 90);
  }
  return globalThis._contextAnalytics.client.run(query, { signal });
}
