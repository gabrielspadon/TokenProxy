import { Worker } from 'node:worker_threads';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { CompatibilityError } from './model.mjs';

function runtime(cwd) {
  for (const base of [cwd, resolve(cwd, '..')]) {
    const file = resolve(base, 'src/lib/compatibility/worker.mjs');
    if (existsSync(file)) return { file: realpathSync(file), base: realpathSync(base) };
  }
  throw new CompatibilityError(
    'The packaged local compatibility runtime is unavailable.',
    503,
    'runtime_unavailable'
  );
}

export function createCompatibilityWorker(definition, { cwd = process.cwd() } = {}) {
  const { file, base } = runtime(cwd);
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
