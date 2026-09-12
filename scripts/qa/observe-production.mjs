#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { readFrontObservationJournal, signFrontObservation, verifyFrontObservation } from '../../src/lib/db/repos/frontOutcomeJournalRepo.js';
import { openAnalyticsReadOnly } from '../../src/lib/db/analytics/readOnly.mjs';
import { normalizeTerminalEvidence } from '../../src/lib/db/terminalEvidence.js';

const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_ATTEMPTS = 100000;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (message) => { throw new Error(`Observation rejected: ${message}`); };
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function statusCount(status) {
  if (!status || status.journal_healthy !== true || status.ready !== true || status.public_ready !== true || !timestamp(status.terminal_window_started_at)
    || typeof status.observation_monotonic_ms !== 'number' || !Number.isFinite(status.observation_monotonic_ms) || status.observation_monotonic_ms < 0
    || !status.terminal_counts || typeof status.terminal_counts !== 'object' || Array.isArray(status.terminal_counts)) fail('front status');
  const counts = Object.values(status.terminal_counts);
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) fail('front counters');
  return counts.reduce((sum, count) => sum + count, 0);
}

export function readFrontStatus(socketPath) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/status', method: 'GET' }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 65536) req.destroy(new Error('Front status exceeds bound'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) fail('front status HTTP');
          const source = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const result = Object.fromEntries(['ready', 'public_ready', 'journal_healthy', 'terminal_counts', 'terminal_window_started_at',
            'backend_build_sha', 'observation_monotonic_ms', 'active', 'queued', 'dispatching', 'source_manifest'].map((key) => [key, source[key] ?? null]));
          statusCount(result);
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(1000, () => req.destroy(new Error('Front status timed out')));
    req.on('error', reject);
    req.end();
  });
}

