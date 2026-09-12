import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ActivityQueryError, readActivityAnalytics, validateActivityQuery } from '../../src/lib/db/analytics/activityQueries.mjs';
import { TABLES, buildCreateTableSql } from '../../src/lib/db/schema.js';
import { ECONOMICS_ORACLE, ECONOMICS_WINDOW, seedEconomicsCorrectness } from '../fixtures/economics-analytics-scale.mjs';

let native, db;
beforeEach(() => {
  native = new Database(':memory:');
  native.exec(`CREATE TABLE requestStats(id TEXT,timestamp TEXT,provider TEXT,model TEXT,connectionId TEXT,status TEXT,
    promptTokens INTEGER,completionTokens INTEGER,cachedTokens INTEGER,cacheCreationTokens INTEGER,
    latencyTotal REAL,latencyTtft REAL,contextSessionId INTEGER);
    CREATE TABLE usageHistory(id INTEGER,timestamp TEXT,provider TEXT,model TEXT,connectionId TEXT,status TEXT,
    promptTokens INTEGER,completionTokens INTEGER,cost REAL,tokens TEXT);`);
  db = { all: (sql,args=[]) => native.prepare(sql).all(...args), get: (sql,args=[]) => native.prepare(sql).get(...args) };
  const request = native.prepare('INSERT INTO requestStats VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  request.run('r1','2026-09-06T10:00:00.000Z','claude','same-model','personal','success',1000,100,600,100,2000,300,1);
  request.run('r2','2026-09-06T11:00:00.000Z','claude','same-model','work','error',500,20,0,50,0,0,2);
  request.run('r3','2026-09-06T12:00:00.000Z','codex','same-model','third','pending',300,10,100,0,90000000000,500,null);
  request.run('r4','2026-09-06T12:00:00.000Z','codex','same-model','third','aborted',200,0,0,0,1000,100,null);
  const usage = native.prepare('INSERT INTO usageHistory VALUES(?,?,?,?,?,?,?,?,?,?)');
  usage.run(1,'2026-09-06T10:00:00.000Z','claude','same-model','personal','ok',1000,100,0.004,'{"cached_tokens":600,"cache_creation_input_tokens":100,"secret":"must-not-escape"}');
  usage.run(2,'2026-09-06T11:00:00.000Z','claude','same-model','work','error',500,20,0,'{"cached_tokens":0,"cache_creation_input_tokens":50}');
  usage.run(3,'2026-09-06T12:00:00.000Z','codex','same-model','third','ok',300,10,null,'invalid-json');
});
afterEach(() => native.close());
const read = (overrides={}) => readActivityAnalytics(db,{operation:'activity',...overrides});

describe('analytical workspace read contract', () => {
  it('matches an independent mixed-provenance oracle across every facet and end boundary', () => {
    const fixture = new Database(':memory:');
    try {
      for (const [name,table] of Object.entries(TABLES)) fixture.exec(buildCreateTableSql(name,table));
      seedEconomicsCorrectness(fixture);
      const adapter={get:(sql,args=[])=>fixture.prepare(sql).get(...args),all:(sql,args=[])=>fixture.prepare(sql).all(...args)};
      const query={operation:'activity',view:'economics',...ECONOMICS_WINDOW,pageSize:10};
      const result=readActivityAnalytics(adapter,query);
      expect(result.summary).toMatchObject(ECONOMICS_ORACLE.summary);
      expect(result.summary.estimatedCostUsd).toBeCloseTo(0.35,12);
      expect(Object.fromEntries(result.groups.map(row=>[row.provider,row.records]))).toEqual(ECONOMICS_ORACLE.providers);
      expect(result.series.points.map(row=>row.records)).toEqual(ECONOMICS_ORACLE.seriesRecords);
      expect(result.items.map(row=>row.requestId)).toEqual(ECONOMICS_ORACLE.itemRequestIds);
      for(const facet of ['summary','groups','series','items']){
        const projected=readActivityAnalytics(adapter,{...query,facets:facet});
        const fields=facet==='groups'?['groups','groupPagination']:facet==='items'?['items','pagination']:[facet];
        for(const field of fields)expect(projected[field]).toEqual(result[field]);
      }
    } finally { fixture.close(); }
  });
  it('keeps attempts, completion ledger and estimated costs separate', () => {
    const traffic = read(), money = read({view:'economics'});
    expect(traffic.source).toBe('requestStats');
    expect(traffic.summary).toMatchObject({records:4,inputTokens:2000,uncachedInputTokens:1150,cacheReadTokens:700,cacheWriteTokens:150,outputTokens:130,
      succeeded:1,failed:2,recordedPending:1,recordedCostUsd:null,costSamples:0,latencySamples:3,maximumLatencyMs:90000000000});
    expect(money.source).toBe('usageHistory');
    expect(money.summary).toMatchObject({records:3,inputTokens:1800,recordedCostUsd:0.004,costSamples:2,zeroCostRows:1,missingTokenDetailRows:1});
    expect(money.items.every(row=>row.contextSessionId===null)).toBe(true);
    expect(JSON.stringify(money)).not.toContain('must-not-escape');
    expect(money.definitions.recordedCostUsd).toContain('not subscription spend');
  });
  it('uses exclusive end boundaries and exact account/provider/model conjunctions', () => {
    const result = read({start:'2026-09-06T10:00:00.000Z',end:'2026-09-06T12:00:00.000Z',provider:'claude',model:'same-model',connectionId:'work'});
    expect(result.summary.records).toBe(1);
    expect(result.items.map(row=>row.id)).toEqual(['r2']);
    expect(read({end:'2026-09-06T12:00:00.000Z'}).summary.records).toBe(2);
  });
  it('parameterizes hostile filter text without widening results', () => {
    expect(read({provider:"claude' OR 1=1 --"}).summary.records).toBe(0);
    expect(db.get('SELECT COUNT(*) AS count FROM requestStats').count).toBe(4);
  });
  it('groups model names within provider and account IDs without label joins', () => {
    const models = read({groupBy:'model'});
    expect(models.groups).toHaveLength(2);
    expect(models.groups.map(row=>row.provider).sort()).toEqual(['claude','codex']);
    expect(read({groupBy:'account'}).groups.map(row=>row.connectionId).sort()).toEqual(['personal','third','work']);
  });
  it('keeps chart, groups, summary and paged rows in the same filtered population', () => {
    for (const view of ['activity','economics']) {
      const result = read({view,pageSize:1});
      expect(result.items).toHaveLength(1);
      expect(result.pagination.hasNext).toBe(true);
      expect(result.series.points.reduce((n,p)=>n+p.records,0)).toBe(result.summary.records);
      expect(result.groups.reduce((n,p)=>n+p.inputTokens,0)).toBe(result.summary.inputTokens);
      expect(read({view,pageSize:1,page:2}).items[0].id).not.toBe(result.items[0].id);
    }
  });
  it('projects explicit canonical facets from one materialized filtered population', () => {
    const statements = [];
    const traced = {
      get: (sql,args=[]) => { statements.push(sql); return db.get(sql,args); },
      all: (sql,args=[]) => { statements.push(sql); return db.all(sql,args); },
    };
    const result = readActivityAnalytics(traced, {
      operation:'activity', view:'economics', facets:'groups,summary', groupBy:'account',
    });
    expect(result.filters.facets).toEqual(['summary','groups']);
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('groups');
    for (const omitted of ['series','items','pagination']) expect(result).not.toHaveProperty(omitted);
    expect(statements.filter(sql=>sql.includes('records AS MATERIALIZED'))).toHaveLength(1);
  });
  it('keeps the compatibility projection while rejecting ambiguous facet requests', () => {
    expect(validateActivityQuery({operation:'activity'}).facets).toEqual(['summary','groups','series','items']);
    expect(validateActivityQuery({operation:'activity',facets:'items,summary'}).facets).toEqual(['summary','items']);
    for (const facets of ['', 'summary,summary', 'records', {summary:true}])
      expect(()=>validateActivityQuery({operation:'activity',facets})).toThrow(ActivityQueryError);
  });
  it('retains extreme measured latency and distinguishes missing samples', () => {
    const result = read({provider:'claude'});
    expect(result.summary).toMatchObject({averageLatencyMs:2000,latencySamples:1,records:2});
    expect(result.items.find(row=>row.id==='r2').latencyMs).toBeNull();
    expect(read().summary.maximumLatencyMs).toBe(90000000000);
    expect(read().summary).toMatchObject({p50LatencyMs:2000,p95LatencyMs:90000000000});
  });
  it.each(['null','{"cached_tokens":-2,"cache_creation_input_tokens":0}','{"cached_tokens":"invalid","cache_creation_input_tokens":0}',
    '{"cached_tokens":1e999,"cache_creation_input_tokens":0}'])('does not turn invalid cache quantities into uncached usage %s', (tokens) => {
    native.prepare('UPDATE usageHistory SET tokens=? WHERE id=1').run(tokens);
    const result=read({view:'economics',connectionId:'personal'});
    expect(result.summary).toMatchObject({records:1,inputTokens:1000,cacheReadTokens:null,cacheReadSamples:0,uncachedInputTokens:null,
      invalidTokenRows:1,missingTokenDetailRows:1,cacheReadFraction:null});
    expect(result.items[0].cacheReadTokens).toBeNull();
  });
  it('preserves missing cache fields as unknown rather than zero', () => {
    native.prepare('UPDATE usageHistory SET tokens=? WHERE id=1').run('{}');
    expect(read({view:'economics',connectionId:'personal'}).summary).toMatchObject({cacheReadTokens:null,cacheWriteTokens:null,
      uncachedInputTokens:null,invalidTokenRows:0,missingTokenDetailRows:1,cacheReadFraction:null});
  });
  it('sorts the complete filtered population before pagination and filters outcomes', () => {
    expect(read({sortBy:'inputTokens',sortDirection:'desc',pageSize:1}).items[0].id).toBe('r1');
    expect(read({sortBy:'inputTokens',sortDirection:'asc',pageSize:1,page:2}).items[0].id).toBe('r3');
    expect(read({status:'failed'}).summary).toMatchObject({records:2,failed:2});
    expect(read({status:'pending'}).items[0].id).toBe('r3');
  });
  it('exposes inconsistent cache totals without negative uncached input or invented savings', () => {
    native.prepare('UPDATE requestStats SET cachedTokens=1500 WHERE id=?').run('r1');
    const result = read({connectionId:'personal'});
    expect(result.summary).toMatchObject({inconsistentCacheRows:1,uncachedInputTokens:0,cacheReadTokens:1500,inputTokens:1000});
    expect(result.summary.cacheReadFraction).toBe(1.5);
  });
  it('works before context instrumentation exists and never backfills', () => {
    native.exec('ALTER TABLE requestStats DROP COLUMN contextSessionId');
    expect(read().items.every(row=>row.contextSessionId===null)).toBe(true);
    expect(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row=>row.name).sort()).toEqual(['requestStats','usageHistory']);
  });
  it('does not invent continuous utilization for gaps', () => {
    native.prepare('UPDATE requestStats SET timestamp=? WHERE id=?').run('2023-01-01T00:00:00.000Z','r1');
    const result = read();
    expect(result.series.points.length).toBeLessThanOrEqual(720);
    expect(result.series.points.reduce((n,p)=>n+p.records,0)).toBe(4);
    expect(result.series.points.every(p=>Number.isFinite(Date.parse(p.bucketStart)))).toBe(true);
  });
  it('reads a chosen chart scale, never finer than the point cap allows', () => {
    const daily = read({bucketMs:'86400000'});
    expect(daily.series.bucketMs).toBe(86400000);
    expect(daily.series.points.map(p=>p.bucketStart)).toEqual(['2026-09-06T00:00:00.000Z']);
    expect(daily.series.points[0].records).toBe(4);
    expect(read({bucketMs:'60000'}).series.bucketMs).toBe(60000);
    native.prepare('UPDATE requestStats SET timestamp=? WHERE id=?').run('2023-01-01T00:00:00.000Z','r1');
    expect(read({bucketMs:'60000'}).series.bucketMs).toBeGreaterThan(60000);
    for (const bad of ['1000','90000','0','-60000','x']) expect(() => read({bucketMs:bad})).toThrow(ActivityQueryError);
  });
  it('reports malformed timestamps and keeps other observations chartable', () => {
    native.prepare('UPDATE requestStats SET timestamp=? WHERE id=?').run('invalid-date','r1');
    const result=read();
    expect(result.summary).toMatchObject({records:4,invalidTimestampRows:1});
    expect(result.series.points.reduce((n,p)=>n+p.records,0)).toBe(3);
  });
  it('marks limited dimension results instead of presenting top100 as the whole population', () => {
    const stmt = native.prepare('INSERT INTO requestStats(id,timestamp,provider,promptTokens,completionTokens,cachedTokens,cacheCreationTokens) VALUES(?,?,?,?,?,?,?)');
    for(let i=0;i<105;i++)stmt.run(`many-${i}`,'2026-09-06T10:00:00.000Z',`provider-${i}`,1,0,0,0);
    const result=read();
    expect(result.groupsTruncated).toBe(true);expect(result.groups).toHaveLength(100);expect(result.summary.records).toBe(109);
  });
  it('returns explicit empty measurement state', () => {
    const result=read({provider:'absent'});
    expect(result.summary).toMatchObject({records:0,inputTokens:0,cacheReadFraction:null,averageLatencyMs:null,recordedCostUsd:null});
    expect(result.series.points).toEqual([]);expect(result.pagination.totalPages).toBe(0);
  });
  it.each([
    {page:0},{page:'2oops'},{pageSize:101},{groupBy:'apiKey'},{view:'sql'},{start:'tomorrow'},
    {start:'2026-09-07T00:00:00Z',end:'2026-09-06T00:00:00Z'},{provider:['claude']},{model:'x'.repeat(201)},
    {sql:'SELECT * FROM settings'},{operation:'anything'},
    {start:'2026-02-30T00:00:00Z'},
    {start:'2026-09-06T12:00:00'}, {sortBy:'apiKey'},{sortDirection:'DESC;SELECT'},{status:'any'},
  ])('rejects unsupported queries before executing SQL %j', (query) => {
    expect(()=>validateActivityQuery({operation:'activity',...query})).toThrow(ActivityQueryError);
  });
});
