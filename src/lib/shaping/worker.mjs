import { parentPort, workerData } from 'node:worker_threads';
// There is no service adapter in this worker. Future accidental fetch use fails
// before any endpoint can be contacted; external stages are reported unsupported.
globalThis.fetch = async () => { throw new Error('Offline experiments cannot contact services'); };
try {
  const { evaluateSettings } = await import('./evaluate.mjs');
  const { compareEvaluationEvidence } = await import('./recommendations.mjs');
  const started = performance.now();
  const options = workerData.fixtures ? { fixtures: workerData.fixtures } : {};
  const baseline = await evaluateSettings(workerData.baseline, workerData.fixtureSetId, options);
  const candidate = await evaluateSettings(workerData.candidate, workerData.fixtureSetId, options);
  parentPort.postMessage({ status: 'completed', baseline, candidate, localExecutionMs: performance.now() - started,
    evaluatorVersion: 2, runtime: process.version, comparison: compareEvaluationEvidence(baseline, candidate) });
} catch { parentPort.postMessage({ error: 'offline_evaluation_failed' }); }
