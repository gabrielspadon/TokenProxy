import { createHash, randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { insertQuotaCheckEvent } from './quotaHistoryRepo.js';

export const QUOTA_CHECK_BATCH_SIZE = 8;
export const QUOTA_CHECK_LEASE_MS = 120_000;
const reasons = new Set(['poll-not-before', 'reset-not-before', 'probe-not-before', 'verify-not-before', 'retry-not-before']);
const cancellations = new Set(['account-inactive', 'setting-disabled', 'auth-unsupported', 'account-missing', 'scheduler-stopped', 'ownership-lost', 'check-deadline']);
const iso = value => new Date(value).toISOString();
const identity = (id, provider) => createHash('sha256').update(JSON.stringify([id, provider])).digest('hex');
const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const isOwner = (db, claim, now) => !!db.get(
  "SELECT id FROM quotaCheckJobs WHERE id=? AND claimToken=? AND status='running' AND leaseExpiresAt>?",
  [claim.id, claim.claimToken, iso(now)],
);

// This queue schedules metadata checks. A claim grants no permission for a paid
// warming request, whose opt-in and durable attempt guard are checked separately.
// Native SQLite coordinates same-host writers. sql.js remains a single-writer
// process with durable snapshots; it cannot coordinate another process's memory.
export function createQuotaCheckQueue(db) {
  const publish = result => { db.flush?.(); return result; };
  const event = (row, type, code, now, fields = {}) => insertQuotaCheckEvent(db, {
    jobId: row.id, checkId: row.checkId || randomUUID(), connectionId: row.connectionId, provider: row.provider,
    eventType: type, code, capturedAt: iso(now), ...fields,
  });
  const cancelRow = (row, reason, now) => {
    const changed = db.run("UPDATE quotaCheckJobs SET status='cancelled',cancelReason=?,claimToken=NULL,leaseExpiresAt=NULL,finishedAt=?,lastOutcome='cancelled',updatedAt=? WHERE id=? AND status!='cancelled'", [reason, iso(now), iso(now), row.id]).changes;
    if (changed) event(row, 'cancelled', reason, now);
    return changed;
  };
  return {
    coordination: db.driver === 'sql.js' ? 'single-process-snapshot' : 'same-host-sqlite',
    reconcile(accounts, now = Date.now()) {
      const stamp = iso(now);
      const eligible = new Map();
      for (const account of accounts) {
        if (!validText(account.id) || !validText(account.provider) || account.cancelReason != null && !cancellations.has(account.cancelReason)) throw new TypeError('Invalid quota check account');
        eligible.set(identity(account.id, account.provider), account);
      }
      return publish(db.transaction(() => {
        let changed = 0;
        for (const row of db.all('SELECT * FROM quotaCheckJobs')) {
          const account = eligible.get(row.id);
          const reason = account?.cancelReason ?? (account ? null : 'account-missing');
          if (reason && row.status !== 'cancelled') changed += cancelRow(row, reason, now);
        }
        for (const [id, account] of eligible) {
          if (account.cancelReason) continue;
          changed += db.run(`INSERT INTO quotaCheckJobs(id,connectionId,provider,status,nextCheckAt,reason,createdAt,updatedAt)
            VALUES(?,?,?,'scheduled',?,'poll-not-before',?,?) ON CONFLICT(id) DO UPDATE SET status='scheduled',nextCheckAt=excluded.nextCheckAt,
            reason='poll-not-before',cancelReason=NULL,checkId=NULL,claimToken=NULL,leaseExpiresAt=NULL,updatedAt=excluded.updatedAt WHERE quotaCheckJobs.status='cancelled'`,
          [id, account.id, account.provider, stamp, stamp, stamp]).changes;
        }
        return changed;
      }));
    },
    due(limit = QUOTA_CHECK_BATCH_SIZE, now = Date.now()) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('Invalid quota check batch');
      return db.all("SELECT id,connectionId,provider FROM quotaCheckJobs WHERE (status='scheduled' AND nextCheckAt<=?) OR (status='running' AND leaseExpiresAt<=?) ORDER BY nextCheckAt,id LIMIT ?", [iso(now), iso(now), limit]);
    },
    claim(id, now = Date.now(), leaseMs = QUOTA_CHECK_LEASE_MS) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600_000) throw new TypeError('Invalid quota check lease');
      return publish(db.transaction(() => {
        const claimToken = randomUUID(), checkId = randomUUID();
        const result = db.run(`UPDATE quotaCheckJobs SET status='running',claimToken=?,checkId=?,leaseExpiresAt=?,startedAt=?,finishedAt=NULL,updatedAt=?
          WHERE id=? AND ((status='scheduled' AND nextCheckAt<=?) OR (status='running' AND leaseExpiresAt<=?))`,
        [claimToken, checkId, iso(now + leaseMs), iso(now), iso(now), id, iso(now), iso(now)]);
        return result.changes ? db.get('SELECT * FROM quotaCheckJobs WHERE id=?', [id]) : null;
      }));
    },
    owns(claim, now = Date.now()) { return isOwner(db, claim, now); },
    cancel(claim, reason, now = Date.now()) {
      if (!cancellations.has(reason)) throw new TypeError('Invalid quota check cancellation');
      return publish(db.transaction(() => isOwner(db, claim, now) ? cancelRow(claim, reason, now) > 0 : false));
    },
    renew(claim, now = Date.now(), leaseMs = QUOTA_CHECK_LEASE_MS) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600_000) throw new TypeError('Invalid quota check lease');
      return publish(db.run("UPDATE quotaCheckJobs SET leaseExpiresAt=?,updatedAt=? WHERE id=? AND claimToken=? AND status='running' AND leaseExpiresAt>?", [iso(now + leaseMs), iso(now), claim.id, claim.claimToken, iso(now)]).changes > 0);
    },
    complete(claim, { nextCheckAt, reason, targets = [], outcome }, now = Date.now()) {
      if (!reasons.has(reason) || !['completed', 'failed'].includes(outcome) || !Number.isFinite(Date.parse(nextCheckAt)) || !Array.isArray(targets) || targets.length > 100) throw new TypeError('Invalid quota check completion');
      return publish(db.transaction(() => {
        if (!isOwner(db, claim, now)) return false;
        const evidence = targets.map(target => {
          if (target.scope != null && !validText(target.scope) || target.resetAt != null && !Number.isFinite(Date.parse(target.resetAt))) throw new TypeError('Invalid quota check target');
          const observation = target.observationId ? db.get('SELECT id,resourceType,unit,resetAt FROM quotaObservations WHERE id=? AND connectionId=? AND provider=? AND scope IS ?', [target.observationId, claim.connectionId, claim.provider, target.scope ?? null]) : null;
          if (target.observationId && !observation) throw new TypeError('Quota observation does not match check target');
          if (observation && target.resetAt != null && iso(target.resetAt) !== observation.resetAt) throw new TypeError('Quota reset does not match prior observation');
          return { scope: target.scope ?? null, resetAt: target.resetAt ? iso(target.resetAt) : null,
            observationId: observation?.id ?? null, resourceType: observation?.resourceType ?? null, unit: observation?.unit ?? null };
        });
        const changed = db.run(`UPDATE quotaCheckJobs SET status='scheduled',nextCheckAt=?,reason=?,targets=?,lastOutcome=?,finishedAt=?,claimToken=NULL,leaseExpiresAt=NULL,updatedAt=? WHERE id=? AND claimToken=?`,
          [iso(nextCheckAt), reason, JSON.stringify(evidence), outcome, iso(now), iso(now), claim.id, claim.claimToken]).changes > 0;
        if (changed) for (const target of evidence.length ? evidence : [{}]) event(claim, 'scheduled', reason, now, {
          scope: target.scope, observationId: target.observationId, resetAt: target.resetAt, scheduledFor: iso(nextCheckAt),
        });
        return changed;
      }));
    },
    cancelAll(reason = 'setting-disabled', now = Date.now()) {
      if (!cancellations.has(reason)) throw new TypeError('Invalid quota check cancellation');
      return publish(db.transaction(() => db.all("SELECT * FROM quotaCheckJobs WHERE status!='cancelled'").reduce((count, row) => count + cancelRow(row, reason, now), 0)));
    },
    list({ connectionId, provider, status, page = 1, pageSize = 50 } = {}) {
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200 || !Number.isSafeInteger((page - 1) * pageSize)) throw new TypeError('Invalid quota check pagination');
      const clauses = [], params = [];
      for (const [key, value] of Object.entries({ connectionId, provider, status })) {
        if (value == null) continue;
        if (!validText(value) || key === 'status' && !['scheduled', 'running', 'cancelled'].includes(value)) throw new TypeError('Invalid quota check filter');
        clauses.push(`${key}=?`); params.push(value);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = db.get(`SELECT COUNT(*) AS total FROM quotaCheckJobs ${where}`, params).total;
      const rows = db.all(`SELECT id,connectionId,provider,status,nextCheckAt,reason,targets,checkId,leaseExpiresAt,startedAt,finishedAt,lastOutcome,cancelReason,createdAt,updatedAt FROM quotaCheckJobs ${where} ORDER BY nextCheckAt,id LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
      return { items: rows.map(row => ({ ...row, targets: JSON.parse(row.targets) })), total, page, pageSize, hasMore: page * pageSize < total,
        coordination: this.coordination, execution: 'metadata-check', timing: 'not-before', concurrency: 1, concurrencyScope: 'process', maxChecksPerTick: QUOTA_CHECK_BATCH_SIZE };
    },
  };
}

export async function getQuotaCheckQueue() { return createQuotaCheckQueue(await getAdapter()); }
