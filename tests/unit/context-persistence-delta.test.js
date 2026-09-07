import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ adapter: null, get: vi.fn() }));
vi.mock('../../src/lib/db/driver.js', () => ({ getAdapter: () => state.get() }));
import { createBetterSqliteAdapter } from '../../src/lib/db/adapters/betterSqliteAdapter.js';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { createSqlJsAdapter } from '../../src/lib/db/adapters/sqljsAdapter.js';
import { TABLES, buildCreateTableSql } from '../../src/lib/db/schema.js';
import { saveRequestStats } from '../../src/lib/db/repos/requestStatsRepo.js';
import { readContextEvidenceExport } from '../../src/lib/db/analytics/contextEvidenceExport.mjs';
import { measureContextStructure } from '../../open-sse/utils/contextStructure.js';

const factories = [['better-sqlite3', createBetterSqliteAdapter], ['node:sqlite', createNodeSqliteAdapter], ['sql.js', createSqlJsAdapter]];
const stamp = new Date().toISOString();
const structure = measureContextStructure({ messages: [{ role: 'user', content: 'protected α' }] }, 'client-received', Buffer.alloc(32, 7));
function entry(patch = {}) {
  return { id: 'request', provider: 'controlled', model: 'fixture', timestamp: stamp, connectionId: 'account', status: 'pending', tokens: null,
    contextTelemetry: { sessionHash: 'a'.repeat(32), identitySource: 'explicit', logicalRequestId: 'logical', requestedModel: 'selected', attempt: 1,
      dispatchCoverage: 'physical-dispatch', stages: [{ stage: 'tools', in: 800, out: 800, ran: false }, { stage: 'rtk', in: 800, out: 600, ran: true, semanticPreserving: true }, { stage: 'final', in: 600, out: 610, ran: true }],
      structures: [structure], controls: { rtk: true, contextStructure: true }, bodyAfterBytes: 610, cachePrefixBytes: 80, messageCount: 1, toolCount: 0,
      pricingSnapshot: { id: 'b'.repeat(64), provider: 'controlled', model: 'fixture', source: 'fixture', currency: 'USD', unit: 'per-million-tokens', calculatorVersion: 'fixture-v1', rates: { input: 1, output: 2 }, capturedAt: stamp } }, ...patch };
}
const snapshot = db => Object.fromEntries(['requestStats', 'contextStages', 'contextStructures', 'contextSessions', 'usageRateSnapshots'].map(table => [table, db.all(`SELECT * FROM ${table} ORDER BY 1`)]));
for (const [driver, create] of factories) describe(driver, () => {
  let db, file;
  beforeEach(async () => {
    file = join(mkdtempSync(join(process.env.DATA_DIR, 'delta-')), 'data.sqlite');
    db = await create(file); state.adapter = db; state.get.mockReset().mockImplementation(async () => db);
    for (const [name, definition] of Object.entries(TABLES)) db.exec(buildCreateTableSql(name, definition));
    db.exec('CREATE TABLE _testLedgerWrites(name TEXT,operation TEXT)');
    for (const table of ['contextStages', 'contextStructures']) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER test_${table}_${operation} AFTER ${operation} ON ${table} BEGIN INSERT INTO _testLedgerWrites VALUES('${table}','${operation}'); END`);
  });
  afterEach(() => { vi.restoreAllMocks(); db?.close(); db = null; });
  it('repeated identical snapshots cause zero durable changes and keep every signed byte', async () => {
    const detail = entry(); await saveRequestStats(detail);
    const first = snapshot(db), before = db.get('SELECT total_changes() AS n').n;
    await saveRequestStats(detail); await saveRequestStats(structuredClone(detail));
    expect(snapshot(db)).toEqual(first);
    expect(db.get('SELECT total_changes() AS n').n - before).toBe(0);
    expect(JSON.parse(first.contextStructures[0].data)).toEqual(structure);
  });
  it('updates final usage and time without rewriting an unchanged ordered stage or HMAC ledger', async () => {
    const pending = entry(); await saveRequestStats(pending);
    const stages = db.all('SELECT * FROM contextStages ORDER BY ordinal'), structures = db.all('SELECT * FROM contextStructures');
    db.run('DELETE FROM _testLedgerWrites');
    const finalAt = new Date(Date.parse(stamp) + 1000).toISOString();
    await saveRequestStats({ ...pending, timestamp: finalAt, status: 'success', tokens: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 }, latency: { total: 31, ttft: 7 } });
    expect(db.all('SELECT * FROM contextStages ORDER BY ordinal')).toEqual(stages);
    expect(db.all('SELECT * FROM contextStructures')).toEqual(structures);
    expect(db.all('SELECT * FROM _testLedgerWrites')).toEqual([]);
    expect(db.get('SELECT status,timestamp,promptTokens,completionTokens,cachedTokens,cacheCreationTokens,latencyTotal,latencyTtft,usageSource,usageInputPresent,usageOutputPresent,rateSnapshotId FROM requestStats')).toEqual({ status: 'success', timestamp: finalAt, promptTokens: 35, completionTokens: 3, cachedTokens: 20, cacheCreationTokens: 5, latencyTotal: 31, latencyTtft: 7, usageSource: 'provider', usageInputPresent: 1, usageOutputPresent: 1, rateSnapshotId: 'b'.repeat(64) });
    expect(db.get('SELECT firstSeenAt,lastSeenAt FROM contextSessions')).toEqual({ firstSeenAt: stamp, lastSeenAt: finalAt });
  });
  it('persists and exports every effective context control, including false values', async () => {
    const detail = entry();
    detail.contextTelemetry.controls = {
      rtk: true, contextStructure: true,
      diet: true, lingua: false, epochMicro: true, epochAuto: false, adaptiveCacheTtl: true,
      ignored: true,
    };
    await saveRequestStats(detail);
    const expected = {
      rtk: true, contextStructure: true,
      diet: true, lingua: false, epochMicro: true, epochAuto: false, adaptiveCacheTtl: true,
    };
    expect(JSON.parse(db.get('SELECT contextControls FROM requestStats WHERE id=?', ['request']).contextControls)).toEqual(expected);
    const exported = readContextEvidenceExport(db, { selection: { id: 'request', sessionId: 1 }, scope: {}, context: {} }, 'selected', 10);
    expect(exported.items[0].controls).toEqual(expected);
  });
  it('keeps each changed intermediate boundary, shrinking stage order and growing structural evidence', async () => {
    const detail = entry(); await saveRequestStats(detail);
    detail.contextTelemetry.stages = [{ stage: 'tools', in: 800, out: 800, ran: false }, { stage: 'final', in: 800, out: 900, ran: true }];
    const physical = { ...structure, boundary: 'physical-dispatch' };
    detail.contextTelemetry.structures = [structure, physical];
    await saveRequestStats(detail);
    expect(db.all('SELECT ordinal,stage,beforeBytes,afterBytes,deltaBytes,outcome,risk FROM contextStages ORDER BY ordinal')).toEqual([
      { ordinal: 0, stage: 'tools', beforeBytes: 800, afterBytes: 800, deltaBytes: 0, outcome: 'skipped', risk: 'normalization' },
      { ordinal: 1, stage: 'final', beforeBytes: 800, afterBytes: 900, deltaBytes: 100, outcome: 'applied', risk: 'normalization' },
    ]);
    expect(db.all('SELECT boundary,data FROM contextStructures ORDER BY boundary').map(r => JSON.parse(r.data))).toEqual([structure, physical]);
  });
  it('persists changed risk and same-boundary fingerprints even when byte counts match', async () => {
    const detail = entry(); await saveRequestStats(detail);
    const replacement = measureContextStructure({ messages: [{ role: 'user', content: 'protected β' }] }, 'client-received', Buffer.alloc(32, 7));
    detail.contextTelemetry.stages[1].semanticPreserving = false;
    detail.contextTelemetry.structures = [replacement];
    db.run('DELETE FROM _testLedgerWrites');
    await saveRequestStats(detail);
    expect(db.get("SELECT risk FROM contextStages WHERE stage='rtk'").risk).toBe('content-changing');
    expect(JSON.parse(db.get('SELECT data FROM contextStructures').data)).toEqual(replacement);
    expect(db.all('SELECT * FROM _testLedgerWrites ORDER BY name')).toEqual([
      { name: 'contextStages', operation: 'UPDATE' }, { name: 'contextStructures', operation: 'UPDATE' },
    ]);
  });
  it('retains first pricing attribution and request identity when later metadata changes', async () => {
    const detail = entry(); await saveRequestStats(detail);
    const originalPricing = db.get('SELECT * FROM usageRateSnapshots');
    const nextAt = new Date(Date.parse(stamp) + 1000).toISOString();
    detail.contextTelemetry.pricingSnapshot = { ...detail.contextTelemetry.pricingSnapshot, id: 'c'.repeat(64), rates: { input: 9, output: 10 }, capturedAt: nextAt };
    await saveRequestStats({ ...detail, provider: 'different', model: 'different', connectionId: 'different', status: 'success', tokens: { prompt_tokens: 15, completion_tokens: 2 } });
    expect(db.get('SELECT provider,model,connectionId,rateSnapshotId,pricingCapturedAt FROM requestStats')).toEqual({ provider: 'controlled', model: 'fixture', connectionId: 'account', rateSnapshotId: 'b'.repeat(64), pricingCapturedAt: stamp });
    expect(db.get('SELECT * FROM usageRateSnapshots WHERE id=?', ['b'.repeat(64)])).toEqual(originalPricing);
    expect(db.get('SELECT COUNT(*) AS n FROM usageRateSnapshots').n).toBe(2);
  });
  it('does not cache a rolled-back optional ledger or suppress its later valid restoration', async () => {
    const detail = entry(); await saveRequestStats(detail);
    db.exec("CREATE TRIGGER fail_ledger BEFORE UPDATE ON contextStages WHEN NEW.afterBytes=999 BEGIN SELECT RAISE(ABORT,'injected fixture'); END");
    db.exec("CREATE TRIGGER fail_ledger_insert BEFORE INSERT ON contextStages WHEN NEW.afterBytes=999 BEGIN SELECT RAISE(ABORT,'injected fixture'); END");
    detail.contextTelemetry.stages = [{ stage: 'final', in: 800, out: 999, ran: true }];
    await saveRequestStats({ ...detail, status: 'success', tokens: { prompt_tokens: 17, completion_tokens: 4 } });
    expect(db.get('SELECT promptTokens,completionTokens,contextTelemetryError FROM requestStats')).toEqual({ promptTokens: 17, completionTokens: 4, contextTelemetryError: 'invalid-metrics' });
    expect(db.all('SELECT * FROM contextStages')).toEqual([]);
    db.exec('DROP TRIGGER fail_ledger; DROP TRIGGER fail_ledger_insert');
    await saveRequestStats({ ...detail, status: 'success', tokens: { prompt_tokens: 17, completion_tokens: 4 } });
    expect(db.get('SELECT afterBytes FROM contextStages').afterBytes).toBe(999);
    expect(db.get('SELECT contextTelemetryError FROM requestStats').contextTelemetryError).toBeNull();
  });
  it('checks a delayed pending write against the committed terminal state', async () => {
    const gate = Promise.withResolvers(); state.get.mockImplementationOnce(() => gate.promise);
    const pending = saveRequestStats(entry());
    await saveRequestStats(entry({ status: 'aborted', tokens: { prompt_tokens: 12, completion_tokens: 2 }, latency: { total: 14 } }));
    const final = snapshot(db); gate.resolve(db); await pending;
    expect(snapshot(db)).toEqual(final);
  });
  it('keeps native and sql.js persisted snapshots after repeated terminal updates and reload', async () => {
    const detail = entry({ status: 'success', tokens: { prompt_tokens: 15, completion_tokens: 2, cached_tokens: 0 } });
    await saveRequestStats(detail); await saveRequestStats(detail);
    const saved = snapshot(db); db.flush?.(); db.close(); db = await create(file); state.adapter = db;
    expect(snapshot(db)).toEqual(saved);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
});
