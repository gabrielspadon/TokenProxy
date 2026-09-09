import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

// Read-only application verification. Authentication changes only its session.
const root = await realpath(process.argv[2]);
const json = async name => JSON.parse(await readFile(join(root, name), 'utf8'));
const [owner, run, auth, seed] = await Promise.all(['owner.json', 'process.json', 'preview-auth.json', 'seed-receipt.json'].map(json));
assert.equal(owner.kind, 'tokenproxy-redesign-preview-v1');
assert.equal(owner.root, root);
assert.equal(owner.runId, run.runId);
assert.match(run.url, /^http:\/\/127\.0\.0\.1:\d+$/);
// A dev preview only gets `routeTable` once redesign-preview.mjs proved a deep dynamic
// route resolves. Without it the 200 assertions below are probing a possibly truncated
// route table, and their failure would read as a broken handler instead.
if (run.mode === 'dev') assert.ok(run.routeTable?.canaryStatus, 'dev process.json carries no routeTable receipt; start it through scripts/redesign-preview.mjs so the route-table probe runs');
const identity = async () => {
  const response = await fetch(`${run.url}/__redesign_owner`, { headers: { 'x-redesign-owner': auth.ownerToken }, signal: AbortSignal.timeout(5000) });
  const value = await response.json();
  assert.equal(value.runId, run.runId);
  assert.equal(value.pid, run.pid);
  return value;
};
await identity();
const login = await fetch(`${run.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: auth.initialPassword }), signal: AbortSignal.timeout(45000) });
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const results = [];
let accounts;
const paths = ['/api/providers', '/api/admin/health/detail', '/api/admin/quota', '/api/admin/models', '/api/context?period=24h', '/api/analytics?view=activity&groupBy=account&pageSize=50', '/api/analytics?view=economics&groupBy=account&pageSize=50'];
if (seed.routing?.sessionId) paths.push(`/api/context/sessions/${seed.routing.sessionId}?page=1&pageSize=25`);
for (const path of paths) {
  const response = await fetch(`${run.url}${path}`, { headers: { cookie }, signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('x-tokenproxy-preview-version'), run.fixtureVersion);
  const data = await response.json();
  if (path === '/api/providers') accounts = data.connections;
  results.push({ path, status: response.status, responseKeys: Object.keys(data) });
}
assert.equal(accounts.length, seed.accounts);
const live = await identity();
const receipt = { version: 'redesign-preview-read-v1', runId: run.runId, mode: run.mode, url: run.url, dataDir: run.dataDir || join(root, 'runtime'), fixtureVersion: run.fixtureVersion, clock: run.clock, sourceManifestHash: run.sourceManifestHash, sourceAttribution: run.sourceAttribution, recordedAt: new Date().toISOString(), accountCount: accounts.length, enabledCount: accounts.filter(account => account.isActive).length, providers: [...new Set(accounts.map(account => account.provider))], results, guard: live.guard, dataSource: 'actual authenticated application handlers reading disposable retained SQLite; no presentation interception', providerHealth: 'Qualification and entitlement remain unknown unless explicitly reported as synthetic evidence.', browserInspected: false };
await writeFile(join(root, 'preview-verification.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
