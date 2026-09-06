import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { beginBudgetDispatch } from '@/sse/services/budgetDispatch.js';
import { getAdapter } from '@/lib/db/driver.js';
import { createApiKey, updateApiKey, validateApiKey } from '@/lib/db/repos/apiKeysRepo.js';
import { saveRequestUsage, reconcileBudgetUsage } from '@/lib/db/repos/usageRepo.js';
import { reserveBudget, markBudgetDispatched, markBudgetUncertain, getBudgetStatus, releaseBudgetReservation, getApiKeyBudgetSummaries } from '@/lib/db/repos/budgetRepo.js';

let db;
beforeAll(async () => { db = await getAdapter(); });
beforeEach(() => {
  for (const table of ['apiKeyBudgetReservations','apiKeyBudgetAccounts','usageHistory','apiKeys']) db.run(`DELETE FROM ${table}`);
});
async function key(limits, policy = 'strict') {
  const k = await createApiKey('budget fixture', 'isolated');
  return updateApiKey(k.id, { ...limits, budgetPolicy: policy });
}
const admission = (k, bounds = {}, extra = {}) => reserveBudget({apiKey:k.key, requestId:randomUUID(), logicalRequestId:'logical', bounds, ...extra});
const usage = (k, r, tokens, extra = {}) => saveRequestUsage({ apiKey:k.key, provider:'test', model:'test', requestId:r.requestId,
  logicalRequestId:r.logicalRequestId, tokens, ...extra });

