import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = resolve(process.argv[2] || '/tmp/bounded-remediation-evidence');
mkdirSync(artifacts, { recursive: true });
const launch = (...args) =>
  JSON.parse(
    execFileSync(process.execPath, [join(project, 'scripts/redesign-preview.mjs'), ...args], {
      cwd: project,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
  );
const seeded = launch('seed', '--mode', 'dev', '--scenario', 'populated');
const marker = JSON.parse(readFileSync(join(seeded.root, 'owner.json'), 'utf8'));
assert.equal(marker.kind, 'tokenproxy-redesign-preview-v1');
assert.equal(marker.root, seeded.root);

// The account this journey authorizes must be selectable, because
// eligibility() refuses an inactive account with 'account_unavailable'
// (src/lib/notifications/remediation.mjs:113). The seed leaves every fixture
// account credentialless AND inactive, so activation here is the synthetic
// precondition, never a credential.
const account = 'connection-fixture-alpha';
const failures = [];
const db = new DatabaseSync(join(seeded.root, 'runtime/db/data.sqlite'));
try {
  db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  const stored = db.prepare('SELECT provider, data FROM providerConnections WHERE id=?').get(account);
  assert.equal(stored.provider, 'openai');
  for (const key of ['apiKey', 'accessToken', 'refreshToken', 'password']) assert.ok(!JSON.parse(stored.data)[key]);
  db.prepare('UPDATE providerConnections SET isActive=1 WHERE id=?').run(account);
  // Retained failed operations for this exact account. These are the rows the
  // alert's evidence refs must resolve to, so the drain path is exercised
  // against real retained records rather than a fabricated reference.
  const insert = db.prepare(`INSERT INTO operationEvents(operationId,phase,state,source,actorClass,subjectKind,subjectId,provider,connectionId,occurredAt,capturedAt,code,details)
    VALUES(?,?,'failed','synthetic-bounded-remediation-fixture','background','connection',?,?,?,?,?,?,?)`);
  for (let index = 0; index < 3; index++) {
    const at = new Date(Date.now() - (180 - index * 20) * 1000).toISOString();
    const result = insert.run(`synthetic-bounded-remediation-${index}`, 'reachability', account, 'openai', account, at, at,
      'synthetic_failed_operation', JSON.stringify({ synthetic: true, reason: 'Injected retained failure for the bounded remediation acceptance.' }));
    failures.push(String(result.lastInsertRowid));
  }
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
writeFileSync(
  join(artifacts, 'synthetic-seed.json'),
  JSON.stringify({ ...seeded, activatedAccount: account, syntheticFailedOperationEventIds: failures, upstreamCalls: 0, providerCalls: 0 }, null, 2)
);
let started = false;
try {
  launch('start', '--mode', 'dev', '--run', seeded.root);
  started = true;
  execFileSync(
    process.execPath,
    [join(project, 'tests/e2e/notification-automation-acceptance.mjs'), seeded.root, artifacts, account, failures.join(',')],
    { cwd: project, stdio: 'inherit', timeout: 600000 }
  );
} finally {
  if (started)
    writeFileSync(
      join(artifacts, 'stopped.json'),
      JSON.stringify(launch('stop', '--run', seeded.root), null, 2)
    );
}
