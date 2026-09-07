import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pinBinding, pinRevision } from '../../../src/lib/db/helpers/sessionPinControl.js';
import { CLOCK } from './catalog.mjs';

export const EDGE_IDS = Object.freeze({ custom: 'connection-fixture-custom', reauth: 'connection-fixture-reauth', provider: 'openai-compatible-redesign-fixture', freePool: 'redesign-pool-free', boundPool: 'redesign-pool-bound', expiredPreview: 'b0000000-0000-4000-8000-000000000001', expiredPinHash: 'b'.repeat(64) });
export function seedEdgeCases(db) {
  assert.equal(db.get('SELECT provider FROM providerConnections WHERE id=?', [EDGE_IDS.custom])?.provider, EDGE_IDS.provider);
  return db.transaction(() => {
    db.run('INSERT INTO providerNodes(id,type,name,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?)', [EDGE_IDS.provider, 'openai-compatible', 'Synthetic custom upstream', JSON.stringify({ prefix: 'synthetic-edge', baseUrl: 'https://synthetic-upstream.invalid/v1', apiType: 'chat' }), CLOCK, CLOCK]);
    for (const id of [EDGE_IDS.freePool, EDGE_IDS.boundPool]) db.run('INSERT INTO proxyPools(id,isActive,testStatus,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?)', [id, 0, 'untested', JSON.stringify({ name: `Synthetic ${id}`, proxyUrl: 'http://127.0.0.1:9', type: 'http', strictProxy: true }), CLOCK, CLOCK]);
    db.run('UPDATE providerConnections SET data=? WHERE id=?', [JSON.stringify({ maxConcurrent: 1, providerSpecificData: { proxyPoolId: EDGE_IDS.boundPool }, lastQuotaSnapshot: { fetchedAt: CLOCK, windows: [{ key: 'Synthetic exhausted window', remainingPercentage: 0, resetAt: '2026-09-07T13:00:00.000Z' }] } }), EDGE_IDS.custom]);
    db.run('UPDATE providerConnections SET data=? WHERE id=?', [JSON.stringify({ testStatus: 'expired', lastError: 'Synthetic credential expired; reauthentication has not been performed.', errorCode: 401 }), EDGE_IDS.reauth]);
    db.run('INSERT INTO quotaWindows(connectionId,scope,remaining,"limit",observedAt,resetAt,confidence) VALUES(?,?,?,?,?,?,?)', [EDGE_IDS.custom, 'Synthetic exhausted window', 0, 100, CLOCK, '2026-09-07T13:00:00.000Z', 'fresh']);
    db.run('INSERT INTO contextSessions(sessionHash,identitySource,projectLabel,firstSeenAt,lastSeenAt) VALUES(?,?,?,?,?)', [EDGE_IDS.expiredPinHash, 'explicit', 'Synthetic failure and expiry', CLOCK, CLOCK]);
    const sessionId = db.get('SELECT id FROM contextSessions WHERE sessionHash=?', [EDGE_IDS.expiredPinHash]).id;
    const requests = [['redesign-shaping-error', 'error', 'Synthetic shaping evidence failed validation'], ['redesign-stream-aborted', 'aborted', null], ['redesign-zero-usage', 'success', null]];
    for (const [id, status, error] of requests) db.run('INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,contextSessionId,logicalRequestId,attempt,dispatchCoverage,usageSource,usageInputPresent,usageOutputPresent,contextTelemetryError,bodyBeforeBytes,bodyAfterBytes,clientTool) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, CLOCK, 'openai', 'gpt-4o', 'connection-fixture-alpha', status, sessionId, `${id}-logical`, 1, 'physical-attempt', id === 'redesign-zero-usage' ? 'provider' : 'missing', id === 'redesign-zero-usage' ? 1 : 0, id === 'redesign-zero-usage' ? 1 : 0, error, 1200, 1200, 'Synthetic edge fixture']);
    db.run('INSERT INTO usageHistory(timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cost,requestId,logicalRequestId,attempt,dispatchCoverage,usageSource) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [CLOCK, 'openai', 'gpt-4o', 'connection-fixture-alpha', 'ok', 0, 0, null, 'redesign-zero-usage', 'redesign-zero-usage-logical', 1, 'physical-dispatch', 'provider']);
    // No costLedger row: zero/zero usage cannot support a counterfactual saving.
    const pin = { sessionHash: EDGE_IDS.expiredPinHash, model: 'gpt-4o', connectionId: 'connection-fixture-alpha', providerNode: null, pinnedAt: '2026-09-07T10:00:00.000Z', lastSeenAt: '2026-09-07T10:30:00.000Z', expiresAt: '2026-09-07T11:00:00.000Z', operatorExpiresAt: null };
    db.run('INSERT INTO sessionAffinity(sessionHash,model,connectionId,pinnedAt,lastSeenAt,expiresAt) VALUES(?,?,?,?,?,?)', [pin.sessionHash, pin.model, pin.connectionId, pin.pinnedAt, pin.lastSeenAt, pin.expiresAt]);
    db.run('INSERT INTO sessionPinActions(id,version,sessionHash,model,action,expectedRevision,expectedBinding,status,beforeState,preview,createdAt,previewExpiresAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [EDGE_IDS.expiredPreview, 1, pin.sessionHash, pin.model, 'clear', pinRevision(pin), pinBinding(pin), 'preview', JSON.stringify(pin), JSON.stringify({ effect: 'Synthetic expired clear preview', providerCalls: 0 }), '2026-09-07T10:30:00.000Z', '2026-09-07T10:35:00.000Z']);
    const budgetKey = 'redesign-budget-key';
    db.run('INSERT INTO apiKeys(id,key,name,machineId,isActive,budgetPolicy,maxPromptTokens,maxCompletionTokens,maxCostUsd,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)', [budgetKey, 'sk-synthetic-redesign-budget-not-a-credential', 'Synthetic budget evidence', 'isolated', 0, 'strict', 1000, 1000, 1, CLOCK]);
    db.run('INSERT INTO apiKeyBudgetAccounts(apiKeyId,initializedAt) VALUES(?,?)', [budgetKey, CLOCK]);
    const rate = { provider: 'claude', model: 'fixture-budget-model', currency: 'USD', unit: 'per-million-tokens', calculatorVersion: 'cache-inclusive-usd-v2', source: 'synthetic-fixture', rates: { input: 2, output: 4, cached: 0.5, cache_creation: 3, reasoning: 4 } };
    const rateId = createHash('sha256').update(JSON.stringify(rate)).digest('hex');
    db.run('INSERT INTO usageRateSnapshots(id,provider,model,currency,unit,calculatorVersion,source,rates,capturedAt) VALUES(?,?,?,?,?,?,?,?,?)', [rateId, rate.provider, rate.model, rate.currency, rate.unit, rate.calculatorVersion, rate.source, JSON.stringify(rate.rates), CLOCK]);
    for (const state of ['reserved', 'uncertain']) {
      const id = `redesign-budget-${state}`;
      db.run('INSERT INTO apiKeyBudgetReservations(requestId,logicalRequestId,apiKeyId,createdAt,updatedAt,state,policy,reservedPromptTokens,reservedCompletionTokens,reservedCostUsd,rateSnapshotId,dispatchCoverage,boundEvidence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, `logical-${id}`, budgetKey, CLOCK, CLOCK, state, 'strict', 100, 50, 0.001, rateId, 'physical-dispatch', JSON.stringify({ synthetic: true, fixture: 'redesign-edge-v1' })]);
      if (state === 'uncertain') db.run('INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,logicalRequestId,attempt,rateSnapshotId,pricingCapturedAt,dispatchCoverage) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [id, CLOCK, rate.provider, rate.model, EDGE_IDS.reauth, 'error', `logical-${id}`, 1, rateId, CLOCK, 'physical-dispatch']);
    }
    return { version: 'redesign-edge-v1', ...EDGE_IDS, sessionId, requests: requests.map(([id]) => id), counterfactualExcluded: 'redesign-zero-usage', budget: { keyId: budgetKey, reserved: 'redesign-budget-reserved', uncertain: 'redesign-budget-uncertain', rateId, upstreamCalls: 0 }, processLoad: { 'connection-fixture-alpha': { 'gpt-4o (openai)': 2 }, [EDGE_IDS.custom]: { 'synthetic-model (synthetic-edge)': 1 } }, limits: ['Concurrent counters are synthetic process state, not dispatched work.', 'Expired preview is retained evidence, not an expired provider credential.', 'Terminal aborted history is distinct from the browser stream-interruption fault.'] };
  });
}
