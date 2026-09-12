import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../dataDir.js';
import { getAdapter } from '../driver.js';
import { registerShutdownFlusher } from '../../shutdown.js';

const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024;
const DEFAULT_IMPORT_INTERVAL_MS = 5_000;
const MIN_IMPORT_INTERVAL_MS = 1_000;
const MAX_IMPORT_INTERVAL_MS = 60_000;
// Match the front writer's UUID grammar.  The backend owns logical IDs and
// can move to a newer UUID version without making valid front evidence unreadable.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIPT = /^[a-f0-9]{64}$/;
const ORIGINS = new Set(['production', 'test', 'import', 'unknown']);
const STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);
// The front namespaces each rotated segment with its active clock domain.
// The numeric-only form remains readable for the earliest draft fixture.
const SEGMENT = /^private-(?:[0-9]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9]{8})\.jsonl$/i;

function fail(message) {
  throw new Error(`Invalid front outcome journal: ${message}`);
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isFlatRecord(value) {
  return value && !Array.isArray(value) && typeof value === 'object'
    && Object.values(value).every((item) => item === null || ['string', 'boolean'].includes(typeof item)
      || (typeof item === 'number' && Number.isFinite(item)));
}

function canonicalReceipt(record) {
  const copy = { ...record };
  delete copy.receiptId;
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(copy).sort().map((key) => [key, copy[key]])))).digest('hex');
}

function assertReceipt(record, label) {
  if (!isFlatRecord(record) || !RECEIPT.test(record.receiptId || '') || canonicalReceipt(record) !== record.receiptId) fail(`${label} receipt`);
}

function assertBase(record, label) {
  assertReceipt(record, label);
  if (record.schemaVersion !== 1 || !UUID.test(record.clockDomain || '') || !isTimestamp(record.recordedAt)) fail(`${label} envelope`);
}

function assertId(value, label, nullable = false) {
  if ((nullable && value === null) || UUID.test(value || '')) return;
  fail(label);
}

function assertOrigin(record, label) {
  if ((record.dataOrigin !== null && !ORIGINS.has(record.dataOrigin)) || (record.originReceiptId !== null && !RECEIPT.test(record.originReceiptId || ''))) fail(`${label} origin`);
}

function duration(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(label);
  return value;
}

function validateEvent(record, label) {
  assertBase(record, label);
  if (record.kind === 'process-start') return { type: 'process-start', record };
  assertId(record.frontIngressId, `${label} frontIngressId`);
  if (record.kind === 'start') {
    assertId(record.logicalRequestId, `${label} logicalRequestId`, true);
    if (record.state !== 'pending' || !isTimestamp(record.firstObservedAt)) fail(`${label} start state`);
    assertOrigin(record, label);
    return { type: 'start', record: { ...record, dataOrigin: record.dataOrigin ?? 'unknown' } };
  }
  if (record.kind === 'link') {
    assertId(record.logicalRequestId, `${label} logicalRequestId`);
    return { type: 'link', record };
  }
  if (record.kind === 'terminal') {
    assertId(record.logicalRequestId, `${label} logicalRequestId`, true);
    if (!STATES.has(record.state) || !isTimestamp(record.firstObservedAt) || !isTimestamp(record.terminalAt)
      || (record.terminalStatus !== null && (!Number.isInteger(record.terminalStatus) || record.terminalStatus < 100 || record.terminalStatus > 599))) fail(`${label} terminal state`);
    assertOrigin(record, label);
    const total = duration(record.endToEndDurationMs, `${label} end-to-end duration`);
    const queue = duration(record.queueDurationMs, `${label} queue duration`);
    const headers = duration(record.preheadersDurationMs, `${label} response header duration`);
    const stream = duration(record.streamDurationMs, `${label} stream duration`);
    // Every producer value is independently rounded from a monotonic clock.
    // Three adjacent rounded spans may differ from the rounded wall total by
    // at most 3 ms without changing their non-overlap meaning.
    if (Math.abs(queue + headers + stream - total) > 3) fail(`${label} timing total`);
    return { type: 'terminal', record: { ...record, dataOrigin: record.dataOrigin ?? 'unknown' } };
  }
  fail(`${label} kind`);
}

