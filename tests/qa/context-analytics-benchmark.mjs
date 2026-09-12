// Self-contained synthetic benchmark. No live database or provider calls.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const economicsMode=process.argv.includes('--economics');
if(economicsMode){
  const temporary=mkdtempSync(join(tmpdir(),'economics-analytics-benchmark-'));
  process.env.DATA_DIR=temporary;
  process.chdir(resolve(fileURLToPath(new URL('../..',import.meta.url))));
  const [{getAdapter},{createContextAnalyticsClient},{readActivityAnalytics},{seedEconomicsScale}]=await Promise.all([
    import('../../src/lib/db/driver.js'),import('../../src/lib/db/analytics/client.js'),import('../../src/lib/db/analytics/activityQueries.mjs'),import('../fixtures/economics-analytics-scale.mjs'),
  ]);
  const requestedRows=process.argv.find(arg=>arg.startsWith('--rows='));
  const db=await getAdapter(),rowsPerTable=requestedRows?Number(requestedRows.slice(7)):process.argv.includes('--million')?1000000:250000;
  let client,rssTimer,peakRss=process.memoryUsage.rss();
  const samples=[],failures=[],plans=[],writeDurations=[];
  const percentile=(values,p)=>values.toSorted((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]??null;
  const operations=[
    {name:'economics-page-population',query:{operation:'activity',view:'economics',facets:['summary','groups','series','items'],groupBy:'provider',pageSize:25,groupPage:1,groupPageSize:12,groupSortBy:'recordedCostUsd',groupSortDirection:'desc',page:1,sortBy:'timestamp',sortDirection:'desc'},expected:value=>value.summary?.records},
    {name:'economics-items',query:{operation:'activity',view:'economics',facets:['items'],groupBy:'provider',pageSize:25,page:1,sortBy:'timestamp',sortDirection:'desc'},expected:value=>value.pagination?.totalItems},
    {name:'activity-summary-groups',query:{operation:'activity',view:'activity',facets:['summary','groups'],groupBy:'account',pageSize:50,groupPage:1,groupPageSize:100},expected:value=>value.summary?.records},
  ];
  try{
    db.transaction(()=>seedEconomicsScale(db,{rowsPerTable}));
    assert.equal(db.get('SELECT COUNT(*) AS n FROM requestStats').n,rowsPerTable);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM usageHistory').n,rowsPerTable);
    for(const operation of operations){
      const query=operation.query;
      let captured;
      const tracing={get:(sql,args=[])=>db.get(sql,args),all:(sql,args=[])=>{if(sql.includes('records AS MATERIALIZED'))captured={sql,args};return db.all(sql,args);}};
      readActivityAnalytics(tracing,query);
      plans.push({operation:operation.name,view:query.view,facets:query.facets,steps:db.all(`EXPLAIN QUERY PLAN ${captured.sql}`,captured.args).map(row=>row.detail)});
    }
    client=createContextAnalyticsClient({file:join(temporary,'db','data.sqlite'),driver:db.driver,cacheTtlMs:1000});
    rssTimer=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage.rss());},20);
    rssTimer.unref?.();
    let writes=0,overlappingWrites=0,writerFailures=0,activeReads=0,maxWriterTickDelayMs=0,lastWriterTick=null;
    const write=()=>{
      const started=performance.now();
      try{db.run("INSERT INTO _meta(key,value) VALUES('economics-benchmark-write',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[String(++writes)]);if(activeReads)overlappingWrites++;}
      catch{writerFailures++;}
      writeDurations.push(performance.now()-started);
    };
    async function load(operation,scenario,expectedDelivery=null,record=true){
      const started=performance.now();
      try{
        activeReads++;
        const value=await client.run(operation.query,{authorizedScope:'synthetic-benchmark'});
        const durationMs=performance.now()-started;
        assert.equal(operation.expected(value),rowsPerTable);
        if(expectedDelivery)assert.equal(value.freshness.delivery,expectedDelivery);
        if(record)samples.push({operation:operation.name,...scenario,durationMs,delivery:value.freshness.delivery,queueDurationMs:value.freshness.queueDurationMs,executionDurationMs:value.freshness.executionDurationMs,queryDurationMs:value.freshness.queryDurationMs});
        return value;
      }catch(error){failures.push({operation:operation.name,...scenario,error:error.constructor.name});return null;}
      finally{activeReads--;}
    }
    async function cold(operation,count,concurrency,writer=false){
      const scenario={cacheState:'result-cache-cold',concurrency,writer};
      for(let offset=0;offset<count;offset+=concurrency){
        client.invalidate();
        await Promise.all(Array.from({length:Math.min(concurrency,count-offset)},()=>load(operation,scenario,'computed')));
      }
    }
    async function warm(operation,count,concurrency){
      const scenario={cacheState:'result-cache-warm',concurrency,writer:false};
      let primedAt=-Infinity;
      for(let offset=0;offset<count;offset+=concurrency){
        if(performance.now()-primedAt>800){client.invalidate();await load(operation,{cacheState:'prime',concurrency,writer:false},'computed',false);primedAt=performance.now();}
        await Promise.all(Array.from({length:Math.min(concurrency,count-offset)},()=>load(operation,scenario,'cache-hit')));
      }
    }
    async function withWriter(operation,concurrency){
      const before=writes;
      lastWriterTick=performance.now();
      const writer=setInterval(()=>{const now=performance.now();maxWriterTickDelayMs=Math.max(maxWriterTickDelayMs,now-lastWriterTick);lastWriterTick=now;if(writes-before<200)write();},5);
      await new Promise(resolve=>setTimeout(resolve,15));
      await cold(operation,10,concurrency,true);
      clearInterval(writer);
    }
    for(const operation of operations)for(const concurrency of [1,5]){
      await cold(operation,50,concurrency);
      await warm(operation,200,concurrency);
      await withWriter(operation,concurrency);
    }
    const profiles=[];
    for(const operation of operations)for(const cacheState of ['result-cache-cold','result-cache-warm'])for(const concurrency of [1,5])for(const writer of [false,true]){
      const rows=samples.filter(row=>row.operation===operation.name&&row.cacheState===cacheState&&row.concurrency===concurrency&&row.writer===writer);
      if(rows.length)profiles.push({operation:operation.name,facets:operation.query.facets,cacheState,concurrency,writer,count:rows.length,p95Ms:percentile(rows.map(row=>row.durationMs),0.95),p99Ms:percentile(rows.map(row=>row.durationMs),0.99)});
    }
    const receipt={fixture:{version:'economics-analytics-v1',rowsPerTable,requestRows:rowsPerTable,usageRows:rowsPerTable},
      settings:{cacheTtlMs:1000,serviceDeadlineMs:15000},profiles,samples,
      syntheticWriteHealth:{writes,overlappingWrites,failures:writerFailures,p95Ms:percentile(writeDurations,0.95),maxMs:Math.max(...writeDurations),maxTickDelayMs:maxWriterTickDelayMs,finalValue:db.get("SELECT value FROM _meta WHERE key='economics-benchmark-write'")?.value??null},
      plans,failures,peakAnalyticsProcessRssBytes:peakRss,isolatedTemporaryData:true};
    const output=process.argv.find((arg,index)=>index>1 && !arg.startsWith('--'));
    if(output)writeFileSync(output,JSON.stringify(receipt,null,2)+'\n');
    console.log(JSON.stringify(receipt,null,2));
    assert.equal(failures.length,0);
    assert.equal(writerFailures,0);assert(overlappingWrites>0);
    for(const profile of profiles.filter(row=>row.cacheState==='result-cache-cold')){assert(profile.p95Ms<2000);assert(profile.p99Ms<5000);}
    assert(peakRss<512*1024*1024);
  }finally{
    clearInterval(rssTimer);await client?.close();db.close();rmSync(temporary,{recursive:true,force:true});
  }
}else{
const temporary = mkdtempSync(join(tmpdir(), "context-analytics-benchmark-"));
process.env.DATA_DIR = temporary;
process.chdir(resolve(fileURLToPath(new URL("../..", import.meta.url))));
const { getAdapter } = await import("../../src/lib/db/driver.js");
const { readContextOverview } = await import("../../src/lib/db/analytics/contextQueries.mjs");
const { getContextOverview } = await import("../../src/lib/db/repos/contextRepo.js");
const db = await getAdapter();
const requests = 100000, stages = 1400000, sessions = 1000;
const rows = [];
try {
  db.transaction(() => {
    db.exec(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<1000)
      INSERT INTO contextSessions(id,sessionHash,identitySource,firstSeenAt,lastSeenAt)
      SELECT i,printf('%032x',i),'explicit','2026-09-06T12:00:00.000Z','2026-09-06T12:00:00.000Z' FROM seq;
      WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<100000)
      INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,contextSessionId,logicalRequestId,
        usageSource,usageInputPresent,usageOutputPresent,cacheReadPresent,promptTokens,completionTokens,cachedTokens,bodyBeforeBytes,bodyAfterBytes)
      SELECT 'request-'||i,'2026-09-06T12:00:00.000Z','fixture-provider','fixture-model','fixture-account-'||(i%5),'success',
        1+(i%1000),'logical-'||i,'provider',1,1,1,1000,20,600,100000,98600 FROM seq;
      WITH names(ordinal,stage) AS (VALUES(0,'tools'),(1,'schema'),(2,'thinking'),(3,'rtk'),(4,'privacy'),(5,'inject'),(6,'pxpipe'),
        (7,'mem'),(8,'headroom'),(9,'qac'),(10,'pairs'),(11,'reorder'),(12,'midinject'),(13,'final'))
      INSERT INTO contextStages(requestId,ordinal,stage,beforeBytes,afterBytes,deltaBytes,outcome,risk)
      SELECT r.id,n.ordinal,n.stage,100000-100*n.ordinal,99900-100*n.ordinal,-100,'applied','normalization' FROM requestStats r CROSS JOIN names n;`);
  });
  assert.equal(db.get("SELECT count(*) AS n FROM contextStages").n, stages);
  async function measure(name, query) {
    let last = performance.now(), maxTickDelayMs = 0, ticks = 0, writerTicks = 0;
    const timer = setInterval(() => {
      const now = performance.now(); maxTickDelayMs = Math.max(maxTickDelayMs, now - last); last = now; ticks++;
      db.run("INSERT INTO _meta(key,value) VALUES('analytics-benchmark',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(++writerTicks)]);
    }, 5);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const initialTicks = ticks, start = performance.now();
    const result = await query();
    const durationMs = performance.now() - start;
    const concurrentWriterTicks = ticks - initialTicks;
    await new Promise((resolve) => setTimeout(resolve, 10)); clearInterval(timer);
    rows.push({ name, durationMs, maxTickDelayMs, concurrentWriterTicks, attempts: result.summary.attempts, savedBytes: result.summary.savedBytes });
    return result;
  }
  const filter = { pageSize: 25 };
  const baseline = await measure("serving-thread-full", () => readContextOverview(db, filter));
  for (let i = 0; i < 3; i++) {
    const threaded = await measure(`worker-full-${i}`, () => getContextOverview(filter));
    assert.deepEqual(threaded.summary, baseline.summary);
    assert.deepEqual(threaded.stages, baseline.stages);
    assert.deepEqual(threaded.sessions, baseline.sessions);
  }
  const account = { connectionId: "fixture-account-0", pageSize: 1 };
  await measure("serving-thread-account-full", () => readContextOverview(db, account));
  const summary = await measure("worker-account-summary", () => getContextOverview({ ...account, view: "summary" }));
  assert.equal(summary.summary.attempts, 20000);
  assert.equal(summary.summary.savedBytes, 28000000);
  assert.equal(summary.stages, undefined);
  const result = { fixtureRequests: requests, fixtureStages: stages, fixtureSessions: sessions, externalNetworkAttempts: 0,
    productionDataAccess: false, baseline: "same pure query module on serving thread", measurements: rows };
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  assert(rows.filter((r) => r.name.startsWith("worker-full")).every((r) => r.concurrentWriterTicks > 5 && r.maxTickDelayMs < 100));
} finally {
  await globalThis._contextAnalytics?.client.close();
  db.close(); rmSync(temporary, { recursive: true, force: true });
}
}
