import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBunSqliteAdapter } from '../../src/lib/db/adapters/bunSqliteAdapter.js';
import { createSqlJsAdapter } from '../../src/lib/db/adapters/sqljsAdapter.js';
import { openAnalyticsReadOnly } from '../../src/lib/db/analytics/readOnly.mjs';

if (!process.versions.bun) throw new Error('Run with bun tests/qa/writer-ownership-bun.mjs');
const directory = fs.mkdtempSync(join(tmpdir(), 'tokenproxy-bun-owner-'));
const file = join(directory, 'fixture.sqlite');
const adapters = [];
try {
  const first = await createBunSqliteAdapter(file); adapters.push(first);
  const second = await createBunSqliteAdapter(file); adapters.push(second);
  first.exec('CREATE TABLE business (value INTEGER)'); first.run('INSERT INTO business VALUES (1)');
  second.run('INSERT INTO business VALUES (2)');
  const fallback = await createSqlJsAdapter(file); adapters.push(fallback);
  assert.throws(() => fallback.run('INSERT INTO business VALUES (3)'), { code: 'DB_WRITER_OWNERSHIP_BUSY' });
  first.close();
  assert.throws(() => fallback.run('INSERT INTO business VALUES (3)'), { code: 'DB_WRITER_OWNERSHIP_BUSY' });
  second.close();
  fallback.run('INSERT INTO business VALUES (3)'); fallback.flush();
  assert.equal(fallback.get('SELECT COUNT(*) AS n FROM business').n, 3);
  await assert.rejects(createBunSqliteAdapter(file), { code: 'DB_WRITER_OWNERSHIP_BUSY' });
  const observer = await openAnalyticsReadOnly(file, 'sql.js'); adapters.push(observer);
  assert.equal(observer.get('SELECT COUNT(*) AS n FROM business').n, 3);
  assert.throws(() => observer.exec('INSERT INTO business VALUES (4)'));
  fallback.close();
  const resumed = await createBunSqliteAdapter(file); adapters.push(resumed);
  assert.equal(resumed.get('SELECT COUNT(*) AS n FROM business').n, 3);
  console.log(JSON.stringify({ kind: 'writer-ownership-bun-test', bun: process.versions.bun, passed: true,
    checks: ['native-concurrency', 'exclusive-fallback', 'snapshot-promotion', 'native-admission', 'analytics-readonly', 'ownership-release'] }));
} finally {
  while (adapters.length) adapters.pop().close();
  fs.rmSync(directory, { recursive: true, force: true });
}
