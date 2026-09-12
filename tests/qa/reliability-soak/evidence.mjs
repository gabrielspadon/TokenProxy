import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const FULL_REQUESTS = 10_000;
export const FULL_DURATION_MS = 60 * 60_000;
export const CASES = Object.freeze([
  'json', 'stream', 'sustained', 'cancel', 'provider-reject', 'stream-reset',
  'malformed', 'unauthorized', 'unknown-model',
]);

export function slope(samples, field) {
  const values = samples.filter((sample) => Number.isFinite(sample[field]) && Number.isFinite(sample.elapsedMs));
  if (values.length < 2) return null;
  const first = values[0].elapsedMs;
  const xs = values.map((sample) => (sample.elapsedMs - first) / 60_000);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = values.reduce((sum, sample) => sum + sample[field], 0) / values.length;
  const denominator = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  return denominator > 0 ? values.reduce((sum, sample, i) => sum + (xs[i] - mx) * (sample[field] - my), 0) / denominator : null;
}

export function resourceSummary(samples) {
  const fields = ['gatewayRssBytes', 'frontRssBytes', 'gatewayFdCount', 'frontFdCount', 'queued', 'active', 'dispatching', 'providerActive'];
  return Object.fromEntries(fields.map((field) => {
    const values = samples.filter((sample) => Number.isFinite(sample[field]));
    return [field, {
      samples: values.length,
      first: values[0]?.[field] ?? null,
      last: values.at(-1)?.[field] ?? null,
      peak: values.length ? Math.max(...values.map((sample) => sample[field])) : null,
      slopePerMinute: slope(values, field),
      monotonicallyGrowing: values.length >= 6 && values.at(-1)[field] > values[0][field]
        && values.every((sample, i) => i === 0 || sample[field] >= values[i - 1][field]),
    }];
  }));
}

export function processResources(identity) {
  const text = readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/u);
  if (fields[19] !== identity.startTime) throw new Error('resource PID identity changed');
  const status = readFileSync(`/proc/${identity.pid}/status`, 'utf8');
  return {
    rssBytes: Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1]) * 1024,
    fdCount: readdirSync(`/proc/${identity.pid}/fd`).length,
  };
}

export function readHistory(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return {
      integrity: db.prepare('PRAGMA quick_check').all(),
      foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all(),
      attempts: db.prepare('SELECT id,logicalRequestId,status,attempt FROM requestStats ORDER BY timestamp,id').all(),
      logical: db.prepare('SELECT logicalRequestId,state,attemptCount,terminalAttemptId FROM logicalRequestOutcomes ORDER BY firstObservedAt,logicalRequestId').all(),
      usage: db.prepare('SELECT requestId,logicalRequestId,status FROM usageHistory ORDER BY id').all(),
      front: db.prepare('SELECT frontIngressId,logicalRequestId,state,terminalStatus FROM frontRequestOutcomes ORDER BY firstObservedAt,frontIngressId').all(),
    };
  } finally { db.close(); }
}

