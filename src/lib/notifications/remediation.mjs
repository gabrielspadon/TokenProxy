import { randomUUID } from 'node:crypto';
import { canonicalConfig } from '../db/helpers/configHistory.js';

export const AUTOMATION_LIMITS = Object.freeze({ queued: 256, batch: 8, dailyGlobal: 20 });
export const AUTOMATION_CONDITIONS = Object.freeze(['quota_risk','stale_telemetry','repeated_fallback','operation_failure','compression_saver_failure']);
export const DRAIN_EFFECT = 'Stops subsequent dispatch to this account. In-flight responses continue. Sessions may need another eligible account on their next request, which can break cache continuity. Restoring permits subsequent selection; it does not move a running response.';
export class AutomationError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const parse = value => { try { return JSON.parse(value); } catch { throw new AutomationError('retained_state_unreadable', 503); } };
const iso = value => new Date(value).toISOString();
const policyRow = row => row ? { ...row, enabled: Boolean(row.enabled) } : null;
const same = (left, right) => canonicalConfig(left) === canonicalConfig(right);
const drain = (db, id) => {
  const row = db.get("SELECT value FROM kv WHERE scope='admin.drain' AND key=?", [id]);
  return row ? parse(row.value) : null;
};
const readRule = (db, id) => db.get('SELECT * FROM notificationRules WHERE id=?', [id]);
export const readActionPolicy = (db, id) => policyRow(db.get('SELECT * FROM notificationActionPolicies WHERE ruleId=?', [id]));
export function validateActionPolicy(db, input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['ruleId','ruleRevision','expectedRevision','enabled','action','cooldownSeconds','dailyLimit','maxEvidenceAgeSeconds'].includes(key))) throw new AutomationError('invalid_action_policy');
  if (typeof input.ruleId !== 'string' || !input.ruleId || input.ruleId.length > 128 || !Number.isSafeInteger(input.ruleRevision) || input.ruleRevision < 1) throw new AutomationError('invalid_rule_identity');
  const rule = readRule(db, input.ruleId);
  if (!rule) throw new AutomationError('rule_not_found', 404);
  if (rule.revision !== input.ruleRevision) throw new AutomationError('rule_revision_conflict', 409);
  if (rule.scopeKind !== 'connection' || !rule.scopeId) throw new AutomationError('one_account_rule_required');
  if (!AUTOMATION_CONDITIONS.includes(rule.conditionKind)) throw new AutomationError('condition_has_no_account_action');
  if (!db.get('SELECT id FROM providerConnections WHERE id=?', [rule.scopeId])) throw new AutomationError('account_not_found', 404);
  if (input.action !== 'drain-account' || typeof input.enabled !== 'boolean') throw new AutomationError('invalid_action');
  if (input.enabled && !rule.enabled) throw new AutomationError('rule_disabled', 409);
  for (const [key, min, max] of [['cooldownSeconds',60,86400],['dailyLimit',1,10],['maxEvidenceAgeSeconds',60,3600]]) {
    if (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max) throw new AutomationError(`invalid_${key}`);
  }
  const existing = readActionPolicy(db, rule.id);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== (existing?.revision || 0)) throw new AutomationError('action_revision_conflict', 409);
  return { ruleId: rule.id, ruleRevision: rule.revision, connectionId: rule.scopeId, revision: (existing?.revision || 0) + 1,
    action: input.action, enabled: input.enabled, cooldownSeconds: input.cooldownSeconds, dailyLimit: input.dailyLimit,
    maxEvidenceAgeSeconds: input.maxEvidenceAgeSeconds, createdAt: existing?.createdAt || iso(now), updatedAt: iso(now) };
}
export function saveActionPolicy(db, input, now = Date.now()) {
  return db.transaction(() => {
    const policy = validateActionPolicy(db, input, now);
    db.run(`INSERT INTO notificationActionPolicies(ruleId,revision,ruleRevision,connectionId,action,enabled,cooldownSeconds,dailyLimit,maxEvidenceAgeSeconds,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ruleId) DO UPDATE SET revision=excluded.revision,ruleRevision=excluded.ruleRevision,
      connectionId=excluded.connectionId,action=excluded.action,enabled=excluded.enabled,cooldownSeconds=excluded.cooldownSeconds,
      dailyLimit=excluded.dailyLimit,maxEvidenceAgeSeconds=excluded.maxEvidenceAgeSeconds,updatedAt=excluded.updatedAt`,
    [policy.ruleId,policy.revision,policy.ruleRevision,policy.connectionId,policy.action,Number(policy.enabled),policy.cooldownSeconds,policy.dailyLimit,policy.maxEvidenceAgeSeconds,policy.createdAt,policy.updatedAt]);
    db.run('INSERT INTO notificationActionPolicyVersions(ruleId,revision,definition,createdAt) VALUES(?,?,?,?)', [policy.ruleId,policy.revision,JSON.stringify(policy),iso(now)]);
    return policy;
  });
}
function receipt(db, id, operation, outcome, reasonCode, details, now) {
  const result = db.run('INSERT INTO notificationActionReceipts(actionId,operation,outcome,reasonCode,details,createdAt) VALUES(?,?,?,?,?,?)', [id,operation,outcome,reasonCode,JSON.stringify(details),iso(now)]);
  return { id: Number(result.lastInsertRowid), actionId: id, operation, outcome, reasonCode, details, createdAt: iso(now) };
}
function evidenceReason(event, policy, now) {
  const time = Date.parse(event.firedAt);
  if (!Number.isFinite(time) || time > now || time < now - policy.maxEvidenceAgeSeconds * 1000) return 'evidence_stale';
  if (time < Date.parse(policy.updatedAt)) return 'predates_authorization';
  const refs = typeof event.evidence === 'string' ? parse(event.evidence).refs : event.evidence?.refs;
  if (!Array.isArray(refs) || !refs.length) return 'evidence_absent';
  return null;
}
function retainedEvidenceMatches(db, event, rule) {
  const evidence = typeof event.evidence === 'string' ? parse(event.evidence) : event.evidence;
  const refs = evidence?.refs;
  if (!Array.isArray(refs) || !refs.length || refs.length > 200) return false;
  return refs.every(ref => {
    if (typeof ref !== 'string' || ref.length > 2048) return false;
    if (['quota_risk','stale_telemetry'].includes(rule.conditionKind) && evidence.kind === 'quotaObservation') {
      return Boolean(db.get("SELECT id FROM quotaObservations WHERE id=? AND connectionId=? AND observationKind='observed'",[ref,rule.scopeId]));
    }
    if (rule.conditionKind === 'repeated_fallback' && evidence.kind === 'accountSwitch') {
      return Boolean(db.get("SELECT id FROM accountSwitches WHERE id=? AND fromConnectionId=? AND trigger NOT IN ('initial-pin','first-pin')",[ref,rule.scopeId]));
    }
    if (rule.conditionKind === 'operation_failure' && evidence.kind === 'operationEvent') {
      return Boolean(db.get("SELECT id FROM operationEvents WHERE id=? AND connectionId=? AND state='failed'",[ref,rule.scopeId]));
    }
    if (rule.conditionKind === 'compression_saver_failure' && evidence.kind === 'contextStage') {
      let pair; try { pair = JSON.parse(ref); } catch { return false; }
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !Number.isSafeInteger(pair[1])) return false;
      return Boolean(db.get(`SELECT s.requestId FROM contextStages s JOIN requestStats r ON r.id=s.requestId
        WHERE s.requestId=? AND s.ordinal=? AND r.connectionId=? AND s.outcome='failed' AND s.outcomeSource='execution'
        AND (s.executionRequestId IS NULL OR s.executionRequestId=s.requestId)`,[pair[0],pair[1],rule.scopeId]));
    }
    return false;
  });
}
export function enqueueAuthorizedAction(db, event, now = Date.now()) {
  const policy = readActionPolicy(db, event.ruleId);
  if (!policy?.enabled || policy.ruleRevision !== event.ruleRevision) return null;
  if (db.get('SELECT id FROM notificationActions WHERE eventId=?', [event.id])) return null;
  const reason = evidenceReason(event, policy, now) ||
    (db.get("SELECT COUNT(*) AS n FROM notificationActions WHERE state='queued'").n >= AUTOMATION_LIMITS.queued ? 'queue_full' : null);
  const id = randomUUID(), beforeState = drain(db, policy.connectionId), state = reason ? 'skipped' : 'queued';
  db.run('INSERT INTO notificationActions(id,eventId,ruleId,policyRevision,connectionId,policy,beforeState,state,reasonCode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [id,event.id,event.ruleId,policy.revision,policy.connectionId,JSON.stringify(policy),JSON.stringify(beforeState),state,reason,iso(now),iso(now)]);
  receipt(db,id,'enqueue',state,reason,{ ruleRevision: event.ruleRevision, policyRevision: policy.revision },now);
  return { id, state, reasonCode: reason };
}
function eligibility(db, item, now) {
  const policy = parse(item.policy), currentPolicy = readActionPolicy(db, item.ruleId), rule = readRule(db, item.ruleId);
  if (!currentPolicy?.enabled || currentPolicy.revision !== item.policyRevision || !same(policy,currentPolicy)) return 'authority_changed';
  if (!rule?.enabled || rule.revision !== policy.ruleRevision || rule.scopeKind !== 'connection' || rule.scopeId !== item.connectionId) return 'rule_changed';
  const event = db.get('SELECT * FROM notificationRuleEvents WHERE id=?', [item.eventId]);
  if (!event || event.ruleRevision !== policy.ruleRevision || event.scopeKey !== item.connectionId) return 'event_absent';
  if (event.outcome !== 'firing' || (event.snoozedUntil && Date.parse(event.snoozedUntil) > now)) return 'alert_suppressed';
  const evidence = evidenceReason(event,policy,now); if (evidence) return evidence;
  if (!retainedEvidenceMatches(db,event,rule)) return 'evidence_unavailable';
  const account = db.get('SELECT isActive FROM providerConnections WHERE id=?', [item.connectionId]);
  if (!account || !account.isActive) return 'account_unavailable';
  const current = drain(db,item.connectionId);
  if (!same(current,parse(item.beforeState))) return 'account_state_changed';
  if (current?.isDraining) return 'already_draining';
  const from = iso(now - 86400000);
  if (db.get('SELECT COUNT(*) AS n FROM notificationActions WHERE appliedAt>=?', [from]).n >= AUTOMATION_LIMITS.dailyGlobal) return 'global_daily_limit';
  const prior = db.get('SELECT COUNT(*) AS n,MAX(appliedAt) AS last FROM notificationActions WHERE ruleId=? AND appliedAt>=?', [item.ruleId,from]);
  if (prior.n >= policy.dailyLimit) return 'policy_daily_limit';
  if (prior.last && Date.parse(prior.last) > now - policy.cooldownSeconds * 1000) return 'policy_cooldown';
  return null;
}
export function inspectAction(db, id) {
  const row = db.get('SELECT * FROM notificationActions WHERE id=?', [id]);
  return row ? { ...row, policy: parse(row.policy), beforeState: parse(row.beforeState), afterState: row.afterState ? parse(row.afterState) : null,
    receipts: db.all('SELECT * FROM notificationActionReceipts WHERE actionId=? ORDER BY id', [id]).map(row => ({ ...row,details:parse(row.details) })) } : null;
}
export function executeAction(db, id, { now = Date.now(), dryRun = false } = {}) {
  return db.transaction(() => {
    const item = db.get('SELECT * FROM notificationActions WHERE id=?', [id]);
    if (!item) throw new AutomationError('action_not_found',404);
    if (item.state !== 'queued') return { id, state:item.state, changed:false, dryRun };
    const reason = eligibility(db,item,now);
    if (dryRun) return { id,dryRun:true,eligible:!reason,reasonCode:reason,changed:false,effect:DRAIN_EFFECT,connectionId:item.connectionId };
    if (reason) {
      const state = ['authority_changed','rule_changed','account_state_changed'].includes(reason) ? 'conflict' : 'skipped';
      db.run('UPDATE notificationActions SET state=?,reasonCode=?,updatedAt=? WHERE id=?',[state,reason,iso(now),id]);
      return { id,state,changed:false,receipt:receipt(db,id,'apply',state,reason,{},now) };
    }
    const after = { isDraining:true,requestedAt:iso(now),completedAt:null };
    db.run("INSERT INTO kv(scope,key,value) VALUES('admin.drain',?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value",[item.connectionId,JSON.stringify(after)]);
    db.run("UPDATE notificationActions SET state='applied',afterState=?,appliedAt=?,updatedAt=? WHERE id=?",[JSON.stringify(after),iso(now),iso(now),id]);
    return { id,state:'applied',changed:true,connectionId:item.connectionId,receipt:receipt(db,id,'apply','applied',null,{ effect:DRAIN_EFFECT },now) };
  });
}
export function rollbackAction(db, id, { expectedAfterState, now = Date.now() } = {}) {
  return db.transaction(() => {
    const item = db.get('SELECT * FROM notificationActions WHERE id=?', [id]);
    if (!item) throw new AutomationError('action_not_found',404);
    if (item.state !== 'applied' || !same(expectedAfterState,parse(item.afterState)) || !same(drain(db,item.connectionId),parse(item.afterState))) {
      return { id,state:'conflict',changed:false,receipt:receipt(db,id,'rollback','conflict','account_state_changed',{},now) };
    }
    if (!db.get('SELECT id FROM providerConnections WHERE id=?',[item.connectionId])) throw new AutomationError('account_not_found',404);
    const before = parse(item.beforeState);
    const restored = before || { isDraining:false,requestedAt:parse(item.afterState).requestedAt,completedAt:iso(now) };
    db.run("UPDATE kv SET value=? WHERE scope='admin.drain' AND key=?",[JSON.stringify(restored),item.connectionId]);
    db.run("UPDATE notificationActions SET state='rolled-back',updatedAt=? WHERE id=?",[iso(now),id]);
    return { id,state:'rolled-back',changed:true,connectionId:item.connectionId,receipt:receipt(db,id,'rollback','applied',null,{ restored },now) };
  });
}

export function listActions(db, { ruleId = null, before = null, limit = 50 } = {}) {
  if ((ruleId !== null && typeof ruleId !== 'string') || (before !== null && typeof before !== 'string') || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AutomationError('invalid_pagination');
  const cursor = before ? db.get('SELECT createdAt,id FROM notificationActions WHERE id=?',[before]) : null;
  if (before && !cursor) throw new AutomationError('unknown_cursor');
  const clauses=[], params=[];
  if (ruleId) { clauses.push('ruleId=?'); params.push(ruleId); }
  if (cursor) { clauses.push('(createdAt<? OR (createdAt=? AND id<?))'); params.push(cursor.createdAt,cursor.createdAt,cursor.id); }
  const rows = db.all(`SELECT * FROM notificationActions ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY createdAt DESC,id DESC LIMIT ?`,[...params,limit+1]);
  return { items: rows.slice(0,limit).map(row => ({ ...row, policy:parse(row.policy),beforeState:parse(row.beforeState),afterState:row.afterState?parse(row.afterState):null })),
    next: rows.length > limit ? rows[limit-1].id : null };
}
export function previewPolicyAgainstHistory(db, input, { now = Date.now(), limit = 100 } = {}) {
  const policy = validateActionPolicy(db,input,now);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AutomationError('invalid_limit');
  const rows = db.all('SELECT * FROM notificationRuleEvents WHERE ruleId=? ORDER BY firedAt DESC,id LIMIT ?', [policy.ruleId,limit+1]);
  const rule = readRule(db,policy.ruleId);
  let drained = false, last = null;
  const simulatedTimes=[];
  const history = rows.slice(0,limit).reverse().map(event => {
    const eventTime=Date.parse(event.firedAt), retained=retainedEvidenceMatches(db,event,rule);
    const sameRule=event.ruleRevision===policy.ruleRevision && event.scopeKey===policy.connectionId;
    const reason = !policy.enabled ? 'policy_disabled' : !sameRule ? 'different_rule_revision' : !retained ? 'evidence_unavailable'
      : drained ? 'already_draining' : simulatedTimes.filter(value=>value>=eventTime-86400000).length>=policy.dailyLimit ? 'policy_daily_limit'
      : last!==null && eventTime-last<policy.cooldownSeconds*1000 ? 'policy_cooldown' : null;
    if (!reason) { drained=true; last=eventTime; simulatedTimes.push(eventTime); }
    return { eventId:event.id,firedAt:event.firedAt,ruleRevision:event.ruleRevision,evidenceRetained:retained,
      wouldApplyNow:false,reasonCode:'historical_authorization_not_replayed',simulation:{ outcome:reason?'skipped':'drain',reasonCode:reason } };
  }).reverse();
  return { dryRun:true, changed:false, policy, effect:DRAIN_EFFECT, coverage:{ limit,hasMore:rows.length>limit },
    assumptions:['Account starts available at the first selected event.','No operator restore or competing policy acts during this scenario.','Historical availability and action-time telemetry freshness are unknown.','Current rule revision must match each event. Historical alerts are never enqueued.'],history };
}
