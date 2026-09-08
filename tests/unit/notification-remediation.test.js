import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';
import { createRule, recordFiring } from '@/lib/db/repos/notificationRulesRepo.js';
import { AUTOMATION_LIMITS, readActionPolicy, saveActionPolicy, enqueueAuthorizedAction, executeAction, rollbackAction, inspectAction, previewPolicyAgainstHistory } from '@/lib/notifications/remediation.mjs';

const db = await getAdapter();
const NOW = Date.now() - 5000;
const time = offset => new Date(NOW + offset).toISOString();
beforeEach(() => {
  for (const table of ['notificationActionReceipts','notificationActions','notificationActionPolicyVersions','notificationActionPolicies','notificationRuleEvents','notificationRuleVersions','notificationRules','operationEvents']) db.run(`DELETE FROM ${table}`);
  db.run("DELETE FROM kv WHERE scope='admin.drain'");
  db.run(`INSERT INTO providerConnections(id,provider,authType,isActive,data,createdAt,updatedAt) VALUES('remediation-account','synthetic','apikey',1,'{}',?,?) ON CONFLICT(id) DO NOTHING`,[time(0),time(0)]);
  db.run("UPDATE providerConnections SET isActive=1 WHERE id='remediation-account'");
});
async function setup({ enabled = true, dailyLimit = 3 } = {}) {
  const rule = await createRule({ name:'Bounded synthetic drain',conditionKind:'operation_failure',scopeKind:'connection',scopeId:'remediation-account',threshold:1,durationSeconds:60,cooldownSeconds:60 });
  const input = { ruleId:rule.id,ruleRevision:rule.revision,expectedRevision:0,enabled,action:'drain-account',cooldownSeconds:60,dailyLimit,maxEvidenceAgeSeconds:600 };
  return { rule,input,policy:saveActionPolicy(db,input,NOW) };
}
function firing(rule, { firedAt=time(1000), connectionId='remediation-account', refs, eventId=randomUUID() } = {}) {
  const result = db.run("INSERT INTO operationEvents(operationId,phase,state,subjectKind,subjectId,source,actorClass,connectionId,occurredAt,capturedAt,details) VALUES(?,'reachability','failed','connection',?,'fixture','operator',?,?,?,'{}')",[randomUUID(),connectionId,connectionId,firedAt,firedAt]);
  const evidence = JSON.stringify({ kind:'operationEvent',refs:refs || [String(result.lastInsertRowid)] });
  db.run("INSERT INTO notificationRuleEvents(id,ruleId,ruleRevision,scopeKey,firedAt,breachStartedAt,observedValue,evidence,outcome) VALUES(?,?,?,?,?,?,1,?,'firing')",[eventId,rule.id,rule.revision,connectionId,firedAt,firedAt,evidence]);
  return { id:eventId,ruleId:rule.id,ruleRevision:rule.revision,scopeKey:connectionId,firedAt,evidence };
}
const queued = (rule, options) => db.transaction(() => enqueueAuthorizedAction(db,firing(rule,options),Math.max(NOW+2000, Date.parse(options?.firedAt || time(1000))+1000)));
const drainState = () => db.get("SELECT value FROM kv WHERE scope='admin.drain' AND key='remediation-account'")?.value;

it('requires exact account/rule authority and retained optimistic revisions', async () => {
  const { input,rule,policy } = await setup({ enabled:false });
  expect(policy.enabled).toBe(false);
  expect(() => saveActionPolicy(db,input,NOW)).toThrow(/action_revision_conflict/);
  expect(() => saveActionPolicy(db,{...input,expectedRevision:1,ruleRevision:2},NOW)).toThrow(/rule_revision_conflict/);
  const revised = saveActionPolicy(db,{...input,expectedRevision:1,enabled:true},NOW+100);
  expect(revised.revision).toBe(2); expect(readActionPolicy(db,rule.id).enabled).toBe(true);
  expect(db.get('SELECT COUNT(*) AS n FROM notificationActionPolicyVersions').n).toBe(2);
});

it('does not authorize historical alerts when an operator enables an action later', async () => {
  const { rule } = await setup();
  const old = queued(rule,{ firedAt:time(-1) });
  expect(old).toMatchObject({ state:'skipped',reasonCode:'predates_authorization' });
  expect(drainState()).toBeUndefined();
});

it('dry-runs a queued action without touching state and applies it once transactionally', async () => {
  const { rule } = await setup(); const action = queued(rule);
  expect(executeAction(db,action.id,{now:NOW+3000,dryRun:true})).toMatchObject({ eligible:true,dryRun:true,changed:false });
  expect(drainState()).toBeUndefined();
  expect(executeAction(db,action.id,{now:NOW+3000})).toMatchObject({ state:'applied',changed:true });
  expect(JSON.parse(drainState()).isDraining).toBe(true);
  expect(executeAction(db,action.id,{now:NOW+4000})).toMatchObject({ state:'applied',changed:false });
  expect(inspectAction(db,action.id).receipts.map(row=>row.operation)).toEqual(['enqueue','apply']);
});

it('revalidates policy and manual account changes before applying a queued intent', async () => {
  const { rule,input } = await setup(); const action = queued(rule);
  saveActionPolicy(db,{...input,expectedRevision:1,enabled:false},NOW+2500);
  expect(executeAction(db,action.id,{now:NOW+3000})).toMatchObject({ state:'conflict',receipt:{ reasonCode:'authority_changed' } });
  expect(drainState()).toBeUndefined();
});

