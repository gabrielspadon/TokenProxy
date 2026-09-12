import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
const MAX_ACTIVE_CLOCK_RETRIES = 3;
// Match the front writer's UUID grammar.  The backend owns logical IDs and
// can move to a newer UUID version without making valid front evidence unreadable.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIPT = /^[a-f0-9]{64}$/;
const KEY_ID = /^[a-f0-9]{32}$/;
const ORIGINS = new Set(['production', 'test', 'import', 'unknown']);
const STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);
// The front namespaces each rotated segment with its active clock domain.
// The numeric-only form remains readable for the earliest draft fixture.
const SEGMENT = /^private-(?:[0-9]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9]{8})\.jsonl$/i;
const completedSegmentCache = globalThis.__tokenproxyFrontOutcomeJournalCompletedSegments ??= new Map();

function fail(message) {
  throw new Error(`Invalid front outcome journal: ${message}`);
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') fail('non-canonical JSON');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function canonicalReceipt(record) {
  const copy = { ...record };
  delete copy.receiptId;
  return canonicalJson(copy);
}

function decodeKey(value) {
  if (typeof value !== 'string') return null;
  const key = Buffer.from(value, 'base64');
  return key.length === 32 && key.toString('base64') === value ? key : null;
}

function parseKeyring(content) {
  let value;
  try { value = JSON.parse(content.toString('utf8')); } catch { fail('journal keyring JSON'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || value.schemaVersion !== 1
    || !KEY_ID.test(value.activeKeyId || '') || !value.keys || Array.isArray(value.keys) || typeof value.keys !== 'object') fail('journal keyring');
  const keys = Object.fromEntries(Object.entries(value.keys).map(([id, encoded]) => [id, decodeKey(encoded)]));
  if (!Object.keys(keys).length || Object.entries(keys).some(([id, key]) => !KEY_ID.test(id) || !key) || !keys[value.activeKeyId]) fail('journal keyring');
  return { activeKeyId: value.activeKeyId, keys };
}

function assertReceipt(record, label, keyring) {
  if (!record || Array.isArray(record) || typeof record !== 'object' || !RECEIPT.test(record.receiptId || '')
    || !KEY_ID.test(record.authKeyId || '') || !keyring.keys[record.authKeyId]) fail(`${label} receipt`);
  const expected = createHmac('sha256', keyring.keys[record.authKeyId]).update(canonicalReceipt(record)).digest();
  if (!timingSafeEqual(expected, Buffer.from(record.receiptId, 'hex'))) fail(`${label} receipt`);
}

function assertBase(record, label, keyring) {
  assertReceipt(record, label, keyring);
  if (record.schemaVersion !== 2 || !UUID.test(record.clockDomain || '') || !isTimestamp(record.recordedAt)) fail(`${label} envelope`);
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

function validateEvent(record, label, keyring) {
  assertBase(record, label, keyring);
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

function assertOwnedRegularStat(stat, label, maxBytes = MAX_SEGMENT_BYTES) {
  if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail(`${label} must be an owned mode-0600 regular file`);
}

function openOwnedRegular(file, label, maxBytes = MAX_SEGMENT_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    assertOwnedRegularStat(stat, label, maxBytes);
    return { fd, stat };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw error;
  }
}

function readOwnedFile(file, label, maxBytes) {
  const { fd, stat } = openOwnedRegular(file, label, maxBytes);
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

function checksum(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readKeyring(file) {
  const directory = path.dirname(file);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('journal keyring directory');
  const { content } = readOwnedFile(file, 'journal keyring', MAX_LINE_BYTES);
  return { keyring: parseKeyring(content), fingerprint: checksum(content) };
}

function parseActiveClock(directory, keyring) {
  const { content } = readOwnedFile(path.join(directory, 'active-clock.json'), 'active clock');
  let active;
  try { active = JSON.parse(content.toString('utf8')); } catch { fail('active clock JSON'); }
  assertBase(active, 'active clock', keyring);
  if (Object.keys(active).some((key) => !['schemaVersion', 'clockDomain', 'recordedAt', 'authKeyId', 'receiptId'].includes(key))) fail('active clock fields');
  return active;
}

function readSegment(directory, name, checkpoint, keyring) {
  const { content, stat } = readOwnedFile(path.join(directory, name), `segment ${name}`);
  const continuing = checkpoint && checkpoint.dev === stat.dev && checkpoint.ino === stat.ino;
  const offset = continuing ? checkpoint.offset : 0;
  if (offset > content.length) fail(`segment ${name} shrank without rotation`);
  if (continuing && (!RECEIPT.test(checkpoint.prefixSha256 || '') || checksum(content.subarray(0, offset)) !== checkpoint.prefixSha256)) {
    fail(`segment ${name} consumed prefix changed`);
  }
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
    events.push(validateEvent(value, `segment ${name}`, keyring));
    cursor = newline + 1;
  }
  const nextOffset = offset + completeLength;
  return { stat, events, nextOffset, prefixSha256: checksum(content.subarray(0, nextOffset)), pendingBytes: pending.length - completeLength };
}

function cacheKey(directory, name) {
  return `${directory}\u0000${name}`;
}

function sameCheckpoint(checkpoint, cached) {
  return checkpoint && checkpoint.dev === cached.dev && checkpoint.ino === cached.ino
    && checkpoint.offset === cached.offset && checkpoint.prefixSha256 === cached.prefixSha256;
}

function cachedCompletedSegment(directory, name, checkpoint, keyringFingerprint) {
  const key = cacheKey(directory, name);
  const cached = completedSegmentCache.get(key);
  if (!cached || cached.keyringFingerprint !== keyringFingerprint || !sameCheckpoint(checkpoint, cached)) {
    completedSegmentCache.delete(key);
    return null;
  }
  try {
    const stat = fs.lstatSync(path.join(directory, name));
    assertOwnedRegularStat(stat, `segment ${name}`);
    if (stat.dev !== cached.dev || stat.ino !== cached.ino || stat.size !== cached.size
      || stat.mtimeMs !== cached.mtimeMs || stat.ctimeMs !== cached.ctimeMs) {
      completedSegmentCache.delete(key);
      return null;
    }
    return { stat, events: [], nextOffset: cached.offset, prefixSha256: cached.prefixSha256, pendingBytes: 0, cached: true };
  } catch {
    completedSegmentCache.delete(key);
    return null;
  }
}

function cacheCompletedSegment(directory, name, data, keyringFingerprint) {
  if (data.pendingBytes || data.nextOffset !== data.stat.size) return;
  completedSegmentCache.set(cacheKey(directory, name), {
    dev: data.stat.dev,
    ino: data.stat.ino,
    size: data.stat.size,
    mtimeMs: data.stat.mtimeMs,
    ctimeMs: data.stat.ctimeMs,
    offset: data.nextOffset,
    prefixSha256: data.prefixSha256,
    keyringFingerprint,
  });
}

function same(value, expected) {
  return (value ?? null) === (expected ?? null);
}

function collectOperations(db, active, segmentData) {
  const rows = new Map(db.all('SELECT * FROM frontRequestOutcomes').map((row) => [row.frontIngressId, { ...row }]));
  const logical = new Map(db.all('SELECT frontIngressId,logicalRequestId FROM frontRequestOutcomes WHERE logicalRequestId IS NOT NULL')
    .map((row) => [row.logicalRequestId, row.frontIngressId]));
  const operations = [];
  const groups = new Map();
  for (const { name, events } of segmentData) for (const [ordinal, event] of events.entries()) {
    const clockDomain = event.record.clockDomain;
    const group = groups.get(clockDomain) || { clockDomain, firstRecordedAt: event.record.recordedAt, events: [] };
    group.events.push({ event, name, ordinal });
    groups.set(clockDomain, group);
  }
  const ordered = [...groups.values()]
    .sort((a, b) => a.firstRecordedAt.localeCompare(b.firstRecordedAt) || a.clockDomain.localeCompare(b.clockDomain))
    .flatMap((group) => group.events);
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

function isBuildPhase(phase = process.env.NEXT_PHASE) {
  return phase === 'phase-production-build' || phase === 'phase-export' || phase === 'phase-static';
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
  if (scheduler.timer || isBuildPhase()) return false;
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
  keyringPath,
} = {}) {
  // The front unit's default is DATA_DIR/front-telemetry.  An explicit null
  // remains the operator and test seam that disables this optional import.
  const journalDirectory = directory === null ? null : directory || process.env.TOKENPROXY_FRONT_TELEMETRY_DIR || path.join(DATA_DIR, 'front-telemetry');
  if (!journalDirectory) return { enabled: false, events: 0, segments: 0, pendingBytes: 0 };
  const directoryStat = fs.lstatSync(journalDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('directory');
  const resolvedDirectory = fs.realpathSync(journalDirectory);
  const resolvedKeyring = keyringPath || process.env.TOKENPROXY_FRONT_TELEMETRY_KEYRING
    || path.join(path.dirname(resolvedDirectory), 'front-telemetry-auth', 'keyring.json');
  const db = await getAdapter();
  for (let attempt = 0; attempt < MAX_ACTIVE_CLOCK_RETRIES; attempt += 1) {
    const { keyring, fingerprint: keyringFingerprint } = readKeyring(resolvedKeyring);
    const active = parseActiveClock(resolvedDirectory, keyring);
    const names = fs.readdirSync(resolvedDirectory).filter((name) => SEGMENT.test(name)).sort();
    const activePrefix = `private-${active.clockDomain}-`;
    const activeTail = names.filter((name) => name.startsWith(activePrefix)).at(-1) || names.at(-1);
    const cacheCandidates = [];
    const segmentData = names.map((name) => {
      const previous = db.get('SELECT value FROM _meta WHERE key=?', [checkpointKey(resolvedDirectory, name)]);
      let checkpoint = null;
      if (previous) {
        try { checkpoint = JSON.parse(previous.value); } catch { fail(`checkpoint ${name}`); }
        if (!Number.isInteger(checkpoint.offset) || checkpoint.offset < 0 || !Number.isInteger(checkpoint.dev) || !Number.isInteger(checkpoint.ino)
          || !RECEIPT.test(checkpoint.prefixSha256 || '')) fail(`checkpoint ${name}`);
      }
      const cached = name === activeTail ? null : cachedCompletedSegment(resolvedDirectory, name, checkpoint, keyringFingerprint);
      if (cached) return { name, ...cached };
      const data = readSegment(resolvedDirectory, name, checkpoint, keyring);
      if (name !== activeTail && !data.pendingBytes && data.nextOffset === data.stat.size) cacheCandidates.push({ name, data });
      return { name, ...data };
    });
    const operations = collectOperations(db, active, segmentData);
    // A front restart publishes a new active clock independently from its next
    // segment. Never turn that transient view into interrupted rows.
    if (parseActiveClock(resolvedDirectory, keyring).receiptId !== active.receiptId) continue;
    let interrupted = 0;
    db.transaction(() => {
      interrupted = writeOperations(db, active, operations);
      for (const data of segmentData) if (!data.cached && data.nextOffset > 0) db.run('INSERT INTO _meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        [checkpointKey(resolvedDirectory, data.name), JSON.stringify({ dev: data.stat.dev, ino: data.stat.ino, offset: data.nextOffset,
          prefixSha256: data.prefixSha256 })]);
    });
    for (const { name, data } of cacheCandidates) cacheCompletedSegment(resolvedDirectory, name, data, keyringFingerprint);
    const events = segmentData.reduce((total, data) => total + data.events.length, 0);
    return { enabled: true, events, segments: segmentData.filter((data) => data.events.length).length,
      pendingBytes: segmentData.reduce((total, data) => total + data.pendingBytes, 0), activeClockDomain: active.clockDomain, interrupted };
  }
  fail('active clock changed during import');
}
