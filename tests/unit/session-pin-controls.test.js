import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ operator: true, inference: false, loopback: true }));
const runtime = vi.hoisted(() => ({ proxy: 'usable', snapshot: null, onQuota: null }));
vi.mock('@/dashboardGuard', () => ({ hasValidCliToken: async () => auth.operator, isLocalRequest: () => auth.loopback }));
vi.mock('@/lib/auth/dashboardSession', () => ({ verifyDashboardAuthToken: async () => false }));
vi.mock('@/lib/auth/clientApiKey', () => ({ resolveClientApiKey: async () => ({ valid: auth.inference }) }));
vi.mock('@/lib/admin/authzLog.js', () => ({ logAdminAuthz: vi.fn() }));
vi.mock('@/sse/services/quotaGuard.js', () => ({ evaluateQuota: vi.fn(async () => { const hook = runtime.onQuota; runtime.onQuota = null; if (hook) await hook(); return { paused: false, snapshot: runtime.snapshot }; }) }));
vi.mock('@/lib/network/connectionProxy', () => ({ resolveConnectionProxyConfig: async () => ({ kind: runtime.proxy }), toConnectionProxyOptions: () => ({}) }));

import { GET, POST } from '@/app/api/admin/session-pins/[[...path]]/route.js';
import { getAdapter } from '@/lib/db/driver.js';
import { createProviderConnection, updateProviderConnection } from '@/lib/db/repos/connectionsRepo.js';
import { disableModels, enableModels } from '@/lib/db/repos/disabledModelsRepo.js';
import { setPin } from '@/lib/db/repos/sessionAffinityRepo.js';
import { listSessionPins, previewSessionPin, applySessionPin, getSessionPinAction, encodePinId, publicPin } from '@/lib/db/repos/sessionPinsRepo.js';
import { PIN_SELECT, completePinAction } from '@/lib/db/helpers/sessionPinControl.js';
import { createSchedulerRepos } from '@/sse/services/schedulerRepos.js';
import { selectAndReserve } from '@/sse/services/accountScheduler.js';
import { getProviderCredentials } from '@/sse/services/auth.js';
import { leaseRegistry, registerAccountCapacity } from '@/sse/services/accountLeaseRegistry.js';

