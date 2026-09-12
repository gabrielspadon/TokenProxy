import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TELEMETRY_OUTCOME_TABLES } from '../../src/lib/db/telemetryOutcomeSchema.js';
import { buildCreateTableSql } from '../../src/lib/db/schema.js';
import { createTransactionController } from '../../src/lib/db/adapters/criticalTransaction.js';
import { telemetryFilterSql } from '../../src/lib/db/analytics/telemetryFilter.mjs';
import { applyQuarantine, createQuarantineManifest, inspectQuarantine, quarantineSha256, revertQuarantine, telemetryRowFingerprint } from '../../src/lib/db/repos/telemetryQuarantineRepo.js';
import { runQuarantineMaintenance } from '../../scripts/qa/telemetry-quarantine.mjs';

let raw, db;
const EVIDENCE = 'Retained fixture proof with explicit reviewed identities';
const SELECTED = [{ sourceTable: 'requestStats', rowId: 'fixture' }, { sourceTable: 'usageHistory', rowId: '1' }];
const temporary = [];

function adapter(rawDb) {
  const controller = createTransactionController({ exec: sql => rawDb.exec(sql), readSynchronous: () => rawDb.prepare('PRAGMA synchronous').get().synchronous, isInTransaction: () => rawDb.isTransaction });
  return {
    run: (sql, params = []) => rawDb.prepare(sql).run(...params),
    get: (sql, params = []) => rawDb.prepare(sql).get(...params),
    all: (sql, params = []) => rawDb.prepare(sql).all(...params),
    transaction: fn => controller.transaction(() => { rawDb.exec('BEGIN'); try { const value = fn(); rawDb.exec('COMMIT'); return value; } catch (error) { rawDb.exec('ROLLBACK'); throw error; } }),
    criticalTransaction: controller.criticalTransaction,
  };
}