function openOwnedRegular(file, label) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SEGMENT_BYTES || (stat.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail(`${label} must be an owned mode-0600 regular file`);
    return { fd, stat };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw error;
  }
}

function readOwnedFile(file, label) {
  const { fd, stat } = openOwnedRegular(file, label);
  try {
    const content = Buffer.alloc(stat.size);
    let read = 0;
    while (read < content.length) {
      const count = fs.readSync(fd, content, read, content.length - read, read);
      if (!count) break;
      read += count;
    }
    if (read !== content.length) fail(`${label} changed during read`);
    return { content, stat };
  } finally {
    fs.closeSync(fd);
  }
}

function checkpointKey(directory, name) {
  return `frontOutcomeJournal:v1:${createHash('sha256').update(directory).digest('hex')}:${name}`;
}

function parseActiveClock(directory) {
  const { content } = readOwnedFile(path.join(directory, 'active-clock.json'), 'active clock');
  let active;
  try { active = JSON.parse(content.toString('utf8')); } catch { fail('active clock JSON'); }
  assertBase(active, 'active clock');
  if (Object.keys(active).some((key) => !['schemaVersion', 'clockDomain', 'recordedAt', 'receiptId'].includes(key))) fail('active clock fields');
  return active;
}

function readSegment(directory, name, checkpoint) {
  const { content, stat } = readOwnedFile(path.join(directory, name), `segment ${name}`);
  const offset = checkpoint && checkpoint.dev === stat.dev && checkpoint.ino === stat.ino ? checkpoint.offset : 0;
  if (offset > content.length) fail(`segment ${name} shrank without rotation`);
  const pending = content.subarray(offset);
  const lastNewline = pending.lastIndexOf(0x0a);
  const completeLength = lastNewline < 0 ? 0 : lastNewline + 1;
  const events = [];
  let cursor = 0;
  while (cursor < completeLength) {
    const newline = pending.indexOf(0x0a, cursor);
    const line = pending.subarray(cursor, newline);
    if (!line.length || line.length > MAX_LINE_BYTES) fail(`segment ${name} line`);
    let value;
    try { value = JSON.parse(line.toString('utf8')); } catch { fail(`segment ${name} JSON`); }
    events.push(validateEvent(value, `segment ${name}`));
    cursor = newline + 1;
  }
  return { stat, events, nextOffset: offset + completeLength, pendingBytes: pending.length - completeLength };
}

function same(value, expected) {
  return (value ?? null) === (expected ?? null);
}

function collectOperations(db, active, segmentData) {
  const rows = new Map(db.all('SELECT * FROM frontRequestOutcomes').map((row) => [row.frontIngressId, { ...row }]));
  const logical = new Map(db.all('SELECT frontIngressId,logicalRequestId FROM frontRequestOutcomes WHERE logicalRequestId IS NOT NULL')
    .map((row) => [row.logicalRequestId, row.frontIngressId]));
  const operations = [];
  const ordered = segmentData.flatMap(({ name, events }) => events.map((event, ordinal) => ({ event, name, ordinal })))
    .sort((a, b) => a.event.record.recordedAt.localeCompare(b.event.record.recordedAt)
      || a.name.localeCompare(b.name) || a.ordinal - b.ordinal);
  for (const { event } of ordered) {
    const record = event.record;
    if (event.type === 'process-start') continue;
    const current = rows.get(record.frontIngressId);
    if (event.type === 'start') {
      if (current) {
        if (current.state !== 'pending' || !same(current.clockDomain, record.clockDomain) || !same(current.firstObservedAt, record.firstObservedAt)
          || !same(current.logicalRequestId, record.logicalRequestId) || !same(current.dataOrigin, record.dataOrigin) || !same(current.originReceiptId, record.originReceiptId)) fail(`conflicting start ${record.frontIngressId}`);
      } else {
        if (record.logicalRequestId && logical.has(record.logicalRequestId)) fail(`logical request already linked ${record.logicalRequestId}`);
        const row = { frontIngressId: record.frontIngressId, logicalRequestId: record.logicalRequestId, state: 'pending', firstObservedAt: record.firstObservedAt,
          terminalAt: null, queueDurationMs: null, endToEndDurationMs: null, terminalStatus: null, clockDomain: record.clockDomain,
          receiptId: record.receiptId, dataOrigin: record.dataOrigin, originReceiptId: record.originReceiptId, updatedAt: record.recordedAt };
        rows.set(row.frontIngressId, row);
        if (row.logicalRequestId) logical.set(row.logicalRequestId, row.frontIngressId);
        operations.push({ type: 'start', row });
      }
      continue;
    }
    if (!current) fail(`${event.type} without start ${record.frontIngressId}`);
    if (event.type === 'link') {
      if (current.logicalRequestId && current.logicalRequestId !== record.logicalRequestId) fail(`conflicting link ${record.frontIngressId}`);
      const linked = logical.get(record.logicalRequestId);
      if (linked && linked !== record.frontIngressId) fail(`logical request already linked ${record.logicalRequestId}`);
      if (!current.logicalRequestId) {
        current.logicalRequestId = record.logicalRequestId;
        current.receiptId = record.receiptId;
        current.updatedAt = record.recordedAt;
        logical.set(record.logicalRequestId, record.frontIngressId);
        operations.push({ type: 'link', row: { ...current } });
      }
      continue;
    }
    if (current.logicalRequestId !== record.logicalRequestId || current.state !== 'pending' || !same(current.clockDomain, record.clockDomain)
      || !same(current.firstObservedAt, record.firstObservedAt) || !same(current.dataOrigin, record.dataOrigin) || !same(current.originReceiptId, record.originReceiptId)) fail(`conflicting terminal ${record.frontIngressId}`);
    current.state = record.state;
    current.terminalAt = record.terminalAt;
    current.queueDurationMs = record.queueDurationMs;
    current.endToEndDurationMs = record.endToEndDurationMs;
    current.terminalStatus = record.terminalStatus;
    current.receiptId = record.receiptId;
    current.updatedAt = record.recordedAt;
    operations.push({ type: 'terminal', row: { ...current }, record });
  }
  return operations;
}

