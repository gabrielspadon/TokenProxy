import { createHash } from 'node:crypto';

const SOURCES = new Set(['requestStats', 'usageHistory']);
const SHA = /^[a-f0-9]{64}$/;
const MAX_ROWS = 10_000;
const REASON = 'historical-test-fixture';

function fail(message) { throw new Error(`Telemetry quarantine refused: ${message}`); }

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('non-canonical value');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export const quarantineSha256 = content => createHash('sha256').update(content).digest('hex');

// Include every stored column with its name and adapter value type. JSON-looking
// TEXT is opaque; normalizing it would hide changes to the source evidence.
export function telemetryRowFingerprint(row) {
  if (!row || typeof row !== 'object') fail('missing source row');
  const fields = Object.keys(row).sort().map(name => {
    const value = row[name];
    if (value === null) return [name, 'null'];
    if (ArrayBuffer.isView(value)) return [name, 'blob', Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')];
    if (typeof value === 'bigint') return [name, 'integer', value.toString()];
    if (typeof value === 'number' && Number.isFinite(value)) return [name, 'number', value];
    if (typeof value === 'string') return [name, 'text', value];
    fail('unsupported source value');
  });
  return quarantineSha256(canonical(fields));
}

function sourceIdentity(row) {
  if (!row || !SOURCES.has(row.sourceTable) || typeof row.rowId !== 'string'
    || !row.rowId.length || row.rowId.length > 256 || /[\x00-\x1f]/.test(row.rowId)
    || (row.sourceTable === 'usageHistory' && !/^[1-9][0-9]*$/.test(row.rowId))) fail('invalid explicit row identity');
  return `${row.sourceTable}:${row.rowId}`;
}

function orderedRows(rows, requireFingerprint) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) fail('explicit row inventory required');
  const seen = new Set();
  for (const row of rows) {
    const identity = sourceIdentity(row);
    if (seen.has(identity)) fail('duplicate explicit row identity');
    seen.add(identity);
    const keys = requireFingerprint ? ['sourceTable', 'rowId', 'rowFingerprint'] : ['sourceTable', 'rowId'];
    if (Object.keys(row).some(key => !keys.includes(key)) || (requireFingerprint && !SHA.test(row.rowFingerprint || ''))) fail('invalid row descriptor');
  }
  return [...rows].sort((left, right) => {
    const a = sourceIdentity(left), b = sourceIdentity(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function readRow(db, row) {
  sourceIdentity(row);
  // Table is allowlisted; values are bound. Avoid CAST(id) so source PK indexes
  // remain available even for a large retained history.
  return db.get(`SELECT * FROM ${row.sourceTable} WHERE id=?`, [row.rowId]);
}

function manifestBody(rows, evidenceSha256) {
  return { schemaVersion: 1, reasonCode: REASON, evidenceSha256,
    selectorSha256: quarantineSha256(canonical(rows)), expectedRows: rows.length, rows };
}

export function createQuarantineManifest(db, { rows, evidence }) {
  if (!(typeof evidence === 'string' || Buffer.isBuffer(evidence)) || !evidence.length) fail('evidence bytes required');
  const selected = orderedRows(rows, false).map(row => ({ ...row, rowFingerprint: telemetryRowFingerprint(readRow(db, row)) }));
  const body = manifestBody(selected, quarantineSha256(evidence));
  return { ...body, id: quarantineSha256(canonical(body)) };
}

function validateManifest(manifest, evidence) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.reasonCode !== REASON
    || !SHA.test(manifest.evidenceSha256 || '') || !(typeof evidence === 'string' || Buffer.isBuffer(evidence))
    || !evidence.length || quarantineSha256(evidence) !== manifest.evidenceSha256) fail('evidence mismatch');
  const rows = orderedRows(manifest.rows, true);
  const body = manifestBody(rows, manifest.evidenceSha256);
  if (canonical(manifest) !== canonical({ ...body, id: quarantineSha256(canonical(body)) })) fail('manifest or selector mismatch');
  return rows;
}

function inspectRows(db, manifest, rows) {
  const origins = { production: 0, test: 0, import: 0, unknown: 0 };
  for (const row of rows) {
    const stored = readRow(db, row);
    if (!stored || telemetryRowFingerprint(stored) !== row.rowFingerprint) fail(`source fingerprint mismatch for ${sourceIdentity(row)}`);
    const origin = stored.dataOrigin ?? 'unknown';
    if (!Object.hasOwn(origins, origin)) fail('invalid trusted origin');
    origins[origin] += 1;
    const conflict = db.get(`SELECT q.receiptId FROM telemetryQuarantineRows q
      JOIN telemetryQuarantineReceipts r ON r.id=q.receiptId
      WHERE q.sourceTable=? AND q.rowId=? AND r.state='active' AND q.receiptId<>?`, [row.sourceTable, row.rowId, manifest.id]);
    if (conflict) fail('source row already has a different active receipt');
  }
  return origins;
}

function assertTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid receipt timestamp');
}