it('refuses a queue item after the account was manually drained and restored', async () => {
  const { rule } = await setup(); const action = queued(rule);
  db.run("INSERT INTO kv(scope,key,value) VALUES('admin.drain','remediation-account',?)",[JSON.stringify({isDraining:false,requestedAt:time(2100),completedAt:time(2200)})]);
  expect(executeAction(db,action.id,{now:NOW+3000})).toMatchObject({ state:'conflict',receipt:{reasonCode:'account_state_changed'} });
});

it('refuses missing or mismatched source evidence, including another account', async () => {
  const { rule } = await setup(); const action = queued(rule,{connectionId:'other-account'});
  expect(executeAction(db,action.id,{now:NOW+3000})).toMatchObject({ state:'skipped',receipt:{reasonCode:'event_absent'} });
  const missing=queued(rule,{refs:['missing']});
  expect(executeAction(db,missing.id,{now:NOW+3000})).toMatchObject({ state:'skipped',receipt:{reasonCode:'evidence_unavailable'} });
});

it('acknowledgement or snooze suppresses a queued action without deleting evidence', async () => {
  const { rule } = await setup(); const action = queued(rule);
  db.run("UPDATE notificationRuleEvents SET outcome='acknowledged',acknowledgedAt=?",[time(2500)]);
  expect(executeAction(db,action.id,{now:NOW+3000})).toMatchObject({ state:'skipped',receipt:{reasonCode:'alert_suppressed'} });
  expect(inspectAction(db,action.id).receipts).toHaveLength(2);
});

it('refuses stale evidence at execution even when it was fresh on enqueue', async () => {
  const { rule } = await setup(); const action = queued(rule);
  expect(executeAction(db,action.id,{now:NOW+700000})).toMatchObject({ state:'skipped',receipt:{reasonCode:'evidence_stale'} });
});

it('rolls back only the exact applied state and does not refund the action budget', async () => {
  const { rule } = await setup(); const action = queued(rule);
  executeAction(db,action.id,{now:NOW+3000}); const after = inspectAction(db,action.id).afterState;
  expect(rollbackAction(db,action.id,{expectedAfterState:after,now:NOW+4000})).toMatchObject({state:'rolled-back',changed:true});
  expect(JSON.parse(drainState()).isDraining).toBe(false);
  expect(inspectAction(db,action.id).appliedAt).toBe(time(3000));
  expect(rollbackAction(db,action.id,{expectedAfterState:after,now:NOW+5000})).toMatchObject({state:'conflict',changed:false});
});

it('leaves newer operator changes intact when rollback conflicts', async () => {
  const { rule } = await setup(); const action = queued(rule);
  executeAction(db,action.id,{now:NOW+3000}); const after = inspectAction(db,action.id).afterState;
  const manual=JSON.stringify({...after,requestedAt:time(3500)});
  db.run("UPDATE kv SET value=? WHERE scope='admin.drain'",[manual]);
  expect(rollbackAction(db,action.id,{expectedAfterState:after,now:NOW+4000})).toMatchObject({state:'conflict',changed:false});
  expect(drainState()).toBe(manual);
});

it('enforces per-policy daily limits even after a successful rollback', async () => {
  const { rule } = await setup({dailyLimit:1}); const action = queued(rule);
  executeAction(db,action.id,{now:NOW+3000});
  rollbackAction(db,action.id,{expectedAfterState:inspectAction(db,action.id).afterState,now:NOW+4000});
  db.run("UPDATE notificationRuleEvents SET outcome='acknowledged',acknowledgedAt=?",[time(5000)]);
  const next = queued(rule,{firedAt:time(6000)});
  expect(executeAction(db,next.id,{now:NOW+7000})).toMatchObject({state:'skipped',receipt:{reasonCode:'policy_daily_limit'}});
});

it('preserves action evidence when a dry-run reviews retained history', async () => {
  const { rule,input } = await setup(); queued(rule);
  const before=drainState(), count=db.get('SELECT COUNT(*) AS n FROM notificationActions').n;
  const preview=previewPolicyAgainstHistory(db,{...input,expectedRevision:1},{now:NOW+3000});
  expect(preview).toMatchObject({dryRun:true,changed:false});
  expect(preview.history[0]).toMatchObject({evidenceRetained:true,wouldApplyNow:false});
  expect(drainState()).toBe(before); expect(db.get('SELECT COUNT(*) AS n FROM notificationActions').n).toBe(count);
});

it('captures action intent in the same transaction as a real rule firing', async () => {
  const { rule }=await setup();
  const recorded=await recordFiring(rule,{firedAt:time(1000),breachStartedAt:time(0),observedValue:1,refs:['retained-fixture']},'remediation-account');
  expect(db.get('SELECT eventId FROM notificationActions WHERE eventId=?',[recorded.id]).eventId).toBe(recorded.id);
  expect(await recordFiring(rule,{firedAt:time(1000),refs:[]},'remediation-account')).toBeNull();
  expect(db.get('SELECT COUNT(*) AS n FROM notificationActions').n).toBe(1);
  expect(AUTOMATION_LIMITS.batch).toBeLessThanOrEqual(8);
});
