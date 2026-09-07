import { beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/lib/db/driver.js';
import { saveRequestUsage } from '../../src/lib/db/repos/usageRepo.js';
import { updatePricing } from '../../src/lib/db/repos/pricingRepo.js';
import { createContextTelemetry, recordContextAttempt } from '../../open-sse/handlers/chatCore/contextTelemetry.js';
import { readActivityAnalytics, validateActivityQuery } from '../../src/lib/db/analytics/activityQueries.mjs';
import { recordCostLedger } from '../../src/lib/db/repos/costLedgerRepo.js';

const db=await getAdapter(), stamp='2026-09-06T12:00:00.000Z';
const reference=char=>`ctx1_${char.repeat(64)}`;
const fields={provider:'fixture',model:'model',connectionId:'account'};
const read=(patch={})=>readActivityAnalytics(db,{operation:'activity',view:'economics',...patch});
beforeEach(async()=>{
  db.run('DELETE FROM usageHistory');db.run('DELETE FROM requestStats');db.run('DELETE FROM contextSessions');
  await updatePricing({fixture:{model:{input:2,output:4,cached:0.5,cache_creation:3,reasoning:1}}});
});
async function capture({attempt=1,logical='logical',project='a',client='b',time=stamp,cost=null,latency=500,rid,completionId}={}) {
  const context=createContextTelemetry({timestamp:time,logicalRequestId:logical,attempt,sessionHash:'a'.repeat(64),sessionIdentitySource:'explicit'});
  context.dispatchCoverage='physical-dispatch';
  await recordContextAttempt(context,fields);
  db.run('UPDATE requestStats SET clientKeyId=?,clientIdentitySource=?,clientRef=?,projectRef=?,taskRef=?,latencyTotal=?,latencyTtft=? WHERE id=?',
    ['key','client-reported',reference(client),reference(project),reference('c'),latency,100,context.requestId]);
  await saveRequestUsage({...fields,timestamp:time,requestedModel:'requested-alias',contextTelemetry:context,rid,completionId,
    tokens:{prompt_tokens:100,cached_tokens:60,cache_creation_input_tokens:20,completion_tokens:10,reasoning_tokens:5,...(cost===null?{}:{cost_usd:cost})}});
  return context;
}
describe('authoritative Economics evidence',()=>{
  it('retains an explicit counterfactual identifier through the real usage writer and reads exact evidence',async()=>{
    const rid='economics-writer-roundtrip';
    const completionId='11111111-1111-4111-8111-111111111111';
    const c=await capture({rid,completionId});
    await recordCostLedger({id:rid,completionId,ts:stamp,provider:fields.provider,model:fields.model,baselineUsd:0.001,actualUsd:0.002,savedUsd:-0.001,saverSavedUsd:-0.0012,cacheSavedUsd:0.0002,inputTokens:100,cacheReadTokens:60,cacheWriteTokens:20,outputTokens:10});
    const row=read({requestId:c.requestId}).items[0];
    expect(row.completionId).toBe(completionId);
    expect(row.counterfactual).toMatchObject({available:true,identityBasis:'server-completion-id',modeledDifferenceUsd:-0.001});
    expect(db.get('SELECT completionId FROM usageHistory WHERE requestId=?',[c.requestId]).completionId).toBe(completionId);
    expect(JSON.stringify(row)).not.toContain(rid);
  });
  it('joins actual persisted capture to exact request metrics and captured rates',async()=>{
    const c=await capture();const result=read({requestId:c.requestId}), row=result.items[0];
    expect(row).toMatchObject({requestLink:'linked',requestedModel:'requested-alias',latencyMs:500,ttftMs:100,projectRef:reference('a'),clientIdentitySource:'client-reported'});
    expect(result.summary).toMatchObject({linkedRequestRows:1,explicitSessionRows:1,clientProjectRows:1,costLatencySamples:1,initialAttemptRows:1,additionalAttemptRows:0});
    expect(row.costComponents).toMatchObject({available:true,reconcilesToEstimate:true,reasoningPresent:true,reasoningAdjustmentUsd:-0.000015});
    expect(row.costComponents.totalUsd).toBeCloseTo(row.estimatedCostUsd,12);
    expect(row.costComponents.cacheRateDifferentialUsd).toBeCloseTo(0.00007,12);
    expect(JSON.stringify(result)).not.toContain('sessionHash');
  });
  it('keeps USD provider reports and estimates separate, including reported zero',async()=>{
    await capture({cost:0});const result=read({costSource:'provider-reported'});
    expect(result.summary).toMatchObject({records:1,recordedCostUsd:0,reportedCostUsd:0,providerReportedCostRows:1,confirmedCostRows:0});
    expect(result.items[0].estimatedCostUsd).toBeGreaterThan(0);
    expect(read({costSource:'application-estimate'}).summary.records).toBe(0);
  });
  it('refuses inconsistent identity enrichment without discarding the cost row',async()=>{
    const c=await capture();db.run('UPDATE usageHistory SET logicalRequestId=? WHERE requestId=?',['another',c.requestId]);
    const row=read().items[0];expect(row).toMatchObject({requestLink:'conflict',latencyMs:null,projectRef:null,clientRef:null});
    expect(read({requestLink:'conflict'}).summary).toMatchObject({records:1,conflictingRequestRows:1,costLatencySamples:0});
    expect(read({projectRef:reference('a')}).summary.records).toBe(0);
  });
  it.each(['provider','model','connectionId'])('refuses mismatched %s identity on an exact request id',async field=>{
    const c=await capture();
    db.run(`UPDATE usageHistory SET ${field}=? WHERE requestId=?`,['another',c.requestId]);
    expect(read().items[0]).toMatchObject({requestLink:'conflict',latencyMs:null,projectRef:null});
  });
  it('preserves costs when retained request evidence expires without inventing identity',async()=>{
    const c=await capture();db.run('DELETE FROM requestStats WHERE id=?',[c.requestId]);
    expect(read().items[0]).toMatchObject({requestLink:'unavailable',latencyMs:null,projectRef:null,logicalRequestId:'logical'});
    expect(read({missing:'projectRef'}).summary).toMatchObject({records:1,unavailableRequestRows:1});
  });
  it('filters entire explicit-reference populations and paginates all cohorts',async()=>{
    await capture({project:'a'});await capture({project:'b',attempt:2});await capture({project:'b',attempt:3});
    const first=read({groupBy:'client-project',groupPageSize:1,groupSortBy:'records'});
    expect(first.groupPagination).toMatchObject({totalItems:2,totalPages:2,hasNext:true});expect(first.groups[0].projectRef).toBe(reference('b'));
    expect(read({groupBy:'client-project',groupPageSize:1,groupPage:2}).groups[0].projectRef).toBe(reference('a'));
    const p1=read({projectRef:reference('b'),pageSize:1}),p2=read({projectRef:reference('b'),pageSize:1,page:2});
    expect(p1.summary.records).toBe(2);expect(p1.items[0].id).not.toBe(p2.items[0].id);
    expect(p1.items[0].recordedCostUsd+p2.items[0].recordedCostUsd).toBeCloseTo(p1.summary.recordedCostUsd,12);
  });
  it('classifies additional attempts only with physical coverage and a logical identity',async()=>{
    const first=await capture(), second=await capture({attempt:2}), third=await capture({attempt:3});
    db.run("UPDATE usageHistory SET dispatchCoverage='executor-invocation' WHERE requestId=?",[third.requestId]);
    expect(read({attemptKind:'additional'}).items.map(row=>row.requestId)).toEqual([second.requestId]);
    expect(read({attemptKind:'initial'}).items.map(row=>row.requestId)).toEqual([first.requestId]);
    expect(read({attemptKind:'unknown'}).items.map(row=>row.requestId)).toEqual([third.requestId]);
    expect(read().summary).toMatchObject({records:3,logicalRequests:1,additionalAttemptRows:1});
  });
  it('keeps unknown identity cohorts selectable and shared filters conjunctive',async()=>{
    await capture();db.run('INSERT INTO usageHistory(timestamp,provider,model,cost) VALUES(?,?,?,?)',[stamp,'fixture','model',0]);
    const result=read({groupBy:'client-project',missing:'projectRef',provider:'fixture',start:stamp,end:'2026-09-06T12:01:00.000Z'});
    expect(result.summary.records).toBe(1);expect(result.groups[0].projectRef).toBeNull();
    expect(read({missing:'projectRef',provider:'other'}).summary.records).toBe(0);
  });
  it('does not decompose unknown or inconsistent cache detail',async()=>{
    const c=await capture();db.run('UPDATE usageHistory SET tokens=? WHERE requestId=?',['{}',c.requestId]);
    expect(read().items[0].costComponents).toMatchObject({available:false,reason:'complete-consistent-token-detail-unavailable'});
    db.run('UPDATE usageHistory SET tokens=? WHERE requestId=?',['{"cached_tokens":1000,"cache_creation_input_tokens":0}',c.requestId]);
    expect(read().items[0].costComponents.available).toBe(false);
  });
  it('rejects unsafe and contradictory filters before query execution',()=>{
    for(const patch of [{projectRef:'raw-project'},{missing:'projectRef',projectRef:reference('a')},{requestLink:'guess'},{groupSortBy:'apiKey'},{groupPageSize:101},{groupPage:0}]) {
      expect(()=>validateActivityQuery({operation:'activity',view:'economics',...patch})).toThrow();
    }
  });
});
