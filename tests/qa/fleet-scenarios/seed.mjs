import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(process.argv[2]);
const receipt = JSON.parse(await readFile(join(root, 'process.json'), 'utf8'));
assert.equal(receipt.root, root);
assert.match(root, /\/tokenproxy-redesign-[^/]+$/);
const db = new DatabaseSync(join(receipt.dataDir, 'db', 'data.sqlite'));
const now = Date.now(), timestamp = delta => new Date(now + delta * 60000).toISOString();
const insert = db.prepare('INSERT OR REPLACE INTO quotaObservations(id,connectionId,provider,scope,source,observationKind,resourceType,unit,remaining,"limit",percentage,observedAt,capturedAt,resetAt,confidence,windowDurationMs,windowType) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
db.exec('BEGIN');
for (const account of ['capacity-fixture-a', 'capacity-fixture-b']) {
  assert.equal(db.prepare('SELECT provider FROM providerConnections WHERE id=?').get(account)?.provider, 'codex');
  for (const [index, scope] of ['hourly', 'weekly', 'monthly', 'spark_hourly', 'spark_weekly', 'spark_monthly'].entries()) {
    for (let point = 0; point < 5; point++) {
      const stamp = timestamp(-21 + point * 5), balance = 100 - point * (index + 1);
      insert.run(`fleet-proof-${account}-${scope}-${point}`, account, 'codex', scope, 'synthetic-fleet-proof', 'observed', 'subscription-quota', 'credits', balance, 100, balance, stamp, stamp, timestamp(180), 'reported', index % 3 === 0 ? 3600000 : index % 3 === 1 ? 604800000 : 2592000000, index === 3 ? 'rolling' : 'fixed');
    }
  }
}
db.exec('COMMIT');
console.log(JSON.stringify({ synthetic: true, source: 'synthetic-fleet-proof', inserted: 60, root, providerCalls: 0 }));
db.close();
