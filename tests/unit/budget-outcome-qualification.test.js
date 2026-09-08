import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getAdapter } from '@/lib/db/driver.js';
import { createApiKey, updateApiKey } from '@/lib/db/repos/apiKeysRepo.js';
import { saveRequestUsage, reconcileBudgetUsage } from '@/lib/db/repos/usageRepo.js';
import { reserveBudget, markBudgetDispatched, getBudgetStatus } from '@/lib/db/repos/budgetRepo.js';
import { priceUsage } from '@/lib/db/repos/usagePricing.js';

let db;
beforeAll(async () => { db = await getAdapter(); });
beforeEach(() => { for (const table of ['apiKeyBudgetReservations', 'apiKeyBudgetAccounts', 'usageHistory', 'usageDaily', 'apiKeys']) db.run(`DELETE FROM ${table}`); });

async function partial() {
  const created = await createApiKey('receipt fixture', 'isolated');
  const k = await updateApiKey(created.id, { maxCompletionTokens: 100, budgetPolicy: 'reserve-remaining' });
  const r = await reserveBudget({ apiKey: k.key, requestId: randomUUID(), logicalRequestId: 'logical', bounds: {} });
  await markBudgetDispatched(r.requestId);
  await saveRequestUsage({ apiKey: k.key, provider: 'test', model: 'test', requestId: r.requestId, logicalRequestId: r.logicalRequestId,
    tokens: { prompt_tokens: 12, completion_tokens: 20 }, usageFinality: 'partial' });
  return { k, r };
}
const snapshot = () => JSON.stringify(db.all('SELECT * FROM usageHistory')) + JSON.stringify(db.all('SELECT * FROM apiKeyBudgetReservations')) + JSON.stringify(db.all('SELECT * FROM apiKeyBudgetAccounts'));

describe('receipt reconciliation refuses ambiguity before any write', () => {
  it.each([
    ['prompt_tokens', 'input_tokens', 12, 13],
    ['completion_tokens', 'output_tokens', 40, 41],
    ['cost_usd', 'cost_in_usd', 0.5, 0.25],
  ])('rejects a receipt where %s and %s disagree', async (a, b, x, y) => {
    const { k, r } = await partial();
    const before = snapshot();
    await expect(reconcileBudgetUsage(k.id, r.requestId, { kind: 'provider-usage', reference: 'fixture', tokens: { [a]: x, [b]: y } }))
      .rejects.toThrow(`conflicting values for ${a} and ${b}`);
    expect(snapshot()).toBe(before);
    expect((await getBudgetStatus(k.id)).reservations[0].state).toBe('uncertain');
  });
  it('accepts a receipt that spells one quantity twice with the same value', async () => {
    const { k, r } = await partial();
    await reconcileBudgetUsage(k.id, r.requestId, { kind: 'provider-usage', reference: 'fixture', tokens: { prompt_tokens: 12, input_tokens: 12, completion_tokens: 40, output_tokens: 40 } });
    expect(db.get('SELECT completionTokens FROM usageHistory').completionTokens).toBe(40);
  });
  it('preserves an explicit reported USD zero as provider-reported, not confirmed payment', async () => {
    const { k, r } = await partial();
    await reconcileBudgetUsage(k.id, r.requestId, { kind: 'provider-usage', reference: 'fixture', tokens: { prompt_tokens: 12, completion_tokens: 40, cost_usd: 0 } });
    const row = db.get('SELECT reportedCostUsd, costSource, cost FROM usageHistory');
    expect(row).toMatchObject({ reportedCostUsd: 0, costSource: 'provider-reported', cost: 0 });
    const status = await getBudgetStatus(k.id);
    expect(status.reservations[0].state).toBe('settled');
    expect(status.reservations[0].actualCostUsd).toBe(0);
  });
});

describe('priceUsage keeps conflicting reported USD values as evidence, not as an amount', () => {
  const rates = { rates: { input: 1, output: 2 } };
  it('leaves the reported amount unknown and labels the estimate separately', () => {
    const priced = priceUsage({ prompt_tokens: 1000000, completion_tokens: 0, cost_usd: 0.5, cost_in_usd: 0.25 }, rates);
    expect(priced.reportedCostUsd).toBeNull();
    expect(priced.costEvidence).toEqual({ source: 'upstream-usage', currency: 'USD', conflict: { cost_usd: 0.5, cost_in_usd: 0.25 } });
    expect(priced.estimatedCostUsd).toBe(1);
    expect(priced.costSource).toBe('application-estimate');
    expect(priced.cost).toBe(1);
  });
  it('without a rate card the conflict leaves cost unknown', () => {
    const priced = priceUsage({ prompt_tokens: 1, completion_tokens: 1, cost_usd: 0.5, cost_in_usd: 0.25 }, { rates: null });
    expect(priced).toMatchObject({ reportedCostUsd: null, estimatedCostUsd: null, cost: null, costSource: 'unknown' });
    expect(priced.costEvidence.conflict).toEqual({ cost_usd: 0.5, cost_in_usd: 0.25 });
  });
  it('agreeing duplicate spellings and a single spelling both report normally', () => {
    expect(priceUsage({ cost_usd: 0.5, cost_in_usd: 0.5 }, { rates: null })).toMatchObject({ reportedCostUsd: 0.5, costSource: 'provider-reported', costEvidence: { field: 'cost_usd' } });
    expect(priceUsage({ cost_in_usd: 0.3 }, { rates: null })).toMatchObject({ reportedCostUsd: 0.3, costEvidence: { field: 'cost_in_usd' } });
  });
});
