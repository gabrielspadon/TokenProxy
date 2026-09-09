import { createHash } from 'node:crypto';
import { CLOCK } from './catalog.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const modelFor = provider => ({ openai: 'gpt-4o', claude: 'claude-sonnet-4-6', codex: 'gpt-5.2', gemini: 'gemini-2.5-pro', deepseek: 'deepseek-chat' }[provider] || 'synthetic-model');
export function seedRepresentative(db, accounts) {
  const enabled = accounts.filter(account => !['connection-fixture-beta', 'capacity-fixture-b', 'connection-fixture-custom', 'connection-fixture-reauth'].includes(account.id));
  const at = minutes => new Date(Date.parse(CLOCK) - minutes * 60000).toISOString();
  return db.transaction(() => {
    for (const account of enabled) db.run('UPDATE providerConnections SET isActive=1 WHERE id=?', [account.id]);
    for (const [index, account] of accounts.slice(6).entries()) {
      const stale = index % 3 === 1, unknown = index % 3 === 2;
      const observedAt = unknown ? null : at(stale ? 145 : 3 + index);
      const remaining = unknown ? null : 18 + index * 12;
      const data = { maxConcurrent: [8, 4, 2][index % 3], providerSpecificData: { enabledModels: [modelFor(account.provider)] }, lastQuotaSnapshot: { fetchedAt: observedAt, source: 'synthetic-fixture', windows: [{ key: 'Synthetic session allowance', remainingPercentage: remaining, resetAt: at(-90 - index * 15) }] } };
      db.run('UPDATE providerConnections SET data=? WHERE id=?', [JSON.stringify(data), account.id]);
      db.run('INSERT INTO quotaWindows(connectionId,scope,remaining,"limit",observedAt,resetAt,confidence) VALUES(?,?,?,?,?,?,?)', [account.id, 'Synthetic session allowance', remaining, unknown ? null : 100, observedAt || CLOCK, unknown ? null : at(-90 - index * 15), unknown ? 'unknown' : stale ? 'stale' : 'fresh']);
      for (let step = 0; step < 6; step++) {
        const stamp = unknown ? null : at((stale ? 145 : 3 + index) + (5 - step) * 10);
        db.run('INSERT INTO quotaObservations(id,connectionId,provider,scope,source,observationKind,resourceType,unit,remaining,"limit",observedAt,capturedAt,resetAt,confidence,windowDurationMs,windowType) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [hash([account.id,step]), account.id, account.provider, 'Synthetic session allowance', 'synthetic-fixture', 'observed', 'request-limit', 'requests', unknown ? null : remaining + (5 - step) * 2, unknown ? null : 100, stamp, stamp || CLOCK, unknown ? null : at(-90 - index * 15), unknown ? 'unknown' : 'reported', 18000000, 'fixed']);
      }
    }
    for (const [index, account] of enabled.entries()) {
      const model = modelFor(account.provider), sessionHash = hash(['representative-session', account.id]);
      db.run('INSERT INTO contextSessions(sessionHash,identitySource,projectLabel,firstSeenAt,lastSeenAt) VALUES(?,?,?,?,?)', [sessionHash, 'explicit', `Synthetic ${account.provider} workload ${index + 1}`, at(240), at(index)]);
      const sessionId = db.get('SELECT id FROM contextSessions WHERE sessionHash=?', [sessionHash]).id;
      const rates = { input: 2, output: 4, cached: 0.5, cache_creation: 3, reasoning: 1 };
      const rate = { provider: account.provider, model, currency: 'USD', unit: 'per-million-tokens', calculatorVersion: 'cache-inclusive-usd-v2', source: 'synthetic-fixture', rates };
      const rateId = hash(rate);
      db.run('INSERT OR IGNORE INTO usageRateSnapshots(id,provider,model,currency,unit,calculatorVersion,source,rates,capturedAt) VALUES(?,?,?,?,?,?,?,?,?)', [rateId, account.provider, model, 'USD', 'per-million-tokens', rate.calculatorVersion, rate.source, JSON.stringify(rates), at(240)]);
      for (let turn = 0; turn < 6; turn++) {
        const ordinal = index * 6 + turn, id = `representative-request-${String(ordinal + 1).padStart(3,'0')}`, logical = `${id}-logical`;
        const stamp = at(235 - ordinal * 4), input = 5000 + turn * 2200 + index * 350, output = 250 + turn * 80, cached = turn * 500;
        const cost = ((input - cached) * 2 + cached * 0.5 + output * 4) / 1e6;
        const baseline = cost + (turn === 4 ? -0.001 : 0.003), completionId = `c0000000-0000-4000-8000-${String(ordinal + 1).padStart(12,'0')}`;
        db.run('INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,contextSessionId,logicalRequestId,attempt,dispatchCoverage,usageSource,promptTokens,completionTokens,cachedTokens,bodyBeforeBytes,bodyAfterBytes,clientTool,requestedModel,rateSnapshotId,pricingCapturedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, stamp, account.provider, model, account.id, 'success', sessionId, logical, 1, 'physical-dispatch', 'provider', input, output, cached, input * 4 + 1200, input * 4, 'Synthetic team workload', `${account.provider}/${model}`, rateId, at(240)]);
        db.run('INSERT INTO contextStages(requestId,ordinal,stage,beforeBytes,afterBytes,deltaBytes,outcome,risk) VALUES(?,?,?,?,?,?,?,?)', [id, 0, 'diet', input * 4 + 1200, input * 4, -1200, 'applied', 'content-changing']);
        db.run('INSERT INTO usageHistory(timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cost,tokens,requestId,logicalRequestId,attempt,dispatchCoverage,usageSource,rateSnapshotId,pricingCapturedAt,costSource,estimatedCostUsd,completionId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [stamp, account.provider, model, account.id, 'ok', input, output, cost, JSON.stringify({ cached_tokens: cached }), id, logical, 1, 'physical-dispatch', 'provider', rateId, at(240), 'application-estimate', cost, completionId]);
        db.run('INSERT INTO costLedger(id,ts,provider,model,baselineUsd,actualUsd,savedUsd,saverSavedUsd,cacheSavedUsd,inputTokens,cacheReadTokens,cacheWriteTokens,outputTokens,completionId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, stamp, account.provider, model, baseline, cost, baseline - cost, baseline - cost - cached * 1.5 / 1e6, cached * 1.5 / 1e6, input, cached, 0, output, completionId]);
      }
    }
    return { version: 'representative-local-v1', enabledAccountIds: enabled.map(account => account.id), additionalRequests: enabled.length * 6, additionalQuotaObservations: accounts.slice(6).length * 6, health: 'Provider qualification and entitlement remain unknown. Enabled is local policy only.', providerCalls: 0 };
  });
}
