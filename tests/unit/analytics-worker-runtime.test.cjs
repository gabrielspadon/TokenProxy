const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, chmodSync, realpathSync } = require('node:fs');
const { dirname, join, resolve, matchesGlob } = require('node:path');
const { pathToFileURL } = require('node:url');
const { tmpdir } = require('node:os');
const { Worker } = require('node:worker_threads');
const { createHash } = require('node:crypto');

function queryWorker(worker, query, id) {
  return new Promise((resolveResult, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', message); worker.off('error', error); worker.off('exit', exit);
    };
    const message = value => { if (value.id === id) { cleanup(); resolveResult(value); } };
    const error = failure => { cleanup(); reject(failure); };
    const exit = code => error(new Error(`Relocated analytics worker exited with ${code}`));
    const timer = setTimeout(() => error(new Error('Relocated analytics worker timed out')), 5000);
    worker.on('message', message); worker.once('error', error); worker.once('exit', exit);
    worker.postMessage({ id, query });
  });
}

test('the traced analytics closure runs Context, Capacity and Economics from an isolated package', async () => {
  const checkout = resolve(__dirname, '../..');
  const packageRoot = process.env.ANALYTICS_PACKAGE_ROOT ? resolve(process.env.ANALYTICS_PACKAGE_ROOT) : checkout;
  const { default: config } = await import('../../next.config.mjs');
  const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
  const { fileList } = await nodeFileTrace([join(checkout, 'src/lib/db/analytics/worker.mjs')], { base: checkout, processCwd: checkout });
  const sources = [...fileList].filter(file => file.startsWith('src/') || file.startsWith('open-sse/'));
  for (const file of sources) {
    assert.ok(config.outputFileTracingIncludes['**'].some(pattern => matchesGlob(`./${file}`, pattern)), `Untraced analytics source dependency: ${file}`);
  }
  assert.ok(sources.includes('src/lib/db/completionIdentity.mjs'));
  const relocated = realpathSync(mkdtempSync(join(tmpdir(), 'analytics-worker-relocated-')));
  const file = join(relocated, 'synthetic.sqlite');
  let worker;
  try {
    // The selected emitted package must contain every dependency; neither a
    // symlink nor node_modules exposes the checkout to the relocated worker.
    for (const source of ['package.json', ...sources]) {
      mkdirSync(dirname(join(relocated, source)), { recursive: true });
      cpSync(join(packageRoot, source), join(relocated, source));
    }
    const { TABLES, buildCreateTableSql } = await import('../../src/lib/db/schema.js');
    const { seedCapacityEconomics, CAPACITY_ECONOMICS_FIXTURE: fixture } = await import('../e2e/capacity-economics-seed.mjs');
    const { DatabaseSync } = require('node:sqlite');
    const writer = new DatabaseSync(file);
    try {
      for (const [name, definition] of Object.entries(TABLES)) {
        writer.exec(buildCreateTableSql(name, definition));
        for (const sql of definition.indexes || []) writer.exec(sql);
      }
      const db = {
        get: (sql, args = []) => writer.prepare(sql).get(...args),
        all: (sql, args = []) => writer.prepare(sql).all(...args),
        run: (sql, args = []) => writer.prepare(sql).run(...args),
        transaction: callback => {
          writer.exec('BEGIN');
          try { const result = callback(); writer.exec('COMMIT'); return result; }
          catch (error) { writer.exec('ROLLBACK'); throw error; }
        },
      };
      for (const id of fixture.accountIds) db.run('INSERT INTO providerConnections(id,provider,authType,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?)', [id,fixture.provider,'apikey','{}',fixture.capturedAt,fixture.capturedAt]);
      seedCapacityEconomics(db, { fixtureKind: 'synthetic-fixture' });
    } finally { writer.close(); }
    chmodSync(file, 0o400);
    const hash = () => createHash('sha256').update(readFileSync(file)).digest('hex');
    const before = hash();
    const { openAnalyticsReadOnly } = await import(pathToFileURL(join(relocated, 'src/lib/db/analytics/readOnly.mjs')));
    const reader = await openAnalyticsReadOnly(file, 'node:sqlite');
    try { assert.throws(() => reader.exec('DELETE FROM usageHistory'), /readonly|read-only/i); }
    finally { reader.close(); }
    worker = new Worker(join(relocated, 'src/lib/db/analytics/worker.mjs'), {
      workerData: { file, driver: 'node:sqlite' }, env: { NODE_ENV: 'production' },
      execArgv: ['--permission', `--allow-fs-read=${relocated}`], stdout: true, stderr: true,
    });
    worker.stdout.resume(); worker.stderr.resume();
    const context = await queryWorker(worker, { operation: 'overview', filter: { view: 'summary' }, retainedDays: 45 }, 'context');
    assert.equal(context.error, undefined);
    assert.equal(context.result.recording.totalRetainedAttempts, 8);
    const capacity = await queryWorker(worker, { operation: 'quota-workbench', start: '2026-09-07T00:00:00.000Z', end: fixture.capturedAt, filters: { connectionId: fixture.accountIds[0] } }, 'capacity');
    assert.equal(capacity.error, undefined); assert.equal(capacity.result.total, 36);
    const economics = await queryWorker(worker, { operation: 'activity', view: 'economics' }, 'economics');
    assert.equal(economics.error, undefined); assert.equal(economics.result.items.length, 8);
    const negative = economics.result.items.find(row => row.requestId === 'economics-fixture-5');
    assert.equal(negative.counterfactual.available, true);
    assert.equal(negative.counterfactual.modeledDifferenceUsd, -0.01);
    assert.equal(negative.counterfactual.identityBasis, 'server-completion-id');
    const refused = await queryWorker(worker, { operation: 'sql', sql: 'DELETE FROM usageHistory' }, 'refused');
    assert.equal(refused.result, undefined);
    assert.equal(refused.error, 'Context analytics is temporarily unavailable.');
    assert.equal(hash(), before, 'Analytics modified the synthetic SQLite file');
  } finally {
    await worker?.terminate();
    rmSync(relocated, { recursive: true, force: true });
  }
});
