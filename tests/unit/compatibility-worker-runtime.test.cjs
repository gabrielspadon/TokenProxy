const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

async function resultFrom(worker) {
  worker.stdout?.resume();
  worker.stderr?.resume();
  try {
    return await new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error('Restricted worker timed out')), 5000);
      worker.once('message', value => { clearTimeout(timer); resolveResult(value); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('Worker exited without a result')); });
    });
  } finally { await worker.terminate(); }
}

test('the traced restricted worker runs from a relocated package with no checkout fallback', async () => {
  const root = process.env.COMPATIBILITY_PACKAGE_ROOT
    ? resolve(process.env.COMPATIBILITY_PACKAGE_ROOT)
    : resolve(__dirname, '../..');
  const { COMPATIBILITY_WORKER_FILES } = await import('../../src/lib/compatibility/runtimeFiles.mjs');
  const { createCompatibilityWorker } = await import('../../src/lib/compatibility/runtime.mjs');
  const { SAMPLE_FIXTURES } = await import('../../src/shared/compatibility/samples.js');
  const relocated = mkdtempSync(join(tmpdir(), 'compatibility-worker-relocated-'));
  try {
    for (const file of ['package.json', ...COMPATIBILITY_WORKER_FILES]) {
      assert.ok(!file.includes('..') && !file.includes('*'));
      mkdirSync(dirname(join(relocated, file)), { recursive: true });
      cpSync(join(root, file), join(relocated, file));
    }
    mkdirSync(join(relocated, 'server'));
    for (const fixture of [...SAMPLE_FIXTURES, { definition: { ...SAMPLE_FIXTURES[0].definition, scope: 'controlled-gateway-routing', provider: 'openai', targetFormat: 'openai', scenario: 'tool-ordering', fixtureVersion: 'controlled-v1' } }]) {
      const response = await resultFrom(createCompatibilityWorker(fixture.definition, { cwd: join(relocated, 'server') }));
      assert.equal(response.error, undefined);
      assert.ok(response.result.checks.every(check => check.outcome === 'passed'));
      assert.equal(response.result.coverage.providerCalls, 0);
      assert.equal(response.result.coverage.credentialsRead, false);
      assert.equal(response.result.coverage.modelReadiness, 'unknown');
      assert.equal(response.result.sourceFormat, fixture.definition.sourceFormat);
      assert.equal(response.result.targetFormat, fixture.definition.targetFormat);
    }
    assert.throws(() => createCompatibilityWorker(SAMPLE_FIXTURES[0].definition, { cwd: join(relocated, 'absent', 'server') }), { code: 'runtime_unavailable' });
  } finally { rmSync(relocated, { recursive: true, force: true }); }
});

test('the production worker factory withholds inherited secrets and write, network and subprocess grants', async () => {
  const { createCompatibilityWorker } = await import('../../src/lib/compatibility/runtime.mjs');
  const scratch = mkdtempSync(join(tmpdir(), 'compatibility-worker-permissions-'));
  const base = join(scratch, 'package');
  const file = join(base, 'src/lib/compatibility/worker.mjs');
  const previous = process.env.COMPATIBILITY_TEST_SECRET;
  try {
    process.env.COMPATIBILITY_TEST_SECRET = 'synthetic-parent-only';
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(join(scratch, 'outside.txt'), 'synthetic-outside-data');
    writeFileSync(file, `import { parentPort, workerData } from 'node:worker_threads';
      import { readFileSync } from 'node:fs';
      let outsideRead;
      try { readFileSync(workerData.definition.outside); outsideRead = 'allowed'; }
      catch (error) { outsideRead = error.code; }
      parentPort.postMessage({ inherited: process.env.COMPATIBILITY_TEST_SECRET,
        write: process.permission.has('fs.write'), child: process.permission.has('child'),
        network: process.permission.has('net'), outsideRead });`);
    const response = await resultFrom(createCompatibilityWorker({ outside: join(scratch, 'outside.txt') }, { cwd: base }));
    assert.deepEqual(response, { inherited: undefined, write: false, child: false, network: false, outsideRead: 'ERR_ACCESS_DENIED' });
  } finally {
    if (previous === undefined) delete process.env.COMPATIBILITY_TEST_SECRET;
    else process.env.COMPATIBILITY_TEST_SECRET = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
});
