import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TABLES, buildCreateTableSql } from '../../src/lib/db/schema.js';
import { readEvidence } from '../../src/lib/db/analytics/evidenceQueries.mjs';
import { readContextSession } from '../../src/lib/db/analytics/contextQueries.mjs';
import { readContextEvents } from '../../src/lib/db/analytics/contextEvents.mjs';
import { measureContextStructure } from '../../open-sse/utils/contextStructure.js';
import { INITIAL_SCOPE } from '../../src/lib/db/analytics/investigationModel.mjs';
let native,db;
const time='2026-09-06T12:00:00.000Z';
const definition=(patch={})=>({schemaVersion:1,lens:'context',scope:{...INITIAL_SCOPE},comparisonIds:[],selection:null,context:{},...patch});
const query=(mode='population',patch={})=>({operation:'evidence',mode,definition:definition(patch)});
beforeEach(()=>{
  native=new Database(':memory:');
  for(const [name,table] of Object.entries(TABLES)) native.exec(buildCreateTableSql(name,table));
  db={get:(sql,args=[])=>native.prepare(sql).get(...args),all:(sql,args=[])=>native.prepare(sql).all(...args)};
  native.prepare('INSERT INTO contextSessions(id,sessionHash,firstSeenAt,lastSeenAt,identitySource,projectLabel) VALUES(?,?,?,?,?,?)').run(1,'PRIVATE-HASH',time,time,'explicit','Operator label');
});
afterEach(()=>native.close());
function attempt(id='r1',account='a',timestamp=time) {
  native.prepare('INSERT INTO requestStats(id,timestamp,contextSessionId,logicalRequestId,clientKeyId,clientRef,provider,model,connectionId,usageSource) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,timestamp,1,'logical-'+id,'key-a','opaque-client','provider','model',account,'missing');
  for(const boundary of ['client-received','gateway-shaped','physical-dispatch']) {
    const value=measureContextStructure({messages:[{role:'user',content:'PRIVATE prompt café'}]},boundary,Buffer.alloc(32,1));
    native.prepare('INSERT INTO contextStructures(requestId,boundary,version,data) VALUES(?,?,?,?)').run(id,boundary,1,JSON.stringify({...value,secret:'PRIVATE-extra'}));
  }
  native.prepare('INSERT INTO contextStages(requestId,ordinal,stage,beforeBytes,afterBytes,deltaBytes,outcome,risk) VALUES(?,?,?,?,?,?,?,?)').run(id,0,'tools',100,120,20,'applied','normalization');
}
function event(id,request='r1',key='key-a',logical='logical-'+request,session=1) {
  native.prepare('INSERT INTO contextClientEvents(id,clientKeyId,clientEventId,occurredAt,recordedAt,type,requestId,logicalRequestId,contextSessionId,clientRef,payloadHash,beforeTokens,afterTokens,tokenMeasurementMethod) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,key,'caller-'+id,'2026-09-06T13:00:00.000Z',time,'compaction',request,logical,session,'opaque-client','PRIVATE-HMAC',100,120,'client-estimate');
}
describe('Context evidence export',()=>{
  it('exports exact owned relations without raw content and keeps explicit reports separate from inference',()=>{
    attempt(); event('owned'); event('other-key','r1','key-b'); event('other-logical','r1','key-a','wrong'); event('unlinked',null,'key-a',null,null);
    native.prepare("UPDATE contextStages SET durationMs=4.5,durationSource='monotonic' WHERE requestId=?").run('r1');
    native.prepare('INSERT INTO usageHistory(timestamp,requestId,logicalRequestId,cost,estimatedCostUsd,reportedCostUsd,costSource,meta,apiKey) VALUES(?,?,?,?,?,?,?,?,?)').run(time,'r1','logical-r1',0,null,null,null,'PRIVATE-meta','PRIVATE-key');
    native.prepare('INSERT INTO usageHistory(timestamp,cost) VALUES(?,?)').run(time,99);
    const result=readEvidence(db,query());
    expect(result.items[0]).toMatchObject({id:'r1',contextSessionId:1,logicalRequestId:'logical-r1',providerInputTokens:null,stages:[{deltaBytes:20,durationMs:4.5,durationSource:'monotonic'}]});
    expect(result.items[0].structures.map(s=>s.boundary)).toEqual(['client-received','gateway-shaped','physical-dispatch']);
    expect(result.items[0].costRecords).toMatchObject([{recordedCostUsd:0,estimatedCostUsd:null,reportedCostUsd:null,costSource:null}]);
    expect(result.clientEvents).toMatchObject([{id:'owned',source:'client-reported',providerVerified:false,beforeTokens:100,afterTokens:120}]);
    expect(result.manifest.coverage).toMatchObject({attributedAttempts:1,attemptsWithStructure:1,relatedClientEvents:1,reconstruction:false});
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(readContextSession(db,1).turns[0].structures).toEqual(result.items[0].structures);
    expect(readContextSession(db,1).turns[0].costRecords).toEqual(result.items[0].costRecords);
    expect(readContextEvents(db,{requestId:'r1'}).events.map(e=>e.id)).toEqual(['owned']);
  });
  it('applies request-time bounds and dimensions to the entire population, including comparison accounts',()=>{
    attempt('r1','a'); attempt('r2','b'); attempt('r3','a','2026-09-06T12:01:00.000Z'); event('e1'); event('e2','r2');
    const result=readEvidence(db,query('comparison',{comparisonIds:['a','deleted'],scope:{...INITIAL_SCOPE,period:'custom',start:'2026-09-06T11:00:00.000Z',end:'2026-09-06T12:01:00.000Z'}}));
    expect(result.items.map(r=>r.id)).toEqual(['r1']); expect(result.clientEvents.map(e=>e.id)).toEqual(['e1']);
    expect(result.manifest.coverage.eventScope).toContain('outside request-time bounds');
    expect(readEvidence(db,query('population',{context:{projectLabel:'missing'}})).items).toEqual([]);
  });
  it('requires exact attempt and session selection and labels selected scope semantics',()=>{
    attempt(); event('e1');
    const result=readEvidence(db,query('selected',{selection:{kind:'context-attempt',id:'r1',sessionId:1},scope:{...INITIAL_SCOPE,provider:'other'}}));
    expect(result.items).toHaveLength(1); expect(result.manifest.scopeSemantics).toContain('Exact selected identity');
    const mismatch=readEvidence(db,query('selected',{selection:{kind:'context-attempt',id:'r1',sessionId:2}}));
    expect(mismatch.items).toEqual([]); expect(mismatch.clientEvents).toEqual([]); expect(mismatch.manifest.missingSelection).toBe(true);
  });
  it('exports two exact attempt/session tuples independently of account comparison and shared filters',()=>{
    attempt('r1','a'); attempt('r2','b'); attempt('r3','a'); event('e1'); event('e2','r2'); event('e3','r3');
    const input=query('attempt-comparison',{schemaVersion:2,selection:{kind:'context-attempt',id:'r2',sessionId:1},context:{baseline:{id:'r1',sessionId:1}},comparisonIds:['unrelated'],scope:{...INITIAL_SCOPE,provider:'absent'}});
    const result=readEvidence(db,input);
    expect(result.items.map(row=>row.id)).toEqual(['r1','r2']);expect(result.clientEvents.map(row=>row.id)).toEqual(['e1','e2']);
    expect(result.manifest).toMatchObject({comparisonComplete:true,missingAttempts:[],timeBounds:{startInclusive:null,endExclusive:null},requestedAttempts:[{role:'selected',id:'r2',sessionId:1},{role:'baseline',id:'r1',sessionId:1}]});
    expect(result.items.every(row=>row.structures.length===3)).toBe(true);
    input.definition.context.baseline.sessionId=99;
    const mismatch=readEvidence(db,input);expect(mismatch.items.map(row=>row.id)).toEqual(['r2']);expect(mismatch.clientEvents.map(row=>row.id)).toEqual(['e2']);
    expect(mismatch.manifest).toMatchObject({comparisonComplete:false,missingAttempts:[{role:'baseline',id:'r1',sessionId:99}]});
    input.definition.context.baseline.id='r2'; expect(()=>readEvidence(db,input)).toThrow(/distinct/);
    input.definition.schemaVersion=1; expect(()=>readEvidence(db,input)).toThrow();
  });
  it('withholds malformed or mismatched boundaries and preserves historical absence',()=>{
    attempt(); native.prepare("UPDATE contextStructures SET data=? WHERE boundary='physical-dispatch'").run('{"raw":"PRIVATE"}');
    native.prepare("UPDATE contextStructures SET boundary='unrecognized' WHERE boundary='gateway-shaped'").run();
    const result=readEvidence(db,query());
    expect(result.items[0].structures).toHaveLength(1); expect(result.manifest.coverage.rejectedStructures).toBe(2);
    native.exec('DELETE FROM contextStructures');
    const historical=readEvidence(db,query());expect(historical.items[0].structures).toEqual([]);expect(historical.items[0].costRecords).toEqual([]);expect(historical.clientEvents).toEqual([]);
  });
  it('refuses related event overflow without returning a partial artifact',()=>{
    attempt(); native.transaction(()=>{for(let n=0;n<5001;n++)event('e'+n);})();
    const result=readEvidence(db,query());expect(result).toMatchObject({refused:true,relatedEventRecords:5001});expect(result).not.toHaveProperty('items');expect(result).not.toHaveProperty('clientEvents');
  });
  it('exports complete populations beyond the page size and preserves ordered stages',()=>{
    native.transaction(()=>{for(let n=0;n<105;n++)attempt('r'+n);})();
    const result=readEvidence(db,query());expect(result.items).toHaveLength(105);expect(result.items.every(r=>r.structures.length===3&&r.stages[0].ordinal===0)).toBe(true);
  });
});