export function readJournal(directory, keyringPath, verify) {
  const keyring = JSON.parse(readFileSync(keyringPath, 'utf8'));
  const records = [];
  const files = [];
  for (const name of readdirSync(directory).filter((name) => /^private-.*\.jsonl$/u.test(name)).sort()) {
    const file = join(directory, name);
    const raw = readFileSync(file);
    if (statSync(file).size > 16 * 1024 * 1024 || raw.at(-1) !== 10) throw new Error('invalid or unfinished journal segment');
    files.push({ name, bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') });
    for (const line of raw.toString('utf8').trimEnd().split('\n')) {
      const record = JSON.parse(line);
      if (!verify(record, keyring)) throw new Error('journal receipt authentication failed');
      records.push(record);
    }
  }
  return { records, files };
}

export function reconcile({ clients, provider, journal, history }) {
  const violations = [];
  const starts = new Map();
  const terminals = new Map();
  for (const record of journal.records) {
    if (record.kind === 'start') {
      if (starts.has(record.frontIngressId)) violations.push('duplicate front start');
      starts.set(record.frontIngressId, record);
    }
    if (record.kind === 'terminal') {
      if (terminals.has(record.frontIngressId)) violations.push('duplicate front terminal');
      terminals.set(record.frontIngressId, record);
    }
  }
  for (const id of starts.keys()) if (!terminals.has(id)) violations.push('unexplained stale front pending');
  for (const id of terminals.keys()) if (!starts.has(id)) violations.push('terminal missing start');
  const dbFront = new Map(history.front.map((row) => [row.frontIngressId, row]));
  if (dbFront.size !== terminals.size) violations.push('front journal and database inventory differ');
  for (const [id, record] of terminals) {
    const row = dbFront.get(id);
    if (!row || row.state !== record.state || row.logicalRequestId !== record.logicalRequestId) violations.push('journal ingestion loss or mismatch');
  }
  const providerByClient = new Map();
  for (const attempt of provider) {
    const list = providerByClient.get(attempt.id) || [];
    list.push(attempt);
    providerByClient.set(attempt.id, list);
  }
  let unsafeReplay = 0;
  const clientIds = new Set(clients.map((row) => row.id));
  if (clientIds.size !== clients.length) violations.push('duplicate client fixture identity');
  if (provider.some((row) => !clientIds.has(row.id))) violations.push('provider dispatch has no client');
  if (provider.some((row) => row.model !== 'fixture-model')) violations.push('fixed selected model changed');
  const usageLogical = new Set(history.usage.map((row) => row.logicalRequestId));
  const logical = new Map(history.logical.map((row) => [row.logicalRequestId, row]));
  for (const client of clients) {
    const dispatches = providerByClient.get(client.id) || [];
    if (dispatches.length > 1) { unsafeReplay += dispatches.length - 1; violations.push(`replayed single-route request ${client.id}`); }
    if (['malformed', 'unauthorized', 'unknown-model'].includes(client.case)) {
      if (dispatches.length !== 0) violations.push(`rejected request dispatched ${client.id}`);
    } else if (dispatches.length !== 1) violations.push(`missing provider dispatch ${client.id}`);
    if (!client.frontIngressId) violations.push(`client missing front identity ${client.id}`);
    else {
      const terminal = terminals.get(client.frontIngressId);
      if (!terminal) violations.push(`client missing terminal ${client.id}`);
      else if (client.case === 'cancel' && terminal.state !== 'cancelled') violations.push(`cancellation misclassified ${client.id}`);
      else if (['json', 'stream', 'sustained'].includes(client.case) && terminal.state !== 'succeeded') violations.push(`successful client misclassified ${client.id}`);
      else if (['stream-reset', 'provider-reject', 'malformed', 'unauthorized', 'unknown-model'].includes(client.case) && terminal.state === 'succeeded') violations.push(`failure classified as success ${client.id}`);
    }
    if (['json', 'stream', 'sustained'].includes(client.case)) {
      if (!client.logicalRequestId) violations.push(`success missing logical identity ${client.id}`);
      else {
        if (!usageLogical.has(client.logicalRequestId)) violations.push(`success missing durable usage ${client.id}`);
        if (logical.get(client.logicalRequestId)?.state !== 'succeeded') violations.push(`success missing logical terminal ${client.id}`);
      }
    }
  }
  const duplicateAttempts = history.attempts.length - new Set(history.attempts.map((row) => row.id)).size;
  if (history.front.some((row) => row.terminalStatus === 503) && clients.every((row) => row.status !== 503)) violations.push('unexplained front refusal or queue eviction');
  const pending = history.front.filter((row) => row.state === 'pending').length
    + history.logical.filter((row) => row.state === 'pending').length
    + history.attempts.filter((row) => row.status === 'pending').length;
  if (pending) violations.push('database contains stale front pending');
  if (duplicateAttempts) violations.push('duplicate physical attempt identity');
  if (history.attempts.some((row) => !row.logicalRequestId)) violations.push('physical attempt missing logical identity');
  if (history.integrity.some((row) => Object.values(row)[0] !== 'ok') || history.foreignKeyViolations.length) violations.push('database integrity failure');
  return {
    state: violations.length ? 'failed' : 'passed', violations,
    clients: clients.length, providerDispatches: provider.length, starts: starts.size, terminals: terminals.size,
    importedFront: history.front.length, physicalAttempts: history.attempts.length, logicalOutcomes: history.logical.length, usageRows: history.usage.length,
    unsafeReplay, stalePending: pending + starts.size - terminals.size, duplicateAttempts,
  };
}

export function qualification(receipt) {
  const failures = [];
  if (receipt.errors.length) failures.push(...receipt.errors);
  if (receipt.clients.some((row) => row.state !== 'passed')) failures.push('client contract failure');
  if (receipt.reconciliation?.state !== 'passed') failures.push('terminal reconciliation incomplete or failed');
  if (!receipt.cleanup?.front?.listenerGone || !receipt.cleanup?.gateway?.listenerGone || !receipt.cleanup?.provider) failures.push('owned cleanup incomplete');
  if (!receipt.cutovers.length || receipt.cutovers.some((row) => row.state !== 'passed')) failures.push('quiet restart contract incomplete or failed');
  if (!receipt.dashboard.length || receipt.dashboard.some((row) => row.state !== 'passed')) failures.push('dashboard reads incomplete or failed');
  if (!receipt.resources.length || !receipt.quiescentResources.length) failures.push('resource evidence missing');
  const full = receipt.mode === 'full' && receipt.deterministicCompleted >= FULL_REQUESTS
    && receipt.mixedDurationMs >= FULL_DURATION_MS && receipt.cutovers.length >= 6
    && CASES.every((scenario) => receipt.clients.some((row) => row.phase === 'deterministic' && row.case === scenario));
  return {
    state: failures.length ? 'failed' : full ? 'passed' : 'not-run',
    reason: failures.length ? [...new Set(failures)].join('; ') : full ? 'full isolated qualification passed' : 'smoke completed; full request count and duration gates not qualified',
    smokeState: failures.length ? 'failed' : 'passed',
  };
}
