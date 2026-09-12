import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { createSqlJsAdapter } from '../../src/lib/db/adapters/sqljsAdapter.js';
import { runMigrationOnce } from '../../src/lib/db/migrate.js';
import { buildCreateTableSql } from '../../src/lib/db/schema.js';
import { ECONOMICS_PROJECTION_TABLES, economicsProjectionReady } from '../../src/lib/db/economicsProjectionSchema.js';
import { readActivityAnalytics, readActivityEvidence } from '../../src/lib/db/analytics/activityQueries.mjs';
import { analyticsDataVersion, createContextAnalyticsClient } from '../../src/lib/db/analytics/client.js';
import { applyQuarantine, createQuarantineManifest, revertQuarantine } from '../../src/lib/db/repos/telemetryQuarantineRepo.js';

const at = '2026-09-06T12:00:00.000Z';
const start = '2026-09-06T00:00:00.000Z', end = '2026-09-07T00:00:00.000Z';
const evidence = 'Owned synthetic source identities for economics visibility regression';
const ref = number => `ctx1_${String(number).repeat(64)}`;
const query = patch => ({ operation: 'activity', view: 'economics', start, end, pageSize: 100, ...patch });
const rows = [{ sourceTable: 'usageHistory', rowId: '1' }, { sourceTable: 'requestStats', rowId: 'request-2' }];