function assertStoredReceipt(db, receipt, manifest) {
  const storedRows = db.all('SELECT sourceTable,rowId,rowFingerprint FROM telemetryQuarantineRows WHERE receiptId=? ORDER BY sourceTable,rowId', [receipt.id]);
  if (receipt.evidenceSha256 !== manifest.evidenceSha256 || receipt.selectorSha256 !== manifest.selectorSha256
    || receipt.reasonCode !== manifest.reasonCode || receipt.expectedRows !== manifest.expectedRows
    || receipt.actualRows !== manifest.expectedRows || canonical(storedRows.map(row => ({ ...row }))) !== canonical(manifest.rows)) fail('stored receipt mismatch');
}

export function inspectQuarantine(db, manifest, { evidence }) {
  const rows = validateManifest(manifest, evidence);
  return db.transaction(() => {
    const origins = inspectRows(db, manifest, rows);
    const receipt = db.get('SELECT * FROM telemetryQuarantineReceipts WHERE id=?', [manifest.id]);
    if (receipt) assertStoredReceipt(db, receipt, manifest);
    return { schemaVersion: 1, id: manifest.id, state: receipt?.state ?? 'unapplied', expectedRows: rows.length,
      actualRows: rows.length, origins, evidenceSha256: manifest.evidenceSha256, selectorSha256: manifest.selectorSha256 };
  });
}

// Explicit adapter injection keeps maintenance detached from the running app's
// singleton. These functions never select candidates by duration/provider/model.
export function applyQuarantine(db, manifest, { evidence, now = new Date().toISOString() }) {
  const rows = validateManifest(manifest, evidence);
  assertTimestamp(now);
  if (typeof db.criticalTransaction !== 'function') fail('durable transaction required');
  return db.criticalTransaction(() => {
    inspectRows(db, manifest, rows);
    const existing = db.get('SELECT * FROM telemetryQuarantineReceipts WHERE id=?', [manifest.id]);
    if (existing) {
      assertStoredReceipt(db, existing, manifest);
      if (existing.state !== 'active') fail('receipt already reverted');
      return { id: manifest.id, state: 'active', rows: rows.length, changed: false };
    }
    const receiptWrite = db.run(`INSERT INTO telemetryQuarantineReceipts(id,reasonCode,evidenceSha256,selectorSha256,expectedRows,actualRows,state,createdAt,metadata)
      VALUES(?,?,?,?,?,?,'active',?,?)`, [manifest.id, manifest.reasonCode, manifest.evidenceSha256,
      manifest.selectorSha256, rows.length, rows.length, now, JSON.stringify({ schemaVersion: 1, sourceRowsPreserved: true })]);
    if (receiptWrite.changes !== 1) fail('receipt not persisted');
    for (const row of rows) {
      const rowWrite = db.run(`INSERT INTO telemetryQuarantineRows(receiptId,sourceTable,rowId,rowFingerprint,quarantinedAt)
        VALUES(?,?,?,?,?)`, [manifest.id, row.sourceTable, row.rowId, row.rowFingerprint, now]);
      if (rowWrite.changes !== 1) fail('row receipt not persisted');
    }
    return { id: manifest.id, state: 'active', rows: rows.length, changed: true };
  });
}

export function revertQuarantine(db, manifest, { evidence, now = new Date().toISOString() }) {
  const rows = validateManifest(manifest, evidence);
  assertTimestamp(now);
  if (typeof db.criticalTransaction !== 'function') fail('durable transaction required');
  return db.criticalTransaction(() => {
    inspectRows(db, manifest, rows);
    const receipt = db.get('SELECT * FROM telemetryQuarantineReceipts WHERE id=?', [manifest.id]);
    if (!receipt) fail('receipt missing');
    assertStoredReceipt(db, receipt, manifest);
    if (receipt.state === 'reverted') return { id: manifest.id, state: 'reverted', rows: rows.length, changed: false };
    const result = db.run("UPDATE telemetryQuarantineReceipts SET state='reverted',revertedAt=? WHERE id=? AND state='active'", [now, manifest.id]);
    if (result.changes !== 1) fail('revert not persisted');
    return { id: manifest.id, state: 'reverted', rows: rows.length, changed: true };
  });
}