function manifest() { return createQuarantineManifest(db, { rows: SELECTED, evidence: EVIDENCE }); }
function visible(table) { return db.all(`SELECT id FROM ${table} WHERE ${telemetryFilterSql(table)} ORDER BY id`).map(row => row.id); }
function sourceRows() { return ['requestStats', 'usageHistory'].map(table => db.all(`SELECT * FROM ${table} ORDER BY id`)); }

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE requestStats(id TEXT PRIMARY KEY,dataOrigin TEXT,latencyTotal INTEGER,model TEXT,payload BLOB);
    CREATE TABLE usageHistory(id INTEGER PRIMARY KEY,dataOrigin TEXT,cost REAL,tokens TEXT);
    INSERT INTO requestStats VALUES('fixture','unknown',88600000000,'gpt-5.6-sol',X'007f');
    INSERT INTO requestStats VALUES('unusual','unknown',88600000000,'gpt-5.6-sol',NULL);
    INSERT INTO requestStats VALUES('production','production',20,'gpt-5.6-sol',NULL);
    INSERT INTO requestStats VALUES('new-test','test',20,'gpt-5.6-sol',NULL);
    INSERT INTO requestStats VALUES('imported','import',20,'gpt-5.6-sol',NULL);
    INSERT INTO usageHistory VALUES(1,'unknown',999999.0,'{"test": true}');
    INSERT INTO usageHistory VALUES(2,NULL,999999.0,'{}');`);
  for (const name of ['telemetryQuarantineReceipts', 'telemetryQuarantineRows']) raw.exec(buildCreateTableSql(name, TELEMETRY_OUTCOME_TABLES[name]));
  db = adapter(raw);
});

afterEach(() => {
  raw.close();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('binds exact row identities and full fingerprints to stable evidence and selector hashes', () => {
  const value = manifest();
  expect(createQuarantineManifest(db, { rows: [...SELECTED].reverse(), evidence: EVIDENCE })).toEqual(value);
  expect(value.evidenceSha256).toBe(quarantineSha256(EVIDENCE));
  expect(value.rows[0].rowFingerprint).toBe(telemetryRowFingerprint(db.get('SELECT * FROM requestStats WHERE id=?', ['fixture'])));
  const baseline = sourceRows();
  expect(inspectQuarantine(db, value, { evidence: EVIDENCE })).toMatchObject({ state: 'unapplied', actualRows: 2, origins: { unknown: 2 } });
  expect(db.all('SELECT * FROM telemetryQuarantineReceipts')).toEqual([]);
  expect(sourceRows()).toEqual(baseline);
});

it('atomically excludes only proven rows, preserves all source data and reverses without deletion', () => {
  const value = manifest(), before = sourceRows();
  expect(visible('requestStats')).toContain('unusual');
  expect(applyQuarantine(db, value, { evidence: EVIDENCE })).toMatchObject({ state: 'active', rows: 2, changed: true });
  expect(visible('requestStats')).toEqual(['imported', 'production', 'unusual']);
  expect(visible('usageHistory')).toEqual([2]);
  expect(sourceRows()).toEqual(before);
  expect(applyQuarantine(db, value, { evidence: EVIDENCE }).changed).toBe(false);
  expect(revertQuarantine(db, value, { evidence: EVIDENCE })).toMatchObject({ state: 'reverted', changed: true });
  expect(visible('requestStats')).toContain('fixture');
  expect(visible('usageHistory')).toEqual([1, 2]);
  expect(sourceRows()).toEqual(before);
  expect(revertQuarantine(db, value, { evidence: EVIDENCE }).changed).toBe(false);
  expect(db.all('SELECT * FROM telemetryQuarantineRows')).toHaveLength(2);
  expect(() => applyQuarantine(db, value, { evidence: EVIDENCE })).toThrow('already reverted');
});

it.each(['fingerprint', 'missing', 'evidence', 'selector', 'count', 'duplicate', 'row-id', 'table', 'extra-field'])('fails closed on %s mismatch without partial receipt writes', mode => {
  const value = manifest();
  let evidence = EVIDENCE;
  if (mode === 'fingerprint') raw.exec("UPDATE requestStats SET model='changed' WHERE id='fixture'");
  if (mode === 'missing') raw.exec("DELETE FROM requestStats WHERE id='fixture'");
  if (mode === 'evidence') evidence += 'changed';
  if (mode === 'selector') value.selectorSha256 = 'a'.repeat(64);
  if (mode === 'count') value.expectedRows += 1;
  if (mode === 'duplicate') value.rows.push(value.rows[0]);
  if (mode === 'row-id') value.rows[0].rowId = 'unusual';
  if (mode === 'table') value.rows[0].sourceTable = 'requestStats; DELETE FROM usageHistory';
  if (mode === 'extra-field') value.where = 'latencyTotal>86400000';
  const before = sourceRows();
  expect(() => applyQuarantine(db, value, { evidence })).toThrow('refused');
  expect(db.all('SELECT * FROM telemetryQuarantineReceipts')).toEqual([]);
  expect(db.all('SELECT * FROM telemetryQuarantineRows')).toEqual([]);
  expect(sourceRows()).toEqual(before);
});

it('rolls back a failure after inserting the receipt and first row', () => {
  raw.exec("CREATE TRIGGER reject_second BEFORE INSERT ON telemetryQuarantineRows WHEN NEW.sourceTable='usageHistory' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  expect(() => applyQuarantine(db, manifest(), { evidence: EVIDENCE })).toThrow('injected failure');
  expect(db.all('SELECT * FROM telemetryQuarantineReceipts')).toEqual([]);
  expect(db.all('SELECT * FROM telemetryQuarantineRows')).toEqual([]);
});

it('rejects a different overlapping active receipt and detects receipt corruption on revert', () => {
  const value = manifest();
  applyQuarantine(db, value, { evidence: EVIDENCE });
  const different = createQuarantineManifest(db, { rows: SELECTED, evidence: `${EVIDENCE}!` });
  expect(() => applyQuarantine(db, different, { evidence: `${EVIDENCE}!` })).toThrow('different active receipt');
  raw.exec("UPDATE telemetryQuarantineRows SET rowFingerprint='bad' WHERE sourceTable='usageHistory'");
  expect(() => revertQuarantine(db, value, { evidence: EVIDENCE })).toThrow('stored receipt mismatch');
  expect(db.get('SELECT state FROM telemetryQuarantineReceipts').state).toBe('active');
});

it('restores complete source and quarantine evidence from a readable backup', () => {
  const value = manifest(), baseline = sourceRows();
  applyQuarantine(db, value, { evidence: EVIDENCE });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-quarantine-'));
  temporary.push(directory);
  const backup = path.join(directory, 'backup.sqlite');
  raw.prepare('VACUUM INTO ?').run(backup);
  const restored = new DatabaseSync(backup);
  try {
    expect(restored.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
    const restoredDb = adapter(restored);
    expect(inspectQuarantine(restoredDb, value, { evidence: EVIDENCE })).toMatchObject({ state: 'active', actualRows: 2 });
    expect(revertQuarantine(restoredDb, value, { evidence: EVIDENCE })).toMatchObject({ state: 'reverted' });
    expect(['requestStats', 'usageHistory'].map(table => restoredDb.all(`SELECT * FROM ${table} ORDER BY id`))).toEqual(baseline);
    restored.exec("UPDATE usageHistory SET tokens='changed' WHERE id=1");
    expect(() => inspectQuarantine(restoredDb, value, { evidence: EVIDENCE })).toThrow('source fingerprint mismatch');
  } finally { restored.close(); }
});

it('uses the same exclusion contract for projection aliases and rejects SQL identifiers', () => {
  const value = manifest();
  applyQuarantine(db, value, { evidence: EVIDENCE });
  expect(db.all(`SELECT p.id FROM usageHistory p WHERE ${telemetryFilterSql('usageHistory', 'p')}`)).toEqual([{ id: 2 }]);
  expect(() => telemetryFilterSql('other')).toThrow();
  expect(() => telemetryFilterSql('usageHistory', "x) OR 1=1 --")).toThrow();
});

it('rejects implicit, duplicate, missing, malformed and empty candidate selections', () => {
  for (const rows of [[], SELECTED.concat(SELECTED), [{ sourceTable: 'usageHistory', rowId: '01' }], [{ sourceTable: 'requestStats', rowId: 'absent' }]]) {
    expect(() => createQuarantineManifest(db, { rows, evidence: EVIDENCE })).toThrow();
  }
  expect(() => createQuarantineManifest(db, { rows: SELECTED, evidence: '' })).toThrow();
});

function offlineFiles() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-offline-quarantine-'));
  temporary.push(directory);
  const database = path.join(directory, 'offline.sqlite');
  raw.prepare('VACUUM INTO ?').run(database);
  fs.chmodSync(database, 0o600);
  const write = (name, value) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    return file;
  };
  const marker = write('.tokenproxy-quarantine-offline.json', { schemaVersion: 1, purpose: 'synthetic-fixture', offline: true,
    database: 'offline.sqlite', databaseSha256: quarantineSha256(fs.readFileSync(database)) });
  return { directory, database, marker, manifest: write('manifest.json', manifest()), evidence: write('proof.txt', EVIDENCE) };
}

it('runs dry-run, apply, reopen and revert on separate owned copies while preserving its input backup', () => {
  const files = offlineFiles();
  const before = fs.readFileSync(files.database);
  const common = { database: files.database, manifest: files.manifest, evidence: files.evidence };
  const dryRun = runQuarantineMaintenance({ ...common, 'output-dir': path.join(files.directory, 'dry-run') });
  expect(dryRun).toMatchObject({ action: 'dry-run', sourcePreserved: true, result: { state: 'unapplied' }, candidateSha256: null });
  expect(fs.existsSync(path.join(files.directory, 'dry-run', 'candidate.sqlite'))).toBe(false);
  const output = path.join(files.directory, 'apply');
  const applied = runQuarantineMaintenance({ ...common, action: 'apply', 'output-dir': output });
  expect(applied).toMatchObject({ sourcePreserved: true, before: { state: 'unapplied' }, result: { state: 'active', actualRows: 2 } });
  expect(fs.readFileSync(files.database)).toEqual(before);
  expect(fs.readFileSync(path.join(output, 'before.sqlite'))).toEqual(before);
  const candidate = path.join(output, 'candidate.sqlite'), candidateBefore = fs.readFileSync(candidate);
  const reverted = runQuarantineMaintenance({ ...common, database: candidate, action: 'revert', 'output-dir': path.join(files.directory, 'reverted') });
  expect(reverted).toMatchObject({ before: { state: 'active' }, result: { state: 'reverted', actualRows: 2 } });
  expect(fs.readFileSync(candidate)).toEqual(candidateBefore);
  expect(fs.readFileSync(files.database)).toEqual(before);
});

it.each(['marker-hash', 'marker-purpose', 'missing-marker', 'wal', 'symlink', 'hardlink', 'permissions', 'output-exists', 'production-path'])('refuses %s before producing a successful maintenance receipt', failure => {
  const files = offlineFiles();
  let database = files.database;
  if (failure === 'marker-hash') fs.writeFileSync(files.marker, JSON.stringify({ schemaVersion: 1, purpose: 'synthetic-fixture', offline: true, database: 'offline.sqlite', databaseSha256: 'a'.repeat(64) }));
  if (failure === 'marker-purpose') fs.writeFileSync(files.marker, JSON.stringify({ schemaVersion: 1, purpose: 'production', offline: true, database: 'offline.sqlite', databaseSha256: quarantineSha256(fs.readFileSync(database)) }));
  if (failure === 'missing-marker') fs.unlinkSync(files.marker);
  if (failure === 'wal') fs.writeFileSync(`${database}-wal`, '');
  if (failure === 'symlink') { database = path.join(files.directory, 'link.sqlite'); fs.symlinkSync(files.database, database); }
  if (failure === 'hardlink') fs.linkSync(database, path.join(files.directory, 'link.sqlite'));
  if (failure === 'permissions') fs.chmodSync(database, 0o644);
  if (failure === 'production-path') database = path.join(os.homedir(), '.tokenproxy', 'never-open.sqlite');
  const output = path.join(files.directory, 'output');
  if (failure === 'output-exists') fs.mkdirSync(output);
  expect(() => runQuarantineMaintenance({ action: 'apply', database, manifest: files.manifest, evidence: files.evidence, 'output-dir': output })).toThrow();
  expect(fs.existsSync(path.join(output, 'receipt.json'))).toBe(false);
});

it('prepares a bound dry-run manifest only from an explicit evidence-bound row inventory', () => {
  const files = offlineFiles();
  const selection = path.join(files.directory, 'selection.json');
  fs.writeFileSync(selection, JSON.stringify({ schemaVersion: 1, expectedRows: SELECTED.length,
    evidenceSha256: quarantineSha256(EVIDENCE), rows: SELECTED }), { mode: 0o600 });
  const output = path.join(files.directory, 'bound');
  const common = { database: files.database, selection, evidence: files.evidence };
  expect(runQuarantineMaintenance({ ...common, 'output-dir': output }).result.state).toBe('unapplied');
  expect(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json')))).toEqual(manifest());
  expect(() => runQuarantineMaintenance({ ...common, action: 'apply', 'output-dir': path.join(files.directory, 'invalid') })).toThrow();
});

it('exercises the executable CLI and rejects unknown options without a success receipt', () => {
  const files = offlineFiles(), output = path.join(files.directory, 'cli');
  const script = fileURLToPath(new URL('../../scripts/qa/telemetry-quarantine.mjs', import.meta.url));
  const args = [script, '--database', files.database, '--manifest', files.manifest, '--evidence', files.evidence, '--output-dir', output];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ action: 'dry-run', sourcePreserved: true, result: { state: 'unapplied' } });
  const rejected = spawnSync(process.execPath, [...args, '--where', 'latencyTotal>0'], { encoding: 'utf8' });
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain('unknown, duplicate or missing argument');
});

it.each(['receipt', 'row'])('rejects a silent %s write failure atomically', target => {
  const originalRun = db.run;
  db.run = (sql, params) => sql.startsWith(`INSERT INTO telemetryQuarantine${target === 'receipt' ? 'Receipts' : 'Rows'}`)
    ? { changes: 0 } : originalRun(sql, params);
  expect(() => applyQuarantine(db, manifest(), { evidence: EVIDENCE })).toThrow('not persisted');
  expect(db.all('SELECT * FROM telemetryQuarantineReceipts')).toEqual([]);
  expect(db.all('SELECT * FROM telemetryQuarantineRows')).toEqual([]);
});

it('requires valid timestamps and a durable transaction for mutations', () => {
  const value = manifest();
  expect(() => applyQuarantine(db, value, { evidence: EVIDENCE, now: 'invalid' })).toThrow('invalid receipt timestamp');
  expect(() => applyQuarantine({ ...db, criticalTransaction: undefined }, value, { evidence: EVIDENCE })).toThrow('durable transaction required');
  expect(() => revertQuarantine({ ...db, criticalTransaction: undefined }, value, { evidence: EVIDENCE })).toThrow('durable transaction required');
});

it('never accepts the unbound historical aggregate candidate as an applicable manifest', () => {
  const candidate = JSON.parse(fs.readFileSync(new URL('../qa/telemetry-quarantine/historical-fixture-candidate.json', import.meta.url)));
  expect(candidate.expectedRequestStatsRows).toBe(156);
  expect(candidate.applyEligible).toBe(false);
  expect(candidate.rows).toEqual([]);
  expect(() => applyQuarantine(db, candidate, { evidence: EVIDENCE })).toThrow();
});
