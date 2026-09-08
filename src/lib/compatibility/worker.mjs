import { parentPort, workerData } from 'node:worker_threads';

// Permission-mode workers receive no runtime secrets, write/network/subprocess
// grant or account lookup. Refuse a runtime that could not enforce this boundary.
if (!process.permission || process.permission.has('fs.write') || process.permission.has('child') || process.permission.has('net')) {
  throw new Error('Local execution permission boundary unavailable.');
}
try {
  const { implementationFingerprint } = await import('./version.mjs');
  const before = implementationFingerprint();
  const controlled = workerData.definition.scope && workerData.definition.scope !== 'local-translation';
  const result = controlled
    ? await (await import('./controlled.mjs')).executeControlledFixture(workerData.definition)
    : (await import('./runner.mjs')).executeLocalFixture(workerData.definition);
  const after = implementationFingerprint();
  if (before !== after) throw new Error('Compatibility source changed during execution.');
  result.implementationHash = after;
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: { code: error.code || 'translation_failed', message: error.code === 'route_unavailable' || error.code === 'too_large' ? error.message : 'The local translator rejected this fixture. Inspect its declared format and payload; no upstream request was made.' } });
}
