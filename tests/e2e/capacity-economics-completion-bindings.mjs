import assert from 'node:assert/strict';
import { CAPACITY_ECONOMICS_FIXTURE as fixture, capacityEconomicsCompletionId } from './capacity-economics-seed.mjs';

// Repair only the eight known synthetic scenarios after the caller upgrades its
// disposable database. This never opens a database or backfills live history.
export function bindCapacityEconomicsFixtureCompletions(db, { fixtureKind, usageIds } = {}) {
  assert.equal(fixtureKind, 'synthetic-fixture');
  assert.ok(Array.isArray(usageIds) && usageIds.length===8 && new Set(usageIds).size===8
    && usageIds.every(id=>Number.isSafeInteger(id) && id>0), 'Original synthetic receipt usageIds are required');
  for (const table of ['usageHistory','costLedger']) {
    assert.ok(db.all(`PRAGMA table_info(${table})`,[]).some(column=>column.name==='completionId'), 'Completion schema migration must run first');
  }
  const at = index => new Date(Date.parse(fixture.capturedAt) + (-8 + index) * 60000).toISOString();
  const requestIds = Array.from({length:8},(_,index)=>`economics-fixture-${index+1}`);
  const marks = requestIds.map(()=>'?').join(',');
  const equalFields = (row, fields) => {
    assert.ok(row, 'Synthetic fixture row is missing');
    for (const [field,value] of Object.entries(fields)) assert.ok(row[field]===value, `Synthetic fixture ${field} drift`);
  };
  return db.transaction(() => {
    const usage = db.all(`SELECT * FROM usageHistory WHERE requestId IN (${marks})`,requestIds);
    const requests = db.all(`SELECT * FROM requestStats WHERE id IN (${marks})`,requestIds);
    assert.equal(usage.length,8,'Expected exactly eight synthetic completion rows');
    assert.equal(requests.length,8,'Expected exactly eight synthetic request rows');
    const costIds = [...requestIds,'economics-fixture-ambiguous'];
    const costs = db.all(`SELECT * FROM costLedger WHERE id IN (${costIds.map(()=>'?').join(',')})`,costIds);
    assert.equal(costs.length,4,'Expected exactly four synthetic cost rows');
    for (let index=0; index<8; index++) {
      const requestId=requestIds[index], completionId=capacityEconomicsCompletionId(index);
      const logical=index<3 ? 'economics-fixture-logical' : `economics-fixture-logical-${index}`;
      const common={timestamp:at(index),provider:fixture.provider,model:fixture.model,connectionId:fixture.accountIds[index%2],promptTokens:10000,completionTokens:1500,attempt:index<3 ? index+1 : 1};
      const row=usage.find(item=>item.requestId===requestId);
      equalFields(row,{...common,id:usageIds[index],requestId,logicalRequestId:index===7 ? 'conflicting-logical' : logical,usageSource:'provider',status:index===2 ? 'error' : 'ok'});
      equalFields(requests.find(item=>item.id===requestId),{...common,id:requestId,logicalRequestId:logical,status:index===2 ? 'error' : 'success'});
      assert.ok(row.completionId===null || row.completionId===completionId,'Synthetic usage completion binding drift');
      const tokens=JSON.parse(row.tokens),meta=JSON.parse(row.meta);
      equalFields(tokens,{cached_tokens:6000,cache_creation_input_tokens:1000,reasoning_tokens:200});
      equalFields(meta,{requestedModel:'synthetic-research-route'});
      const costId=index>=5 && index<=6 ? 'economics-fixture-ambiguous' : requestId;
      assert.ok(meta.costLedgerId===undefined || meta.costLedgerId===costId,'Synthetic rid mapping drift');
      const cost=costs.find(item=>item.id===costId);
      if (index===0 || index===4 || index===5 || index===7) {
        equalFields(cost,{ts:at(index),provider:fixture.provider,model:fixture.model,inputTokens:10000,outputTokens:1500,cacheReadTokens:6000,cacheWriteTokens:1000,
          baselineUsd:index===4 ? 0.01 : 0.03,actualUsd:0.02,savedUsd:index===4 ? -0.01 : 0.01});
        assert.ok(cost.completionId===null || cost.completionId===completionId,'Synthetic cost completion binding drift');
      }
    }
    let usageBindings=0,costBindings=0;
    for (let index=0; index<8; index++) {
      const completionId=capacityEconomicsCompletionId(index);
      if (!completionId) continue;
      const row=usage.find(item=>item.requestId===requestIds[index]);
      usageBindings+=db.run('UPDATE usageHistory SET completionId=? WHERE id=? AND requestId=? AND timestamp=? AND completionId IS NULL',[completionId,row.id,row.requestId,at(index)]).changes;
      if ([0,4,7].includes(index)) costBindings+=db.run('UPDATE costLedger SET completionId=? WHERE id=? AND ts=? AND completionId IS NULL',[completionId,requestIds[index],at(index)]).changes;
      equalFields(db.get('SELECT completionId FROM usageHistory WHERE id=?',[row.id]),{completionId});
      if ([0,4,7].includes(index)) equalFields(db.get('SELECT completionId FROM costLedger WHERE id=?',[requestIds[index]]),{completionId});
    }
    return {fixtureVersion:fixture.version,usageBindings,costBindings,legacyUnboundRequestIds:requestIds.slice(5,7),upstreamCalls:0};
  });
}
