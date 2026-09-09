import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const state=vi.hoisted(()=>({db:null,denied:null}));
vi.mock('@/lib/db/driver.js',()=>({getAdapter:async()=>state.db}));
vi.mock('@/lib/admin/guard.js',()=>({requireAdmin:async()=>state.denied}));
import { createBetterSqliteAdapter } from '@/lib/db/adapters/betterSqliteAdapter.js';
import { createSqlJsAdapter } from '@/lib/db/adapters/sqljsAdapter.js';
import { runMigrationOnce } from '@/lib/db/migrate.js';
import { createRule, recordFiring } from '@/lib/db/repos/notificationRulesRepo.js';
import { saveActionPolicy, executeAction, inspectAction, rollbackAction } from '@/lib/notifications/remediation.mjs';
import { drainAuthorizedActions } from '@/lib/notifications/remediationQueue.js';
import { GET, POST } from '@/app/api/admin/notification-actions/route.js';
import { GET as getEvent } from '@/app/api/admin/notification-rules/events/[id]/route.js';

let dir,file;
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenproxy-remediation-'));file=path.join(dir,'data.sqlite');state.denied=null;});
afterEach(()=>{vi.restoreAllMocks();state.db?.close();state.db=null;fs.rmSync(dir,{recursive:true,force:true});});
async function open(driver='better-sqlite3') {
  state.db=await(driver==='sql.js'?createSqlJsAdapter(file):createBetterSqliteAdapter(file));
  await runMigrationOnce(state.db);
}
async function setup({enabled=true}={}) {
  const t=Date.now()-10000,iso=new Date(t).toISOString();
  state.db.run("INSERT INTO providerConnections(id,provider,authType,isActive,data,createdAt,updatedAt) VALUES('account','synthetic','apikey',1,'{}',?,?) ON CONFLICT(id) DO NOTHING",[iso,iso]);
  const rule=await createRule({name:'Synthetic action '+randomUUID(),scopeKind:'connection',scopeId:'account',conditionKind:'operation_failure',threshold:1,durationSeconds:60,cooldownSeconds:60});
  const policy={ruleId:rule.id,ruleRevision:rule.revision,expectedRevision:0,enabled,action:'drain-account',cooldownSeconds:60,dailyLimit:1,maxEvidenceAgeSeconds:300};
  saveActionPolicy(state.db,policy,t);
  return {rule,policy,t};
}
async function fire(rule,t) {
  const at=new Date(t+1000).toISOString(),id=randomUUID();
  const row=state.db.run("INSERT INTO operationEvents(operationId,phase,state,subjectKind,subjectId,source,actorClass,connectionId,occurredAt,capturedAt,details) VALUES(?,'reachability','failed','connection','account','fixture','operator','account',?,?,'{}')",[id,at,at]);
  const event=await recordFiring(rule,{firedAt:at,breachStartedAt:at,observedValue:1,refs:[String(row.lastInsertRowid)]},'account');
  return state.db.get('SELECT id FROM notificationActions WHERE eventId=?',[event.id]).id;
}
const post=body=>new Request('http://localhost/api/admin/notification-actions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const read=async query=>{const response=await GET(new Request('http://localhost/api/admin/notification-actions'+query));return {status:response.status,body:await response.json()};};
const drained=()=>state.db.get("SELECT value FROM kv WHERE scope='admin.drain' AND key='account'");

describe.each(['better-sqlite3','sql.js'])('durable bounded automation on %s',driver=>{
  it('recovers committed intent, changes state once, and retains rollback after reopening',async()=>{
    await open(driver); const {rule,t}=await setup();const id=await fire(rule,t);
    state.db.flush?.();state.db.close();await open(driver);
    expect((await drainAuthorizedActions({adapter:state.db})).outcomes[0]).toMatchObject({state:'applied',persistence:'confirmed'});
    expect((await drainAuthorizedActions({adapter:state.db})).processed).toBe(0);
    const action=inspectAction(state.db,id);
    expect(action.receipts.filter(row=>row.operation==='apply')).toHaveLength(1);
    expect(rollbackAction(state.db,id,{expectedAfterState:action.afterState}).changed).toBe(true);
    state.db.flush?.();state.db.close();await open(driver);
    expect(inspectAction(state.db,id).state).toBe('rolled-back');
    expect(JSON.parse(drained().value).isDraining).toBe(false);
  });
  it('rolls back the drain and state receipt together on a receipt write failure',async()=>{
    await open(driver);const {rule,t}=await setup();const id=await fire(rule,t);
    state.db.exec("CREATE TRIGGER action_fault BEFORE INSERT ON notificationActionReceipts WHEN NEW.operation='apply' BEGIN SELECT RAISE(ABORT,'synthetic disk fault'); END");
    expect(()=>executeAction(state.db,id)).toThrow('synthetic disk fault');
    expect(drained()).toBeFalsy();expect(inspectAction(state.db,id).state).toBe('queued');
    state.db.exec('DROP TRIGGER action_fault');
    expect(executeAction(state.db,id).state).toBe('applied');
  });
  it('enforces bounded batch and aborted queue without losing retained work',async()=>{
    await open(driver);
    for(let i=0;i<12;i++){const {rule,t}=await setup();await fire(rule,t);}
    const controller=new AbortController();controller.abort();
    expect((await drainAuthorizedActions({adapter:state.db,signal:controller.signal})).processed).toBe(0);
    const batch=await drainAuthorizedActions({adapter:state.db});
    expect(batch.processed).toBe(8);expect(batch.outcomes.filter(row=>row.state==='applied')).toHaveLength(1);
    expect(state.db.get("SELECT COUNT(*) AS n FROM notificationActions WHERE state='queued'").n).toBe(4);
  });
});

it('refuses unauthenticated reads and writes before opening storage',async()=>{
  state.denied=new Response('denied',{status:401});
  expect((await GET(new Request('http://localhost/api/admin/notification-actions'))).status).toBe(401);
  expect((await POST(post({action:'save-policy'}))).status).toBe(401);
  expect(state.db).toBeNull();
});
it('requires explicit policy shape, exact revision, body bounds and mutation verb',async()=>{
  await open();const {policy}=await setup({enabled:false});
  let response=await POST(post({action:'save-policy',policy:{...policy,expectedRevision:1,enabled:true}}));
  expect(response.status).toBe(200);expect((await response.json()).persistence).toBe('confirmed');
  response=await POST(post({action:'save-policy',policy:{...policy,expectedRevision:1,enabled:true}}));
  expect(response.status).toBe(409);
  expect((await POST(post({action:'apply',actionId:'unapproved'}))).status).toBe(400);
  expect((await POST(post({action:'save-policy',extra:'invalid',policy}))).status).toBe(400);
  expect((await POST(post({action:'save-policy',policy,padding:'x'.repeat(17000)}))).status).toBe(413);
  for(const query of ['?limit=-1','?ruleId=one&ruleId=two','?unknown=1','?before=missing'])expect((await read(query)).status).toBe(400);
});
it('does not claim a persistence barrier failure is a successful save',async()=>{
  await open('sql.js');const {policy}=await setup({enabled:false});
  vi.spyOn(state.db,'flush').mockImplementation(()=>{throw new Error('synthetic storage unavailable');});
  const response=await POST(post({action:'save-policy',policy:{...policy,expectedRevision:1,enabled:true}}));
  expect(response.status).toBe(207);expect(await response.json()).toMatchObject({changed:true,persistence:'unconfirmed'});
});
it('will not execute an intent if its pre-action durability barrier fails',async()=>{
  await open('sql.js');const {rule,t}=await setup();await fire(rule,t);
  vi.spyOn(state.db,'flush').mockImplementation(()=>{throw new Error('synthetic storage unavailable');});
  await expect(drainAuthorizedActions({adapter:state.db})).rejects.toThrow('synthetic storage unavailable');
  expect(drained()).toBeFalsy();
});
it('reports uncertain persistence after a local action and stops the batch',async()=>{
  await open('sql.js');const {rule,t}=await setup();await fire(rule,t);
  const flush=state.db.flush;let calls=0;
  vi.spyOn(state.db,'flush').mockImplementation(()=>{if(++calls===2)throw new Error('synthetic storage unavailable');flush();});
  const result=await drainAuthorizedActions({adapter:state.db});
  expect(result.outcomes).toHaveLength(1);expect(result.outcomes[0]).toMatchObject({state:'applied',changed:true,persistence:'unconfirmed'});
});
it('retrieves an exact old triggering alert independently of the newest page',async()=>{
  await open();const {rule,t}=await setup();const id=await fire(rule,t),action=inspectAction(state.db,id);
  state.db.run("UPDATE notificationRuleEvents SET firedAt='2000-01-01T00:00:00.000Z' WHERE id=?",[action.eventId]);
  const response=await getEvent(new Request('http://localhost/api/admin/notification-rules/events/'+action.eventId),{params:Promise.resolve({id:action.eventId})});
  expect(response.status).toBe(200);expect((await response.json()).event).toMatchObject({id:action.eventId,ruleDefinition:{name:rule.name}});
});
it('respects the global rolling action limit across different policies',async()=>{
  await open();const {rule,t}=await setup();const id=await fire(rule,t);
  for(let i=0;i<20;i++)state.db.run(`INSERT INTO notificationActions(id,eventId,ruleId,policyRevision,connectionId,policy,beforeState,state,createdAt,updatedAt,appliedAt)
    SELECT ?,?,'prior-policy',policyRevision,connectionId,policy,beforeState,'rolled-back',createdAt,updatedAt,? FROM notificationActions WHERE id=?`,['prior-'+i,'prior-event-'+i,new Date().toISOString(),id]);
  expect(executeAction(state.db,id)).toMatchObject({state:'skipped',receipt:{reasonCode:'global_daily_limit'}});
  expect(drained()).toBeFalsy();
});
