import { beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';
import { CAPACITY_ECONOMICS_FIXTURE as fixture,seedCapacityEconomics } from '../e2e/capacity-economics-seed.mjs';
import { bindCapacityEconomicsFixtureCompletions } from '../e2e/capacity-economics-completion-bindings.mjs';
import { readActivityAnalytics } from '@/lib/db/analytics/activityQueries.mjs';
const db=await getAdapter();
let receipt;
beforeAll(() => {
  for (const id of fixture.accountIds) db.run('INSERT INTO providerConnections(id,provider,name,data,createdAt,updatedAt,authType) VALUES(?,?,?,?,?,?,?)',[id,fixture.provider,id,'{}',fixture.capturedAt,fixture.capturedAt,'apikey']);
  receipt=seedCapacityEconomics(db,{fixtureKind:'synthetic-fixture'});
});
beforeEach(() => {
  db.run('UPDATE usageHistory SET completionId=NULL'); db.run('UPDATE costLedger SET completionId=NULL');
  db.run("UPDATE usageHistory SET timestamp='2026-09-07T11:52:00.000Z' WHERE requestId='economics-fixture-1'");
});
describe('guarded existing synthetic fixture completion binding', () => {
  it('binds only the known six usage and three cost rows, preserves two legacy rows, and is idempotent', () => {
    const bind=()=>bindCapacityEconomicsFixtureCompletions(db,{fixtureKind:'synthetic-fixture',usageIds:receipt.usageIds});
    expect(bind()).toMatchObject({usageBindings:6,costBindings:3,legacyUnboundRequestIds:['economics-fixture-6','economics-fixture-7']});
    expect(bind()).toMatchObject({usageBindings:0,costBindings:0});
    const rows=readActivityAnalytics(db,{operation:'activity',view:'economics'}).items;
    expect(rows.find(row=>row.requestId==='economics-fixture-5').counterfactual).toMatchObject({available:true,modeledDifferenceUsd:-0.01});
    for (const id of ['economics-fixture-6','economics-fixture-7']) expect(rows.find(row=>row.requestId===id).counterfactual.state).toBe('identity-unavailable');
  });
  it('refuses timestamp drift before mutating any completion identity', () => {
    db.run("UPDATE usageHistory SET timestamp='2026-09-01T00:00:00.000Z' WHERE requestId='economics-fixture-1'");
    expect(()=>bindCapacityEconomicsFixtureCompletions(db,{fixtureKind:'synthetic-fixture',usageIds:receipt.usageIds})).toThrow('Synthetic fixture timestamp drift');
    expect(db.get('SELECT COUNT(completionId) AS n FROM usageHistory').n).toBe(0);
    expect(db.get('SELECT COUNT(completionId) AS n FROM costLedger').n).toBe(0);
  });
  it('requires an explicit synthetic fixture declaration', () => {
    expect(()=>bindCapacityEconomicsFixtureCompletions(db,{})).toThrow();
  });
  it('refuses receipt identity drift before writing', () => {
    const usageIds=[...receipt.usageIds]; usageIds[0]=1000000;
    expect(()=>bindCapacityEconomicsFixtureCompletions(db,{fixtureKind:'synthetic-fixture',usageIds})).toThrow('Synthetic fixture id drift');
    expect(db.get('SELECT COUNT(completionId) AS n FROM usageHistory').n).toBe(0);
  });
});