function writeOperations(db, active, operations) {
  for (const operation of operations) {
    const row = operation.row;
    if (operation.type === 'start') db.run(`INSERT INTO frontRequestOutcomes(frontIngressId,logicalRequestId,state,firstObservedAt,terminalAt,queueDurationMs,endToEndDurationMs,terminalStatus,clockDomain,receiptId,dataOrigin,originReceiptId,updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [row.frontIngressId, row.logicalRequestId, row.state, row.firstObservedAt, row.terminalAt, row.queueDurationMs, row.endToEndDurationMs, row.terminalStatus, row.clockDomain, row.receiptId, row.dataOrigin, row.originReceiptId, row.updatedAt]);
    if (operation.type === 'link') db.run('UPDATE frontRequestOutcomes SET logicalRequestId=?,receiptId=?,updatedAt=? WHERE frontIngressId=?', [row.logicalRequestId, row.receiptId, row.updatedAt, row.frontIngressId]);
    if (operation.type === 'terminal') {
      db.run(`UPDATE frontRequestOutcomes SET state=?,terminalAt=?,queueDurationMs=?,endToEndDurationMs=?,terminalStatus=?,receiptId=?,updatedAt=? WHERE frontIngressId=?`,
        [row.state, row.terminalAt, row.queueDurationMs, row.endToEndDurationMs, row.terminalStatus, row.receiptId, row.updatedAt, row.frontIngressId]);
      const spans = [['queue', operation.record.queueDurationMs], ['response-headers', operation.record.preheadersDurationMs], ['stream', operation.record.streamDurationMs]];
      for (const [ordinal, [stage, durationMs]] of spans.entries()) db.run(`INSERT INTO requestTimingSpans(id,logicalRequestId,attemptRequestId,frontIngressId,processRole,stage,ordinal,relation,clockDomain,durationMs,outcome,recordedAt,dataOrigin,originReceiptId)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, [createHash('sha256').update(`${row.receiptId}:${stage}`).digest('hex'), row.logicalRequestId, null, row.frontIngressId, 'front', stage, ordinal, 'sequential', row.clockDomain, durationMs, row.state, row.terminalAt, row.dataOrigin, row.originReceiptId]);
    }
  }
  return db.run(`UPDATE frontRequestOutcomes SET state='interrupted',terminalAt=?,updatedAt=?
    WHERE state='pending' AND clockDomain<>?`, [active.recordedAt, active.recordedAt, active.clockDomain]).changes;
}

