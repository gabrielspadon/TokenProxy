import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensureCriticalAckSchema } from '../criticalAckSchema.js';

export const CRITICAL_ACK_SCOPE = 'durable-before-return';
const ZERO_HASH = '0'.repeat(64);
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DRIVERS = new Set(['node:sqlite', 'better-sqlite3', 'bun:sqlite', 'sql.js']);
const processIdentity = globalThis.__tokenproxyCriticalAckProcess ??= {
  processInstanceId: randomUUID(), pid: process.pid,
};
const runtimeByDatabase = globalThis.__tokenproxyCriticalAckRuntime ??= new Map();
const MARKER_FIELDS = ['schemaVersion', 'epoch', 'sequence', 'transactionId', 'processInstanceId',
  'pid', 'driver', 'buildSha', 'recordedAt', 'previousMarkerSha256', 'intentSha256', 'mutationChanges'];

function buildIdentity() {
  if (/^[a-f0-9]{40}$/.test(process.env.TP_BUILD_SHA || '')) return process.env.TP_BUILD_SHA;
  try {
    const value = fs.readFileSync(join(process.cwd(), 'BUILD_SHA'), 'utf8').trim();
    if (/^[a-f0-9]{40}$/.test(value)) return value;
  } catch {}
  return null;
}

function fail(message) {
  throw Object.assign(new Error(`Critical acknowledgment journal ${message}`), {
    code: 'CRITICAL_TRANSACTION_ACK_INVALID', retryable: false,
  });
}

export function criticalAckCanonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(criticalAckCanonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') fail('contains non-canonical data');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${criticalAckCanonicalJson(value[key])}`).join(',')}}`;
}

export function criticalAckDigest(value) {
  return createHash('sha256').update(criticalAckCanonicalJson(value)).digest('hex');
}

function withDigest(value, field) { return { ...value, [field]: criticalAckDigest(value) }; }
export function assertCriticalAckDigest(value, field) {
  const body = { ...value };
  delete body[field];
  if (!SHA256.test(value?.[field] || '') || value[field] !== criticalAckDigest(body)) fail('digest mismatch');
}
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function integer(value, min = 0) { return Number.isSafeInteger(value) && value >= min; }

export function assertCriticalAckMarker(marker) {
  if (!marker || Object.keys(marker).sort().join() !== [...MARKER_FIELDS, 'markerSha256'].sort().join()
    || marker.schemaVersion !== 1 || !UUID.test(marker.epoch) || !UUID.test(marker.transactionId)
    || !UUID.test(marker.processInstanceId) || !integer(marker.sequence, 1) || !integer(marker.pid, 1)
    || !integer(marker.mutationChanges) || !DRIVERS.has(marker.driver) || !timestamp(marker.recordedAt)
    || !SHA256.test(marker.previousMarkerSha256) || !SHA256.test(marker.intentSha256)
    || !(marker.buildSha === null || /^[a-f0-9]{40}$/.test(marker.buildSha))) fail('marker shape mismatch');
  assertCriticalAckDigest(marker, 'markerSha256');
  return marker;
}

export function assertCriticalAckReceipt(receipt) {
  if (Object.keys(receipt).sort().join() !== ['schemaVersion', 'kind', 'acknowledgmentScope', 'marker', 'ackEligibleAt', 'receiptSha256'].sort().join()
    || receipt.schemaVersion !== 1 || receipt.kind !== 'critical-ack-eligible'
    || receipt.acknowledgmentScope !== CRITICAL_ACK_SCOPE || !timestamp(receipt.ackEligibleAt)) fail('receipt shape mismatch');
  assertCriticalAckMarker(receipt.marker);
  assertCriticalAckDigest(receipt, 'receiptSha256');
}

function assertIntent(intent) {
  const { kind, intentSha256, ...body } = intent;
  if (kind !== 'critical-ack-intent') fail('intent shape mismatch');
  assertCriticalAckMarker(withDigest({ ...body, intentSha256, mutationChanges: 0 }, 'markerSha256'));
  assertCriticalAckDigest(intent, 'intentSha256');
}