export async function readLiveSecretStatus(baseUrl, credentialPath) {
  const url = new URL('/api/admin/live-safety', baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password) fail('safety status requires explicit loopback HTTP');
  const credential = readPrivateJson(credentialPath);
  if (Object.keys(credential).length !== 1 || typeof credential.cliToken !== 'string' || !credential.cliToken
    || credential.cliToken.length > 4096 || /[\r\n]/.test(credential.cliToken)) fail('safety status credential');
  const response = await fetch(url, { headers:{'x-tp-cli-token':credential.cliToken}, redirect:'error', signal:AbortSignal.timeout(2000) });
  if (!response.ok) { await response.body?.cancel(); fail('safety status authentication or HTTP'); }
  const reader = response.body.getReader(), chunks=[]; let bytes=0;
  try { while (true) { const next=await reader.read(); if(next.done) break; bytes+=next.value.length;
    if(bytes>262144) fail('safety status exceeds bound'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(()=>{}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function sampleObservation({ directory, keyringPath, databasePath, driver, controlSocket, releaseId,
  safetyUrl, safetyCredentialPath, captureAcknowledgments,
  readSafety = safetyUrl ? () => readLiveSecretStatus(safetyUrl, safetyCredentialPath) : null,
  readStatus = () => readFrontStatus(controlSocket), now = () => new Date().toISOString() }) {
  if (!SHA.test(releaseId || '')) fail('release evidence SHA256 required');
  const captureStartedAt = now();
  const before = await readStatus();
  statusCount(before);
  const journal = readFrontObservationJournal({ directory, keyringPath });
  const db = await openAnalyticsReadOnly(databasePath, driver);
  let attempts, acknowledgments;
  const secrets = readSafety ? await readSafety() : { unobservable:['runtime-capture-not-configured'] };
  try {
    db.exec('BEGIN');
    const available = new Set(db.all('PRAGMA table_info(requestStats)').map(row=>row.name));
    const extraColumns = ['dispatchCoverage','connectionId','replayDisposition','replaySource','replayStatus','replayObservedAt']
      .map(name=>available.has(name)?name:`NULL AS ${name}`).join(',');
    attempts = db.all(`SELECT id,logicalRequestId,attempt,status,contextTelemetryError,
      terminalState,terminalReason,terminalSource,terminalObservedAt,${extraColumns} FROM requestStats
      WHERE logicalRequestId IS NOT NULL ORDER BY logicalRequestId,attempt,id LIMIT ?`, [MAX_ATTEMPTS + 1]);
    if (attempts.length > MAX_ATTEMPTS) fail('attempt snapshot exceeds bound');
    try {
      const moduleUrl = new URL('../../src/lib/db/adapters/criticalAckJournal.js', import.meta.url).href;
      const capture = captureAcknowledgments || (await import(/* @vite-ignore */ moduleUrl)).captureCriticalAcknowledgments;
      acknowledgments = capture({ databaseFile:databasePath,db });
    } catch { acknowledgments = {unobservable:['acknowledgment-producer-unavailable']}; }
  } finally { db.close(); }
  const after = await readStatus();
  if (statusCount(before) !== statusCount(after) || before.terminal_window_started_at !== after.terminal_window_started_at
    || before.backend_build_sha !== after.backend_build_sha || JSON.stringify(before.source_manifest)!==JSON.stringify(after.source_manifest)) {
    fail('front changed while sampling; retry without pausing traffic');
  }
  return signFrontObservation({ schemaVersion: 1, kind: 'production-observation', releaseId, captureStartedAt,
    captureEndedAt: now(), monotonicStartedMs: before.observation_monotonic_ms,
    monotonicEndedMs: after.observation_monotonic_ms, status: after, ...journal, attempts,
    safety:{secrets,acknowledgments} }, keyringPath);
}

function validateSnapshot(snapshot, keyringPath) {
  verifyFrontObservation(snapshot, keyringPath);
  if (snapshot.schemaVersion !== 1 || snapshot.kind !== 'production-observation' || !SHA.test(snapshot.releaseId || '')
    || !timestamp(snapshot.captureStartedAt) || !timestamp(snapshot.captureEndedAt)
    || !Number.isFinite(snapshot.monotonicStartedMs) || !Number.isFinite(snapshot.monotonicEndedMs)
    || snapshot.monotonicStartedMs < 0 || snapshot.monotonicStartedMs > snapshot.monotonicEndedMs
    || snapshot.captureStartedAt > snapshot.captureEndedAt || !Array.isArray(snapshot.attempts)) fail('snapshot envelope');
  statusCount(snapshot.status);
  if (snapshot.segments.some((segment) => segment.pendingBytes !== 0)) fail('partial journal tail');
  const all = snapshot.segments.flatMap((segment) => segment.events);
  const receipts = new Set();
  for (const event of all) {
    if (receipts.has(event.receiptId)) fail('duplicate event receipt');
    receipts.add(event.receiptId);
  }
  const activeSegments = snapshot.segments.filter((segment) => segment.name.startsWith(`private-${snapshot.active.clockDomain}-`));
  if (!activeSegments.length || activeSegments.some((segment, index) => !segment.name.endsWith(`-${String(index).padStart(8, '0')}.jsonl`))) fail('active segment gap');
  const activeEvents = activeSegments.flatMap((segment) => segment.events);
  if (activeEvents[0]?.kind !== 'process-start' || activeEvents.filter((event) => event.kind === 'terminal').length !== statusCount(snapshot.status)) fail('journal counter coverage');
  return all;
}

function collectRequests(events) {
  const requests = new Map();
  const logicalIds = new Map();
  // Segment names preserve process-local order; clocks never share identities.
  for (const event of events) {
    if (event.kind === 'process-start') continue;
    let row = requests.get(event.frontIngressId);
    if (event.kind === 'start') {
      if (row) fail('duplicate ingress start');
      row = { start: event, logicalRequestId: event.logicalRequestId, terminal: null };
      requests.set(event.frontIngressId, row);
    } else {
      if (!row || row.start.clockDomain !== event.clockDomain || row.terminal) fail('invalid request lifecycle');
      if (row.logicalRequestId && row.logicalRequestId !== event.logicalRequestId) fail('conflicting logical identity');
      row.logicalRequestId = event.logicalRequestId;
      if (event.kind === 'terminal') {
        if (event.firstObservedAt !== row.start.firstObservedAt || event.dataOrigin !== row.start.dataOrigin
          || event.requestClass !== row.start.requestClass) fail('terminal identity mismatch');
        row.terminal = event;
      }
    }
    if (row.logicalRequestId) {
      const owner = logicalIds.get(row.logicalRequestId);
      if (owner && owner !== event.frontIngressId) fail('logical identity reused by ingress');
      logicalIds.set(row.logicalRequestId, event.frontIngressId);
    }
  }
  return requests;
}

export function observationRequestScope(row, begin, end) {
  if (row.start.firstObservedAt < begin.captureEndedAt || row.start.firstObservedAt >= end.captureStartedAt) return 'outsideWindow';
  if (['test','import'].includes(row.start.dataOrigin)) return 'trustedNonProduction';
  if (row.start.dataOrigin !== 'production' || row.start.observationVersion !== 1 || row.start.requestClass === 'unknown') return 'untrustedOriginOrClass';
  return row.start.requestClass === 'inference' ? 'natural' : 'nonInference';
}

export function authenticatedObservationSources(options) {
  const observation = assembleObservation(options);
  const before = options.begin.segments.flatMap(segment=>segment.events);
  const after = options.end.segments.flatMap(segment=>segment.events);
  return { observation,before,after,requests:[...collectRequests(after).values()]
    .filter(row=>observationRequestScope(row,options.begin,options.end)==='natural') };
}

function classify(row, attempts, capturedAt) {
  const terminal = row.terminal;
  if (!terminal) return { category: 'unknown', reason: 'pending-or-interrupted' };
  if (terminal.observationVersion !== 1) return { category: 'unknown', reason: 'missing-signed-reason' };
  if (terminal.terminalReason === 'caller-cancelled' && terminal.state === 'cancelled') return { category: 'callerCancellation', reason: 'caller-cancelled' };
  if (['admission-timeout', 'backend-unavailable'].includes(terminal.terminalReason) && terminal.state === 'failed') return { category: 'proxyFailure', reason: terminal.terminalReason };
  if (!UUID.test(row.logicalRequestId || '')) return { category: 'unknown', reason: 'missing-logical-identity' };
  const rows = attempts.get(row.logicalRequestId) || [];
  if (!rows.length || rows.some((attempt, index) => !Number.isSafeInteger(attempt.attempt) || attempt.attempt !== index + 1
    || attempt.contextTelemetryError || !UUID.test(attempt.id || ''))) return { category: 'unknown', reason: 'ambiguous-or-missing-attempts' };
  if (rows.slice(0, -1).some((attempt) => attempt.status === 'success' || attempt.status === 'pending')) return { category: 'unknown', reason: 'ambiguous-attempt-sequence' };
  const last = rows.at(-1);
  if (!timestamp(last.terminalObservedAt) || last.terminalObservedAt < row.start.firstObservedAt
    || last.terminalObservedAt > capturedAt) return { category: 'unknown', reason: 'missing-backend-terminal-evidence' };
  try {
    normalizeTerminalEvidence({ state: last.terminalState, reason: last.terminalReason, source: last.terminalSource }, last.status);
  } catch { return { category: 'unknown', reason: 'invalid-backend-terminal-evidence' }; }
  if (['provider-stream', 'provider-json', 'provider-http'].includes(last.terminalSource) && last.terminalState === 'failed') return { category: 'providerFailure', reason: last.terminalReason };
  if (terminal.state === 'succeeded' && terminal.terminalReason === 'backend-response-complete' && last.terminalState === 'succeeded') return { category: 'success', reason: last.terminalReason };
  return { category: 'unknown', reason: last.terminalReason || 'unattributed-terminal' };
}

export function assembleObservation({ begin, end, keyringPath }) {
  const before = validateSnapshot(begin, keyringPath);
  const after = validateSnapshot(end, keyringPath);
  if (begin.releaseId !== end.releaseId || begin.active.clockDomain !== end.active.clockDomain
    || begin.status.terminal_window_started_at !== end.status.terminal_window_started_at
    || begin.status.backend_build_sha !== end.status.backend_build_sha) fail('release or front process changed');
  const afterReceipts = new Set(after.map((event) => event.receiptId));
  if (before.some((event) => !afterReceipts.has(event.receiptId))) fail('journal history disappeared');
  const durationMs = end.monotonicStartedMs - begin.monotonicEndedMs;
  const wallDurationMs = Date.parse(end.captureStartedAt) - Date.parse(begin.captureEndedAt);
  if (durationMs < 0 || Math.abs(durationMs - wallDurationMs) > 1000) fail('observation clock discontinuity');
  const attempts = new Map();
  const attemptIds = new Set();
  for (const row of end.attempts) {
    if (attemptIds.has(row.id)) fail('duplicate backend attempt');
    attemptIds.add(row.id);
    const list = attempts.get(row.logicalRequestId) || [];
    list.push(row);
    attempts.set(row.logicalRequestId, list);
  }
  for (const list of attempts.values()) list.sort((a, b) => a.attempt - b.attempt);
  const counts = { naturalLogicalRequests: 0, success: 0, proxyFailure: 0, providerFailure: 0, callerCancellation: 0, unknown: 0 };
  const exclusions = { outsideWindow: 0, trustedNonProduction: 0, nonInference: 0, untrustedOriginOrClass: 0 };
  const unknowns = [];
  for (const [frontIngressId, row] of collectRequests(after)) {
    const scope = observationRequestScope(row,begin,end);
    if (scope !== 'natural') { exclusions[scope]++; continue; }
    counts.naturalLogicalRequests++;
    const result = classify(row, attempts, end.captureEndedAt);
    counts[result.category]++;
    if (result.category === 'unknown') unknowns.push({ frontIngressId, logicalRequestId: row.logicalRequestId, reason: result.reason });
  }
  const proxyFailureRate = counts.naturalLogicalRequests ? counts.proxyFailure / counts.naturalLogicalRequests : null;
  const failures = [];
  if (durationMs < 86400000) failures.push('less-than-24-hours');
  if (counts.naturalLogicalRequests < 1000) failures.push('less-than-1000-natural-logical-requests');
  if (counts.unknown || exclusions.untrustedOriginOrClass) failures.push('unresolved-outcome-evidence');
  if (proxyFailureRate === null || proxyFailureRate >= 0.001) failures.push('proxy-failure-rate-not-below-0.1-percent');
  return { schemaVersion: 1, kind: 'production-observation-result', releaseId: end.releaseId,
    window: { start: begin.captureEndedAt, end: end.captureStartedAt, durationMs },
    snapshots: { beginReceipt: begin.receiptId, endReceipt: end.receiptId }, counts, exclusions, proxyFailureRate,
    unknowns, outcomeGatePassed: failures.length === 0, failures,
    remainingReleaseGates: ['unsafe-replay', 'secret-exposure', 'acknowledged-data-loss', 'deployment-eviction'],
    liveQualificationComplete: false };
}

function readPrivateJson(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES || (stat.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('snapshot file ownership, mode or size');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || !args[index + 1] || Object.hasOwn(options, args[index].slice(2))) fail('arguments');
    options[args[index].slice(2)] = args[index + 1];
  }
  const result = command === 'sample'
    ? await sampleObservation({ directory: options.journal, keyringPath: options.keyring, databasePath: options.database,
      driver: options.driver, controlSocket: options['control-socket'], releaseId: options['release-id'],
      safetyUrl: options['safety-url'], safetyCredentialPath: options['safety-credential'] })
    : command === 'assemble'
      ? assembleObservation({ begin: readPrivateJson(options.begin), end: readPrivateJson(options.end), keyringPath: options.keyring })
      : fail('use sample or assemble');
  if (!path.isAbsolute(options.output || '')) fail('absolute output path required');
  fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: options.output, sha256: digest(result), outcomeGatePassed: result.outcomeGatePassed ?? null })}\n`);
  if (command === 'assemble' && !result.outcomeGatePassed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const reason = /^(?:Observation rejected:|Invalid front outcome journal:)/.test(error?.message || '')
      ? error.message : 'input-or-storage-error';
    process.stderr.write(`Observation failed (${reason}).\n`);
    process.exitCode = 1;
  });
}
