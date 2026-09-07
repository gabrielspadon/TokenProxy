import { beforeAll, describe, expect, it } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';
import { seedCapacityEconomics, CAPACITY_ECONOMICS_FIXTURE } from '../e2e/capacity-economics-seed.mjs';
import { parseQuotaWorkbenchQuery, readQuotaWorkbench } from '@/lib/db/analytics/quotaWorkbenchQueries.mjs';
import { readActivityAnalytics } from '@/lib/db/analytics/activityQueries.mjs';
import { readEvidence } from '@/lib/db/analytics/evidenceQueries.mjs';
import { INITIAL_SCOPE, INITIAL_CONTEXT, INITIAL_ECONOMICS } from '@/lib/db/analytics/investigationModel.mjs';
const db = await getAdapter(), fixture = CAPACITY_ECONOMICS_FIXTURE;
let receipt;
const read = patch => readActivityAnalytics(db, { operation:'activity', view:'economics', provider:fixture.provider, ...patch });
const workbench = id => readQuotaWorkbench(db, parseQuotaWorkbenchQuery(new URLSearchParams({ connectionId:id, end:fixture.capturedAt })));
beforeAll(() => {
  for (const id of fixture.accountIds) db.run('INSERT INTO providerConnections(id,provider,name,data,createdAt,updatedAt,authType) VALUES(?,?,?,?,?,?,?)', [id,fixture.provider,id,'{}',fixture.capturedAt,fixture.capturedAt,'apikey']);
  receipt = seedCapacityEconomics(db, { fixtureKind:'synthetic-fixture' });
});
describe('versioned retained Capacity and Economics scenarios', () => {
  it('retains separate same-scope units, a fresh reset observation and stale evidence', () => {
    const a = workbench(fixture.accountIds[0]), b = workbench(fixture.accountIds[1]);
    expect(a.total + b.total).toBe(49);
    const weekly = a.series.filter(series => series.scope === 'Weekly (7d)');
    expect(weekly).toHaveLength(2);
    expect(new Set(weekly.map(series => series.unit))).toEqual(new Set(['requests','USD']));
    expect(weekly[0].id).not.toBe(weekly[1].id);
    expect(a.series.find(series => series.scope === 'Session (5h)').analysis.increases).toHaveLength(1);
    expect(b.series.find(series => series.scope === 'Weekly (7d)').analysis.state).toBe('stale');
    expect(b.series.find(series => series.scope === 'Unknown allowance').analysis.state).toBe('unknown_observation_time');
  });
  it('projects captured-rate arithmetic, reported zero, negative modeling and refused joins', () => {
    const rows = read({}).items;
    expect(rows).toHaveLength(8);
    expect(rows.find(row => row.requestId === 'economics-fixture-1').counterfactual).toMatchObject({ available:true,splitAvailable:false });
    expect(rows.find(row => row.requestId === 'economics-fixture-2')).toMatchObject({ recordedCostUsd:0,reportedCostUsd:0,costSource:'provider-reported' });
    expect(rows.find(row => row.requestId === 'economics-fixture-5').counterfactual).toMatchObject({ available:true,modeledDifferenceUsd:-0.01 });
    expect(rows.find(row => row.requestId === 'economics-fixture-6').counterfactual.state).toBe('identity-unavailable');
    expect(rows.find(row => row.requestId === 'economics-fixture-7').counterfactual.state).toBe('identity-unavailable');
    expect(rows.find(row => row.requestId === 'economics-fixture-8')).toMatchObject({ requestLink:'conflict',counterfactual:{state:'identity-conflict'} });
    expect(rows.find(row => row.requestId === 'economics-fixture-1').costComponents.reconcilesToEstimate).toBe(true);
    expect(read({ attemptKind:'additional' }).summary.records).toBe(2);
    expect(readActivityAnalytics(db,{operation:'activity',requestId:'economics-fixture-1'}).items[0]).toMatchObject({requestedModel:'synthetic-research-route',model:fixture.model});
  });
  it('exports the exact selected historical series with explicit capture bounds', () => {
    const selected = workbench(fixture.accountIds[0]).series.find(series => series.unit === 'USD');
    const definition = { schemaVersion:3, lens:'capacity', scope:{ ...INITIAL_SCOPE,period:'custom',start:'2026-09-07T10:00:00.000Z',end:fixture.capturedAt }, context:INITIAL_CONTEXT,economics:INITIAL_ECONOMICS,comparisonIds:[],selection:{kind:'account',id:fixture.accountIds[0],windowScope:selected.scope,windowId:selected.id} };
    const result = readEvidence(db,{operation:'evidence',mode:'selected',definition});
    expect(result.quotaHistory.map(series => series.id)).toEqual([selected.id]);
    expect(result.quotaHistory[0].points).toHaveLength(12);
    expect(result.manifest.coverage.selectedQuotaHistory).toMatchObject({ available:true, modelAttribution:'unavailable' });
    definition.selection.windowId = '0'.repeat(64);
    const missing = readEvidence(db,{operation:'evidence',mode:'selected',definition});
    expect(missing.quotaHistory).toEqual([]);
    expect(missing.manifest.coverage.selectedQuotaHistory.available).toBe(false);
  });
  it('exposes only selected matching cost rows and never emits the private session identifier', () => {
    const definition = { schemaVersion:3,lens:'economics',scope:INITIAL_SCOPE,context:INITIAL_CONTEXT,economics:INITIAL_ECONOMICS,comparisonIds:[],selection:{kind:'economics-record',id:String(receipt.usageIds[4])} };
    const result = readEvidence(db,{operation:'evidence',mode:'selected',definition});
    expect(result.items).toHaveLength(1);
    expect(result.items[0].counterfactual.modeledDifferenceUsd).toBe(-0.01);
    expect(JSON.stringify(result)).not.toContain('"sid"');
  });
});