function assertFailure(failure) {
  if (Object.keys(failure).sort().join() !== ['schemaVersion', 'kind', 'epoch', 'transactionId', 'intentSha256', 'commitState', 'recordedAt', 'failureSha256'].sort().join()
    || failure.schemaVersion !== 1 || failure.kind !== 'critical-ack-failure' || !UUID.test(failure.epoch)
    || !UUID.test(failure.transactionId) || !SHA256.test(failure.intentSha256) || !timestamp(failure.recordedAt)
    || !['not-started', 'rolled-back', 'uncertain', 'committed'].includes(failure.commitState)) fail('failure shape mismatch');
  assertCriticalAckDigest(failure, 'failureSha256');
}

function privateStat(stat, directory = false) {
  if (!(directory ? stat.isDirectory() : stat.isFile())
    || (!directory && stat.nlink !== 1)
    || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) fail('unsafe ownership or permissions');
}

function directorySync(directory) {
  // Windows does not expose a directory durability barrier through this API.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function journalPath(databaseFile) {
  if (typeof databaseFile !== 'string' || !databaseFile || databaseFile === ':memory:') fail('requires a durable database file');
  return `${resolve(databaseFile)}.critical-acks`;
}

function ensureDirectory(directory) {
  let created = false;
  try { fs.mkdirSync(directory, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  privateStat(fs.lstatSync(directory), true);
  if (created) directorySync(dirname(directory));
}

function readRecord(file, { sync = false } = {}) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    privateStat(stat);
    if (stat.size > 16_384) fail('record exceeds size limit');
    const bytes = fs.readFileSync(fd, 'utf8');
    const record = JSON.parse(bytes);
    if (bytes !== criticalAckCanonicalJson(record) + '\n') fail('record is not canonical');
    if (sync) fs.fsyncSync(fd);
    return record;
  } finally { fs.closeSync(fd); }
}

