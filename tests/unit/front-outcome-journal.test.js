import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAdapter } from '../../src/lib/db/driver.js';
import { ingestFrontOutcomeJournal, readFrontObservationJournal, startFrontOutcomeJournalIngestion, stopFrontOutcomeJournalIngestion } from '../../src/lib/db/repos/frontOutcomeJournalRepo.js';
import { canStartFrontOutcomeJournal } from '../../src/instrumentation.js';

const CLOCK = '11111111-1111-4111-8111-111111111111';
const INGRESS = '22222222-2222-4222-8222-222222222222';
const LOGICAL = '33333333-3333-4333-8333-333333333333';
const AT = '2026-09-12T12:00:00.000Z';
const AUTH_KEY_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const directories = [];
const db = await getAdapter();

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function defaultKeyring() {
  return { schemaVersion: 1, activeKeyId: AUTH_KEY_ID, keys: { [AUTH_KEY_ID]: Buffer.alloc(32, 7).toString('base64') } };
}

function signed(record, keyring = defaultKeyring()) {
  const unsigned = { ...record, schemaVersion: 2, authKeyId: record.authKeyId || keyring.activeKeyId };
  return { ...unsigned, receiptId: createHmac('sha256', Buffer.from(keyring.keys[unsigned.authKeyId], 'base64'))
    .update(canonicalJson(unsigned)).digest('hex') };
}

function journal(events, activeClock = CLOCK) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-front-outcome-'));
  const directory = path.join(root, 'front-telemetry');
  directories.push(root);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const keyringDirectory = path.join(path.dirname(directory), 'front-telemetry-auth');
  const keyring = defaultKeyring();
  fs.mkdirSync(keyringDirectory, { mode: 0o700 });
  fs.chmodSync(keyringDirectory, 0o700);
  fs.writeFileSync(path.join(keyringDirectory, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const active = signed({ schemaVersion: 2, clockDomain: activeClock, recordedAt: AT }, keyring);
  fs.writeFileSync(path.join(directory, 'active-clock.json'), JSON.stringify(active), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, `private-${activeClock}-00000000.jsonl`), `${events.map((event) => JSON.stringify(signed(event, keyring))).join('\n')}\n`, { mode: 0o600 });
  return directory;
}

function terminal({ clockDomain = CLOCK, state = 'succeeded', total = 20 } = {}) {
  return { schemaVersion: 1, kind: 'terminal', clockDomain, recordedAt: '2026-09-12T12:00:00.020Z',
    frontIngressId: INGRESS, logicalRequestId: LOGICAL, firstObservedAt: AT,
    terminalAt: '2026-09-12T12:00:00.020Z', state, terminalStatus: 200,
    queueDurationMs: 2, preheadersDurationMs: 7, streamDurationMs: 11, endToEndDurationMs: total,
    dataOrigin: 'production', originReceiptId: null };
}

it('validates signed dispatch booleans strictly while preserving legacy absence',()=>{
  for(const value of [true,false,undefined]) {
    const event=terminal();if(value!==undefined)event.backendDispatched=value;
    const directory=journal([event]);
    expect(readFrontObservationJournal({directory,keyringPath:keyringPath(directory)}).segments[0].events[0].backendDispatched).toBe(value);
  }
  for(const value of [null,0,1,'false']) {
    const directory=journal([{...terminal(),backendDispatched:value}]);
    expect(()=>readFrontObservationJournal({directory,keyringPath:keyringPath(directory)})).toThrow('backend dispatch evidence');
  }
});

function segment(directory) {
  return path.join(directory, `private-${CLOCK}-00000000.jsonl`);
}

function keyringPath(directory) {
  return path.join(path.dirname(directory), 'front-telemetry-auth', 'keyring.json');
}

beforeEach(() => {
  for (const table of ['requestTimingSpans', 'frontRequestOutcomes']) db.run(`DELETE FROM ${table}`);
  db.run("DELETE FROM _meta WHERE key LIKE 'frontOutcomeJournal:%'");
});

afterEach(async () => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  await stopFrontOutcomeJournalIngestion();
  vi.useRealTimers();
});

it('is disabled when an operator explicitly selects the null journal seam', async () => {
  expect(await ingestFrontOutcomeJournal({ directory: null })).toEqual({
    enabled: false,
    events: 0,
    segments: 0,
    pendingBytes: 0,
  });
});