describe.each(['node:sqlite', 'sql.js'])('economics visibility using %s', driver => {
  let directory, file, db;
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-economics-visibility-'));
    file = path.join(directory, 'fixture.sqlite');
    db = await (driver === 'node:sqlite' ? createNodeSqliteAdapter : createSqlJsAdapter)(file);
    await runMigrationOnce(db);
    db.transaction(() => {
      for (let id = 1; id <= 7; id++) {
        const requestId = id === 6 ? 'bh-1' : `request-${id}`;
        db.run(`INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cachedTokens,cacheCreationTokens,
          latencyTotal,latencyTtft,logicalRequestId,sourceUsageId,dataOrigin,clientKeyId,clientIdentitySource,clientRef,taskRef,projectRef)
          VALUES(?,?,?,?,?,'success',100,10,20,0,?,?,?,?,?,?,'client-reported',?,?,?)`,
        [requestId, at, 'provider', 'model', 'account', id * 100, id * 10, `logical-${id}`, id === 5 ? 1 : null,
          id === 3 ? 'test' : 'unknown', `request-key-${id}`, ref(id), ref(id), ref(id)]);
      }
      for (let id = 1; id <= 8; id++) {
        const requestId = id === 6 ? 'bh-1' : id === 8 ? 'not-retained' : `request-${id}`;
        db.run(`INSERT INTO usageHistory(id,timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cost,tokens,
          requestId,logicalRequestId,dataOrigin,clientKeyId,clientIdentitySource,clientRef)
          VALUES(?,?,?,?,?,'ok',100,10,?,'{"cached_tokens":20.0,"cache_creation_input_tokens":0.0}',?,?,?,?,?,?)`,
        [id, at, 'provider', 'model', 'account', id, requestId, `logical-${id}`,
          id === 4 ? 'test' : id === 7 ? 'import' : id === 3 ? 'production' : 'unknown',
          id === 3 ? 'durable-key' : null, id === 3 ? 'client-reported' : null, id === 3 ? ref(9) : null]);
      }
    });
  });
  afterEach(() => { db?.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  const read = patch => readActivityAnalytics(db, query(patch));
  const sourceRows = () => ['usageHistory', 'requestStats'].map(table => db.all(`SELECT * FROM ${table} ORDER BY id`));
  const manifest = (selected = rows) => createQuarantineManifest(db, { rows: selected, evidence });
  const projected = id => db.get('SELECT * FROM usageEconomicsProjection WHERE id=?', [id]);
  const rawRead = patch => db.transaction(() => {
    db.run("UPDATE _meta SET value='0' WHERE key='economicsProjectionVersion'");
    const result = read(patch);
    db.run("UPDATE _meta SET value='4' WHERE key='economicsProjectionVersion'");
    return result;
  });
  const removeProjectionOrigin = () => {
    const { dataOrigin: _origin, ...columns } = ECONOMICS_PROJECTION_TABLES.usageEconomicsProjection.columns;
    const columnNames = Object.keys(columns), stored = db.all(`SELECT ${columnNames.join(',')} FROM usageEconomicsProjection ORDER BY id`);
    const triggers = db.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE '%_economics_after_%'");
    for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
    db.exec('DROP TABLE usageEconomicsProjection');
    db.exec(buildCreateTableSql('usageEconomicsProjection', { columns }));
    for (const row of stored) db.run(`INSERT INTO usageEconomicsProjection(${columnNames.join(',')}) VALUES(${columnNames.map(() => '?').join(',')})`, columnNames.map(name => row[name]));
    return triggers;
  };

  it('preserves every source/projection row while applying and reverting exact visible populations', () => {
    const before = sourceRows(), baseline = read(), selected = manifest();
    expect(baseline.summary).toMatchObject({ records: 7, recordedCostUsd: 32, latencySamples: 5 });
    expect(read({ view: 'activity' }).summary.records).toBe(6);
    applyQuarantine(db, selected, { evidence });
    const result = read();
    expect(result.summary).toMatchObject({ records: 6, recordedCostUsd: 31, linkedRequestRows: 2,
      unavailableRequestRows: 4, conflictingRequestRows: 0, latencySamples: 2, averageLatencyMs: 650, p50LatencyMs: 600, p95LatencyMs: 700 });
    expect(result.items.map(row => row.id).sort()).toEqual([2, 3, 5, 6, 7, 8]);
    expect(read({ view: 'activity' }).items.map(row => row.id).sort()).toEqual(['bh-1', 'request-1', 'request-4', 'request-7']);
    expect(sourceRows()).toEqual(before);
    expect(db.get('SELECT COUNT(*) AS count FROM usageEconomicsProjection').count).toBe(8);
    expect(projected(4).dataOrigin).toBe('test');
    expect(projected(7).dataOrigin).toBe('import');
    expect(projected(6)).toMatchObject({ requestLink: 'linked', latencyMs: 600 });
    revertQuarantine(db, selected, { evidence });
    expect(read()).toEqual(baseline);
    expect(sourceRows()).toEqual(before);
  });

  it('keeps projected helpers, raw hydration, facets, filters, paging and exports on the same population', () => {
    applyQuarantine(db, manifest(), { evidence });
    for (const patch of [
      {}, { facets: ['summary'] }, { facets: ['groups'] }, { facets: ['series'] }, { facets: ['items'] },
      { seriesProfile: 'economics-chart' }, { groupBy: 'model' }, { groupBy: 'account' }, { groupBy: 'client-project' },
      { groupBy: 'logical-request', groupPageSize: 2, groupPage: 2 }, { pageSize: 2, page: 2 },
      { sortBy: 'latencyMs', sortDirection: 'asc' }, { provider: 'missing' }, { requestLink: 'unavailable' },
      { clientRef: ref(5) }, { clientRef: ref(6) }, { recordId: 1 }, { requestId: 'request-2' }, { costSource: 'unknown' },
    ]) expect(read(patch), JSON.stringify(patch)).toEqual(rawRead(patch));
    const exported = readActivityEvidence(db, query(), 6);
    expect(exported.totalRecords).toBe(6);
    expect(exported.items.map(row => row.id).sort()).toEqual([2, 3, 5, 6, 7, 8]);
    expect(readActivityEvidence(db, query({ recordId: 1 }), 1).items).toEqual([]);
    expect(readActivityEvidence(db, query(), 5)).toMatchObject({ exceeded: true, totalRecords: 6 });
    expect(readActivityEvidence(db, query({ view: 'activity' }), 4).totalRecords).toBe(4);
  });

  it('removes only request-derived identity and latency, retaining independently recorded ledger identity', () => {
    applyQuarantine(db, manifest(), { evidence });
    for (const id of [2, 5]) {
      expect(projected(id)).toMatchObject({ requestLink: 'unavailable', latencyMs: null, ttftMs: null, clientKeyId: null, clientIdentitySource: null, clientRef: null, taskRef: null, projectRef: null });
    }
    expect(read().items.find(row => row.id === 3)).toMatchObject({ requestLink: 'unavailable', latencyMs: null, clientKeyId: 'durable-key', clientIdentitySource: 'client-reported', clientRef: ref(9) });
    expect(read({ clientRef: ref(5) }).summary.records).toBe(0);
    expect(read({ clientRef: ref(9) }).summary.records).toBe(1);
  });

  it('refreshes ancestry on source origin changes, disappearance, reappearance and request provenance changes', () => {
    db.run("UPDATE usageHistory SET dataOrigin='test' WHERE id=1");
    expect(projected(5).latencyMs).toBeNull();
    expect(read({ view: 'activity', requestId: 'request-5' }).summary.records).toBe(0);
    db.run('UPDATE requestStats SET sourceUsageId=NULL WHERE id=?', ['request-5']);
    expect(projected(5).latencyMs).toBe(500);
    db.run('UPDATE requestStats SET sourceUsageId=1 WHERE id=?', ['request-5']);
    expect(projected(5).latencyMs).toBeNull();
    db.run('DELETE FROM usageHistory WHERE id=1');
    expect(projected(5).latencyMs).toBe(500);
    db.run("INSERT INTO usageHistory(id,timestamp,dataOrigin) VALUES(1,?,'test')", [at]);
    expect(projected(5).latencyMs).toBeNull();
    db.run("UPDATE usageHistory SET dataOrigin='unknown' WHERE id=1");
    expect(projected(5).latencyMs).toBe(500);
    expect(read()).toEqual(rawRead());
  });

  it('refreshes both old and new quarantine identities on metadata row updates and deletions', () => {
    const selected = manifest([{ sourceTable: 'usageHistory', rowId: '1' }]);
    applyQuarantine(db, selected, { evidence });
    expect(projected(5).latencyMs).toBeNull();
    // Direct fixture mutation exercises corruption/recovery paths; it is not a
    // valid maintenance receipt and is never presented as one to the operator.
    db.run("UPDATE telemetryQuarantineRows SET sourceTable='requestStats',rowId='request-2' WHERE receiptId=?", [selected.id]);
    expect(projected(5).latencyMs).toBe(500);
    expect(projected(2).latencyMs).toBeNull();
    db.run('DELETE FROM telemetryQuarantineRows WHERE receiptId=?', [selected.id]);
    expect(projected(2).latencyMs).toBe(200);
    expect(read()).toEqual(rawRead());
  });

  it('updates only dependent projection rows and uses indexed source lookups', () => {
    db.exec('CREATE TABLE projectionTouches(id INTEGER)');
    db.exec('CREATE TRIGGER track_projection AFTER INSERT ON usageEconomicsProjection BEGIN INSERT INTO projectionTouches VALUES(NEW.id); END');
    const selected = manifest([{ sourceTable: 'usageHistory', rowId: '1' }]);
    applyQuarantine(db, selected, { evidence });
    expect(db.all('SELECT DISTINCT id FROM projectionTouches ORDER BY id').map(row => row.id)).toEqual([1, 5]);
    db.run('DELETE FROM projectionTouches');
    revertQuarantine(db, selected, { evidence });
    expect(db.all('SELECT DISTINCT id FROM projectionTouches ORDER BY id').map(row => row.id)).toEqual([1, 5]);
    db.run('DELETE FROM projectionTouches');
    db.run('UPDATE telemetryQuarantineReceipts SET metadata=? WHERE id=?', ['{"review":"synthetic-update"}', selected.id]);
    expect(db.all('SELECT * FROM projectionTouches')).toEqual([]);
    for (const name of ['usage_economics_after_insert', 'usage_economics_after_update', 'usage_economics_after_delete',
      'quarantine_row_economics_after_insert', 'quarantine_row_economics_after_update', 'quarantine_row_economics_after_delete',
      'quarantine_receipt_economics_after_insert', 'quarantine_receipt_economics_after_update', 'quarantine_receipt_economics_after_delete']) {
      const trigger = db.get('SELECT sql FROM sqlite_master WHERE name=?', [name]).sql, args = [];
      const select = trigger.slice(trigger.indexOf('SELECT u.id')).split(';')[0].replace(/(?:NEW|OLD)\.(sourceTable|rowId|id)/g, (_, field) => {
        args.push(field === 'sourceTable' ? 'usageHistory' : field === 'rowId' || name.startsWith('usage_') ? 1 : selected.id);
        return '?';
      });
      const plan = db.all(`EXPLAIN QUERY PLAN ${select}`, args).map(row => row.detail).join('\n');
      expect(plan, name).toContain('idx_rs_source_usage');
      expect(plan, name).not.toMatch(/SCAN (u|linked|source|requestStats|usageHistory)(?:\s|$)/);
    }
  });

  it('rolls back receipt and projection changes together if a dependent refresh fails', () => {
    const baseline = read(), source = sourceRows(), selected = manifest([{ sourceTable: 'usageHistory', rowId: '1' }]);
    db.exec("CREATE TRIGGER reject_projection BEFORE INSERT ON usageEconomicsProjection WHEN NEW.id=5 BEGIN SELECT RAISE(ABORT,'injected dependent refresh failure'); END");
    expect(() => applyQuarantine(db, selected, { evidence })).toThrow('injected dependent refresh failure');
    expect(db.all('SELECT * FROM telemetryQuarantineReceipts')).toEqual([]);
    expect(db.all('SELECT * FROM telemetryQuarantineRows')).toEqual([]);
    expect(sourceRows()).toEqual(source);
    expect(read()).toEqual(baseline);
  });

  it('invalidates warm worker results on apply, metadata updates and revert using persisted versions', async () => {
    db.flush?.(); db.checkpoint?.();
    const client = createContextAnalyticsClient({ file, driver, cacheTtlMs: 60000 });
    const input = query({ facets: ['summary'] });
    try {
      const baseline = await client.run(input);
      expect((await client.run(input)).freshness.cacheHit).toBe(true);
      const before = analyticsDataVersion(file), selected = manifest();
      applyQuarantine(db, selected, { evidence });
      expect(analyticsDataVersion(file)).not.toBe(before);
      const applied = await client.run(input);
      expect(applied.summary.records).toBe(6);
      expect(applied.freshness.cacheHit).toBe(false);
      expect((await client.run(input)).freshness.cacheHit).toBe(true);
      const metadataVersion = analyticsDataVersion(file);
      db.run('UPDATE telemetryQuarantineReceipts SET metadata=? WHERE id=?', ['{"review":"synthetic-update"}', selected.id]);
      db.flush?.();
      expect(analyticsDataVersion(file)).not.toBe(metadataVersion);
      const metadata = await client.run(input);
      expect(metadata.freshness.cacheHit).toBe(false);
      expect(metadata.summary).toEqual(applied.summary);
      revertQuarantine(db, selected, { evidence });
      const restored = await client.run(input);
      expect(restored.freshness.cacheHit).toBe(false);
      expect(restored.summary).toEqual(baseline.summary);
    } finally { await client.close(); }
  });

  it('atomically upgrades an actual v2 table and preserves source rows, active receipts and numeric storage classes', async () => {
    const selected = manifest();
    applyQuarantine(db, selected, { evidence });
    const source = sourceRows(), expected = read();
    removeProjectionOrigin();
    db.run("UPDATE _meta SET value='2' WHERE key='economicsProjectionVersion'");
    db.run("UPDATE _meta SET value='5' WHERE key='schemaVersion'");
    db.run("UPDATE _meta SET value='38' WHERE key='backupSchemaVersion'");
    const failing = { ...db, exec(sql) {
      if (sql.trimStart().startsWith('INSERT OR REPLACE INTO usageEconomicsProjection')) throw new Error('fixture migration rebuild failure');
      return db.exec(sql);
    } };
    await expect(runMigrationOnce(failing)).rejects.toThrow('fixture migration rebuild failure');
    expect(db.all('PRAGMA table_info(usageEconomicsProjection)').some(row => row.name === 'dataOrigin')).toBe(false);
    expect(db.get("SELECT value FROM _meta WHERE key='schemaVersion'").value).toBe('5');
    expect(db.get("SELECT value FROM _meta WHERE key='economicsProjectionVersion'").value).toBe('2');
    expect(sourceRows()).toEqual(source);
    await runMigrationOnce({ ...db });
    expect(economicsProjectionReady(db, { verifyIntegrity: true })).toBe(true);
    expect(db.get("SELECT value FROM _meta WHERE key='schemaVersion'").value).toBe('7');
    expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe('40');
    expect(db.get('SELECT COUNT(*) AS count FROM usageEconomicsProjection').count).toBe(8);
    expect(db.get('SELECT typeof(cacheRead) AS type FROM usageEconomicsProjection WHERE id=1').type).toBe('real');
    expect(read()).toEqual(expected);
    expect(sourceRows()).toEqual(source);
    revertQuarantine(db, selected, { evidence });
    expect(read().summary.records).toBe(7);
  });

  it('rebuilds source origins after additive column repair even when versions and trigger definitions are current', async () => {
    const source = sourceRows(), expected = read();
    const triggers = removeProjectionOrigin();
    for (const { sql } of triggers) db.exec(sql);
    expect(economicsProjectionReady(db, { verifyIntegrity: true })).toBe(false);
    await runMigrationOnce({ ...db });
    expect(economicsProjectionReady(db, { verifyIntegrity: true })).toBe(true);
    expect(projected(4).dataOrigin).toBe('test');
    expect(projected(7).dataOrigin).toBe('import');
    expect(read()).toEqual(expected);
    expect(sourceRows()).toEqual(source);
  });
});