function optionalRecord(file) {
  try { return readRecord(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// A complete fsynced inode becomes visible exactly once. Never overwrite a
// prior sequence, including one left by a newer database before restore.
function publish(directory, filename, record) {
  privateStat(fs.lstatSync(directory), true);
  const file = join(directory, filename);
  const existing = optionalRecord(file);
  if (existing) {
    if (criticalAckDigest(existing) !== criticalAckDigest(record)) fail('refuses conflicting receipt');
    readRecord(file, { sync: true });
    directorySync(directory);
    return;
  }
  const temporary = join(directory, `.pending-${randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(fd, criticalAckCanonicalJson(record) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST' || criticalAckDigest(readRecord(file)) !== criticalAckDigest(record)) throw error;
    }
    fs.unlinkSync(temporary);
    directorySync(directory);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

const ackName = (sequence) => `ack-${String(sequence).padStart(16, '0')}.json`;
const stateSql = 'SELECT epoch, sequence, lastMarkerSha256 FROM criticalAckState WHERE id = 1';

export function criticalAckFailure(cause, context, commitState) {
  return Object.assign(new Error('Critical transaction acknowledgment was not confirmed; do not replay the mutation'), {
    code: 'CRITICAL_TRANSACTION_ACK_UNCONFIRMED', cause, commitState,
    committed: commitState === 'uncertain' ? null : commitState === 'committed', acknowledgmentState: 'unknown', retryable: false,
    transactionId: context?.intent?.transactionId ?? null,
  });
}

export function createCriticalAckJournal({ databaseFile, driver, db }) {
  let directory;
  const key = resolve(databaseFile);
  if (!runtimeByDatabase.has(key)) runtimeByDatabase.set(key, { enabledAt: new Date().toISOString(), buildSha: buildIdentity(), drivers: new Set(), counters: {
    startedAttempts: 0, createdIntents: 0, acknowledgedReturnsEligible: 0, failedAttempts: 0, omittedAttempts: 0,
  } });
  const runtime = runtimeByDatabase.get(key);
  runtime.drivers.add(driver);
  function prepare() {
    runtime.counters.startedAttempts += 1;
    directory = journalPath(databaseFile);
    ensureDirectory(directory);
    ensureCriticalAckSchema(db);
    let state = db.get(stateSql);
    let header = optionalRecord(join(directory, 'epoch.json'));
    if (header && (header.schemaVersion !== 1 || header.kind !== 'critical-ack-epoch' || !UUID.test(header.epoch))) fail('epoch header mismatch');
    if (!state) {
      if (fs.readdirSync(directory).some((name) => name.startsWith('ack-'))) fail('database history is missing');
      header ||= { schemaVersion: 1, kind: 'critical-ack-epoch', epoch: randomUUID() };
      publish(directory, 'epoch.json', header);
      db.run('INSERT INTO criticalAckState (id, epoch, sequence, lastMarkerSha256) VALUES (1, ?, 0, ?)', [header.epoch, ZERO_HASH]);
      state = db.get(stateSql);
    }
    if (!header || header.epoch !== state.epoch || !integer(state.sequence) || !SHA256.test(state.lastMarkerSha256)) fail('database epoch mismatch');
    if (state.sequence > 0) {
      const previous = db.get('SELECT * FROM criticalAckMarkers WHERE sequence = ?', [state.sequence]);
      assertCriticalAckMarker(previous);
      if (previous.markerSha256 !== state.lastMarkerSha256 || previous.epoch !== state.epoch) fail('database chain mismatch');
    }
    const sequence = state.sequence + 1;
    if (!integer(sequence, 1) || optionalRecord(join(directory, ackName(sequence)))) fail('sequence has already been acknowledged');
    const intent = withDigest({ schemaVersion: 1, kind: 'critical-ack-intent', epoch: state.epoch, sequence,
      transactionId: randomUUID(), ...processIdentity, driver,
      buildSha: runtime.buildSha,
      recordedAt: new Date().toISOString(), previousMarkerSha256: state.lastMarkerSha256 }, 'intentSha256');
    publish(directory, `intent-${intent.transactionId}.json`, intent);
    runtime.counters.createdIntents += 1;
    return { intent, changesBefore: db.get('SELECT total_changes() AS n').n };
  }

  function mark(context) {
    const { kind: _kind, ...body } = context.intent;
    const mutationChanges = db.get('SELECT total_changes() AS n').n - context.changesBefore;
    const marker = withDigest({ ...body, mutationChanges }, 'markerSha256');
    assertCriticalAckMarker(marker);
    const fields = [...MARKER_FIELDS, 'markerSha256'];
    db.run(`INSERT INTO criticalAckMarkers (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, fields.map((field) => marker[field]));
    const changed = db.run('UPDATE criticalAckState SET sequence = ?, lastMarkerSha256 = ? WHERE id = 1 AND epoch = ? AND sequence = ? AND lastMarkerSha256 = ?',
      [marker.sequence, marker.markerSha256, marker.epoch, marker.sequence - 1, marker.previousMarkerSha256]);
    if (Number(changed.changes) !== 1) fail('database sequence changed');
    context.marker = marker;
  }

  function acknowledge(context) {
    const receipt = withDigest({ schemaVersion: 1, kind: 'critical-ack-eligible', acknowledgmentScope: CRITICAL_ACK_SCOPE,
      marker: context.marker, ackEligibleAt: new Date().toISOString() }, 'receiptSha256');
    publish(directory, ackName(context.marker.sequence), receipt);
    runtime.counters.acknowledgedReturnsEligible += 1;
    return receipt;
  }

  function failed(context, commitState) {
    runtime.counters.failedAttempts += 1;
    if (!context) { runtime.counters.omittedAttempts += 1; return; }
    try {
      publish(directory, `failure-${context.intent.transactionId}.json`, withDigest({ schemaVersion: 1,
        kind: 'critical-ack-failure', epoch: context.intent.epoch, transactionId: context.intent.transactionId,
        intentSha256: context.intent.intentSha256, commitState,
        recordedAt: new Date().toISOString() }, 'failureSha256'));
    } catch { runtime.counters.omittedAttempts += 1; }
  }

  return { prepare, mark, acknowledge, failed };
}

export function getCriticalAcknowledgmentRuntime({ databaseFile }) {
  const runtime = runtimeByDatabase.get(resolve(databaseFile));
  return { schemaVersion: 1, kind: 'critical-ack-runtime', ...processIdentity,
    enabledAt: runtime?.enabledAt ?? null, drivers: [...(runtime?.drivers || [])].sort(),
    buildSha: runtime?.buildSha ?? null, counters: runtime ? { ...runtime.counters } : null };
}

// Repair publication only, never replay a callback or edit a business row.
// The caller must supply a read-only connection to the durable on-disk DB.
export function recoverCriticalAcknowledgment({ databaseFile, db, transactionId }) {
  if (!UUID.test(transactionId || '')) fail('invalid recovery identity');
  const marker = db.get('SELECT * FROM criticalAckMarkers WHERE transactionId = ?', [transactionId]);
  assertCriticalAckMarker(marker);
  const directory = journalPath(databaseFile);
  privateStat(fs.lstatSync(directory), true);
  const header = readRecord(join(directory, 'epoch.json'));
  if (header.epoch !== marker.epoch) fail('recovery epoch mismatch');
  const intent = readRecord(join(directory, `intent-${transactionId}.json`));
  assertIntent(intent);
  if (intent.intentSha256 !== marker.intentSha256) fail('recovery intent mismatch');
  const existing = optionalRecord(join(directory, ackName(marker.sequence)));
  if (existing) {
    assertCriticalAckReceipt(existing);
    if (existing.marker.markerSha256 !== marker.markerSha256) fail('recovery marker mismatch');
  }
  const receipt = existing || withDigest({ schemaVersion: 1, kind: 'critical-ack-eligible', acknowledgmentScope: CRITICAL_ACK_SCOPE,
    marker, ackEligibleAt: new Date().toISOString() }, 'receiptSha256');
  publish(directory, ackName(marker.sequence), receipt);
  return receipt;
}

// Captures retained evidence without changing either source. A caller must
// bind/hash this result in its signed observation envelope. Hashes here detect
// corruption and joins, they are not a signature or proof of caller delivery.
export function captureCriticalAcknowledgments({ databaseFile, db, maxRecords = 100_000 }) {
  const result = { schemaVersion: 1, kind: 'critical-ack-snapshot', acknowledgmentScope: CRITICAL_ACK_SCOPE,
    capturedAt: new Date().toISOString(), captureProcessIdentity: { ...processIdentity }, epoch: null, processIdentities: [],
    counters: { createdIntents: 0, committedMarkers: 0, ackEligible: 0, failedAttempts: 0, unresolvedIntents: 0, missingReceipts: 0 },
    journal: { count: 0, sha256: null, firstSequence: null, lastSequence: null, records: [], intents: [], failures: [], inventory: [], header: null },
    database: { sequence: null, lastMarkerSha256: null, markers: [] }, failures: [], unobservable: [], callerObserved: null };
  try {
    if (!integer(maxRecords, 1)) fail('invalid capture bound');
    const directory = journalPath(databaseFile);
    privateStat(fs.lstatSync(directory), true);
    const names = fs.readdirSync(directory).sort();
    if (names.length > maxRecords * 3 + 1) fail('capture bound exceeded');
    const header = readRecord(join(directory, 'epoch.json'));
    if (header.schemaVersion !== 1 || header.kind !== 'critical-ack-epoch' || !UUID.test(header.epoch)) fail('invalid capture epoch');
    result.epoch = header.epoch;
    const before = db.get(stateSql);
    if (!before || before.epoch !== header.epoch || !integer(before.sequence) || before.sequence > maxRecords) fail('capture database epoch or bound mismatch');
    const markers = db.all('SELECT * FROM criticalAckMarkers ORDER BY sequence');
    let previousHash = ZERO_HASH;
    for (const [index, marker] of markers.entries()) {
      assertCriticalAckMarker(marker);
      if (marker.sequence !== index + 1 || marker.epoch !== result.epoch || marker.previousMarkerSha256 !== previousHash) fail('capture database chain mismatch');
      previousHash = marker.markerSha256;
      if (marker.buildSha === null) result.unobservable.push(`build-identity:${marker.sequence}`);
    }
    if (markers.length !== before.sequence || previousHash !== before.lastMarkerSha256) fail('capture database head mismatch');
    result.database = { ...before, markers };
    const receipts = [], intents = [], failures = [], retained = [];
    for (const name of names) {
      if (name === 'epoch.json') { retained.push({ name, sha256: criticalAckDigest(header) }); continue; }
      if (!/^(?:ack-[0-9]{16}|(?:intent|failure)-[a-f0-9-]{36})\.json$/.test(name)) { result.unobservable.push('unrecognized-journal-file'); continue; }
      const record = readRecord(join(directory, name));
      retained.push({ name, sha256: criticalAckDigest(record) });
      if (name.startsWith('ack-')) {
        assertCriticalAckReceipt(record);
        if (name !== ackName(record.marker.sequence) || record.marker.epoch !== result.epoch) fail('capture receipt identity mismatch');
        receipts.push(record);
      } else if (name.startsWith('intent-')) {
        assertIntent(record);
        if (record.schemaVersion !== 1 || record.kind !== 'critical-ack-intent' || record.epoch !== result.epoch
          || name !== `intent-${record.transactionId}.json`) fail('capture intent identity mismatch');
        intents.push(record);
      } else {
        assertFailure(record);
        if (record.schemaVersion !== 1 || record.kind !== 'critical-ack-failure' || record.epoch !== result.epoch
          || !['not-started', 'rolled-back', 'uncertain', 'committed'].includes(record.commitState)
          || name !== `failure-${record.transactionId}.json`) fail('capture failure identity mismatch');
        failures.push(record);
      }
    }
    const markerIds = new Map(markers.map((marker) => [marker.transactionId, marker]));
    const intentIds = new Map(intents.map((intent) => [intent.transactionId, intent]));
    const failedIds = new Map(failures.map((failure) => [failure.transactionId, failure]));
    const receiptIds = new Set();
    for (const marker of markers) {
      if (intentIds.get(marker.transactionId)?.intentSha256 !== marker.intentSha256) result.failures.push(`missing-intent:${marker.sequence}`);
    }
    for (const receipt of receipts) {
      if (markerIds.get(receipt.marker.transactionId)?.markerSha256 !== receipt.marker.markerSha256) result.failures.push(`missing-marker:${receipt.marker.sequence}`);
      receiptIds.add(receipt.marker.transactionId);
    }
    for (const failure of failures) {
      if (intentIds.get(failure.transactionId)?.intentSha256 !== failure.intentSha256) result.failures.push('failure-intent-mismatch');
    }
    const unresolvedIntents = intents.filter((intent) => !receiptIds.has(intent.transactionId)
      && failedIds.get(intent.transactionId)?.commitState !== 'rolled-back').length;
    const missingReceipts = markers.filter((marker) => !receiptIds.has(marker.transactionId)).length;
    result.counters = { createdIntents: intents.length, committedMarkers: markers.length, ackEligible: receipts.length,
      failedAttempts: failures.length, unresolvedIntents, missingReceipts };
    if (unresolvedIntents) result.unobservable.push('unresolved-intents');
    if (missingReceipts) result.unobservable.push('missing-receipts');
    result.journal = { count: retained.length, sha256: criticalAckDigest(retained), firstSequence: receipts[0]?.marker.sequence ?? null,
      lastSequence: receipts.at(-1)?.marker.sequence ?? null, records: receipts, intents, failures, inventory: retained, header };
    result.processIdentities = [...new Map(markers.map(({ processInstanceId, pid, driver, buildSha }) =>
      [processInstanceId, { processInstanceId, pid, driver, buildSha }])).values()];
    if (criticalAckDigest(db.get(stateSql)) !== criticalAckDigest(before)
      || criticalAckDigest(fs.readdirSync(directory).sort()) !== criticalAckDigest(names)) result.unobservable.push('capture-changed');
    if (process.platform === 'win32') result.unobservable.push('directory-fsync-unavailable');
  } catch (error) {
    result.unobservable.push(error.code === 'ENOENT' ? 'source-unavailable' : 'source-invalid-or-unreadable');
  }
  return result;
}

// Recheck the native, complete capture at the evidence-consumer boundary.
// This validates retained sources and arithmetic, never a supplied pass flag.
export function validateCriticalAcknowledgmentCapture(value) {
  if (value?.schemaVersion !== 1 || value.kind !== 'critical-ack-snapshot' || value.acknowledgmentScope !== CRITICAL_ACK_SCOPE
    || value.callerObserved !== null || !timestamp(value.capturedAt) || !UUID.test(value.epoch || '')
    || !Array.isArray(value.failures) || value.failures.length || !Array.isArray(value.unobservable) || value.unobservable.length) fail('capture is not complete');
  const { journal, database, counters } = value;
  if (!journal || !database || !counters || !Array.isArray(database.markers)
    || !['records', 'intents', 'failures', 'inventory'].every((key) => Array.isArray(journal[key]))) fail('capture populations missing');
  if (criticalAckCanonicalJson(journal.header) !== criticalAckCanonicalJson({ schemaVersion: 1, kind: 'critical-ack-epoch', epoch: value.epoch })) fail('capture header mismatch');
  let head = ZERO_HASH;
  const markers = new Map();
  for (const [index, marker] of database.markers.entries()) {
    assertCriticalAckMarker(marker);
    if (marker.sequence !== index + 1 || marker.epoch !== value.epoch || marker.previousMarkerSha256 !== head
      || marker.buildSha === null || markers.has(marker.transactionId)) fail('capture marker chain mismatch');
    markers.set(marker.transactionId, marker);
    head = marker.markerSha256;
  }
  if (database.epoch !== value.epoch || database.sequence !== markers.size || database.lastMarkerSha256 !== head) fail('capture head mismatch');
  const intents = new Map(), failures = new Map(), receipts = new Map();
  const inventory = [{ name: 'epoch.json', sha256: criticalAckDigest(journal.header) }];
  for (const intent of journal.intents) {
    assertIntent(intent);
    if (intent.epoch !== value.epoch || intents.has(intent.transactionId)) fail('capture intent duplicate or epoch mismatch');
    intents.set(intent.transactionId, intent);
    inventory.push({ name: `intent-${intent.transactionId}.json`, sha256: criticalAckDigest(intent) });
  }
  for (const failure of journal.failures) {
    assertFailure(failure);
    if (failure.epoch !== value.epoch || failures.has(failure.transactionId)
      || intents.get(failure.transactionId)?.intentSha256 !== failure.intentSha256) fail('capture failure binding mismatch');
    failures.set(failure.transactionId, failure);
    inventory.push({ name: `failure-${failure.transactionId}.json`, sha256: criticalAckDigest(failure) });
  }
  for (const [index, receipt] of journal.records.entries()) {
    assertCriticalAckReceipt(receipt);
    if (receipt.marker.sequence !== index + 1 || receipts.has(receipt.marker.transactionId)
      || markers.get(receipt.marker.transactionId)?.markerSha256 !== receipt.marker.markerSha256) fail('capture receipt binding mismatch');
    receipts.set(receipt.marker.transactionId, receipt);
    inventory.push({ name: ackName(receipt.marker.sequence), sha256: criticalAckDigest(receipt) });
  }
  for (const marker of markers.values()) {
    if (intents.get(marker.transactionId)?.intentSha256 !== marker.intentSha256 || !receipts.has(marker.transactionId)) fail('capture marker coverage mismatch');
  }
  for (const intent of intents.values()) {
    if (!receipts.has(intent.transactionId) && failures.get(intent.transactionId)?.commitState !== 'rolled-back') fail('capture unresolved intent');
  }
  const expectedCounters = { createdIntents: intents.size, committedMarkers: markers.size, ackEligible: receipts.size,
    failedAttempts: failures.size, unresolvedIntents: 0, missingReceipts: 0 };
  if (criticalAckDigest(counters) !== criticalAckDigest(expectedCounters)) fail('capture counters mismatch');
  inventory.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (criticalAckDigest(inventory) !== criticalAckDigest(journal.inventory) || journal.sha256 !== criticalAckDigest(inventory)
    || journal.count !== inventory.length || journal.firstSequence !== (journal.records[0]?.marker.sequence ?? null)
    || journal.lastSequence !== (journal.records.at(-1)?.marker.sequence ?? null)) fail('capture inventory mismatch');
  const identities = [...new Map(database.markers.map(({ processInstanceId, pid, driver, buildSha }) =>
    [processInstanceId, { processInstanceId, pid, driver, buildSha }])).values()];
  if (criticalAckDigest(value.processIdentities) !== criticalAckDigest(identities)) fail('capture process identities mismatch');
  return value;
}
