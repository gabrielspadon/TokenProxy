import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ECONOMICS_ORACLE, ECONOMICS_WINDOW, seedEconomicsCorrectness } from '../fixtures/economics-analytics-scale.mjs';

const DRIVERS = ['node:sqlite', 'better-sqlite3', 'sql.js'];
const originalDataDir = process.env.DATA_DIR;
let directory, db, runMigrationOnce, readActivityAnalytics, SCHEMA_VERSION;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-economics-projection-'));
  process.env.DATA_DIR = directory;
  vi.resetModules();
  ({ runMigrationOnce } = await import('../../src/lib/db/migrate.js'));
  ({ readActivityAnalytics } = await import('../../src/lib/db/analytics/activityQueries.mjs'));
  ({ SCHEMA_VERSION } = await import('../../src/lib/db/schema.js'));
  db = await open('better-sqlite3');
  await runMigrationOnce(db);
});

afterEach(() => {
  db?.close?.();
  db = null;
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  vi.restoreAllMocks();
});

async function open(driver, file = path.join(directory, 'source.sqlite')) {
  const modules = {
    'node:sqlite': () => import('../../src/lib/db/adapters/nodeSqliteAdapter.js').then(module => module.createNodeSqliteAdapter),
    'better-sqlite3': () => import('../../src/lib/db/adapters/betterSqliteAdapter.js').then(module => module.createBetterSqliteAdapter),
    'sql.js': () => import('../../src/lib/db/adapters/sqljsAdapter.js').then(module => module.createSqlJsAdapter),
  };
  const factory = await modules[driver]();
  return factory(file);
}

const query = (adapter = db) => readActivityAnalytics(adapter, {
  operation: 'activity', view: 'economics', ...ECONOMICS_WINDOW, pageSize: 10,
});
const rerunMigration = () => runMigrationOnce({ ...db });
const projectionCount = () => db.get('SELECT COUNT(*) AS count FROM usageEconomicsProjection').count;

