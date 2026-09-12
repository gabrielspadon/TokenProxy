import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { assembleObservation, sampleObservation } from '../../scripts/qa/observe-production.mjs';
import { signFrontObservation } from '../../src/lib/db/repos/frontOutcomeJournalRepo.js';

const roots = [];
const CLOCK = '11111111-1111-4111-8111-111111111111';
const AT = '2026-09-10T00:00:00.000Z';
const START = '2026-09-10T01:00:00.000Z';
const END = '2026-09-11T01:00:01.000Z';
const KEY_ID = 'a'.repeat(32);
const SECRET = Buffer.alloc(32, 9);
const canon = (value) => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canon).join(',')}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const signed = (record) => {
  const value = { schemaVersion: 2, clockDomain: CLOCK, recordedAt: AT, ...record, authKeyId: KEY_ID };
  return { ...value, receiptId: createHmac('sha256', SECRET).update(canon(value)).digest('hex') };
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(count = 1000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-observation-'));
  roots.push(root);
  const directory = path.join(root, 'journal');
  const auth = path.join(root, 'auth');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(auth, { mode: 0o700 });
  const keyringPath = path.join(auth, 'keyring.json');
  fs.writeFileSync(keyringPath, JSON.stringify({ schemaVersion: 1, activeKeyId: KEY_ID, keys: { [KEY_ID]: SECRET.toString('base64') } }), { mode: 0o600 });
  const active = signed({});
  fs.writeFileSync(path.join(directory, 'active-clock.json'), JSON.stringify(active), { mode: 0o600 });
  const events = [signed({ kind: 'process-start' })];
  const attempts = [];
  for (let i = 0; i < count; i++) {
    const frontIngressId = randomUUID(), logicalRequestId = randomUUID();
    const base = { frontIngressId, firstObservedAt: '2026-09-10T02:00:00.000Z', observationVersion: 1, requestClass: 'inference',
      dataOrigin: 'production', originReceiptId: null, recordedAt: '2026-09-10T02:00:00.000Z' };
    events.push(signed({ ...base, kind: 'start', state: 'pending', logicalRequestId: null }));
    events.push(signed({ ...base, kind: 'link', logicalRequestId }));
    events.push(signed({ ...base, kind: 'terminal', logicalRequestId, state: 'succeeded', terminalStatus: 200,
      terminalAt: base.recordedAt, terminalReason: 'backend-response-complete', queueDurationMs: 0,
      preheadersDurationMs: 0, streamDurationMs: 0, endToEndDurationMs: 0 }));
    attempts.push({ id: randomUUID(), logicalRequestId, attempt: 1, status: 'success', contextTelemetryError: null,
      terminalState: 'succeeded', terminalSource: 'provider-stream', terminalReason: 'stream-complete', terminalObservedAt: base.recordedAt });
  }
  const snapshot = (at, list, rows) => signFrontObservation({ schemaVersion: 1, kind: 'production-observation',
    releaseId: 'b'.repeat(64), captureStartedAt: at, captureEndedAt: at, active,
    monotonicStartedMs: Date.parse(at) - Date.parse(AT), monotonicEndedMs: Date.parse(at) - Date.parse(AT),
    status: { ready: true, public_ready: true, journal_healthy: true, terminal_counts: { success: list.filter((row) => row.kind === 'terminal').length },
      terminal_window_started_at: AT, observation_monotonic_ms: Date.parse(at) - Date.parse(AT), backend_build_sha: 'c'.repeat(40) },
    segments: [{ name: `private-${CLOCK}-00000000.jsonl`, bytes: 1, sha256: 'd'.repeat(64), pendingBytes: 0, events: list }], attempts: rows }, keyringPath);
  return { root, directory, keyringPath, events, attempts, snapshot,
    begin: snapshot(START, events.slice(0, 1), []), end: snapshot(END, events, attempts) };
}

it('qualifies 24 hours and 1000 natural logical requests exactly once from signed joined evidence', () => {
  const f = fixture();
  const result = assembleObservation(f);
  expect(result.outcomeGatePassed).toBe(true);
  expect(result.counts).toEqual({ naturalLogicalRequests: 1000, success: 1000, providerFailure: 0, proxyFailure: 0, callerCancellation: 0, unknown: 0 });
  expect(result.liveQualificationComplete).toBe(false);
  expect(JSON.stringify(result)).not.toContain(SECRET.toString('base64'));
});

it.each([
  ['provider-stream', 'upstream-error-event'],
  ['provider-json', 'upstream-error-response'],
  ['provider-http', 'upstream-http-error'],
])('separates signed %s failures from successful requests', (terminalSource, terminalReason) => {
  const f = fixture();
  Object.assign(f.attempts[0], { status: 'error', terminalState: 'failed', terminalSource, terminalReason });
  f.end = f.snapshot(END, f.events, f.attempts);
  const result = assembleObservation(f);
  expect(result.counts).toMatchObject({ naturalLogicalRequests: 1000, success: 999, providerFailure: 1, proxyFailure: 0 });
  expect(result.outcomeGatePassed).toBe(true);
});

it('does not let missing terminal proof, duplicate attempt ordinal or unsigned edits pass', () => {
  const f = fixture();
  f.attempts[0].terminalReason = null;
  f.end = f.snapshot(END, f.events, f.attempts);
  expect(assembleObservation(f)).toMatchObject({ outcomeGatePassed: false, counts: { unknown: 1 } });
  f.attempts.push({ ...f.attempts[1], id: randomUUID() });
  f.end = f.snapshot(END, f.events, f.attempts);
  expect(assembleObservation(f).counts.unknown).toBe(2);
  f.end.attempts[0].terminalReason = 'stream-complete';
  expect(() => assembleObservation(f)).toThrow('receipt');
});

it('preserves frontend-only failures, uses a strict 0.1 percent limit and excludes catalog traffic', () => {
  const f = fixture();
  const row = { ...f.events[3], logicalRequestId: null, state: 'failed', terminalStatus: 503, terminalReason: 'admission-timeout' };
  delete row.receiptId;
  f.events.splice(2, 2, signed(row));
  f.end = f.snapshot(END, f.events, f.attempts);
  expect(assembleObservation(f)).toMatchObject({ outcomeGatePassed: false, counts: { proxyFailure: 1 }, proxyFailureRate: 0.001 });
  const ingress = f.events[4].frontIngressId;
  f.events = f.events.map((event) => {
    if (event.frontIngressId !== ingress) return event;
    const replacement = { ...event, requestClass: 'discovery' }; delete replacement.receiptId;
    return signed(replacement);
  });
  f.end = f.snapshot(END, f.events, f.attempts);
  expect(assembleObservation(f)).toMatchObject({ exclusions: { nonInference: 1 }, counts: { naturalLogicalRequests: 999 } });
});

it('rejects journal deletion, partial tails, counter mismatches and process restart', () => {
  const f = fixture(1);
  f.end.status.terminal_counts.success++;
  f.end = signFrontObservation(f.end, f.keyringPath);
  expect(() => assembleObservation(f)).toThrow('counter coverage');
  f.end = f.snapshot(END, f.events, f.attempts);
  f.end.segments[0].pendingBytes = 10;
  f.end = signFrontObservation(f.end, f.keyringPath);
  expect(() => assembleObservation(f)).toThrow('partial journal tail');
  f.end = f.snapshot(END, f.events, f.attempts);
  f.end.status.terminal_window_started_at = START;
  f.end = signFrontObservation(f.end, f.keyringPath);
  expect(() => assembleObservation(f)).toThrow('process changed');
});

it('cannot satisfy 24 hours by moving the wall clock forward', () => {
  const f = fixture(1);
  f.end.monotonicStartedMs = f.begin.monotonicEndedMs + 5000;
  f.end.monotonicEndedMs = f.end.monotonicStartedMs;
  f.end = signFrontObservation(f.end, f.keyringPath);
  expect(() => assembleObservation(f)).toThrow('clock discontinuity');
});

it('samples a read-only database and signs the exact joined scalar rows', async () => {
  const f = fixture(1);
  fs.writeFileSync(path.join(f.directory, `private-${CLOCK}-00000000.jsonl`), `${f.events.map(JSON.stringify).join('\n')}\n`, { mode: 0o600 });
  const databasePath = path.join(f.root, 'fixture.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE requestStats(id,logicalRequestId,attempt,status,contextTelemetryError,terminalState,terminalReason,terminalSource,terminalObservedAt)`);
  const row = f.attempts[0];
  db.prepare('INSERT INTO requestStats VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, row.logicalRequestId, row.attempt, row.status, null, row.terminalState, row.terminalReason, row.terminalSource, row.terminalObservedAt);
  db.close();
  const before = fs.readFileSync(databasePath);
  const result = await sampleObservation({ ...f, databasePath, driver: 'node:sqlite', releaseId: f.end.releaseId,
    readStatus: async () => f.end.status, now: () => END });
  expect(result.attempts).toEqual(f.attempts);
  expect(fs.readFileSync(databasePath)).toEqual(before);
  expect(assembleObservation({ ...f, end: result }).counts.success).toBe(1);
});
