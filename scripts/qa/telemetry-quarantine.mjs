#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createTransactionController } from '../../src/lib/db/adapters/criticalTransaction.js';
import { applyQuarantine, createQuarantineManifest, inspectQuarantine, revertQuarantine } from '../../src/lib/db/repos/telemetryQuarantineRepo.js';

const MARKER = '.tokenproxy-quarantine-offline.json';
const FLAGS = new Set(['action', 'database', 'manifest', 'selection', 'evidence', 'output-dir']);

function fail(message) { throw new Error(`Offline quarantine refused: ${message}`); }
function fileHash(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function privateFile(file) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) fail('absolute canonical file path required');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid())) fail('owned private regular file required');
  return file;
}
function loadJson(file) { return JSON.parse(fs.readFileSync(privateFile(file), 'utf8')); }
function writeJson(file, data) { fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
function inputProof(database) {
  const protectedRoot = path.join(os.homedir(), '.tokenproxy');
  if (database === protectedRoot || database.startsWith(`${protectedRoot}${path.sep}`)) fail('production data path');
  privateFile(database);
  for (const suffix of ['-wal', '-shm', '-journal']) if (fs.existsSync(`${database}${suffix}`)) fail('database has SQLite sidecars');
  const marker = loadJson(path.join(path.dirname(database), MARKER));
  if (marker.schemaVersion !== 1 || !['synthetic-fixture', 'offline-backup'].includes(marker.purpose)
    || marker.offline !== true || marker.database !== path.basename(database)
    || marker.databaseSha256 !== fileHash(database)) fail('offline copy marker mismatch');
  return marker;
}

function adapter(raw) {
  const controller = createTransactionController({ exec: sql => raw.exec(sql),
    readSynchronous: () => raw.prepare('PRAGMA synchronous').get().synchronous, isInTransaction: () => raw.isTransaction });
  return {
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    transaction: fn => controller.transaction(() => {
      raw.exec('BEGIN');
      try { const result = fn(); raw.exec('COMMIT'); return result; }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    }),
    criticalTransaction: controller.criticalTransaction,
  };
}
function inspectCopy(file, manifest, evidence) {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = raw.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') fail('backup integrity check');
    if (raw.prepare('PRAGMA foreign_key_check').all().length) fail('backup foreign key check');
    return inspectQuarantine(adapter(raw), manifest, { evidence });
  } finally { raw.close(); }
}

export function runQuarantineMaintenance(options) {
  const action = options.action ?? 'dry-run';
  if (!['dry-run', 'apply', 'revert'].includes(action) || !options.database || !options.evidence
    || !options['output-dir'] || Boolean(options.manifest) === Boolean(options.selection)
    || (options.selection && action !== 'dry-run')) fail('explicit database, evidence, output and one manifest/selection required');
  const database = options.database, output = options['output-dir'];
  const proof = inputProof(database);
  const evidence = fs.readFileSync(privateFile(options.evidence));
  const specification = loadJson(options.manifest || options.selection);
  if (!path.isAbsolute(output) || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) fail('canonical output parent required');
  fs.mkdirSync(output, { mode: 0o700 });
  const backup = path.join(output, 'before.sqlite');
  fs.copyFileSync(database, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  if (fileHash(backup) !== proof.databaseSha256 || fileHash(database) !== proof.databaseSha256) fail('offline source changed while copying');
  let manifest = specification;
  if (options.selection) {
    if (specification.schemaVersion !== 1 || specification.expectedRows !== specification.rows?.length
      || specification.evidenceSha256 !== createHash('sha256').update(evidence).digest('hex')
      || Object.keys(specification).some(key => !['schemaVersion', 'expectedRows', 'evidenceSha256', 'rows'].includes(key))) fail('selection inventory mismatch');
    const raw = new DatabaseSync(backup, { readOnly: true });
    try { manifest = createQuarantineManifest(adapter(raw), { rows: specification.rows, evidence }); }
    finally { raw.close(); }
  }
  const before = inspectCopy(backup, manifest, evidence);
  writeJson(path.join(output, 'manifest.json'), manifest);
  let result = before, candidateSha256 = null;
  if (action !== 'dry-run') {
    const candidate = path.join(output, 'candidate.sqlite');
    fs.copyFileSync(backup, candidate, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(candidate, 0o600);
    const raw = new DatabaseSync(candidate);
    try {
      raw.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
      (action === 'apply' ? applyQuarantine : revertQuarantine)(adapter(raw), manifest, { evidence });
    } finally { raw.close(); }
    result = inspectCopy(candidate, manifest, evidence);
    if (result.state !== (action === 'apply' ? 'active' : 'reverted')) fail('candidate outcome mismatch');
    candidateSha256 = fileHash(candidate);
    writeJson(path.join(output, MARKER), { schemaVersion: 1, purpose: proof.purpose, offline: true,
      database: 'candidate.sqlite', databaseSha256: candidateSha256 });
  }
  if (fileHash(database) !== proof.databaseSha256) fail('input source changed');
  const receipt = { schemaVersion: 1, action, sourcePreserved: true, inputDatabaseSha256: proof.databaseSha256,
    backupSha256: fileHash(backup), candidateSha256, before, result, completedAt: new Date().toISOString() };
  writeJson(path.join(output, 'receipt.json'), receipt);
  return receipt;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || !FLAGS.has(name) || options[name] !== undefined || !args[index + 1]) fail('unknown, duplicate or missing argument');
    options[name] = args[index + 1];
  }
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runQuarantineMaintenance(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
