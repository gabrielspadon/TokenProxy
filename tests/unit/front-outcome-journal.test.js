import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAdapter } from '../../src/lib/db/driver.js';
import { ingestFrontOutcomeJournal, startFrontOutcomeJournalIngestion, stopFrontOutcomeJournalIngestion } from '../../src/lib/db/repos/frontOutcomeJournalRepo.js';
import { canStartFrontOutcomeJournal } from '../../src/instrumentation.js';

const CLOCK = '11111111-1111-4111-8111-111111111111';
const INGRESS = '22222222-2222-4222-8222-222222222222';
const LOGICAL = '33333333-3333-4333-8333-333333333333';
const AT = '2026-09-12T12:00:00.000Z';
const directories = [];
const db = await getAdapter();

function signed(record) {
  const canonical = Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  return { ...record, receiptId: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}

function journal(events, activeClock = CLOCK) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-front-outcome-'));
  directories.push(directory);
  fs.chmodSync(directory, 0o700);
  const active = signed({ schemaVersion: 1, clockDomain: activeClock, recordedAt: AT });
  fs.writeFileSync(path.join(directory, 'active-clock.json'), JSON.stringify(active), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, `private-${activeClock}-00000000.jsonl`), `${events.map((event) => JSON.stringify(signed(event))).join('\n')}\n`, { mode: 0o600 });
  return directory;
}

function terminal({ clockDomain = CLOCK, state = 'succeeded', total = 20 } = {}) {
  return { schemaVersion: 1, kind: 'terminal', clockDomain, recordedAt: '2026-09-12T12:00:00.020Z',
    frontIngressId: INGRESS, logicalRequestId: LOGICAL, firstObservedAt: AT,
    terminalAt: '2026-09-12T12:00:00.020Z', state, terminalStatus: 200,
    queueDurationMs: 2, preheadersDurationMs: 7, streamDurationMs: 11, endToEndDurationMs: total,
    dataOrigin: 'production', originReceiptId: null };
}

function segment(directory) {
  return path.join(directory, `private-${CLOCK}-00000000.jsonl`);
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
