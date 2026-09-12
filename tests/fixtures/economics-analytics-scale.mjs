// Deterministic synthetic evidence only. No production rows, secrets, prompts, or paid requests.
export const ECONOMICS_FIXTURE_VERSION = 'economics-analytics-v1';
export const ECONOMICS_WINDOW = {
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-01-01T00:04:00.000Z',
};

const requests = [
  ['oracle-linked-initial','2026-01-01T00:00:00.000Z','provider-a','model-a','account-a','success',100,20,40,10,100,'logical-a',1,'physical-dispatch'],
  ['oracle-linked-switch','2026-01-01T00:01:00.000Z','provider-a','model-a','account-b','error',200,10,100,0,300,'logical-a',2,'physical-dispatch'],
  ['oracle-conflict','2026-01-01T00:02:00.000Z','provider-a','model-b','account-a','success',75,15,0,0,200,'logical-b',1,'physical-dispatch'],
  ['oracle-after-end','2026-01-01T00:04:00.000Z','provider-a','model-a','account-a','success',900,90,0,0,50,'logical-c',1,'physical-dispatch'],
];
const usage = [
  ['2026-01-01T00:00:00.000Z','provider-a','model-a','account-a','ok',100,20,0.10,'{"cached_tokens":40,"cache_creation_input_tokens":10}','oracle-linked-initial','logical-a',1,'physical-dispatch',0.10,null,'application-estimate'],
  ['2026-01-01T00:01:00.000Z','provider-a','model-a','account-b','error',200,10,0.25,'{"cached_tokens":100,"cache_creation_input_tokens":0}','oracle-linked-switch','logical-a',2,'physical-dispatch',0.20,0.25,'provider-reported'],
  ['2026-01-01T00:02:00.000Z','provider-a','model-b','account-c','ok',50,5,null,'{"cached_tokens":0,"cache_creation_input_tokens":0}',null,null,null,null,null,null,'unknown'],
  ['2026-01-01T00:03:00.000Z','provider-b','model-b','account-a','ok',75,15,0.05,'{"cached_tokens":0,"cache_creation_input_tokens":0}','oracle-conflict','logical-b',1,'physical-dispatch',0.05,null,'application-estimate'],
  ['2026-01-01T00:04:00.000Z','provider-a','model-a','account-a','ok',900,90,9,'{"cached_tokens":0,"cache_creation_input_tokens":0}','oracle-after-end','logical-c',1,'physical-dispatch',9,null,'application-estimate'],
];

export const ECONOMICS_ORACLE = {
  summary: {
    records:4, inputTokens:425, outputTokens:50, recordedCostUsd:0.40, costSamples:3,
    estimatedCostSamples:3, reportedCostUsd:0.25, reportedCostSamples:1,
    linkedRequestRows:2, conflictingRequestRows:1, additionalAttemptRows:1,
    additionalAttemptCostUsd:0.25, initialAttemptRows:2, succeeded:3, failed:1,
  },
  providers: {'provider-a':3,'provider-b':1},
  itemRequestIds: ['oracle-conflict',null,'oracle-linked-switch','oracle-linked-initial'],
  seriesRecords: [1,1,1,1],
};

export function seedEconomicsCorrectness(db) {
  const request = `INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cachedTokens,cacheCreationTokens,latencyTotal,logicalRequestId,attempt,dispatchCoverage)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const completion = `INSERT INTO usageHistory(timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cost,tokens,requestId,logicalRequestId,attempt,dispatchCoverage,estimatedCostUsd,reportedCostUsd,costSource)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const run=(sql,row)=>db.run ? db.run(sql,row) : db.prepare(sql).run(...row);
  for (const row of requests) run(request,row);
  for (const row of usage) run(completion,row);
  return {version:ECONOMICS_FIXTURE_VERSION,requestRows:requests.length,usageRows:usage.length,synthetic:true};
}

export function seedEconomicsScale(db,{rowsPerTable=250000}={}) {
  if (!Number.isSafeInteger(rowsPerTable) || rowsPerTable<1 || rowsPerTable>1000000) throw new Error('rowsPerTable must be 1..1000000');
  db.exec(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<${rowsPerTable})
    INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cachedTokens,cacheCreationTokens,latencyTotal,latencyTtft,logicalRequestId,attempt,dispatchCoverage)
    SELECT 'scale-request-'||i,strftime('%Y-%m-%dT%H:%M:%fZ','2026-01-01','+'||(i%43200)||' minutes'),'provider-'||(i%4),'model-'||(i%12),'account-'||(i%32),
      CASE WHEN i%17=0 THEN 'error' ELSE 'success' END,100+(i%1000),10+(i%100),i%80,i%20,50+(i%5000),10+(i%500),
      'scale-logical-'||CAST((i+1)/2 AS INTEGER),1+(i%2),'physical-dispatch' FROM seq;
    WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<${rowsPerTable})
    INSERT INTO usageHistory(timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cost,tokens,requestId,logicalRequestId,attempt,dispatchCoverage,estimatedCostUsd,reportedCostUsd,costSource)
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ','2026-01-01','+'||(i%43200)||' minutes'),'provider-'||(i%4),'model-'||(i%12),'account-'||(i%32),
      CASE WHEN i%17=0 THEN 'error' ELSE 'ok' END,100+(i%1000),10+(i%100),CASE WHEN i%13=0 THEN NULL ELSE i/1000000.0 END,
      json_object('cached_tokens',i%80,'cache_creation_input_tokens',i%20),'scale-request-'||i,'scale-logical-'||CAST((i+1)/2 AS INTEGER),1+(i%2),'physical-dispatch',
      CASE WHEN i%13=0 THEN NULL ELSE i/1000000.0 END,CASE WHEN i%7=0 THEN i/1000000.0 END,CASE WHEN i%7=0 THEN 'provider-reported' WHEN i%13=0 THEN 'unknown' ELSE 'application-estimate' END FROM seq;`);
  return {version:ECONOMICS_FIXTURE_VERSION,rowsPerTable,requestRows:rowsPerTable,usageRows:rowsPerTable,synthetic:true};
}
