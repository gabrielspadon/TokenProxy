// Self-contained synthetic benchmark. No live database or provider calls.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

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
