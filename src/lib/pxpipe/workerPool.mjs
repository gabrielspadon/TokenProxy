import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const failure = code => Object.assign(new Error(code), { code });
function workerPath() {
  for (const root of [process.cwd(), resolve(process.cwd(), '..')]) {
    const file = resolve(root, 'src/lib/pxpipe/worker.mjs');
    if (existsSync(file)) return file;
  }
  throw failure('pxpipe_worker_runtime_missing');
}

// One reusable CPU lane, bounded queued payload ownership, and no replacement
// worker until termination of its predecessor has actually completed.
export function createPxpipeWorkerPool({ entry, maxQueued = 4, maxBytes = 64 * 1024 * 1024 } = {}) {
  const queue = [];
  let worker, active, terminating, closed = false, sequence = 0, heldBytes = 0;
  function finish(job, error, result) {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    heldBytes -= job.size;
    if (error) job.reject(error); else job.resolve(result);
  }
  function stop(error) {
    if (terminating) return terminating;
    const previous = worker, job = active;
    if (job) job.stopping = true;
    worker = null; active = null;
    if (!previous) { if (job) finish(job, error); return Promise.resolve(); }
    terminating = previous.terminate().then(() => {
      if (job) finish(job, error);
      terminating = null;
      pump();
    }, () => {
      closed = true;
      if (job) finish(job, failure('pxpipe_worker_cleanup_failed'));
      for (const pending of queue.splice(0)) finish(pending, failure('pxpipe_worker_cleanup_failed'));
    });
    return terminating;
  }
  function pump() {
    if (closed || active || terminating || !queue.length) return;
    active = queue.shift();
    try {
      if (!worker) {
        worker = new Worker(workerPath(), { workerData: { entry },
          resourceLimits: { maxOldGenerationSizeMb: 256 },
          // The library resolves its own installed dependencies. Credentials
          // from the gateway environment are never inherited by this worker.
          env: {}, execArgv: process.execArgv.filter(arg => arg === '--experimental-detect-module'),
        });
        const current = worker;
        worker.on('message', ({ id, result, error }) => {
          if (worker !== current || active?.id !== id) return;
          const job = active; active = null;
          finish(job, error ? failure('pxpipe_transform_failed') : null, result);
          current.unref(); pump();
        });
        worker.on('error', () => { if (worker === current) stop(failure('pxpipe_worker_failed')); });
        worker.on('exit', () => { if (worker === current) stop(failure('pxpipe_worker_exited')); });
      }
      worker.ref();
      // Transfer an owned copy. Detaching an injected caller's input would
      // change its public contract and could invalidate a retry decision.
      const body = Uint8Array.from(active.input.body);
      worker.postMessage({ id: active.id, input: { ...active.input, body } }, [body.buffer]);
    } catch (error) {
      if (worker) stop(error);
      else { const job = active; active = null; finish(job, error); queueMicrotask(pump); }
    }
  }
  function run({ signal, timeoutMs = 15000, ...input }) {
    if (closed) return Promise.reject(failure('pxpipe_worker_closed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!(input.body instanceof Uint8Array) || input.body.byteLength > maxBytes || heldBytes + input.body.byteLength > maxBytes) return Promise.reject(failure('pxpipe_worker_capacity'));
    if (queue.length >= maxQueued) return Promise.reject(failure('pxpipe_worker_busy'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(failure('pxpipe_invalid_timeout'));
    return new Promise((resolveResult, reject) => {
      const job = { id: ++sequence, input, signal, size: input.body.byteLength, resolve: resolveResult, reject, finished: false };
      job.abort = () => {
        if (job.finished || job.stopping) return;
        const reason = signal?.aborted ? signal.reason : new DOMException('PXPIPE deadline exceeded', 'TimeoutError');
        if (active === job) { stop(reason); return; }
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        finish(job, reason);
      };
      heldBytes += input.body.byteLength;
      job.timer = setTimeout(job.abort, timeoutMs);
      signal?.addEventListener('abort', job.abort, { once: true });
      queue.push(job); pump();
    });
  }
  async function close() {
    closed = true;
    for (const job of queue.splice(0)) finish(job, failure('pxpipe_worker_closed'));
    await stop(failure('pxpipe_worker_closed'));
  }
  return { run, close };
}
