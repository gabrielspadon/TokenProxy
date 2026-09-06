import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShapingError } from './profile.js';
let active = false;
export async function runExperiment(input, { signal } = {}) {
  if (signal?.aborted) throw new ShapingError('experiment_cancelled', 499);
  if (active) throw new ShapingError('experiment_busy', 409);
  active = true;
  let worker, scratch, abort;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'tokenproxy-offline-shaping-'));
    return await new Promise((resolve, reject) => {
      abort = () => reject(new ShapingError('experiment_cancelled', 499));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      worker = new Worker(new URL('./worker.mjs', import.meta.url), {
        workerData: input, env: { ...process.env, DATA_DIR: scratch },
        // Node 20.18.1 exposes syntax detection behind this flag. The stage
        // dependency dataDir.js is ESM in the root's mixed-module package.
        execArgv: [...process.execArgv, '--experimental-detect-module'],
      });
      const timeout = setTimeout(() => reject(new ShapingError('experiment_timeout', 503)), 15000);
      worker.once('message', result => { clearTimeout(timeout); result.error ? reject(new ShapingError(result.error, 500)) : resolve(result); });
      worker.once('error', () => { clearTimeout(timeout); reject(new ShapingError('experiment_worker_failed', 500)); });
      worker.once('exit', () => { clearTimeout(timeout); reject(new ShapingError('experiment_worker_exited_without_result', 500)); });
    });
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    if (worker) await worker.terminate();
    try { if (scratch) await rm(scratch, { recursive: true, force: true }); }
    finally { active = false; }
  }
}
