import { beforeEach, describe, expect, it, vi } from 'vitest';
const failure = vi.hoisted(() => ({ active: false }));
vi.mock('../../src/lib/db/repos/costLedgerRepo.js', async original => {
  const actual = await original();
  return { ...actual, recordCostLedgerForRequest: args => failure.active
    ? Promise.reject(new Error('synthetic ledger write failure')) : actual.recordCostLedgerForRequest(args) };
});
import { saveUsageStats } from '../../open-sse/handlers/chatCore/requestDetail.js';
import { waitForLedgerWrite } from '../../src/lib/db/repos/costLedgerRepo.js';
import { getAdapter } from '../../src/lib/db/driver.js';
import { readActivityAnalytics } from '../../src/lib/db/analytics/activityQueries.mjs';
import { readRid } from '../../src/shared/observability/decide.js';
import { isCompletionId } from '../../src/lib/db/completionIdentity.mjs';
import { createVisibleTelemetryFixture } from '../fixtures/visible-telemetry.mjs';

const db = await getAdapter();
const args = { provider:'openai', model:'gpt-4o', tokens:{prompt_tokens:100,cached_tokens:50,cache_creation_input_tokens:0,completion_tokens:20}, preSaverSerialized:'x'.repeat(400), silent:true };
const read = () => readActivityAnalytics(db,{operation:'activity',view:'economics'}).items;
// Public analytics excludes test-origin writes, so each completion's own rows
// are re-identified as a receipted synthetic import before it is read back.
const visible = createVisibleTelemetryFixture(db, 'completion-identity-pipeline');
async function complete(rid) { await visible(async () => { await saveUsageStats({...args,rid}); await waitForLedgerWrite(rid); }); }
beforeEach(() => { failure.active=false; db.run('DELETE FROM usageHistory'); db.run('DELETE FROM costLedger'); });

describe('server completion binding through the real final usage writer', () => {
  it('binds exactly one completion despite colliding client header prefixes', async () => {
    const a = readRid(new Request('http://localhost/',{headers:{'x-tp-rid':'cafebabe11111111'}}));
    const b = readRid(new Request('http://localhost/',{headers:{'x-tp-rid':'cafebabe22222222'}}));
    expect(a).toBe('cafebabe'); expect(b).toBe(a);
    await complete(a);
    const first = db.get('SELECT completionId FROM usageHistory');
    expect(isCompletionId(first.completionId)).toBe(true);
    await complete(b);
    const rows = read();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row=>row.completionId)).size).toBe(2);
    expect(rows.find(row=>row.completionId===first.completionId).counterfactual.state).toBe('not-retained');
    expect(rows.find(row=>row.completionId!==first.completionId).counterfactual).toMatchObject({available:true,identityBasis:'server-completion-id'});
    expect(JSON.stringify(rows)).not.toContain('cafebabe');
    expect(JSON.stringify(rows)).not.toContain('costLedgerId');
  });
  it('keeps a later completion unavailable when its ledger write fails and the old rid row survives', async () => {
    await complete('cafebabe');
    const old = db.get('SELECT completionId FROM costLedger');
    db.run('UPDATE costLedger SET ts=?',['2026-09-01T00:00:00.000Z']);
    failure.active=true;
    await complete('cafebabe');
    const rows=read(), later=rows.find(row=>row.completionId!==old.completionId);
    expect(rows).toHaveLength(2);
    expect(later.counterfactual.state).toBe('not-retained');
    expect(db.get('SELECT completionId,ts FROM costLedger')).toEqual({...old,ts:'2026-09-01T00:00:00.000Z'});
  });
  it('does not bind partial usage or turn legacy request IDs into completion evidence', async () => {
    await visible(() => saveUsageStats({...args,rid:'cafebabe',usageFinality:'partial'}));
    expect(db.get('SELECT completionId FROM usageHistory').completionId).toBeNull();
    expect(db.all('SELECT * FROM costLedger')).toHaveLength(0);
    db.run('UPDATE usageHistory SET requestId=?,meta=?',['cafebabe',JSON.stringify({costLedgerId:'cafebabe'})]);
    expect(read()[0].counterfactual.state).toBe('identity-unavailable');
  });
});
