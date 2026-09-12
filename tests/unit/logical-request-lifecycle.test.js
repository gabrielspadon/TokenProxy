import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { getAdapter } from '../../src/lib/db/driver.js';
import { REQUEST_TERMINAL_COLUMNS } from '../../src/lib/db/terminalEvidence.js';
import { saveRequestStats } from '../../src/lib/db/repos/requestStatsRepo.js';
import { createLogicalOutcomeStore } from '../../src/lib/db/repos/logicalRequestOutcomeRepo.js';
import { getRequestIdentity } from '../../src/sse/services/requestIdentity.js';
import { withLogicalRequestLifecycle } from '../../src/sse/services/logicalRequestLifecycle.js';
import { backendClock, ownerIsDead } from '../../src/sse/services/processClock.js';
import { handleChat } from '../../src/sse/handlers/chat.js';

let db, store;
beforeAll(async () => {
  db = await getAdapter();
  const columns = new Set(db.all('PRAGMA table_info(requestStats)').map((row) => row.name));
  for (const column of Object.keys(REQUEST_TERMINAL_COLUMNS)) expect(columns.has(column)).toBe(true);
  store = createLogicalOutcomeStore(db);
});
const request = () => new Request('http://localhost/v1/chat/completions', { method: 'POST', body: '{}' });
const read = (req) => db.get('SELECT * FROM logicalRequestOutcomes WHERE logicalRequestId=?', [getRequestIdentity(req).logicalRequestId]);
function attempt(req, status = 'success', proof = { state: 'succeeded', reason: 'json-complete', source: 'provider-json' }) {
  const identity = getRequestIdentity(req);
  return saveRequestStats({ id: randomUUID(), status, terminalEvidence: proof,
    contextTelemetry: { logicalRequestId: identity.logicalRequestId, attempt: identity.nextAttempt(), sessionHash: 'a'.repeat(64) } });
}
const wrap = (req, run) => withLogicalRequestLifecycle(req, run, { storeFactory: async () => store });

it('persists one logical terminal after body EOF and all durable attempt writes', async () => {
  const req = request();
  const response = await wrap(req, async () => {
    await attempt(req, 'error', { state: 'failed', source: 'provider-http', reason: 'upstream-http-error' });
    void attempt(req);
    return new Response('complete');
  });
  expect(read(req).state).toBe('pending');
  expect(response.headers.get('x-tokenproxy-logical-request-id')).toBe(getRequestIdentity(req).logicalRequestId);
  await response.text();
  expect(read(req)).toMatchObject({ state: 'succeeded', attemptCount: 2, terminalStatus: 200, durationSource: 'backend-monotonic' });
  expect(read(req).endToEndDurationMs).toBeGreaterThanOrEqual(0);
  const spans = db.all('SELECT stage,durationMs,relation FROM requestTimingSpans WHERE logicalRequestId=? ORDER BY ordinal', [read(req).logicalRequestId]);
  expect(spans.map((span) => span.stage)).toEqual(['response-headers', 'stream']);
  expect(spans.reduce((sum, span) => sum + span.durationMs, 0)).toBeCloseTo(read(req).endToEndDurationMs, 5);
});

it('preserves one identity and outcome across a reentrant request wrapper', async () => {
  const req = request();
  const response = await wrap(req, () => wrap(req, async () => { await attempt(req); return new Response('done'); }));
  await response.text();
  expect(read(req)).toMatchObject({ state: 'succeeded', attemptCount: 1 });
  expect(db.get('SELECT COUNT(*) AS n FROM logicalRequestOutcomes WHERE logicalRequestId=?', [read(req).logicalRequestId]).n).toBe(1);
});