let db, a, b;
const model = 'claude-fable-5', hash = 'c'.repeat(64), now = Date.now();
const options = { clientHeaders: { 'x-tokenproxy-session-id': 'test-session-explicit' }, clientApiKey: 'synthetic-key-only', cachePrefixDigest: 'f'.repeat(64) };
const pin = () => db.get(PIN_SELECT, [hash, model]);
async function request(path = [], body, query = '') {
  const req = new Request(`http://localhost/api/admin/session-pins${path.length ? `/${path.join('/')}` : ''}${query}`,
    body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const response = await (body === undefined ? GET : POST)(req, { params: Promise.resolve({ path }) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
async function preview(action, extras = {}, at = Date.now()) {
  const row = pin();
  return previewSessionPin({ id: randomUUID(), pinId: encodePinId(row), expectedRevision: publicPin(row).revision, action, ...extras }, { readiness: 'unknown' }, { now: at });
}
const apply = (p, at = Date.now()) => applySessionPin({ id: p.id, expectedRevision: p.expectedRevision }, { now: at });
beforeAll(async () => {
  expect(process.env.DATA_DIR).toMatch(/tokenproxy-test-file-/);
  db = await getAdapter();
  a = await createProviderConnection({ provider: 'claude', authType: 'oauth', name: 'Account A', accessToken: 'secret-test-only', isActive: true });
  b = await createProviderConnection({ provider: 'claude', authType: 'oauth', name: 'Account B', accessToken: 'other-secret-test-only', isActive: true });
});
beforeEach(async () => {
  Object.assign(auth, { operator: true, inference: false, loopback: true });
  Object.assign(runtime, { proxy: 'usable', snapshot: null, onQuota: null });
  db.run('DELETE FROM sessionAffinity'); db.run('DELETE FROM sessionPinActions'); db.run('DELETE FROM accountSwitches');
  await setPin(hash, model, a.id, { now: new Date(now), expiresAt: new Date(now + 86400000).toISOString() });
  await enableModels('claude', [model], b.id);
  await updateProviderConnection(b.id, { lastQuotaSnapshot: null });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No provider calls permitted'); }));
});
afterAll(() => { vi.unstubAllGlobals(); });

it('API preview, apply, receipt and next real selection preserve exact model and existing leases', async () => {
  const admission = await getProviderCredentials('claude', null, model, options);
  expect(admission.connectionId).toBeTruthy();
  const initialAccount = admission.connectionId, target = initialAccount === a.id ? b.id : a.id;
  const rows = await listSessionPins();
  const selectedPin = rows.pins.find(p => p.id !== encodePinId(pin()));
  const packet = { id: randomUUID(), pinId: selectedPin.id, expectedRevision: selectedPin.revision, action: 'reassign', targetConnectionId: target };
  const before = await request(['preview'], packet);
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  expect(before.body.preview).toMatchObject({ modelSubstitution: false, inFlightAffected: false, readiness: 'unknown' });
  expect((await request(['apply'], { id: before.body.id, expectedRevision: before.body.expectedRevision })).body.status).toBe('queued');
  expect(leaseRegistry.inFlight(initialAccount)).toBe(1);
  const next = await getProviderCredentials('claude', null, model, options);
  expect(next.connectionId).toBe(target);
  expect(next.sessionHash).toBe(admission.sessionHash);
  expect(leaseRegistry.inFlight(initialAccount)).toBe(1);
  expect((await request(['actions', before.body.id])).body.status).toBe('applied');
  expect(db.get('SELECT model, toConnectionId, trigger FROM accountSwitches WHERE sessionHash=? ORDER BY rowid DESC LIMIT 1', [admission.sessionHash])).toMatchObject({ model, toConnectionId: target, trigger: 'operator-reassignment' });
  leaseRegistry.release(admission.accountLease); leaseRegistry.release(next.accountLease);
  const stable = await getProviderCredentials('claude', null, model, options);
  expect(stable.connectionId).toBe(target); leaseRegistry.release(stable.accountLease);
  expect(fetch).not.toHaveBeenCalled();
});
it('absolute expiry survives a pin touch and expires at the exact boundary', async () => {
  const deadline = new Date(now + 60000).toISOString();
  const p = await preview('expire', { deadline }, now);
  expect((await apply(p, now)).status).toBe('applied');
  const repos = await createSchedulerRepos({ now: now + 30000 });
  repos.transaction(() => repos.touchPin({ sessionHash: hash, model }));
  expect(pin().expiresAt).toBe(deadline);
  expect((await createSchedulerRepos({ now: now + 60000 })).getPin({ sessionHash: hash, model })).toBeNull();
});
it('a distant operator deadline never extends the existing idle expiry on apply', async () => {
  const previous = pin().expiresAt, deadline = new Date(now + 20 * 86400000).toISOString();
  const p = await preview('expire', { deadline }, now);
  expect((await apply(p, now)).status).toBe('applied');
  expect(pin()).toMatchObject({ expiresAt: previous, operatorExpiresAt: deadline });
  const repos = await createSchedulerRepos({ now: now + 1000 }); repos.touchPin({ sessionHash: hash, model });
  expect(pin().expiresAt).toBe(new Date(now + 86401000).toISOString());
});
it('a legacy no-TTL pin gains an expiry only from the explicitly applied operator deadline', async () => {
  await setPin(hash, model, a.id, { now: new Date(now), expiresAt: null });
  const listed = await listSessionPins();
  expect(listed.pins[0].expiresAt).toBeNull(); expect(pin().expiresAt).toBeNull();
  const deadline = new Date(now + 60000).toISOString();
  const p = await preview('expire', { deadline }, now);
  expect(pin().expiresAt).toBeNull();
  await apply(p, now);
  expect(pin()).toMatchObject({ expiresAt: deadline, operatorExpiresAt: deadline });
});
it('idle expiry advancing makes a preview stale and records the conflict without changing the binding', async () => {
  const p = await preview('clear', {}, now);
  const repos = await createSchedulerRepos({ now: now + 1000 }); repos.touchPin({ sessionHash: hash, model });
  expect((await apply(p, now + 2000)).status).toBe('conflict');
  expect(pin().connectionId).toBe(a.id);
});
it('preview expiry and pin expiry cannot be bypassed by a later apply', async () => {
  const p = await preview('clear', {}, now);
  expect((await apply(p, now + 300000)).reason).toBe('preview_expired');
  db.run('UPDATE sessionAffinity SET expiresAt=?', [new Date(now + 1000).toISOString()]);
  const q = await preview('reassign', { targetConnectionId: b.id }, now);
  expect((await apply(q, now + 1000)).reason).toBe('pin_expired');
});
it('repeated preview and apply are idempotent only for the original payload', async () => {
  const row = pin(), packet = { id: randomUUID(), pinId: encodePinId(row), expectedRevision: publicPin(row).revision, action: 'clear' };
  const p = await previewSessionPin(packet, {});
  expect((await previewSessionPin(packet, {})).id).toBe(p.id);
  await expect(previewSessionPin({ ...packet, action: 'reassign', targetConnectionId: b.id }, {})).rejects.toMatchObject({ code: 'idempotency_conflict' });
  expect((await apply(p)).status).toBe('applied');
  expect((await apply(p)).status).toBe('applied');
  expect(pin()).toBeUndefined();
  expect((await getSessionPinAction(p.id)).before.connectionId).toBe(a.id);
  await expect(applySessionPin({ id: p.id, expectedRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'idempotency_conflict' });
});
it('clear cancels queued reassignment, and later selection can choose the same account', async () => {
  const q = await preview('reassign', { targetConnectionId: b.id }); await apply(q);
  const conflict = await preview('expire', { deadline: new Date(Date.now() + 60000).toISOString() });
  expect(conflict.preview.conflicts).toContainEqual({ connectionId: b.id, reason: 'reassignment-pending' });
  const clear = await preview('clear');
  expect(clear.preview.cancelledActions).toEqual([q.id]);
  await apply(clear);
  expect((await getSessionPinAction(q.id)).status).toBe('cancelled');
  completePinAction(db, { id: q.id, sessionHash: hash, model }, new Date().toISOString());
  expect((await getSessionPinAction(q.id)).status).toBe('cancelled');
  const repos = await createSchedulerRepos();
  const result = selectAndReserve({ sessionHash: hash, model, accounts: [a], registry: leaseRegistry, repos, now: Date.now() });
  expect(result.connection.id).toBe(a.id); leaseRegistry.release(result.lease);
  expect((await getSessionPinAction(q.id)).status).toBe('cancelled');
});
it('pending target at capacity waits, retains the old pin and consumes exactly once after release', async () => {
  const p = await preview('reassign', { targetConnectionId: b.id }); await apply(p);
  registerAccountCapacity(b.id, 1); const oldLease = leaseRegistry.reserve(b.id);
  const repos = await createSchedulerRepos();
  const args = { sessionHash: hash, model, accounts: [a, b], registry: leaseRegistry, repos, now: Date.now() };
  expect(selectAndReserve(args)).toMatchObject({ unavailable: true, mustWait: true });
  expect(pin().connectionId).toBe(a.id); expect((await getSessionPinAction(p.id)).status).toBe('queued');
  leaseRegistry.release(oldLease);
  const [first, second] = await Promise.all([Promise.resolve().then(() => selectAndReserve(args)), Promise.resolve().then(() => selectAndReserve(args))]);
  expect(first.connection.id).toBe(b.id); expect(second.unavailable).toBe(true);
  expect(db.get("SELECT COUNT(*) AS n FROM accountSwitches WHERE trigger='operator-reassignment'").n).toBe(1);
  leaseRegistry.release(first.lease); registerAccountCapacity(b.id, 100);
});
it('command consumption rollback releases reservation and survives a fresh scheduler facade', async () => {
  const p = await preview('reassign', { targetConnectionId: b.id }); await apply(p);
  const repos = await createSchedulerRepos();
  const broken = { ...repos, completePinAction() { throw new Error('audit unavailable'); } };
  expect(() => selectAndReserve({ sessionHash: hash, model, accounts: [a, b], registry: leaseRegistry, repos: broken, now: Date.now() })).toThrow('audit unavailable');
  expect(pin().connectionId).toBe(a.id); expect(leaseRegistry.inFlight(b.id)).toBe(0);
  expect((await getSessionPinAction(p.id)).status).toBe('queued');
  const next = selectAndReserve({ sessionHash: hash, model, accounts: [a, b], registry: leaseRegistry, repos: await createSchedulerRepos(), now: Date.now() });
  expect(next.connection.id).toBe(b.id); leaseRegistry.release(next.lease);
});
it('a replaced binding invalidates an old queued owner without moving the newer pin', async () => {
  const p = await preview('reassign', { targetConnectionId: b.id }); await apply(p);
  await setPin(hash, model, a.id, { now: new Date(now + 100) });
  const repos = await createSchedulerRepos();
  const result = selectAndReserve({ sessionHash: hash, model, accounts: [a, b], registry: leaseRegistry, repos, now: Date.now() });
  expect(result.connection.id).toBe(a.id); leaseRegistry.release(result.lease);
  expect((await getSessionPinAction(p.id)).status).toBe('conflict');
});
it('disabled target and explicit conflicting account never evade the queue or change model', async () => {
  const admission = await getProviderCredentials('claude', null, model, { ...options, preferredConnectionId: a.id });
  leaseRegistry.release(admission.accountLease);
  const row = db.get(PIN_SELECT, [admission.sessionHash, model]);
  const p = await previewSessionPin({ pinId: encodePinId(row), expectedRevision: publicPin(row).revision, action: 'reassign', targetConnectionId: b.id }, {}); await apply(p);
  const conflict = await getProviderCredentials('claude', null, model, { ...options, preferredConnectionId: a.id });
  expect(conflict).toMatchObject({ mustWait: true });
  await disableModels('claude', [model], b.id);
  expect(await getProviderCredentials('claude', null, model, options)).toMatchObject({ mustWait: true });
  expect(db.get(PIN_SELECT, [admission.sessionHash, model]).connectionId).toBe(a.id);
  expect((await getSessionPinAction(p.id)).status).toBe('queued');
});
it.each(['proxy', 'quota'])('pending target cannot consume when %s admission is unavailable', async why => {
  const admission = await getProviderCredentials('claude', null, model, { ...options, preferredConnectionId: a.id }); leaseRegistry.release(admission.accountLease);
  const row = db.get(PIN_SELECT, [admission.sessionHash, model]);
  const p = await previewSessionPin({ pinId: encodePinId(row), expectedRevision: publicPin(row).revision, action: 'reassign', targetConnectionId: b.id }, {}); await apply(p);
  if (why === 'proxy') runtime.proxy = 'unusable';
  else runtime.snapshot = { windows: [{ key: 'weekly (7d)', remainingPercentage: 0, resetAt: new Date(Date.now() + 86400000).toISOString() }] };
  expect(await getProviderCredentials('claude', null, model, options)).toMatchObject({ mustWait: true });
  expect((await getSessionPinAction(p.id)).status).toBe('queued');
  expect(db.get(PIN_SELECT, [admission.sessionHash, model]).connectionId).toBe(a.id);
  expect(leaseRegistry.inFlight(b.id)).toBe(0);
});
it('preview reports a depleted target as a conflict rather than applying healthy-pin leniency', async () => {
  await updateProviderConnection(b.id, { lastQuotaSnapshot: { windows: [{ key: 'weekly (7d)', remainingPercentage: 0, resetAt: new Date(Date.now() + 86400000).toISOString() }] } });
  const row = pin();
  const result = await request(['preview'], { pinId: encodePinId(row), expectedRevision: publicPin(row).revision, action: 'reassign', targetConnectionId: b.id });
  expect(result.status).toBe(200);
  expect(result.body.preview.localTarget).toMatchObject({ connectionId: null, status: 'refused', reason: 'quota-window-excluded' });
  expect(result.body.preview.conflicts).toContainEqual({ connectionId: b.id, reason: 'quota-window-excluded' });
});
it('a command created during quota reads waits for a fresh boundary instead of bypassing its preflight', async () => {
  const admission = await getProviderCredentials('claude', null, model, { ...options, preferredConnectionId: a.id }); leaseRegistry.release(admission.accountLease);
  const row = db.get(PIN_SELECT, [admission.sessionHash, model]); let p;
  runtime.onQuota = async () => { p = await previewSessionPin({ pinId: encodePinId(row), expectedRevision: publicPin(row).revision, action: 'reassign', targetConnectionId: b.id }, {}); await apply(p); };
  expect(await getProviderCredentials('claude', null, model, options)).toMatchObject({ mustWait: true });
  expect((await getSessionPinAction(p.id)).status).toBe('queued');
  expect(db.get(PIN_SELECT, [admission.sessionHash, model]).connectionId).toBe(a.id);
});
it('an explicit identity under a different client namespace does not inherit a queued command', async () => {
  const admission = await getProviderCredentials('claude', null, model, { ...options, preferredConnectionId: a.id }); leaseRegistry.release(admission.accountLease);
  const row = db.get(PIN_SELECT, [admission.sessionHash, model]);
  const p = await previewSessionPin({ pinId: encodePinId(row), expectedRevision: publicPin(row).revision, action: 'reassign', targetConnectionId: b.id }, {}); await apply(p);
  const other = await getProviderCredentials('claude', null, model, { ...options, clientApiKey: 'different-synthetic-key', preferredConnectionId: a.id });
  expect(other.connectionId).toBe(a.id); expect(other.sessionHash).not.toBe(admission.sessionHash); leaseRegistry.release(other.accountLease);
  expect((await getSessionPinAction(p.id)).status).toBe('queued');
});
it('read-only listing and key pagination do not mutate affinity or audit state', async () => {
  await setPin('d'.repeat(64), model, b.id);
  const changes = db.get('SELECT total_changes() AS n').n;
  const page = await listSessionPins({ limit: 1 });
  const next = await listSessionPins({ limit: 1, before: page.next });
  expect(page.pins[0].id).not.toBe(next.pins[0].id); expect(next.next).toBeNull();
  expect(db.get('SELECT total_changes() AS n').n).toBe(changes);
});
it('list joins only an exact stored routing identity and preserves unknown historical requested/served data', async () => {
  db.run("INSERT INTO contextSessions(sessionHash,identitySource,firstSeenAt,lastSeenAt) VALUES(?,'explicit',?,?)", [hash, new Date(now).toISOString(), new Date(now).toISOString()]);
  const sid = db.get('SELECT id FROM contextSessions WHERE sessionHash=?', [hash]).id;
  db.run("INSERT INTO requestStats(id,timestamp,contextSessionId,model,requestedModel,status,connectionId) VALUES('exact-request',?,?,?,?,'success',?)", [new Date(now).toISOString(), sid, model, `cc/${model}`, a.id]);
  const list = await request();
  expect(list.body.pins[0].session).toMatchObject({ id: sid, join: 'stored-routing-hash' });
  expect(list.body.pins[0].requests[0]).toMatchObject({ id: 'exact-request', requestedModel: `cc/${model}`, servedModel: model });
  db.run("UPDATE contextSessions SET identitySource='request' WHERE id=?", [sid]);
  expect((await request()).body.pins[0].session).toBeNull();
  expect((await request()).body.pins[0].requests).toEqual([]);
  expect(JSON.stringify(list.body)).not.toMatch(/secret-test-only|accessToken|refreshToken|raw-session/);
  expect(list.headers.get('cache-control')).toBe('no-store');
});
it.each([[false, false, true, 401], [false, true, true, 403], [true, false, false, 403]])('auth precedes body parsing and persistence %s/%s/%s', async (operator, inference, loopback, expected) => {
  Object.assign(auth, { operator, inference, loopback });
  const changes = db.get('SELECT total_changes() AS n').n;
  expect((await request(['preview'], 'malformed private body')).status).toBe(expected);
  expect(db.get('SELECT total_changes() AS n').n).toBe(changes);
});
it.each(['?limit=0', '?limit=51', '?limit=1&limit=2', '?unknown=1', '?before=bad',
  '?provider=claude&provider=claude', '?provider=', '?connectionId=', '?model=', '?model=' + 'm'.repeat(513),
  '?lastSeenFrom=yesterday', '?lastSeenTo=2026-09-06', '?lastSeenFrom=' + encodeURIComponent(new Date(now).toISOString()) + '&lastSeenFrom=' + encodeURIComponent(new Date(now).toISOString())])('bounds list query %s', async query => {
  expect((await request([], undefined, query)).status).toBe(400);
});
it('scoped filters narrow the list before pagination and keep the cursor stable', async () => {
  await setPin('d'.repeat(64), model, b.id, { now: new Date(now + 5000) });
  await setPin('e'.repeat(64), 'other-model', a.id, { now: new Date(now + 10000) });
  const c = await createProviderConnection({ provider: 'openai', authType: 'api', name: 'Other provider', apiKey: 'unrelated-secret-test-only', isActive: true });
  await setPin('f'.repeat(64), model, c.id, { now: new Date(now + 15000) });
  expect((await request([], undefined, '?provider=claude')).body.pins.map(p => p.connectionId).sort()).toEqual([a.id, a.id, b.id].sort());
  expect((await request([], undefined, `?connectionId=${b.id}`)).body.pins.map(p => p.connectionId)).toEqual([b.id]);
  expect((await request([], undefined, '?model=other-model')).body.pins.map(p => p.model)).toEqual(['other-model']);
  const fromTo = `?lastSeenFrom=${encodeURIComponent(new Date(now + 5000).toISOString())}&lastSeenTo=${encodeURIComponent(new Date(now + 10000).toISOString())}`;
  expect((await request([], undefined, fromTo)).body.pins.map(p => p.lastSeenAt).sort()).toEqual([new Date(now + 5000).toISOString(), new Date(now + 10000).toISOString()]);
  const first = await request([], undefined, '?provider=claude&limit=2');
  expect(first.body.pins).toHaveLength(2); expect(first.body.next).toBeTruthy();
  const second = await request([], undefined, `?provider=claude&limit=2&before=${encodeURIComponent(first.body.next)}`);
  expect(second.body.pins).toHaveLength(1);
  expect(second.body.next).toBeNull();
  const ids = [...first.body.pins, ...second.body.pins].map(p => p.id);
  expect(new Set(ids).size).toBe(3);
  expect([...first.body.pins, ...second.body.pins].every(p => p.provider === 'claude')).toBe(true);
});
it('bounds and sanitizes malformed mutation bodies', async () => {
  expect((await request(['preview'], 'x'.repeat(32769))).status).toBe(413);
  expect((await request(['preview'], { pinId: 'bad', secret: 'hidden' })).status).toBe(400);
  expect((await request(['apply'], { id: 'bad', expectedRevision: 'bad' })).status).toBe(400);
  expect((await request(['apply'], { id: [randomUUID()], expectedRevision: 'a'.repeat(64) })).status).toBe(400);
  expect((await request(['apply'], { id: randomUUID(), expectedRevision: ['a'.repeat(64)] })).status).toBe(400);
  expect((await request(['preview'], { pinId: 'bad', action: 'reassign' })).status).toBe(400);
});
it('rejects a 36-char hex-dash id that is not a canonical UUID', async () => {
  const shifted = 'aaaaaaaa-aaaa-aaaa-aaaaa-aaaaaaaaaaa';
  await expect(getSessionPinAction(shifted)).rejects.toMatchObject({ code: 'invalid_action_id' });
  const row = pin();
  await expect(previewSessionPin({ id: shifted, pinId: encodePinId(row), expectedRevision: publicPin(row).revision, action: 'clear' }, {})).rejects.toMatchObject({ code: 'invalid_action_id' });
  await expect(applySessionPin({ id: shifted, expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'invalid_apply' });
  await expect(applySessionPin({ id: randomUUID(), expectedRevision: 'g'.repeat(64) })).rejects.toMatchObject({ code: 'invalid_apply' });
});
