import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachCounterfactualEvidence, counterfactualEvidence } from '@/lib/db/analytics/counterfactualEvidence.mjs';
import { getAdapter } from '@/lib/db/driver.js';
const completionId = '11111111-1111-4111-8111-111111111111';
const row = { completionId, requestId: 'r1', provider: 'codex', model: 'm', usageSource: 'provider', requestLink: 'linked', inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 };
const entry = { ...row, id: 'r1', ts: '2026-09-07T12:00:00Z', baselineUsd: 1, actualUsd: 2, savedUsd: -1, saverSavedUsd: -1.2, cacheSavedUsd: 0.2 };
describe('counterfactual evidence boundary', () => {
  it('retains signed modeled differences without claiming realized savings', () => {
    const value = counterfactualEvidence(row, entry, 1);
    expect(value).toMatchObject({ available: true, modeledDifferenceUsd: -1, splitAvailable: true, inputEstimateDifferenceUsd: -1.2, rateSnapshotAvailable: false });
    expect(value).not.toHaveProperty('sid');
    expect(value).not.toHaveProperty('savedUsd');
  });
  it.each([
    [{ ...row, completionId: null }, entry, 1, 'identity-unavailable'],
    [row, null, 0, 'not-retained'],
    [row, entry, 2, 'ambiguous-completion'],
    [{ ...row, provider: 'another' }, entry, 1, 'identity-conflict'],
    [{ ...row, requestLink: 'conflict' }, entry, 1, 'identity-conflict'],
    [row, { ...entry, completionId: null }, 1, 'identity-conflict'],
    [{ ...row, inputTokens: 99 }, entry, 1, 'usage-conflict'],
    [{ ...row, usageSource: 'estimated' }, entry, 1, 'usage-conflict'],
    [{ ...row, invalidTokens: 1 }, entry, 1, 'usage-conflict'],
    [{ ...row, inconsistentCache: 1 }, entry, 1, 'usage-conflict'],
    [{ ...row, cacheReadTokens: 150 }, { ...entry, cacheReadTokens: 150 }, 1, 'usage-conflict'],
    [{ ...row, cacheWriteTokens: 60 }, { ...entry, cacheWriteTokens: 60 }, 1, 'usage-conflict'],
    [{ ...row, inputTokens: 100.5 }, { ...entry, inputTokens: 100.5 }, 1, 'usage-conflict'],
    [{ ...row, inputTokens: Number.MAX_SAFE_INTEGER + 1 }, { ...entry, inputTokens: Number.MAX_SAFE_INTEGER + 1 }, 1, 'usage-conflict'],
    [row, { ...entry, savedUsd: 50 }, 1, 'arithmetic-conflict'],
  ])('refuses unsupported attribution %#', (usage, cost, matches, state) => {
    expect(counterfactualEvidence(usage, cost, matches)).toEqual({ available: false, state, source: 'costLedger', unit: 'USD' });
  });
  it('keeps historical zero/zero decomposition unknown even when the total is zero', () => {
    expect(counterfactualEvidence(row, { ...entry, actualUsd: 1, savedUsd: 0, saverSavedUsd: 0, cacheSavedUsd: 0 }, 1)).toMatchObject({ available: true, modeledDifferenceUsd: 0, splitAvailable: false, inputEstimateDifferenceUsd: null, cachePricingDifferenceUsd: null });
  });
  it('does not accept an overflowing decomposition as reconciled', () => {
    expect(counterfactualEvidence(row, { ...entry, saverSavedUsd: 1e308, cacheSavedUsd: 1e308 }, 1))
      .toMatchObject({ available: true, splitAvailable: false, inputEstimateDifferenceUsd: null, cachePricingDifferenceUsd: null });
  });
});

describe('exact indexed completion binding', () => {
  let db;
  beforeEach(async () => {
    db = await getAdapter();
    db.run('DELETE FROM usageHistory');
    db.run('DELETE FROM costLedger');
  });
  const insert = (db, id = completionId) => {
    db.run('INSERT INTO usageHistory(timestamp,completionId) VALUES(?,?)', [entry.ts,id]);
    db.run('INSERT INTO costLedger(id,completionId,ts,provider,model,baselineUsd,actualUsd,savedUsd,saverSavedUsd,cacheSavedUsd,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ['cafebabe',id,entry.ts,row.provider,row.model,1,2,-1,-1.2,0.2,100,20,50,0]);
  };
  it('does not query history for legacy rid/request-id links or expose freeform identity', () => {
    const legacy = { ...row, completionId: 'private-client-header', costLedgerId: 'cafebabe', requestId: 'cafebabe' };
    const all = vi.fn();
    attachCounterfactualEvidence({ all }, [legacy]);
    expect(legacy.counterfactual.state).toBe('identity-unavailable');
    expect(legacy.completionId).toBeNull();
    expect(all).not.toHaveBeenCalled();
  });
  it('uses indexed equality and grouped counts for only the selected UUIDs', () => {
    insert(db);
    const plans = [];
    const recording = { all: (sql, args) => {
      if (sql.includes('WHERE completionId IN')) plans.push(...db.all(`EXPLAIN QUERY PLAN ${sql}`, args));
      return db.all(sql,args);
    } };
    const selected = { ...row };
    attachCounterfactualEvidence(recording, [selected]);
    expect(selected.counterfactual).toMatchObject({ available: true, id: completionId, identityBasis: 'server-completion-id' });
    expect(plans.map(plan => plan.detail).join('\n')).toContain('idx_cl_completion');
    expect(plans.map(plan => plan.detail).join('\n')).toContain('idx_uh_completion');
    expect(plans.some(plan => /SCAN (usageHistory|costLedger)/.test(plan.detail))).toBe(false);
  });
  it('enforces unique bindings and refuses duplicates from an imported database without its index', () => {
    insert(db);
    expect(() => db.run('INSERT INTO usageHistory(timestamp,completionId) VALUES(?,?)', [entry.ts,completionId])).toThrow();
    expect(() => db.run('INSERT INTO costLedger(id,completionId,ts,baselineUsd,actualUsd,savedUsd) VALUES(?,?,?,?,?,?)', ['another',completionId,entry.ts,1,2,-1])).toThrow();
    db.exec('DROP INDEX idx_uh_completion');
    try {
      db.run('INSERT INTO usageHistory(timestamp,completionId) VALUES(?,?)', [entry.ts,completionId]);
      const selected = { ...row };
      attachCounterfactualEvidence(db, [selected]);
      expect(selected.counterfactual.state).toBe('ambiguous-completion');
    } finally {
      db.run('DELETE FROM usageHistory');
      db.exec('CREATE UNIQUE INDEX idx_uh_completion ON usageHistory(completionId) WHERE completionId IS NOT NULL');
    }
  });
  it('batches exports within SQLite parameter bounds without scanning historical rows', () => {
    const selected = Array.from({ length: 1001 }, (_, i) => ({ ...row, completionId: `${i.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111` }));
    const calls = [];
    const bounded = { all: (sql,args) => { calls.push({sql,args}); return db.all(sql,args); } };
    attachCounterfactualEvidence(bounded, selected);
    expect(calls.filter(call => call.sql.includes('WHERE completionId IN'))).toHaveLength(6);
    expect(calls.every(call => call.args.length <= 400)).toBe(true);
    expect(selected.every(item => item.counterfactual.state === 'not-retained')).toBe(true);
  });
});
