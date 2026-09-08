import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = resolve(process.argv[2] || '/tmp/configuration-domains-evidence');
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
const db = new DatabaseSync(join(seeded.root, 'runtime/db/data.sqlite'));
for (const id of ['connection-fixture-alpha', 'connection-fixture-beta']) {
  const account = db.prepare('SELECT provider, data FROM providerConnections WHERE id=?').get(id);
  assert.equal(account.provider, 'openai');
  const data = JSON.parse(account.data);
  for (const key of ['apiKey', 'accessToken', 'refreshToken', 'password']) assert.ok(!data[key]);
  data.maxConcurrent = 2;
  data.providerSpecificData = {
    ...data.providerSpecificData,
    enabledModels: ['gpt-4o', 'gpt-4o-mini'],
  };
  db.prepare('UPDATE providerConnections SET isActive=0, data=? WHERE id=?').run(
    JSON.stringify(data),
    id
  );
}
db.close();
writeFileSync(
  join(artifacts, 'synthetic-seed.json'),
  JSON.stringify(
    {
      ...seeded,
      disabledCredentiallessAccounts: ['connection-fixture-alpha', 'connection-fixture-beta'],
      upstreamCalls: 0,
    },
    null,
    2
  )
);
let started = false;
try {
  launch('start', '--mode', 'dev', '--run', seeded.root);
  started = true;
  execFileSync(
    process.execPath,
    [join(project, 'tests/e2e/configuration-domains-acceptance.mjs'), seeded.root, artifacts],
    { cwd: project, stdio: 'inherit', timeout: 240000 }
  );
} finally {
  if (started)
    writeFileSync(
      join(artifacts, 'stopped.json'),
      JSON.stringify(launch('stop', '--run', seeded.root), null, 2)
    );
}
