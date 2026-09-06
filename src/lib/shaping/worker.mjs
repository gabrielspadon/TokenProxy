import { parentPort, workerData } from 'node:worker_threads';
// There is no service adapter in this worker. Future accidental fetch use fails
// before any endpoint can be contacted; external stages are reported unsupported.
globalThis.fetch = async () => { throw new Error('Offline experiments cannot contact services'); };
try {
  const { evaluateSettings } = await import('./evaluate.mjs');
  const started = performance.now();
  const baseline = await evaluateSettings(workerData.baseline, workerData.fixtureSetId);
  const candidate = await evaluateSettings(workerData.candidate, workerData.fixtureSetId);
  parentPort.postMessage({ baseline, candidate, localExecutionMs: performance.now() - started, evaluatorVersion: 1 });
} catch { parentPort.postMessage({ error: 'offline_evaluation_failed' }); }