const scheduler = globalThis.__tokenproxyFrontOutcomeJournalScheduler ??= {
  generation: 0,
  timer: null,
  inFlight: null,
  unregisterShutdown: null,
};

function boundedInterval(intervalMs) {
  const parsed = Number(intervalMs);
  return Number.isFinite(parsed) ? Math.min(MAX_IMPORT_INTERVAL_MS, Math.max(MIN_IMPORT_INTERVAL_MS, Math.round(parsed))) : DEFAULT_IMPORT_INTERVAL_MS;
}

async function importOnce(state, ingest) {
  if (state.inFlight) return false;
  const job = Promise.resolve().then(ingest);
  state.inFlight = job;
  try {
    await job;
  } catch (error) {
    console.warn('[frontOutcomeJournal] import failed class=journal-read', error?.message || 'unknown');
  } finally {
    if (state.inFlight === job) state.inFlight = null;
  }
  return true;
}

// Process-wide boot owner. Each cadence is bounded and a stalled import holds
// the single-flight lease instead of allowing another importer to overlap it.
export function startFrontOutcomeJournalIngestion({ intervalMs = DEFAULT_IMPORT_INTERVAL_MS, ingest = ingestFrontOutcomeJournal } = {}) {
  if (scheduler.timer) return false;
  const generation = ++scheduler.generation;
  const tick = () => {
    if (scheduler.generation !== generation) return;
    void importOnce(scheduler, ingest);
  };
  tick();
  scheduler.timer = setInterval(tick, boundedInterval(intervalMs));
  scheduler.timer.unref?.();
  scheduler.unregisterShutdown = registerShutdownFlusher(() => stopFrontOutcomeJournalIngestion(), -80);
  return true;
}

export async function stopFrontOutcomeJournalIngestion() {
  scheduler.generation += 1;
  if (scheduler.timer) clearInterval(scheduler.timer);
  scheduler.timer = null;
  scheduler.unregisterShutdown?.();
  scheduler.unregisterShutdown = null;
  await scheduler.inFlight?.catch(() => {});
}

export async function ingestFrontOutcomeJournal({
  directory,
} = {}) {
  // The front unit's default is DATA_DIR/front-telemetry.  An explicit null
  // remains the operator and test seam that disables this optional import.
  const journalDirectory = directory === null ? null : directory || process.env.TOKENPROXY_FRONT_TELEMETRY_DIR || path.join(DATA_DIR, 'front-telemetry');
  if (!journalDirectory) return { enabled: false, events: 0, segments: 0, pendingBytes: 0 };
  const directoryStat = fs.lstatSync(journalDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('directory');
  const resolvedDirectory = fs.realpathSync(journalDirectory);
  const active = parseActiveClock(resolvedDirectory);
  const db = await getAdapter();
  const names = fs.readdirSync(resolvedDirectory).filter((name) => SEGMENT.test(name)).sort();
  const segmentData = names.map((name) => {
    const previous = db.get('SELECT value FROM _meta WHERE key=?', [checkpointKey(resolvedDirectory, name)]);
    let checkpoint = null;
    if (previous) {
      try { checkpoint = JSON.parse(previous.value); } catch { fail(`checkpoint ${name}`); }
      if (!Number.isInteger(checkpoint.offset) || checkpoint.offset < 0 || !Number.isInteger(checkpoint.dev) || !Number.isInteger(checkpoint.ino)) fail(`checkpoint ${name}`);
    }
    return { name, ...readSegment(resolvedDirectory, name, checkpoint) };
  });
  const operations = collectOperations(db, active, segmentData);
  let interrupted = 0;
  db.transaction(() => {
    interrupted = writeOperations(db, active, operations);
    for (const data of segmentData) if (data.nextOffset > 0) db.run('INSERT INTO _meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [checkpointKey(resolvedDirectory, data.name), JSON.stringify({ dev: data.stat.dev, ino: data.stat.ino, offset: data.nextOffset })]);
  });
  const events = segmentData.reduce((total, data) => total + data.events.length, 0);
  return { enabled: true, events, segments: segmentData.filter((data) => data.events.length).length,
    pendingBytes: segmentData.reduce((total, data) => total + data.pendingBytes, 0), activeClockDomain: active.clockDomain, interrupted };
}
