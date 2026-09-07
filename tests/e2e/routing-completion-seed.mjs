import assert from 'node:assert/strict';
import { measureContextStructure } from '../../open-sse/utils/contextStructure.js';

export const ROUTING_FIXTURE = Object.freeze({ version: 'routing-completion-v1', capturedAt: '2026-09-07T12:00:00.000Z', accountId: 'connection-fixture-alpha', targetId: 'connection-fixture-beta', model: 'gpt-4o', sessionHash: 'd'.repeat(64), logicalRequestId: 'routing-fixture-logical-1', requests: ['routing-fixture-attempt-1', 'routing-fixture-attempt-2'] });

export function routingFixtureStructure(index, boundary) {
  const body={messages:[{role:'user',content:''}]};
  const size=boundary === 'client-received' || !index ? 16000 : 15700;
  body.messages[0].content='x'.repeat(size-Buffer.byteLength(JSON.stringify(body)));
  return measureContextStructure(body,boundary,Buffer.alloc(32,4));
}
export function refreshRoutingFixtureStructures(db, {fixtureKind} = {}) {
  assert.equal(fixtureKind,'synthetic-fixture');
  const session=db.get('SELECT id,projectLabel FROM contextSessions WHERE sessionHash=?',[ROUTING_FIXTURE.sessionHash]);
  assert.equal(session?.projectLabel,'Synthetic routing continuity');
  return db.transaction(()=>{
    let changed=0;
    for(const [index,id] of ROUTING_FIXTURE.requests.entries()) {
      assert.equal(db.get('SELECT contextSessionId FROM requestStats WHERE id=?',[id])?.contextSessionId,session.id);
      for(const boundary of ['client-received','gateway-shaped','physical-dispatch']) changed+=db.run('UPDATE contextStructures SET data=? WHERE requestId=? AND boundary=?',[JSON.stringify(routingFixtureStructure(index,boundary)),id,boundary]).changes;
    }
    assert.equal(changed,6);return {changed,sessionId:session.id,fixture:ROUTING_FIXTURE.version};
  });
}

// The caller owns the isolated database and passes its adapter after checking
// the private runtime manifest. This module neither opens a database nor reads
// credentials. All fixture records are labeled, synthetic and fixed-clock.
export function seedRoutingCompletion(db, { fixtureKind } = {}) {
  assert.equal(fixtureKind, 'synthetic-fixture');
  const f = ROUTING_FIXTURE;
  for (const id of [f.accountId, f.targetId]) {
    const account = db.get('SELECT provider, data FROM providerConnections WHERE id=?', [id]);
    assert.equal(account?.provider, 'openai', `Prepare the credentialless fixture account ${id} first`);
    const data = JSON.parse(account.data);
    for (const field of ['apiKey','accessToken','refreshToken','password']) assert.ok(!data[field], `Fixture ${id} must have no ${field}`);
  }
  assert.equal(db.get('SELECT id FROM contextSessions WHERE sessionHash=?', [f.sessionHash]), undefined, 'Seed once into a fresh fixture database');
  return db.transaction(() => {
    db.run('INSERT INTO contextSessions(sessionHash,identitySource,projectLabel,firstSeenAt,lastSeenAt) VALUES(?,?,?,?,?)', [f.sessionHash,'explicit','Synthetic routing continuity',f.capturedAt,f.capturedAt]);
    const sessionId = db.get('SELECT id FROM contextSessions WHERE sessionHash=?',[f.sessionHash]).id;
    db.run('INSERT INTO sessionAffinity(sessionHash,model,connectionId,pinnedAt,lastSeenAt,expiresAt) VALUES(?,?,?,?,?,?)',[f.sessionHash,f.model,f.accountId,f.capturedAt,f.capturedAt,null]);
    for (let index=0; index<2; index++) {
      const id=f.requests[index], status=index ? 'success' : 'error';
      db.run('INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,logicalRequestId,contextSessionId,requestedModel,attempt,dispatchCoverage,usageSource,usageInputPresent,usageOutputPresent,cacheReadPresent,cacheWritePresent,promptTokens,completionTokens,cachedTokens,contextEstimate,bodyBeforeBytes,bodyAfterBytes,clientTool,routeKind,selection,contextControls,compactHint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [id,f.capturedAt,'openai',f.model,f.accountId,status,f.logicalRequestId,sessionId,'openai/gpt-4o',index+1,'physical-attempt','provider',1,1,1,1,12000, index ? 400 : 0,8000,13000,16000, index ? 15700 : 16000,'Synthetic fixture','direct',index ? 'pinned' : 'first-pin',JSON.stringify({epochMicro:false,epochAuto:false,diet:true,lingua:false,adaptiveCacheTtl:false}),index ? 1 : 0]);
      const stages=index ? [['inject',16000,16200,'applied'],['diet',16200,15700,'applied'],['epochAuto',15700,15700,'skipped']] : [['diet',16000,16000,'unchanged']];
      stages.forEach(([stage,before,after,outcome],ordinal)=>db.run('INSERT INTO contextStages(requestId,ordinal,stage,beforeBytes,afterBytes,deltaBytes,outcome,risk) VALUES(?,?,?,?,?,?,?,?)',[id,ordinal,stage,before,after,after-before,outcome,'content-changing']));
      for (const boundary of ['client-received','gateway-shaped','physical-dispatch']) {
        const structure=routingFixtureStructure(index,boundary);
        db.run('INSERT INTO contextStructures(requestId,boundary,version,data) VALUES(?,?,?,?)',[id,boundary,1,JSON.stringify(structure)]);
      }
    }
    const clientRef=`ctx1_${'e'.repeat(64)}`;
    db.run('INSERT INTO contextClientEvents(id,clientKeyId,clientEventId,occurredAt,recordedAt,type,requestId,contextSessionId,logicalRequestId,clientRef,beforeTokens,afterTokens,tokenMeasurementMethod,payloadHash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ['routing-fixture-client-compaction','synthetic-fixture-key','synthetic-compaction-1',f.capturedAt,f.capturedAt,'compaction',f.requests[1],sessionId,f.logicalRequestId,clientRef,13000,9000,'synthetic client token report','f'.repeat(64)]);
    const pinId=Buffer.from(JSON.stringify([f.sessionHash,f.model])).toString('base64url');
    return { ...f, sessionId, pinId, source:'versioned-synthetic-seed', upstreamCalls:0 };
  });
}
