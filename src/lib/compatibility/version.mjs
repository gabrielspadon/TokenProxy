import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { COMPATIBILITY_WORKER_FILES } from './runtimeFiles.mjs';
export function implementationFingerprint() {
  const root = new URL('../../../', import.meta.url);
  const hash = createHash('sha256');
  for (const path of [...COMPATIBILITY_WORKER_FILES].sort()) {
    hash.update(path); hash.update('\0'); hash.update(readFileSync(new URL(path, root))); hash.update('\0');
  }
  return hash.digest('hex');
}