it.each([
  ['failed', 'error', { state: 'failed', source: 'provider-stream', reason: 'upstream-error-event' }],
  ['unknown', 'unknown', { state: 'unknown', source: 'gateway-stream', reason: 'unsupported-terminal' }],
])('does not infer success from HTTP200 when semantic state is %s', async (state, status, proof) => {
  const req = request();
  const response = await wrap(req, async () => { await attempt(req, status, proof); return new Response('partial'); });
  await response.text();
  expect(read(req)).toMatchObject({ state, terminalStatus: 200, attemptCount: 1 });
});

it('keeps competing successful attempts ambiguous instead of selecting the last one', async () => {
  const req = request();
  const response = await wrap(req, async () => { await attempt(req); await attempt(req); return new Response('combined'); });
  await response.text();
  expect(read(req).state).toBe('unknown');
});

it('records caller cancellation once and releases pending attempt debt', async () => {
  const req = request();
  const response = await wrap(req, async () => {
    await attempt(req, 'pending', null);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); } }));
  });
  await response.body.cancel();
  expect(read(req)).toMatchObject({ state: 'cancelled', attemptCount: 1 });
  expect(db.get('SELECT COUNT(*) AS n FROM requestStats WHERE logicalRequestId=? AND status=?', [read(req).logicalRequestId, 'pending']).n).toBe(0);
});

it('records body interruption without converting it into semantic success', async () => {
  const req = request();
  const response = await wrap(req, async () => {
    await attempt(req, 'pending', null);
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture reset')); } }));
  });
  await expect(response.text()).rejects.toThrow('fixture reset');
  expect(read(req)).toMatchObject({ state: 'interrupted', attemptCount: 1 });
});

it('gives managed early local refusals a server logical identity before dispatch', async () => {
  const req = new Request('http://localhost/v1/chat/completions', { method: 'POST', body: 'invalid-json',
    headers: { 'content-type': 'application/json', 'x-tokenproxy-logical-request-id': 'caller-forged' } });
  const response = await handleChat(req);
  await response.text();
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
  expect(response.headers.get('x-tokenproxy-logical-request-id')).toBe(getRequestIdentity(req).logicalRequestId);
  expect(read(req)).toMatchObject({ state: 'failed', attemptCount: 0, terminalStatus: response.status });
});

it('reconciles only provably dead process clocks and preserves live pending owners', () => {
  const deadClock = { ...backendClock, clockDomain: randomUUID() }, liveClock = { ...backendClock, clockDomain: randomUUID() };
  const previous = createLogicalOutcomeStore(db, { clock: deadClock, dead: () => false });
  const old = previous.begin(randomUUID());
  const active = createLogicalOutcomeStore(db, { clock: liveClock, dead: () => false }).begin(randomUUID());
  createLogicalOutcomeStore(db, { clock: { ...backendClock, clockDomain: randomUUID() }, dead: (owner) => owner.clockDomain === deadClock.clockDomain }).initialize();
  expect(db.get('SELECT state,durationSource FROM logicalRequestOutcomes WHERE logicalRequestId=?', [old.logicalRequestId]))
    .toEqual({ state: 'interrupted', durationSource: 'unknown' });
  expect(db.get('SELECT state FROM logicalRequestOutcomes WHERE logicalRequestId=?', [active.logicalRequestId]).state).toBe('pending');
});

it('checks host, boot and process start identity before declaring an owner dead', () => {
  const current = { hostname: 'fixture', pid: 123, bootId: 'boot-new', startTicks: '20' };
  const owner = { ...current, startTicks: '10' };
  expect(ownerIsDead(owner, current, () => '20', () => {})).toBe(true);
  expect(ownerIsDead({ ...owner, hostname: 'other' }, current, () => '20', () => {})).toBe(false);
  expect(ownerIsDead({ ...owner, bootId: 'boot-old' }, current, () => null, () => {})).toBe(true);
  expect(ownerIsDead(owner, current, () => null, () => { throw Object.assign(new Error(), { code: 'EPERM' }); })).toBe(false);
  expect(ownerIsDead(owner, current, () => null, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); })).toBe(true);
});
