import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIMITS, CompatibilityError, TERMINAL } from './model.mjs';
import { getCompatibilityStore } from '../db/repos/compatibilityRepo.js';

function runtime() {
  for (const base of [process.cwd(), resolve(process.cwd(), '..')]) {
    const file = resolve(base, 'src/lib/compatibility/worker.mjs');
    if (existsSync(file)) return { file, base };
  }
  throw new CompatibilityError(
    'The packaged local compatibility runtime is unavailable.',
    503,
    'runtime_unavailable'
  );
}
function workerFor(definition) {
  const { file, base } = runtime();
  const readRoots = [base];
  if (existsSync(resolve(base, 'node_modules')))
    readRoots.push(realpathSync(resolve(base, 'node_modules')));
  return new Worker(file, {
    workerData: { definition },
    env: { NODE_ENV: 'production' },
    execArgv: ['--permission', ...[...new Set(readRoots)].map((root) => `--allow-fs-read=${root}`)],
    resourceLimits: { maxOldGenerationSizeMb: 192 },
    stdout: true,
    stderr: true,
  });
}
export function createCompatibilityManager(
  store,
  { workerFactory = workerFor, timeoutMs = LIMITS.timeoutMs } = {}
) {
  const owner = randomUUID(),
    queue = [];
  let active = null,
    closing = false;
  store.interruptPrevious(owner);
  function finish(job, status, detail = {}) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    try {
      store.transition(job.run.id, status, detail);
    } catch {
      // A failed persistence write never starts a replacement run, but the run
      // must still reach an explicit terminal state (e.g. a result over the
      // 512KiB retention cap). Retain the refusal, drop the oversized payload.
      try {
        store.transition(job.run.id, 'failed', {
          error: {
            code: 'result_unretainable',
            message:
              'The run finished but its result could not be retained within the byte limit. No retry was started.',
          },
        });
      } catch {
        /* run stays visibly non-terminal rather than lying */
      }
    }
    Promise.resolve(job.worker?.terminate())
      .catch(() => {})
      .finally(() => {
        if (active === job) active = null;
        pump();
      });
  }
  function pump() {
    if (closing || active || !queue.length) return;
    const job = queue.shift();
    active = job;
    try {
      store.transition(job.run.id, 'running');
      job.worker = workerFactory(job.fixture.definition);
      job.worker.stdout?.resume();
      job.worker.stderr?.resume();
      job.timer = setTimeout(
        () =>
          finish(job, 'timed-out', {
            error: {
              code: 'deadline',
              message:
                'The3second local execution deadline elapsed. No automatic retry was started.',
            },
          }),
        timeoutMs
      );
      job.worker.once('message', (message) =>
        finish(
          job,
          message.error || message.result?.checks.some((check) => check.outcome === 'failed')
            ? 'failed'
            : 'succeeded',
          message
        )
      );
      job.worker.once('error', () =>
        finish(job, 'failed', {
          error: {
            code: 'worker_failed',
            message:
              'Local execution could not complete inside the restricted worker. No upstream request was made.',
          },
        })
      );
      job.worker.once('exit', () => {
        if (!job.done)
          finish(job, 'failed', {
            error: {
              code: 'worker_exited',
              message: 'The local worker stopped before returning a result.',
            },
          });
      });
    } catch (error) {
      finish(job, 'failed', {
        error: {
          code: error.code || 'runtime_unavailable',
          message: 'The local execution runtime is unavailable. This run was not replayed.',
        },
      });
    }
  }
  return {
    submit(id, rev) {
      if (closing || queue.length >= LIMITS.queued)
        throw new CompatibilityError(
          'The local execution queue is full. Nothing was scheduled; retry deliberately later.',
          503,
          'queue_full'
        );
      const job = store.createRun(id, rev, owner);
      queue.push(job);
      pump();
      return store.getRun(job.run.id);
    },
    cancel(id) {
      const run = store.getRun(id);
      if (!run) throw new CompatibilityError('Run not found.', 404, 'not_found');
      if (TERMINAL.includes(run.status)) return run;
      if (active?.run.id === id)
        finish(active, 'cancelled', {
          error: {
            code: 'operator_cancelled',
            message: 'Cancelled by the operator. No retry was scheduled.',
          },
        });
      else {
        const index = queue.findIndex((job) => job.run.id === id);
        if (index >= 0) queue.splice(index, 1);
        store.transition(id, 'cancelled', {
          error: { code: 'operator_cancelled', message: 'Cancelled before local execution.' },
        });
      }
      return store.getRun(id);
    },
    close() {
      closing = true;
      for (const job of queue.splice(0)) store.transition(job.run.id, 'interrupted');
      if (active) finish(active, 'interrupted');
    },
  };
}
export async function getCompatibilityManager() {
  if (!globalThis._compatibilityManagerPromise)
    globalThis._compatibilityManagerPromise = getCompatibilityStore()
      .then((store) => createCompatibilityManager(store))
      .catch((error) => {
        globalThis._compatibilityManagerPromise = null;
        throw error;
      });
  return globalThis._compatibilityManagerPromise;
}
