import { randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { normalizeTerminalEvidence } from '../terminalEvidence.js';
import { backendClock, ownerIsDead } from '../../../sse/services/processClock.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STAGES = new Set(['queue', 'selection', 'preparation', 'retry-wait', 'dispatch', 'response-headers', 'stream']);
const OWNER_PREFIX = 'logical-outcome-clock:';

function semanticState(attempts, count, transport, status) {
  if (transport === 'cancelled') return 'cancelled';
  if (transport === 'interrupted') return 'interrupted';
  if (transport === 'error' || status >= 400) return 'failed';
  if (!attempts.length || attempts.length !== count) return 'unknown';
  if (attempts.some((row, index) => row.attempt !== index + 1 || row.contextTelemetryError || !UUID.test(row.id))) return 'unknown';
  if (attempts.slice(0, -1).some((row) => row.status === 'pending' || row.status === 'success')) return 'unknown';
  const last = attempts.at(-1);
  try {
    if (!last.terminalObservedAt) return 'unknown';
    normalizeTerminalEvidence({ state: last.terminalState, reason: last.terminalReason, source: last.terminalSource }, last.status);
  } catch { return 'unknown'; }
  return ['succeeded', 'failed', 'cancelled'].includes(last.terminalState) ? last.terminalState : 'unknown';
}

export function createLogicalOutcomeStore(db, { clock = backendClock, now = () => new Date().toISOString(), monotonic = () => performance.now(), dead = ownerIsDead } = {}) {
  let initialized = false;
  function initialize() {
    if (initialized) return;
    db.transaction(() => {
      for (const record of db.all('SELECT key,value FROM _meta WHERE key LIKE ?', [`${OWNER_PREFIX}%`])) {
        let owner;
        try { owner = JSON.parse(record.value); } catch { continue; }
        if (owner.clockDomain === clock.clockDomain || !UUID.test(owner.clockDomain || '') || !dead(owner, clock)) continue;
        db.run(`UPDATE logicalRequestOutcomes SET state='interrupted',terminalAt=?,updatedAt=?,endToEndDurationMs=NULL,durationSource='unknown'
          WHERE state='pending' AND clockDomain=?`, [now(), now(), owner.clockDomain]);
        db.run(`UPDATE requestStats SET status='cancelled' WHERE status='pending' AND logicalRequestId IN
          (SELECT logicalRequestId FROM logicalRequestOutcomes WHERE clockDomain=? AND state='interrupted')`, [owner.clockDomain]);
      }
      db.run('INSERT INTO _meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING',
        [`${OWNER_PREFIX}${clock.clockDomain}`, JSON.stringify(clock)]);
    });
    initialized = true;
  }
  function begin(logicalRequestId, { dataOrigin = process.env.NODE_ENV === 'test' ? 'test' : 'production', originReceiptId = null,
    startedMs = monotonic(), firstObservedAt = now() } = {}) {
    if (!UUID.test(logicalRequestId) || !['production', 'test', 'import', 'unknown'].includes(dataOrigin)) throw new Error('Invalid logical request identity');
    initialize();
    const token = { logicalRequestId, startedMs, firstObservedAt, clockDomain: clock.clockDomain,
      dataOrigin, originReceiptId, finalized: false };
    db.run(`INSERT INTO logicalRequestOutcomes(logicalRequestId,state,firstObservedAt,clockDomain,dataOrigin,originReceiptId,updatedAt)
      VALUES(?,'pending',?,?,?,?,?) ON CONFLICT(logicalRequestId) DO NOTHING`,
    [logicalRequestId, token.firstObservedAt, clock.clockDomain, dataOrigin, originReceiptId, token.firstObservedAt]);
    return token;
  }
  function finalize(token, { transport = 'complete', status = null, headersMs = null, spans = [] } = {}) {
    if (token.finalized) return db.get('SELECT * FROM logicalRequestOutcomes WHERE logicalRequestId=?', [token.logicalRequestId]);
    const endedMs = monotonic(), at = now();
    let result;
    db.transaction(() => {
      if (['cancelled', 'interrupted'].includes(transport)) db.run(`UPDATE requestStats SET status='cancelled',terminalState=?,terminalReason=?,
        terminalSource='gateway-stream',terminalObservedAt=? WHERE logicalRequestId=? AND status='pending'`,
      [transport === 'cancelled' ? 'cancelled' : 'unknown', transport === 'cancelled' ? 'caller-cancelled' : 'stream-interrupted', at, token.logicalRequestId]);
      const count = db.get('SELECT COUNT(*) AS n FROM requestStats WHERE logicalRequestId=?', [token.logicalRequestId]).n;
      const attempts = db.all(`SELECT id,attempt,status,contextTelemetryError,terminalState,terminalReason,terminalSource,terminalObservedAt
        FROM requestStats WHERE logicalRequestId=? ORDER BY attempt,id LIMIT 129`, [token.logicalRequestId]);
      const state = semanticState(attempts, count, transport, status);
      const durationMs = endedMs >= token.startedMs ? endedMs - token.startedMs : null;
      const terminalAttemptId = attempts.length === count && attempts.every((row, index) => row.attempt === index + 1)
        ? attempts.at(-1)?.id ?? null : null;
      const changed = db.run(`UPDATE logicalRequestOutcomes SET state=?,terminalAt=?,attemptCount=?,terminalAttemptId=?,terminalStatus=?,
        endToEndDurationMs=?,durationSource=?,updatedAt=? WHERE logicalRequestId=? AND clockDomain=? AND state='pending'`,
      [state, at, count, terminalAttemptId, status, durationMs, durationMs === null ? 'unknown' : 'backend-monotonic', at, token.logicalRequestId, token.clockDomain]).changes;
      if (changed) {
        const measured = [...spans];
        if (Number.isFinite(headersMs) && token.startedMs <= headersMs && headersMs <= endedMs) measured.push(
          { stage: 'response-headers', durationMs: headersMs - token.startedMs, relation: 'sequential', outcome: state },
          { stage: 'stream', durationMs: endedMs - headersMs, relation: 'sequential', outcome: state });
        for (const [ordinal, span] of measured.entries()) {
          if (!STAGES.has(span.stage) || !Number.isFinite(span.durationMs) || span.durationMs < 0) throw new Error('Invalid logical timing span');
          db.run(`INSERT INTO requestTimingSpans(id,logicalRequestId,attemptRequestId,frontIngressId,processRole,stage,ordinal,relation,clockDomain,durationMs,outcome,recordedAt,dataOrigin,originReceiptId)
            VALUES(?,?,?,NULL,'backend',?,?,?,?,?,?,?,?,?)`,
          [randomUUID(), token.logicalRequestId, span.attemptRequestId ?? null, span.stage, ordinal,
            span.relation === 'sequential' ? 'sequential' : 'overlap', token.clockDomain, span.durationMs,
            ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(span.outcome) ? span.outcome : 'unknown', at, token.dataOrigin, token.originReceiptId]);
        }
      }
      result = db.get('SELECT * FROM logicalRequestOutcomes WHERE logicalRequestId=?', [token.logicalRequestId]);
    });
    token.finalized = true;
    return result;
  }
  return { begin, finalize, initialize };
}

const stores = new WeakMap();
export async function getLogicalOutcomeStore() {
  const db = await getAdapter();
  if (!stores.has(db)) stores.set(db, createLogicalOutcomeStore(db));
  return stores.get(db);
}
