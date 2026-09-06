const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, cpSync, rmSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { Worker } = require('node:worker_threads');

test('traces and runs the complete offline worker from an isolated relocated source tree', async () => {
  const root = resolve(__dirname, '../..'), { SHAPING_WORKER_FILES } = await import('../../src/lib/shaping/runtimeFiles.mjs');
  const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
  const { fileList } = await nodeFileTrace([join(root, 'src/lib/shaping/worker.mjs')], { base: root, processCwd: root });
  assert.deepEqual([...fileList].filter(file => file !== 'package.json').sort(), SHAPING_WORKER_FILES.map(file => file.slice(2)).sort());
  const relocated = mkdtempSync(join(tmpdir(), 'shaping-worker-relocated-'));
  let worker;
  try {
    for (const file of ['package.json', ...SHAPING_WORKER_FILES]) { mkdirSync(dirname(join(relocated, file)), { recursive: true }); cpSync(join(root, file), join(relocated, file)); }
    const settings = { rtkEnabled: true, memoryToolPruningEnabled: true, memoryMediaPruningEnabled: true, memoryMaxToolTurnsKeepFull: 2, memoryMaxHistoricalToolChars: 800, privacyFilterTerms: [] };
    worker = new Worker(join(relocated, 'src/lib/shaping/worker.mjs'), { env: { ...process.env, DATA_DIR: join(relocated, 'data') }, execArgv: ['--experimental-detect-module'], workerData: { baseline: settings, candidate: settings, fixtureSetId: 'context-integrity-v1' } });
    const result = await new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error('Relocated worker timed out')), 5000);
      worker.once('message', value => { clearTimeout(timer); resolveResult(value); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('Worker exited before returning evidence')); });
    });
    assert.equal(result.error, undefined); assert.equal(result.baseline.results.length, 4);
    assert.deepEqual(result.baseline.results.map(row => row.afterHash), result.candidate.results.map(row => row.afterHash));
    assert.ok(result.candidate.results.every(row => row.validity.toolTransactionsValid && row.validity.currentPreserved && row.validity.liveThinkingPreserved && row.validity.errorEvidencePreserved));
    assert.equal(result.candidate.coverage.providerCalls, 0); assert.equal(result.candidate.coverage.tokenCounts, null);
  } finally { await worker?.terminate(); rmSync(relocated, { recursive: true, force: true }); }
});