describe('migration-governed economics projection', () => {
  it.each(['provider', 'model', 'account', 'session', 'logical-request', 'client-project', 'client', 'task'])('preserves summary values when reusing complete %s groups', groupBy => {
    for (const [index, cost, latency] of [[0, 0.1, 10], [1, 0.2, 20], [2, null, 90], [3, 0.3, null], [4, null, null]]) {
      const id = `rollup-${index}`;
      const timestamp = index === 4 ? 'invalid-date' : `2026-01-0${index + 1}T00:00:00.000Z`;
      const provider = index === 4 ? null : `p-${index % 2}`;
      const model = index === 4 ? null : `m-${index % 3}`;
      const account = index === 4 ? null : `c-${index % 2}`;
      const logical = index === 4 ? null : `shared-logical-${index % 2}`;
      const reference = index === 4 ? null : `ctx1_${String(index % 2).repeat(64)}`;
      db.run('INSERT INTO requestStats(id,timestamp,provider,model,connectionId,latencyTotal,latencyTtft,logicalRequestId) VALUES(?,?,?,?,?,?,?,?)',
        [id, timestamp, provider, model, account, latency, latency, logical]);
      db.run(`INSERT INTO usageHistory(timestamp,provider,model,connectionId,requestId,cost,tokens,logicalRequestId,
        promptTokens,completionTokens,clientKeyId,clientIdentitySource,clientRef,taskRef,projectRef) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [timestamp, provider, model, account, id, cost, '{"cached_tokens":0.1,"cache_creation_input_tokens":0.2}', logical,
        0.5 + index / 10, index / 10, 'fixture-client', 'client-reported', reference, reference, reference]);
    }
    for (const extra of [{}, { provider: 'p-0' }, { provider: 'absent' }]) {
      const options = { operation: 'activity', view: 'economics', groupBy, ...extra, groupPageSize: 1, groupPage: 2 };
      const grouped = readActivityAnalytics(db, { ...options, facets: ['summary', 'groups', 'series'] });
      const direct = readActivityAnalytics(db, { ...options, facets: ['summary'] });
      expect(grouped.summary).toEqual(direct.summary);
    }
  });
  it('preserves global averages and overflow metadata for extreme values', () => {
    for (let index = 0; index < 3; index++) {
      const id = `large-average-${index}`;
      db.run('INSERT INTO requestStats(id,timestamp,provider,latencyTotal,latencyTtft) VALUES(?,?,?,?,?)',
        [id, '2026-01-01T00:00:00.000Z', `p-${index % 2}`, 1e308, 1e308]);
      db.run('INSERT INTO usageHistory(timestamp,provider,requestId,cost,tokens) VALUES(?,?,?,?,?)',
        ['2026-01-01T00:00:00.000Z', `p-${index % 2}`, id, 0.1, '{}']);
    }
    const options = { operation: 'activity', view: 'economics' };
    expect(readActivityAnalytics(db, { ...options, facets: ['summary', 'groups'] }).summary)
      .toEqual(readActivityAnalytics(db, { ...options, facets: ['summary'] }).summary);
  });
  it('preserves nullable sums and zero-default counts for an all-null population', () => {
    for (const provider of ['nullable-a', 'nullable-b', null]) {
      db.run('INSERT INTO usageHistory(timestamp,provider,cost,promptTokens,completionTokens,tokens) VALUES(?,?,?,?,?,?)',
        ['invalid-date', provider, null, null, null, null]);
    }
    const options = { operation: 'activity', view: 'economics', groupPage: 2, groupPageSize: 1 };
    const direct = readActivityAnalytics(db, { ...options, facets: ['summary'] }).summary;
    expect(readActivityAnalytics(db, { ...options, facets: ['summary', 'groups', 'series'] }).summary).toEqual(direct);
    for (const field of ['additionalAttemptCostUsd', 'pairedCostUsd', 'estimatedCostUsd', 'reportedCostUsd',
      'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheEligibleInputTokens', 'cacheEligibleReadTokens',
      'recordedCostUsd', 'averageLatencyMs', 'averageTtftMs', 'pairedAverageLatencyMs', 'firstSeenAt', 'lastSeenAt']) {
      expect(direct[field], field).toBeNull();
    }
    expect(direct).toMatchObject({ records: 3, attempts: 3, inputTokens: 0, outputTokens: 0,
      invalidTimestampRows: 3, costSamples: 0, latencySamples: 0, ttftSamples: 0, logicalRequests: 0 });
  });
  it('counts SQL NULL token details identically in raw and projected reads', () => {
    db.run('INSERT INTO usageHistory(timestamp,provider,model,tokens) VALUES(?,?,?,?)',
      ['2026-01-01T00:00:00.000Z', 'null-tokens', 'model', null]);
    const options = { operation: 'activity', view: 'economics', provider: 'null-tokens' };
    const projected = readActivityAnalytics(db, options);
    db.run("UPDATE _meta SET value='0' WHERE key='economicsProjectionVersion'");
    const raw = readActivityAnalytics(db, options);
    expect(projected).toEqual(raw);
  });
  it('backfills and transactionally maintains exact economics semantics', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(36);
    expect(db.get("SELECT value FROM _meta WHERE key='economicsProjectionVersion'")?.value).toBe('3');
    seedEconomicsCorrectness(db);
    const result = query();
    expect(result.summary).toMatchObject(ECONOMICS_ORACLE.summary);
    expect(result.summary.logicalRequests).toBe(2);
    expect(Object.fromEntries(result.groups.map(row => [row.provider, row.logicalRequests]))).toEqual({ 'provider-a': 1, 'provider-b': 1 });
    expect(result.items.map(row => row.requestId)).toEqual(ECONOMICS_ORACLE.itemRequestIds);
    const series = readActivityAnalytics(db, {
      operation: 'activity', view: 'economics', ...ECONOMICS_WINDOW, facets: ['series'], bucketMs: 120000,
    }).series.points;
    expect(series.map(row => ({ records: row.records, logicalRequests: row.logicalRequests }))).toEqual([
      { records: 2, logicalRequests: 1 }, { records: 2, logicalRequests: 1 },
    ]);
    const chartSeries = readActivityAnalytics(db, {
      operation: 'activity', view: 'economics', ...ECONOMICS_WINDOW, facets: ['series'], seriesProfile: 'economics-chart', bucketMs: 120000,
    }).series.points;
    expect(chartSeries.every(row => 'recordedCostUsd' in row && 'cacheReadTokens' in row && !('logicalRequests' in row))).toBe(true);
    expect(chartSeries.map(row => ({ records: row.records, recordedCostUsd: row.recordedCostUsd }))).toEqual([
      { records: 2, recordedCostUsd: 0.35 }, { records: 2, recordedCostUsd: 0.05 },
    ]);
    expect(projectionCount()).toBe(5);
    db.run("UPDATE _meta SET value='0' WHERE key='economicsProjectionVersion'");
    expect(query()).toEqual(result);
    db.run("UPDATE _meta SET value='3' WHERE key='economicsProjectionVersion'");

    db.run("UPDATE requestStats SET model='conflicting-model' WHERE id=?", ['oracle-linked-initial']);
    expect(query().summary).toMatchObject({ linkedRequestRows: 1, conflictingRequestRows: 2 });
    db.run("UPDATE requestStats SET model='model-a',latencyTotal=4321 WHERE id=?", ['oracle-linked-initial']);
    expect(query().items.find(row => row.requestId === 'oracle-linked-initial').latencyMs).toBe(4321);
    db.run('DELETE FROM requestStats WHERE id=?', ['oracle-linked-switch']);
    expect(query().summary).toMatchObject({ linkedRequestRows: 1, conflictingRequestRows: 1, unavailableRequestRows: 1 });
  });

  it('repairs a missing projection row independently', async () => {
    seedEconomicsCorrectness(db);
    db.exec('DELETE FROM usageEconomicsProjection WHERE id=(SELECT MIN(id) FROM usageEconomicsProjection)');
    expect(projectionCount()).toBe(4);
    await rerunMigration();
    expect(projectionCount()).toBe(5);
  });

  it.each(DRIVERS)('preserves real JSON token sums beyond the integer accumulator range using %s', async driver => {
    db.close();
    db = await open(driver, path.join(directory, `${driver.replaceAll(':', '-')}-affinity.sqlite`));
    await runMigrationOnce(db);
    db.transaction(() => {
      for (let index = 0; index < 1025; index++) {
        db.run('INSERT INTO usageHistory(timestamp,promptTokens,completionTokens,tokens) VALUES(?,?,?,?)',
          ['2026-01-01T00:00:00.000Z', 0, 0, '{"cached_tokens":9007199254740991.0,"cache_creation_input_tokens":0.0}']);
      }
    });
    expect(db.get('SELECT typeof(cacheRead) AS type FROM usageEconomicsProjection LIMIT 1').type).toBe('real');
    const options = { operation: 'activity', view: 'economics', facets: ['summary', 'groups'] };
    const projected = readActivityAnalytics(db, options);
    db.run("UPDATE _meta SET value='0' WHERE key='economicsProjectionVersion'");
    const raw = readActivityAnalytics(db, options);
    expect(projected).toEqual(raw);
    expect(projected.summary.cacheReadTokens).toBeGreaterThan(2 ** 63);
  });

  it('rebuilds integer-affinity projection columns without altering source rows', async () => {
    seedEconomicsCorrectness(db);
    const expected = query();
    const source = db.all('SELECT * FROM usageHistory ORDER BY id');
    const oldDdl = db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='usageEconomicsProjection'").sql.replaceAll('BLOB', 'INTEGER');
    for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_economics_after_%'")) {
      db.exec(`DROP TRIGGER ${name}`);
    }
    db.exec('DROP TABLE usageEconomicsProjection');
    db.exec(oldDdl);
    db.run("UPDATE _meta SET value='1' WHERE key='economicsProjectionVersion'");
    db.run("UPDATE _meta SET value='4' WHERE key='schemaVersion'");
    db.run("UPDATE _meta SET value='36' WHERE key='backupSchemaVersion'");
    await rerunMigration();
    expect(db.all('SELECT * FROM usageHistory ORDER BY id')).toEqual(source);
    expect(query()).toEqual(expected);
    const types = Object.fromEntries(db.all('PRAGMA table_info(usageEconomicsProjection)').map(row => [row.name, row.type]));
    expect(types).toMatchObject({ cacheRead: 'BLOB', cacheWrite: 'BLOB', uncachedInput: 'BLOB' });
    expect(db.get("SELECT value FROM _meta WHERE key='schemaVersion'").value).toBe('6');
    expect(db.get("SELECT value FROM _meta WHERE key='economicsProjectionVersion'").value).toBe('3');
  });

  it('repairs an equal-count orphan projection row independently', async () => {
    seedEconomicsCorrectness(db);
    db.exec('PRAGMA foreign_keys=OFF; UPDATE usageEconomicsProjection SET id=999999 WHERE id=(SELECT MIN(id) FROM usageEconomicsProjection); PRAGMA foreign_keys=ON;');
    expect(projectionCount()).toBe(5);
    expect(db.get('SELECT COUNT(*) AS count FROM usageHistory u JOIN usageEconomicsProjection p ON p.id=u.id').count).toBe(4);
    await rerunMigration();
    expect(projectionCount()).toBe(5);
    expect(db.get('SELECT COUNT(*) AS count FROM usageHistory u JOIN usageEconomicsProjection p ON p.id=u.id').count).toBe(5);
    expect(db.all('PRAGMA foreign_key_check(usageEconomicsProjection)')).toEqual([]);
  });

  it('repairs a stale trigger definition independently', async () => {
    seedEconomicsCorrectness(db);
    db.exec(`DROP TRIGGER usage_economics_after_insert;
      CREATE TRIGGER usage_economics_after_insert AFTER INSERT ON usageHistory BEGIN SELECT 1; END;`);
    await rerunMigration();
    db.run("INSERT INTO usageHistory(timestamp,provider,model,tokens) VALUES(?,?,?,'{}')", ['2026-01-01T00:00:00.000Z', 'trigger-proof', 'trigger-proof']);
    expect(db.get("SELECT provider,model FROM usageEconomicsProjection WHERE provider='trigger-proof'")).toEqual({ provider: 'trigger-proof', model: 'trigger-proof' });
  });

  it('performs one integrity scan and keeps fast readiness metadata-only on a healthy reopen', async () => {
    seedEconomicsCorrectness(db);
    const all = db.all.bind(db), get = db.get.bind(db);
    const calls = [];
    const observed = { ...db,
      all(sql, params = []) { calls.push(sql); return all(sql, params); },
      get(sql, params = []) { calls.push(sql); return get(sql, params); },
    };
    await runMigrationOnce(observed);
    expect(calls.filter(sql => sql === 'PRAGMA foreign_key_check(usageEconomicsProjection)')).toHaveLength(1);
    expect(calls.filter(sql => sql === 'SELECT COUNT(*) AS count FROM usageHistory')).toHaveLength(1);
    calls.length = 0;
    query(observed);
    const readiness = calls.filter(sql => sql.includes('sqlite_master') && sql.includes("type IN ('table','trigger')"));
    expect(readiness).toHaveLength(1);
    expect(readiness[0]).toBe("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')");
  });

  it.each(DRIVERS)('survives close, reopen, and migration revalidation using %s', async driver => {
    db.close();
    db = await open(driver, path.join(directory, `${driver.replaceAll(':', '-')}.sqlite`));
    await runMigrationOnce(db);
    seedEconomicsCorrectness(db);
    const before = query();
    db.flush?.();
    db.close();
    db = await open(driver, path.join(directory, `${driver.replaceAll(':', '-')}.sqlite`));
    await runMigrationOnce(db);
    expect(query()).toEqual(before);
    expect(projectionCount()).toBe(5);
    expect(db.all('PRAGMA foreign_key_check(usageEconomicsProjection)')).toEqual([]);
  });

  it.each(DRIVERS)('rolls back a failed projection rebuild and retries using %s', async driver => {
    db.close();
    db = await open(driver, path.join(directory, `${driver.replaceAll(':', '-')}-rollback.sqlite`));
    await runMigrationOnce(db);
    seedEconomicsCorrectness(db);
    db.run("UPDATE _meta SET value='0' WHERE key='economicsProjectionVersion'");
    const exec = db.exec.bind(db);
    const failing = { ...db, exec(sql) {
      if (sql.trimStart().startsWith('INSERT OR REPLACE INTO usageEconomicsProjection')) throw new Error('fixture projection backfill failed');
      return exec(sql);
    } };
    await expect(runMigrationOnce(failing)).rejects.toThrow('fixture projection backfill failed');
    expect(projectionCount()).toBe(5);
    expect(db.get("SELECT value FROM _meta WHERE key='economicsProjectionVersion'").value).toBe('0');
    await rerunMigration();
    expect(projectionCount()).toBe(5);
    expect(db.get("SELECT value FROM _meta WHERE key='economicsProjectionVersion'").value).toBe('3');
  });
});