describe('durable atomic budget reservations', () => {
  it('unlimited keys avoid accounts and reservation writes', async () => {
    const k = await key({});
    expect(await admission(k)).toBeNull();
    expect(db.get('SELECT COUNT(*) AS n FROM apiKeyBudgetAccounts').n).toBe(0);
    expect(db.get('SELECT COUNT(*) AS n FROM apiKeyBudgetReservations').n).toBe(0);
  });
  it('only one of concurrent unknown-bound admissions can reserve the allowance', async () => {
    const k = await key({maxPromptTokens:100}, null);
    const results = await Promise.allSettled(Array.from({length:20}, () => admission(k)));
    expect(results.filter(r => r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status==='rejected').every(r => r.reason.code==='api_key_budget_exceeded')).toBe(true);
    expect((await getBudgetStatus(k.id)).outstanding.promptTokens).toBe(100);
    expect(await validateApiKey(k.key)).toBe(false);
  });
  it('strict bounded parallel admissions use only their verified completion exposure', async () => {
    const k = await key({maxCompletionTokens:100});
    const results = await Promise.allSettled(Array.from({length:5}, () => admission(k, {completionTokens:30})));
    expect(results.filter(r => r.status==='fulfilled')).toHaveLength(3);
    expect((await getBudgetStatus(k.id)).outstanding.completionTokens).toBe(90);
  });
  it('strict never treats missing bounds or old missing costs as zero', async () => {
    const k = await key({maxCostUsd:10});
    await expect(admission(k)).rejects.toMatchObject({code:'budget-bound-unavailable'});
    db.run("INSERT INTO usageHistory(timestamp,apiKey,promptTokens,completionTokens,cost,tokens) VALUES(?,?,0,0,0,'{}')", [new Date().toISOString(), k.key]);
    await expect(admission(k,{costUsd:1})).rejects.toMatchObject({code:'budget-bound-unavailable'});
  });
  it('settles one exact attempt once and frees only the unused reservation', async () => {
    const k = await key({maxCompletionTokens:100});
    const r = await admission(k,{completionTokens:60});
    await markBudgetDispatched(r.requestId);
    await usage(k,r,{prompt_tokens:12,completion_tokens:20});
    await usage(k,r,{prompt_tokens:12,completion_tokens:20});
    const status = await getBudgetStatus(k.id);
    expect(status.account.recordedCompletionTokens).toBe(20);
    expect(status.outstanding.completionTokens).toBe(0);
    expect(status.reservations[0].state).toBe('settled');
    expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(1);
    expect(await admission(k,{completionTokens:80})).toBeTruthy();
  });
  it('partial stream usage preserves residual exposure without double counting', async () => {
    const k = await key({maxCompletionTokens:100});
    const r = await admission(k,{completionTokens:100});
    await markBudgetDispatched(r.requestId);
    await usage(k,r,{prompt_tokens:12,completion_tokens:20},{usageFinality:'partial'});
    const status = await getBudgetStatus(k.id);
    expect(status.account.recordedCompletionTokens).toBe(20);
    expect(status.outstanding.completionTokens).toBe(80);
    expect(status.reservations[0].state).toBe('uncertain');
    await expect(admission(k,{completionTokens:1})).rejects.toMatchObject({code:'api_key_budget_exceeded'});
  });
  it('retries cannot reuse an already dispatched attempt or its uncertain allowance', async () => {
    const k = await key({maxCompletionTokens:100},'reserve-remaining');
    const r = await admission(k);
    await markBudgetDispatched(r.requestId);
    await expect(markBudgetDispatched(r.requestId)).rejects.toMatchObject({code:'budget-attempt-already-dispatched'});
    await markBudgetUncertain(r.requestId);
    db.run("UPDATE apiKeyBudgetReservations SET updatedAt='2000-01-01T00:00:00Z' WHERE requestId=?",[r.requestId]);
    expect((await getBudgetStatus(k.id)).reservations[0].state).toBe('uncertain');
    await expect(admission(k)).rejects.toMatchObject({code:'api_key_budget_exceeded'});
  });
  it('a new retry gets its own identity after proven provider nonacceptance', async () => {
    const k = await key({maxCompletionTokens:100},'reserve-remaining');
    const r = await admission(k);
    await markBudgetDispatched(r.requestId);
    await expect(releaseBudgetReservation(k.id,r.requestId,{kind:'proven-no-dispatch',reference:'timeout'})).rejects.toThrow();
    await releaseBudgetReservation(k.id,r.requestId,{kind:'provider-nonacceptance',reference:'receipt/mock-auth-rejected'});
    const next = await admission(k);
    expect(next.requestId).not.toBe(r.requestId);
    expect(next.logicalRequestId).toBe(r.logicalRequestId);
  });
  it('missing usage and unknown media costs retain the remaining allowance', async () => {
    const k = await key({maxCostUsd:10},'reserve-remaining');
    const r = await admission(k);
    await markBudgetDispatched(r.requestId);
    await usage(k,r,null);
    const status = await getBudgetStatus(k.id);
    expect(status.account.unknownCostRows).toBe(1);
    expect(status.reservations[0].actualCostUsd).toBeNull();
    expect(status.outstanding.costUsd).toBe(10);
    expect(status.reservations[0].state).toBe('uncertain');
  });
  it('raw-key rotation retains lifetime usage and uncertain exposure under stable key ID', async () => {
    const k = await key({maxCompletionTokens:100},'reserve-remaining');
    const r = await admission(k,{completionTokens:80});
    await markBudgetDispatched(r.requestId);
    await usage(k,r,{prompt_tokens:0,completion_tokens:10},{usageFinality:'partial'});
    const rotated = await updateApiKey(k.id,{key:`rotation-${randomUUID()}`});
    expect(rotated.id).toBe(k.id);
    await expect(admission(rotated,{completionTokens:21})).rejects.toMatchObject({code:'api_key_budget_exceeded'});
    expect((await getBudgetStatus(k.id)).account.recordedCompletionTokens).toBe(10);
  });
  it('a later provider receipt settles partial usage exactly once without another request or charge', async () => {
    const k = await key({maxCompletionTokens:100});
    const r = await admission(k,{completionTokens:100});
    await markBudgetDispatched(r.requestId);
    await usage(k,r,{prompt_tokens:12,completion_tokens:20},{usageFinality:'partial'});
    const beforeDaily = db.all('SELECT data FROM usageDaily').map(r=>JSON.parse(r.data)).reduce((a,r)=>a+r.completionTokens,0);
    const evidence = {kind:'provider-usage',reference:'fixture-provider-receipt-1',tokens:{prompt_tokens:12,completion_tokens:40}};
    await reconcileBudgetUsage(k.id,r.requestId,evidence);
    await reconcileBudgetUsage(k.id,r.requestId,evidence);
    const status = await getBudgetStatus(k.id);
    expect(status.reservations[0].state).toBe('settled');
    expect(status.account.recordedCompletionTokens).toBe(40);
    expect(status.outstanding.completionTokens).toBe(0);
    expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(1);
    expect(db.get('SELECT completionTokens FROM usageHistory').completionTokens).toBe(40);
    const afterDaily = db.all('SELECT data FROM usageDaily').map(r=>JSON.parse(r.data)).reduce((a,r)=>a+r.completionTokens,0);
    expect(afterDaily-beforeDaily).toBe(20);
    await expect(reconcileBudgetUsage(k.id,r.requestId,{...evidence,tokens:{prompt_tokens:12,completion_tokens:50}})).rejects.toThrow('already has different settled');
  });
  it('grouped key summaries separate held exposure from recorded counts without raw secrets', async () => {
    const k = await key({maxCompletionTokens:100},'reserve-remaining');
    const r = await admission(k);
    await markBudgetDispatched(r.requestId);
    const summaries=await getApiKeyBudgetSummaries();
    expect(summaries[k.id]).toMatchObject({apiKeyId:k.id,policy:'reserve-remaining',recorded:{completionTokens:0},outstanding:{requests:1,dispatched:1,completionTokens:100,unknownBoundRequests:1},providerChargeConfirmed:false});
    expect(JSON.stringify(summaries)).not.toContain(k.key);
  });
  it('an unlimited in-flight request keeps stable ownership across key rotation', async () => {
    const k = await key({});
    const context = {requestId:randomUUID(),logicalRequestId:'rotation-in-flight'};
    await beginBudgetDispatch(context,k.key,{});
    expect(context.apiKeyId).toBe(k.id);
    expect(db.get('SELECT COUNT(*) AS n FROM apiKeyBudgetReservations').n).toBe(0);
    await updateApiKey(k.id,{key:'rotated-'+randomUUID()});
    await saveRequestUsage({apiKey:k.key,contextTelemetry:context,provider:'test',model:'test',tokens:{prompt_tokens:8,completion_tokens:6}});
    expect((await getBudgetStatus(k.id)).account).toMatchObject({recordedPromptTokens:8,recordedCompletionTokens:6});
  });
  it('estimates remain recorded but cannot erase unknown historical quantities', async () => {
    const k=await key({maxCompletionTokens:100},'reserve-remaining');
    const r=await admission(k);
    await markBudgetDispatched(r.requestId);
    await usage(k,r,{prompt_tokens:12,completion_tokens:20,estimated:true});
    const status=await getBudgetStatus(k.id);
    expect(status.account).toMatchObject({recordedCompletionTokens:20,unknownCompletionRows:1});
    expect(status.reservations[0].actualCompletionTokens).toBeNull();
    expect(status.outstanding.completionTokens).toBe(100);
  });
  it('uncapped dimensions do not prevent settlement of a complete capped USD amount', async () => {
    const k=await key({maxCostUsd:10},'reserve-remaining');
    const r=await admission(k,{completionTokens:20});
    expect(r.reservedCompletionTokens).toBeNull();
    await markBudgetDispatched(r.requestId);
    await usage(k,r,{cost_usd:3});
    const status=await getBudgetStatus(k.id);
    expect(status.reservations[0].state).toBe('settled');
    expect(status.account.recordedCostUsd).toBe(3);
    expect(status.outstanding.costUsd).toBe(0);
  });
  it('idempotent reserve never crosses a key or logical identity', async () => {
    const k = await key({maxCompletionTokens:100});
    const r = await admission(k,{completionTokens:60});
    expect(await admission(k,{completionTokens:60},{requestId:r.requestId})).toMatchObject({requestId:r.requestId});
    await expect(admission(k,{completionTokens:60},{requestId:r.requestId,logicalRequestId:'other'})).rejects.toMatchObject({code:'budget-identity-conflict'});
  });
});