it('ingests a linked terminal outcome and its non-overlapping front timings exactly once', async () => {
  const directory = journal([
    { schemaVersion: 1, kind: 'process-start', clockDomain: CLOCK, recordedAt: AT },
    { schemaVersion: 1, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: null, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
    { schemaVersion: 1, kind: 'link', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: LOGICAL },
    { schemaVersion: 1, kind: 'terminal', clockDomain: CLOCK, recordedAt: '2026-09-12T12:00:00.020Z',
      frontIngressId: INGRESS, logicalRequestId: LOGICAL, firstObservedAt: AT,
      terminalAt: '2026-09-12T12:00:00.020Z', state: 'succeeded', terminalStatus: 200,
      queueDurationMs: 2, preheadersDurationMs: 7, streamDurationMs: 11, endToEndDurationMs: 20,
      dataOrigin: 'production', originReceiptId: null },
  ]);

  expect(await ingestFrontOutcomeJournal({ directory })).toMatchObject({
    enabled: true,
    events: 4,
    segments: 1,
    pendingBytes: 0,
    activeClockDomain: CLOCK,
    interrupted: 0,
  });
  expect(db.get('SELECT * FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS])).toMatchObject({
    logicalRequestId: LOGICAL,
    state: 'succeeded',
    queueDurationMs: 2,
    endToEndDurationMs: 20,
    terminalStatus: 200,
    clockDomain: CLOCK,
    dataOrigin: 'production',
  });
  expect(db.all(`SELECT stage,durationMs,relation,clockDomain FROM requestTimingSpans
    WHERE frontIngressId=? ORDER BY ordinal`, [INGRESS])).toEqual([
    { stage: 'queue', durationMs: 2, relation: 'sequential', clockDomain: CLOCK },
    { stage: 'response-headers', durationMs: 7, relation: 'sequential', clockDomain: CLOCK },
    { stage: 'stream', durationMs: 11, relation: 'sequential', clockDomain: CLOCK },
  ]);

  expect(await ingestFrontOutcomeJournal({ directory })).toMatchObject({ events: 0, pendingBytes: 0 });
  expect(db.get('SELECT COUNT(*) AS n FROM requestTimingSpans').n).toBe(3);
});

it('retries a partial final line and only advances its checkpoint after the complete record commits', async () => {
  const directory = journal([
    { schemaVersion: 1, kind: 'process-start', clockDomain: CLOCK, recordedAt: AT },
    { schemaVersion: 1, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: null, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
    { schemaVersion: 1, kind: 'link', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS, logicalRequestId: LOGICAL },
  ]);
  fs.appendFileSync(segment(directory), JSON.stringify(signed(terminal())));

  expect(await ingestFrontOutcomeJournal({ directory })).toMatchObject({ events: 3, pendingBytes: expect.any(Number) });
  expect(db.get('SELECT state FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS]).state).toBe('pending');

  fs.appendFileSync(segment(directory), '\n');
  expect(await ingestFrontOutcomeJournal({ directory })).toMatchObject({ events: 1, pendingBytes: 0 });
  expect(db.get('SELECT state FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS]).state).toBe('succeeded');
});

it('marks pending front work interrupted as soon as the active clock changes', async () => {
  const directory = journal([
    { schemaVersion: 1, kind: 'process-start', clockDomain: CLOCK, recordedAt: AT },
    { schemaVersion: 1, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: null, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
  ]);
  await ingestFrontOutcomeJournal({ directory });
  const nextClock = '44444444-4444-4444-8444-444444444444';
  fs.writeFileSync(path.join(directory, 'active-clock.json'), JSON.stringify(signed({ schemaVersion: 1, clockDomain: nextClock, recordedAt: '2026-09-12T12:01:00.000Z' })), { mode: 0o600 });

  expect(await ingestFrontOutcomeJournal({ directory })).toMatchObject({ events: 0, interrupted: 1, activeClockDomain: nextClock });
  expect(db.get('SELECT state,terminalAt FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS])).toEqual({ state: 'interrupted', terminalAt: '2026-09-12T12:01:00.000Z' });
});

it('interrupts an old-clock start ingested in the same transaction as the active clock', async () => {
  const nextClock = '44444444-4444-4444-8444-444444444444';
  const directory = journal([
    { schemaVersion: 1, kind: 'process-start', clockDomain: CLOCK, recordedAt: AT },
    { schemaVersion: 1, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: null, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
  ], nextClock);

  expect(await ingestFrontOutcomeJournal({ directory })).toMatchObject({ events: 2, interrupted: 1, activeClockDomain: nextClock });
  expect(db.get('SELECT state,terminalAt FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS])).toEqual({ state: 'interrupted', terminalAt: AT });
});

it('allows the producer rounding envelope but rejects material timing drift', async () => {
  const directory = journal([
    { schemaVersion: 1, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: LOGICAL, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
    { ...terminal({ total: 17 }), queueDurationMs: 6, preheadersDurationMs: 7, streamDurationMs: 7 },
  ]);
  await expect(ingestFrontOutcomeJournal({ directory })).resolves.toMatchObject({ events: 2 });

  const inconsistent = journal([
    { schemaVersion: 1, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: LOGICAL, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
    { ...terminal({ total: 16 }), queueDurationMs: 6, preheadersDurationMs: 7, streamDurationMs: 7 },
  ]);
  await expect(ingestFrontOutcomeJournal({ directory: inconsistent })).rejects.toThrow('timing total');
});

it('preserves segment order for a clock domain when wall-clock timestamps move backward', async () => {
  const directory = journal([
    { schemaVersion: 2, kind: 'start', clockDomain: CLOCK, recordedAt: '2026-09-12T12:00:00.020Z', frontIngressId: INGRESS,
      logicalRequestId: LOGICAL, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
    { ...terminal(), recordedAt: '2026-09-12T12:00:00.010Z', terminalAt: '2026-09-12T12:00:00.010Z' },
  ]);

  await expect(ingestFrontOutcomeJournal({ directory })).resolves.toMatchObject({ events: 2, interrupted: 0 });
  expect(db.get('SELECT state FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS])).toMatchObject({ state: 'succeeded' });
});

it('uses one total group order without splitting same-clock records around another clock', async () => {
  const otherClock = '44444444-4444-4444-8444-444444444444';
  const directory = journal([
    { schemaVersion: 2, kind: 'start', clockDomain: CLOCK, recordedAt: '2026-09-12T12:00:00.020Z', frontIngressId: INGRESS,
      logicalRequestId: LOGICAL, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
    { ...terminal(), recordedAt: '2026-09-12T12:00:00.010Z', terminalAt: '2026-09-12T12:00:00.010Z' },
  ]);
  const keyring = JSON.parse(fs.readFileSync(keyringPath(directory), 'utf8'));
  fs.writeFileSync(path.join(directory, `private-${otherClock}-00000000.jsonl`), `${JSON.stringify(signed({ schemaVersion: 2, kind: 'process-start', clockDomain: otherClock, recordedAt: '2026-09-12T12:00:00.015Z' }, keyring))}\n`, { mode: 0o600 });

  await expect(ingestFrontOutcomeJournal({ directory })).resolves.toMatchObject({ events: 3, segments: 2 });
  expect(db.get('SELECT state FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS])).toMatchObject({ state: 'succeeded' });
});

it('retries when active-clock changes during a segment read before it can interrupt old work', async () => {
  const nextClock = '44444444-4444-4444-8444-444444444444';
  const directory = journal([
    { schemaVersion: 2, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: null, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
  ]);
  const keyring = JSON.parse(fs.readFileSync(keyringPath(directory), 'utf8'));
  const activeClock = path.join(directory, 'active-clock.json');
  fs.writeFileSync(activeClock, JSON.stringify(signed({ schemaVersion: 2, clockDomain: nextClock, recordedAt: '2026-09-12T12:01:00.000Z' }, keyring)), { mode: 0o600 });
  const originalOpen = fs.openSync;
  let changed = false;
  const open = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
    const fd = originalOpen(file, ...args);
    if (file === segment(directory) && !changed) {
      changed = true;
      fs.writeFileSync(activeClock, JSON.stringify(signed({ schemaVersion: 2, clockDomain: CLOCK, recordedAt: AT }, keyring)), { mode: 0o600 });
    }
    return fd;
  });
  try {
    await expect(ingestFrontOutcomeJournal({ directory })).resolves.toMatchObject({ activeClockDomain: CLOCK, interrupted: 0 });
  } finally {
    open.mockRestore();
  }
  expect(changed).toBe(true);
  expect(db.get('SELECT state FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS])).toEqual({ state: 'pending' });
});

it('caches authenticated completed segments and invalidates them when the keyring changes', async () => {
  const nextClock = '44444444-4444-4444-8444-444444444444';
  const directory = journal([
    { schemaVersion: 2, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: LOGICAL, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
    terminal(),
  ]);
  const activeSegment = path.join(directory, `private-${nextClock}-00000000.jsonl`);
  const keyring = JSON.parse(fs.readFileSync(keyringPath(directory), 'utf8'));
  fs.writeFileSync(path.join(directory, 'active-clock.json'), JSON.stringify(signed({ schemaVersion: 2, clockDomain: nextClock, recordedAt: '2026-09-12T12:01:00.000Z' }, keyring)), { mode: 0o600 });
  fs.writeFileSync(activeSegment, `${JSON.stringify(signed({ schemaVersion: 2, kind: 'process-start', clockDomain: nextClock, recordedAt: '2026-09-12T12:01:00.000Z' }, keyring))}\n`, { mode: 0o600 });
  const historical = segment(directory);

  await expect(ingestFrontOutcomeJournal({ directory })).resolves.toMatchObject({ events: 3, segments: 2 });
  const open = vi.spyOn(fs, 'openSync');
  await expect(ingestFrontOutcomeJournal({ directory })).resolves.toMatchObject({ events: 0, segments: 0 });
  expect(open.mock.calls.some(([file]) => file === historical)).toBe(false);

  open.mockClear();
  const nextId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  keyring.activeKeyId = nextId;
  keyring.keys[nextId] = Buffer.alloc(32, 9).toString('base64');
  fs.writeFileSync(keyringPath(directory), JSON.stringify(keyring), { mode: 0o600 });
  await expect(ingestFrontOutcomeJournal({ directory })).resolves.toMatchObject({ events: 0, segments: 0 });
  expect(open.mock.calls.some(([file]) => file === historical)).toBe(true);
  open.mockRestore();
});

it('runs an initial and recurring journal import without overlapping a stalled import', async () => {
  vi.useFakeTimers();
  let resolve;
  const first = new Promise((done) => { resolve = done; });
  const ingest = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
  expect(startFrontOutcomeJournalIngestion({ intervalMs: 1000, ingest })).toBe(true);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(ingest).toHaveBeenCalledTimes(1);
  resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ingest).toHaveBeenCalledTimes(2);
});

it('does not arm the database-writing importer during build and static phases', async () => {
  const prior = process.env.NEXT_PHASE;
  const ingest = vi.fn();
  try {
    for (const phase of ['phase-production-build', 'phase-export', 'phase-static']) {
      process.env.NEXT_PHASE = phase;
      expect(canStartFrontOutcomeJournal()).toBe(false);
      expect(startFrontOutcomeJournalIngestion({ ingest })).toBe(false);
    }
    expect(ingest).not.toHaveBeenCalled();
  } finally {
    if (prior === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = prior;
  }
});

it('rejects same-inode consumed-prefix mutation without advancing records or checkpoint', async () => {
  const directory = journal([
    { schemaVersion: 1, kind: 'process-start', clockDomain: CLOCK, recordedAt: AT },
    { schemaVersion: 1, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: null, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
  ]);
  await ingestFrontOutcomeJournal({ directory });
  const saved = db.get("SELECT value FROM _meta WHERE key LIKE 'frontOutcomeJournal:%'").value;
  const file = segment(directory);
  const contents = fs.readFileSync(file);
  contents[0] ^= 1;
  fs.writeFileSync(file, contents, { mode: 0o600 });

  await expect(ingestFrontOutcomeJournal({ directory })).rejects.toThrow('consumed prefix changed');
  expect(db.get('SELECT state FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS]).state).toBe('pending');
  expect(db.get("SELECT value FROM _meta WHERE key LIKE 'frontOutcomeJournal:%'").value).toBe(saved);
});

it('rejects malformed or conflicting complete input before it mutates rows or checkpoints', async () => {
  const directory = journal([
    { schemaVersion: 1, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: LOGICAL, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null },
  ]);
  fs.appendFileSync(segment(directory), `${JSON.stringify(signed(terminal({ total: 15 })))}\n`);

  await expect(ingestFrontOutcomeJournal({ directory })).rejects.toThrow('timing total');
  expect(db.get('SELECT * FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS])).toBeUndefined();
  expect(db.get("SELECT value FROM _meta WHERE key LIKE 'frontOutcomeJournal:%'")).toBeUndefined();
});

it('preserves a front-only terminal failure when the backend never returned a logical identity', async () => {
  const directory = journal([
    { schemaVersion: 1, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: null, firstObservedAt: AT, state: 'pending', dataOrigin: null, originReceiptId: null },
    { ...terminal({ state: 'failed' }), logicalRequestId: null, dataOrigin: null },
  ]);

  await expect(ingestFrontOutcomeJournal({ directory })).resolves.toMatchObject({ events: 2, interrupted: 0 });
  expect(db.get('SELECT logicalRequestId,state,dataOrigin FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS]))
    .toEqual({ logicalRequestId: null, state: 'failed', dataOrigin: 'unknown' });
});

it('rejects journal records with a forged receipt and insecure segment files', async () => {
  const directory = journal([]);
  fs.writeFileSync(segment(directory), '', { mode: 0o600 });
  fs.appendFileSync(segment(directory), `${JSON.stringify({ schemaVersion: 1, kind: 'process-start', clockDomain: CLOCK, recordedAt: AT, receiptId: '0'.repeat(64) })}\n`);
  await expect(ingestFrontOutcomeJournal({ directory })).rejects.toThrow('receipt');

  fs.writeFileSync(segment(directory), '', { mode: 0o644 });
  fs.chmodSync(segment(directory), 0o644);
  await expect(ingestFrontOutcomeJournal({ directory })).rejects.toThrow('mode-0600 regular file');
});

it('verifies recursively canonical HMAC records after an active-key rotation retains their key', async () => {
  const directory = journal([
    { schemaVersion: 2, kind: 'start', clockDomain: CLOCK, recordedAt: AT, frontIngressId: INGRESS,
      logicalRequestId: null, firstObservedAt: AT, state: 'pending', dataOrigin: 'production', originReceiptId: null,
      extension: { z: 1, a: [{ b: true, a: null }] } },
  ]);
  const keyring = JSON.parse(fs.readFileSync(keyringPath(directory), 'utf8'));
  const nextId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  keyring.activeKeyId = nextId;
  keyring.keys[nextId] = Buffer.alloc(32, 9).toString('base64');
  fs.writeFileSync(keyringPath(directory), JSON.stringify(keyring), { mode: 0o600 });

  await expect(ingestFrontOutcomeJournal({ directory })).resolves.toMatchObject({ events: 1, interrupted: 0 });
  expect(db.get('SELECT state FROM frontRequestOutcomes WHERE frontIngressId=?', [INGRESS])).toEqual({ state: 'pending' });
});

it('fails closed for plain SHA, unknown auth keys, malformed keyrings, symlinks, and permissive keyring files', async () => {
  const plainDirectory = journal([]);
  const plain = { schemaVersion: 2, kind: 'process-start', clockDomain: CLOCK, recordedAt: AT, authKeyId: AUTH_KEY_ID };
  plain.receiptId = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(plain).sort().map((key) => [key, plain[key]])))).digest('hex');
  fs.writeFileSync(segment(plainDirectory), `${JSON.stringify(plain)}\n`, { mode: 0o600 });
  await expect(ingestFrontOutcomeJournal({ directory: plainDirectory })).rejects.toThrow('receipt');

  const legacyDirectory = journal([]);
  const legacy = { schemaVersion: 1, kind: 'process-start', clockDomain: CLOCK, recordedAt: AT };
  legacy.receiptId = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(legacy).sort().map((key) => [key, legacy[key]])))).digest('hex');
  fs.writeFileSync(segment(legacyDirectory), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  await expect(ingestFrontOutcomeJournal({ directory: legacyDirectory })).rejects.toThrow('receipt');

  const unknownDirectory = journal([]);
  const unknownId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const unknownKeyring = defaultKeyring();
  unknownKeyring.keys[unknownId] = Buffer.alloc(32, 9).toString('base64');
  const unknown = signed({ schemaVersion: 2, kind: 'process-start', clockDomain: CLOCK, recordedAt: AT, authKeyId: unknownId }, unknownKeyring);
  fs.writeFileSync(segment(unknownDirectory), `${JSON.stringify(unknown)}\n`, { mode: 0o600 });
  await expect(ingestFrontOutcomeJournal({ directory: unknownDirectory })).rejects.toThrow('receipt');

  const malformedDirectory = journal([]);
  fs.writeFileSync(keyringPath(malformedDirectory), '{"schemaVersion":1}', { mode: 0o600 });
  await expect(ingestFrontOutcomeJournal({ directory: malformedDirectory })).rejects.toThrow('journal keyring');

  const symlinkDirectory = journal([]);
  const symlinkKeyring = keyringPath(symlinkDirectory);
  const target = `${symlinkKeyring}.target`;
  fs.renameSync(symlinkKeyring, target);
  fs.symlinkSync(target, symlinkKeyring);
  await expect(ingestFrontOutcomeJournal({ directory: symlinkDirectory })).rejects.toThrow();

  const permissiveDirectory = journal([]);
  fs.chmodSync(keyringPath(permissiveDirectory), 0o644);
  await expect(ingestFrontOutcomeJournal({ directory: permissiveDirectory })).rejects.toThrow('mode-0600 regular file');
});
