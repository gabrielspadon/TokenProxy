import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const baselineRoot = process.argv[2];
if (!baselineRoot) throw new Error('Usage: node tests/qa/writer-ownership-overhead.mjs /absolute/baseline/worktree');
const candidateRoot = fileURLToPath(new URL('../..', import.meta.url));
const directory = fs.mkdtempSync(join(tmpdir(), 'tokenproxy-writer-overhead-'));
const samples = 20, readCalls = 500;
const adapters = [];
function summary(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return { count: ordered.length, p50: ordered[Math.ceil(ordered.length * 0.5) - 1], p95: ordered[Math.ceil(ordered.length * 0.95) - 1] };
}
const variants = {};
try {
  for (const [name, root] of Object.entries({ baseline: resolve(baselineRoot), candidate: candidateRoot })) {
    const { createNodeSqliteAdapter } = await import(pathToFileURL(join(root, 'src/lib/db/adapters/nodeSqliteAdapter.js')));
    const { createSqlJsAdapter } = await import(pathToFileURL(join(root, 'src/lib/db/adapters/sqljsAdapter.js')));
    variants[name] = { root, createNodeSqliteAdapter, createSqlJsAdapter, startup: [], reads: [], flushes: [] };
  }
  for (let iteration = 0; iteration < samples; iteration += 1) {
    const order = iteration % 2 ? Object.entries(variants).reverse() : Object.entries(variants);
    for (const [name, variant] of order) {
      const started = performance.now();
      const native = await variant.createNodeSqliteAdapter(join(directory, `${name}-${iteration}.sqlite`));
      variant.startup.push(performance.now() - started);
      native.exec('CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES(1)');
      const readsStarted = performance.now();
      for (let read = 0; read < readCalls; read += 1) native.get('SELECT value FROM probe');
      variant.reads.push((performance.now() - readsStarted) * 1000 / readCalls);
      native.close();
    }
  }
  for (const [name, variant] of Object.entries(variants)) {
    const file = join(directory, `${name}-snapshot.sqlite`);
    const db = await variant.createSqlJsAdapter(file); adapters.push(db);
    db.exec('CREATE TABLE probe(id INTEGER PRIMARY KEY, payload TEXT, value INTEGER)');
    db.transaction(() => {
      for (let row = 0; row < 128; row += 1) db.run('INSERT INTO probe VALUES (?, ?, 0)', [row, 'synthetic'.repeat(128)]);
    });
    db.flush();
    variant.db = db; variant.snapshotBytes = fs.statSync(file).size;
  }
  for (let iteration = 0; iteration < samples; iteration += 1) {
    const order = iteration % 2 ? Object.entries(variants).reverse() : Object.entries(variants);
    for (const [, variant] of order) {
      variant.db.run('UPDATE probe SET value = value + 1 WHERE id = ?', [iteration]);
      const started = performance.now(); variant.db.flush();
      variant.flushes.push(performance.now() - started);
    }
  }
  const sourceFiles = ['writerAdmission.js', 'sqljsAdapter.js', 'nodeSqliteAdapter.js', 'betterSqliteAdapter.js', 'bunSqliteAdapter.js'];
  const sourceSha256 = Object.fromEntries(sourceFiles.map(name => [name,
    createHash('sha256').update(fs.readFileSync(join(candidateRoot, 'src/lib/db/adapters', name))).digest('hex')]));
  console.log(JSON.stringify({ kind: 'writer-ownership-overhead', node: process.versions.node,
    measuredAt: new Date().toISOString(), scope: 'small synthetic fixture, not release qualification',
    baselineSha: execFileSync('git', ['-C', resolve(baselineRoot), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceSha256, samples, nativeReadsPerSample: readCalls,
    results: Object.fromEntries(Object.entries(variants).map(([name, value]) => [name, {
      nativeStartupMs: summary(value.startup), nativeReadUs: summary(value.reads),
      sqlJsFlushMs: summary(value.flushes), snapshotBytes: value.snapshotBytes,
    }])) }, null, 2));
} finally {
  while (adapters.length) adapters.pop().close();
  fs.rmSync(directory, { recursive: true, force: true });
}
