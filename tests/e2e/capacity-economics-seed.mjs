import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const CAPACITY_ECONOMICS_FIXTURE = Object.freeze({ version: 'capacity-economics-v1', capturedAt: '2026-09-07T12:00:00.000Z', accountIds: ['capacity-fixture-a', 'capacity-fixture-b'], provider: 'codex', model: 'gpt-5.2' });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function capacityEconomicsCompletionId(index) {
  assert.ok(Number.isInteger(index) && index >= 0 && index < 8);
  return index >= 5 && index <= 6 ? null : `0000000${index + 1}-1111-4111-8111-111111111111`;
}

// Actual retained schema and read projections, with only synthetic rows. The
// caller owns the guarded, credentialless database; this module never opens it.
export function seedCapacityEconomics(db, { fixtureKind } = {}) {
  assert.equal(fixtureKind, 'synthetic-fixture');
  const f = CAPACITY_ECONOMICS_FIXTURE, clock = Date.parse(f.capturedAt);
  const at = minutes => new Date(clock + minutes * 60000).toISOString();
  for (const id of f.accountIds) {
    const account = db.get('SELECT provider,data FROM providerConnections WHERE id=?', [id]);
    assert.equal(account?.provider, f.provider);
    const data = JSON.parse(account.data);
    for (const field of ['apiKey','accessToken','refreshToken','password']) assert.ok(!data[field]);
  }
  assert.equal(db.get('SELECT id FROM quotaObservations WHERE connectionId=?', [f.accountIds[0]]), undefined, 'Use a fresh synthetic fixture');
  return db.transaction(() => {
    const observation = (id, scope, remaining, unit, index, offset = 0, extra = {}) => {
      const row = { connectionId: id, provider: f.provider, scope, source: 'provider-usage', observationKind: 'observed',
        resourceType: unit === 'USD' ? 'monetary-budget' : unit ? 'request-limit' : 'percentage-allowance', unit, remaining: unit ? remaining : null, limit: unit === 'USD' ? 50 : unit ? 1000 : null,
        percentage: unit ? null : remaining, observedAt: at(-60 + index * 5 + offset), capturedAt: at(-60 + index * 5 + offset + 0.01),
        resetAt: at(180), confidence: unit ? 'reported' : 'reported-percentage', windowDurationMs: scope.includes('7d') ? 604800000 : 18000000, windowType: 'fixed', ...extra };
      const fields = ['id','connectionId','provider','scope','source','observationKind','resourceType','unit','remaining','limit','percentage','observedAt','capturedAt','resetAt','confidence','windowDurationMs','windowType'];
      row.id = hash([f.version,row]);
      db.run(`INSERT INTO quotaObservations (${fields.map(field => `"${field}"`).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(field => row[field]));
    };
    for (let index = 0; index < 12; index++) {
      observation(f.accountIds[0], 'Weekly (7d)', 480 - index * 25, 'requests', index);
      observation(f.accountIds[0], 'Weekly (7d)', 22 - index * 0.5, 'USD', index);
      observation(f.accountIds[0], 'Session (5h)', index < 6 ? 20 - index * 3 : 98 - (index - 6) * 2, null, index, 0, { resetAt: index < 6 ? at(-32) : at(268) });
      observation(f.accountIds[1], 'Weekly (7d)', 600 - index * 15, 'requests', index, -120, { resetAt: at(-30) });
    }
    observation(f.accountIds[1], 'Unknown allowance', null, null, 11, 0, { confidence: 'unknown', observedAt: null, percentage: null, resetAt: null });
    for (const [i,id] of f.accountIds.entries()) {
      const current = db.get('SELECT data FROM providerConnections WHERE id=?', [id]);
      const data = JSON.parse(current.data);
      const windows = i === 0 ? [
        { scope: 'Weekly (7d)', remaining: 205, limit: 1000, observedAt: at(-5), resetAt: at(180), confidence: 'fresh', percentage: 20.5 },
        { scope: 'Session (5h)', remaining: 88, limit: 100, observedAt: at(-5), resetAt: at(268), confidence: 'unknown', percentage: 88 },
      ] : [
        { scope: 'Weekly (7d)', remaining: 435, limit: 1000, observedAt: at(-125), resetAt: at(-30), confidence: 'stale', percentage: 43.5 },
        { scope: 'Unknown allowance', remaining: null, limit: null, observedAt: at(-5), resetAt: null, confidence: 'unknown', percentage: null },
      ];
      data.lastQuotaSnapshot = { fetchedAt: at(i ? -125 : -5), windows: windows.map(w => ({ key: w.scope, remainingPercentage: w.percentage, resetAt: w.resetAt })) };
      data.maxConcurrent = i ? 4 : 16;
      data.providerSpecificData = { ...(data.providerSpecificData || {}), enabledModels: [f.model] };
      db.run('UPDATE providerConnections SET data=? WHERE id=?', [JSON.stringify(data),id]);
      for (const w of windows) db.run('INSERT INTO quotaWindows(connectionId,scope,remaining,"limit",observedAt,resetAt,confidence) VALUES(?,?,?,?,?,?,?)', [id,w.scope,w.remaining,w.limit,w.observedAt,w.resetAt,w.confidence]);
    }
    for (const [index,eventType] of ['scheduled','started','usage-read','clock-running','completed'].entries()) db.run('INSERT INTO quotaCheckEvents(id,checkId,connectionId,provider,scope,source,eventType,scheduledFor,resetAt,observedAt,capturedAt,code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [`capacity-fixture-check-${index}`,'capacity-fixture-reset',f.accountIds[0],f.provider,'Session (5h)','quota-auto-ping',eventType,at(-32),at(268),index > 1 ? at(-30) : null,at(-32+index),index > 1 ? 'observed' : 'reset-not-before']);
    const rateId = hash({ provider:f.provider, model:f.model, currency:'USD', unit:'per-million-tokens', calculatorVersion:'cache-inclusive-usd-v2', source:'synthetic-fixture', rates:{ input:2, output:4, cached:0.5, cache_creation:3, reasoning:1 } });
    db.run('INSERT INTO usageRateSnapshots(id,provider,model,currency,unit,calculatorVersion,source,rates,capturedAt) VALUES(?,?,?,?,?,?,?,?,?)', [rateId,f.provider,f.model,'USD','per-million-tokens','cache-inclusive-usd-v2','synthetic-fixture',JSON.stringify({ input: 2, output: 4, cached: 0.5, cache_creation: 3, reasoning: 1 }),at(-60)]);
    const usageIds = [];
    for (let index = 0; index < 8; index++) {
      const requestId = `economics-fixture-${index + 1}`, logical = index < 3 ? 'economics-fixture-logical' : `economics-fixture-logical-${index}`, id = f.accountIds[index % 2], costLedgerId = index >= 5 && index <= 6 ? 'economics-fixture-ambiguous' : requestId;
      // Historical rid collisions cannot acquire an exact binding retroactively.
      const completionId = capacityEconomicsCompletionId(index);
      const source = index === 1 ? 'provider-reported' : index === 3 ? null : 'application-estimate';
      const estimate = index === 3 ? null : 0.0174, recorded = index === 1 ? 0 : estimate;
      db.run('INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,logicalRequestId,attempt,dispatchCoverage,usageSource,promptTokens,completionTokens,cachedTokens,cacheCreationTokens,latencyTotal,latencyTtft,requestedModel) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [requestId,at(-8+index),f.provider,f.model,id,index === 2 ? 'error' : 'success',logical,index < 3 ? index + 1 : 1,'physical-dispatch','provider',10000,1500,6000,1000,500+index*200,100,'synthetic-research-route']);
      const result = db.run('INSERT INTO usageHistory(timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cost,tokens,meta,requestId,logicalRequestId,attempt,dispatchCoverage,usageSource,rateSnapshotId,pricingCapturedAt,costSource,estimatedCostUsd,reportedCostUsd,completionId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [at(-8+index),f.provider,f.model,id,index === 2 ? 'error' : 'ok',10000,1500,recorded,JSON.stringify({ cached_tokens:6000,cache_creation_input_tokens:1000,reasoning_tokens:200 }),JSON.stringify({ requestedModel:'synthetic-research-route',...(completionId ? {} : {costLedgerId}) }),requestId,index === 7 ? 'conflicting-logical' : logical,index < 3 ? index + 1 : 1,'physical-dispatch','provider',index === 3 ? null : rateId,at(-60),source,estimate,index === 1 ? 0 : null,completionId]);
      usageIds.push(Number(result.lastInsertRowid));
      if (index === 0 || index === 4 || index === 5 || index === 7) db.run('INSERT INTO costLedger(id,ts,provider,model,baselineUsd,actualUsd,savedUsd,saverSavedUsd,cacheSavedUsd,inputTokens,cacheReadTokens,cacheWriteTokens,outputTokens,completionId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [costLedgerId,at(-8+index),f.provider,f.model,index === 4 ? 0.01 : 0.03,0.02,index === 4 ? -0.01 : 0.01,index === 0 ? 0 : index === 4 ? -0.014 : 0.006,index === 0 ? 0 : 0.004,10000,6000,1000,1500,completionId]);
    }
    return { ...f, observationCount:49, currentWindows:4, usageIds, source:'retained-schema synthetic fixtures', upstreamCalls:0, invariants:['Window units are separate.','A passed reset is not replenishment.','The increase is a new observation.','Counterfactual zero/zero split is unknown.','Negative modeled USD is retained.','Ambiguous and conflicting identities refuse attribution.'] };
  });
}
