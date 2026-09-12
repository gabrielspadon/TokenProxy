// Self-contained synthetic benchmark. No live database or provider calls.
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

export function parseCpuList(value){
  if(typeof value!=='string'||!value.trim())throw new Error('process affinity is unavailable');
  const cpus=[];
  for(const part of value.trim().split(',')){
    const match=part.match(/^(\d+)(?:-(\d+))?$/);
    if(!match)throw new Error('process affinity is malformed');
    const first=Number(match[1]),last=match[2]===undefined?first:Number(match[2]);
    if(last<first)throw new Error('process affinity is malformed');
    for(let cpu=first;cpu<=last;cpu++)cpus.push(cpu);
  }
  return [...new Set(cpus)].sort((a,b)=>a-b);
}

function procStatCores(text){
  const cores=new Map();
  for(const line of text.split('\n')){
    const match=line.match(/^cpu(\d+)\s+(.+)$/);
    if(!match)continue;
    const counters=match[2].trim().split(/\s+/).map(Number);
    if(counters.length<4||counters.some(value=>!Number.isFinite(value)))throw new Error('CPU sample is malformed');
    const total=counters.slice(0,8).reduce((sum,value)=>sum+value,0);
    cores.set(Number(match[1]),{total,idle:counters[3]+(counters[4]??0)});
  }
  return cores;
}

export function assessBenchmarkAffinity({allowedList,selectedList=allowedList,before,after,busyThresholdPercent=20}){
  const allowedCores=parseCpuList(allowedList),selectedCores=parseCpuList(selectedList);
  if(selectedCores.some(cpu=>!allowedCores.includes(cpu)))throw new Error('selected benchmark core is outside process affinity');
  if(selectedCores.length!==allowedCores.length||selectedCores.some((cpu,index)=>cpu!==allowedCores[index]))
    throw new Error('selected benchmark cores must match process affinity; launch with taskset');
  const first=procStatCores(before),last=procStatCores(after);
  const cores=selectedCores.map(cpu=>{
    const start=first.get(cpu),end=last.get(cpu);
    if(!start||!end||end.total<=start.total)throw new Error(`CPU ${cpu} has no usable activity sample`);
    const total=end.total-start.total,idle=end.idle-start.idle;
    return {cpu,busyPercent:((total-idle)/total)*100};
  });
  const busyCores=cores.filter(({busyPercent})=>busyPercent>=busyThresholdPercent);
  return {accepted:busyCores.length===0,busyThresholdPercent,allowedCores,selectedCores,cores,busyCores};
}

export async function sampleBenchmarkAffinity({selectedList,sampleMs=1000}={}){
  if(process.platform!=='linux')throw new Error('benchmark affinity preflight requires Linux /proc');
  const status=readFileSync('/proc/self/status','utf8');
  const allowedList=status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]?.trim();
  const before=readFileSync('/proc/stat','utf8');
  await new Promise(resolve=>setTimeout(resolve,sampleMs));
  const after=readFileSync('/proc/stat','utf8');
  return assessBenchmarkAffinity({allowedList,selectedList:selectedList??allowedList,before,after});
}

export function validateGrowthMarker(marker){
  if(!(marker?.kind==='tokenproxy-economics-synthetic-fixture'&&marker.version===1&&marker.rowsPerTable===1000000
    &&marker.synthetic===true&&marker.productionDataAccess===false&&marker.completed===true))
    throw new Error('growth-only requires a completed external 1000000-row synthetic fixture');
  return marker;
}

const exactGrowthParity=(value,rowsPerTable)=>value?.requestRows===rowsPerTable&&value?.usageRows===rowsPerTable
  &&value?.projectionRows===rowsPerTable&&value?.missingRows===0&&value?.orphanRows===0;
export function evaluateGrowthQualification({deliveries,computations,writerCoverage,failures,writerFailures,beforeParity,afterParity,plans,rowsPerTable,peakRssBytes,deadlineMs}){
  const violations=[];
  if(deliveries.length!==32)violations.push({kind:'delivery-count',count:deliveries.length,expected:32});
  if(computations.length!==16)violations.push({kind:'computation-count',count:computations.length,expected:16});
  if(writerCoverage.length!==4)violations.push({kind:'writer-snapshot-count',count:writerCoverage.length,expected:4});
  else if(writerCoverage.some(row=>row.committedWritesWithinWorkerSnapshot<1))violations.push({kind:'writer-snapshot-commit',count:writerCoverage.filter(row=>row.committedWritesWithinWorkerSnapshot<1).length});
  if(failures.length)violations.push({kind:'read-failures',count:failures.length});
  if(writerFailures)violations.push({kind:'writer-failures',count:writerFailures});
  if(!exactGrowthParity(beforeParity,rowsPerTable))violations.push({kind:'projection-parity-before',...beforeParity});
  if(!exactGrowthParity(afterParity,rowsPerTable))violations.push({kind:'projection-parity-after',...afterParity});
  if(plans.length!==4||plans.some(plan=>!plan.steps?.length))violations.push({kind:'plan-count',count:plans.length,expected:4});
  if(deliveries.length===32&&computations.length===16&&writerCoverage.length===4&&plans.length===4){
    const operationNames=[...new Set(plans.map(plan=>plan.operation))];
    const ordinals=(rows,field)=>rows.map(row=>row[field]).sort((a,b)=>a-b).join(',');
    const covered=operationNames.length===4&&operationNames.every(operation=>{
      const operationDeliveries=deliveries.filter(row=>row.operation===operation);
      const operationComputations=computations.filter(row=>row.operation===operation);
      return operationDeliveries.length===8
        &&ordinals(operationDeliveries.filter(row=>row.concurrency===1&&!row.writer),'iteration')==='1,2,3'
        &&ordinals(operationDeliveries.filter(row=>row.concurrency===5&&row.writer),'deliveryOrdinal')==='1,2,3,4,5'
        &&operationComputations.length===4
        &&ordinals(operationComputations.filter(row=>row.concurrency===1&&!row.writer),'iteration')==='1,2,3'
        &&operationComputations.filter(row=>row.concurrency===5&&row.writer).length===1
        &&writerCoverage.filter(row=>row.operation===operation).length===1;
    });
    if(!covered)violations.push({kind:'operation-profile-coverage'});
  }
  const overdue=computations.filter(row=>!Number.isFinite(row.durationMs)||row.durationMs>=deadlineMs);
  if(overdue.length)violations.push({kind:'computation-deadline',count:overdue.length,deadlineMs});
  if(peakRssBytes>=536870912)violations.push({kind:'rss',bytes:peakRssBytes,limitBytes:536870912});
  return {passed:violations.length===0,labels:['growth-smoke'],latencyQualified:false,violations};
}

async function main(){
const economicsMode=process.argv.includes('--economics');
if(economicsMode){
  const growthOnly=process.argv.includes('--growth-only');
  const dataDirArg=process.argv.find(arg=>arg.startsWith('--data-dir='));
  if(growthOnly&&!dataDirArg)throw new Error('growth-only requires a completed external 1000000-row synthetic fixture');
  const ownsTemporary=!dataDirArg;
  const temporary=ownsTemporary?mkdtempSync(join(tmpdir(),'economics-analytics-benchmark-')):resolve(dataDirArg.slice('--data-dir='.length));
  let marker=null;
  try{marker=ownsTemporary?null:JSON.parse(readFileSync(join(temporary,'.tokenproxy-economics-fixture.json'),'utf8'));}
  catch(error){if(growthOnly)throw new Error('growth-only requires a completed external 1000000-row synthetic fixture',{cause:error});throw error;}
  if(marker&&!(marker.kind==='tokenproxy-economics-synthetic-fixture'&&marker.version===1&&marker.synthetic===true&&marker.productionDataAccess===false
    &&Number.isSafeInteger(marker.rowsPerTable)&&marker.rowsPerTable>=1&&marker.rowsPerTable<=1000000))throw new Error('data-dir is not a completed synthetic economics fixture');
  if(growthOnly)validateGrowthMarker(marker);
  const preflightRequested=growthOnly||process.argv.includes('--preflight');
  const selectedCoresArg=process.argv.find(arg=>arg.startsWith('--benchmark-cores='));
  const affinityPreflight=preflightRequested?await sampleBenchmarkAffinity({selectedList:selectedCoresArg?.slice('--benchmark-cores='.length)}):null;
  if(affinityPreflight&&!affinityPreflight.accepted)throw new Error(`selected benchmark cores are at or above 20% busy: ${affinityPreflight.busyCores.map(row=>`${row.cpu}=${row.busyPercent}%`).join(', ')}`);
  process.env.DATA_DIR=temporary;
  process.chdir(resolve(fileURLToPath(new URL('../..',import.meta.url))));
  const [{getAdapter},{createContextAnalyticsClient},{readActivityAnalytics},{seedEconomicsScale}]=await Promise.all([
    import('../../src/lib/db/driver.js'),import('../../src/lib/db/analytics/client.js'),import('../../src/lib/db/analytics/activityQueries.mjs'),import('../fixtures/economics-analytics-scale.mjs'),
  ]);
  const requestedRows=process.argv.find(arg=>arg.startsWith('--rows='));
  const db=await getAdapter();
  let rowsPerTable=requestedRows?Number(requestedRows.slice(7)):marker?.rowsPerTable??(process.argv.includes('--million')?1000000:250000);
  if(marker&&marker.rowsPerTable!==rowsPerTable)throw new Error('requested row count does not match synthetic fixture marker');
  const output=process.argv.find((arg,index)=>index>1 && !arg.startsWith('--'));
  const measuredPeakRss=()=>{
    const linuxPeak=process.platform==='linux'?Number(readFileSync('/proc/self/status','utf8').match(/^VmHWM:\s+(\d+) kB$/m)?.[1])*1024:0;
    return Math.max(process.memoryUsage.rss(),linuxPeak||process.resourceUsage().maxRSS*1024);
  };
  let client,rssTimer,peakRss=measuredPeakRss();
  const samples=[],failures=[],plans=[],writeDurations=[],writeCommits=[],writerComputationCoverage=[],computations=[],correctnessOracles=[];
  const percentile=(values,p)=>values.toSorted((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]??null;
  const operations=[
    {name:'economics-page-population',query:{operation:'activity',view:'economics',facets:['summary','groups','series','items'],groupBy:'provider',pageSize:25,groupPage:1,groupPageSize:12,groupSortBy:'recordedCostUsd',groupSortDirection:'desc',page:1,sortBy:'timestamp',sortDirection:'desc'},expected:value=>value.summary?.records},
    {name:'economics-filtered-provider',query:{operation:'activity',view:'economics',facets:['summary','groups','series','items'],provider:'provider-1',groupBy:'model',pageSize:25,groupPage:1,groupPageSize:12,groupSortBy:'recordedCostUsd',groupSortDirection:'desc',page:1,sortBy:'timestamp',sortDirection:'desc'},expected:value=>value.summary?.records,expectedRows:Math.floor((rowsPerTable+3)/4)},
    {name:'economics-items',query:{operation:'activity',view:'economics',facets:['items'],groupBy:'provider',pageSize:25,page:1,sortBy:'timestamp',sortDirection:'desc'},expected:value=>value.pagination?.totalItems},
    {name:'activity-summary-groups',query:{operation:'activity',view:'activity',facets:['summary','groups'],groupBy:'account',pageSize:50,groupPage:1,groupPageSize:100},expected:value=>value.summary?.records},
  ];
  const parity=()=>({
    requestRows:db.get('SELECT COUNT(*) AS n FROM requestStats').n,
    usageRows:db.get('SELECT COUNT(*) AS n FROM usageHistory').n,
    projectionRows:db.get('SELECT COUNT(*) AS n FROM usageEconomicsProjection').n,
    missingRows:db.get('SELECT COUNT(*) AS n FROM usageHistory u LEFT JOIN usageEconomicsProjection p ON p.id=u.id WHERE p.id IS NULL').n,
    orphanRows:db.get('SELECT COUNT(*) AS n FROM usageEconomicsProjection p LEFT JOIN usageHistory u ON u.id=p.id WHERE u.id IS NULL').n,
  });
  function buildCorrectnessOracle(operation){
    const economics=operation.query.view==='economics',table=economics?'usageHistory':'requestStats';
    const filter=operation.query.provider?'WHERE provider=?':'',args=operation.query.provider?[operation.query.provider]:[];
    const summary=db.get(`SELECT COUNT(*) AS records,COALESCE(SUM(promptTokens),0) AS inputTokens,COALESCE(SUM(completionTokens),0) AS outputTokens,
      COALESCE(SUM(status IN ('success','ok')),0) AS succeeded,COALESCE(SUM(status IN ('error','aborted','cancelled')),0) AS failed${economics?',SUM(cost) AS recordedCostUsd,COUNT(cost) AS costSamples':''}
      FROM ${table} ${filter}`,args);
    const groupColumn=operation.query.groupBy==='account'?'connectionId':operation.query.groupBy;
    const groupCardinality=db.get(`SELECT COUNT(DISTINCT ${groupColumn}) AS n FROM ${table} ${filter}`,args).n;
    const itemIds=operation.query.facets.includes('items')?db.all(`SELECT id FROM ${table} ${filter}
      ORDER BY timestamp ${operation.query.sortDirection.toUpperCase()} NULLS LAST,timestamp DESC,id DESC LIMIT ${operation.query.pageSize}`,args).map(row=>row.id):null;
    return {operation:operation.name,summary,groupCardinality,itemIds,paginationTotal:itemIds?summary.records:null};
  }
  function assertCorrectnessOracle(operation,value){
    if(!growthOnly)return;
    const oracle=correctnessOracles.find(row=>row.operation===operation.name);
    if(operation.query.facets.includes('summary')){
      for(const field of ['records','inputTokens','outputTokens','succeeded','failed','costSamples']){
        if(oracle.summary[field]!==undefined)assert.equal(value.summary?.[field],oracle.summary[field]);
      }
      if(oracle.summary.recordedCostUsd!==undefined)assert(Math.abs(value.summary.recordedCostUsd-oracle.summary.recordedCostUsd)<1e-6);
    }
    if(operation.query.facets.includes('groups')){
      assert.equal(value.groupPagination?.totalItems,oracle.groupCardinality);
      assert.equal(value.groupPagination?.page,1);assert.equal(value.groupPagination?.pageSize,operation.query.groupPageSize);
      assert.equal(value.groupPagination?.totalPages,Math.ceil(oracle.groupCardinality/operation.query.groupPageSize));
      assert.equal(value.groupPagination?.hasNext,oracle.groupCardinality>operation.query.groupPageSize);assert.equal(value.groupPagination?.hasPrev,false);
      assert.equal(value.groups?.length,Math.min(oracle.groupCardinality,operation.query.groupPageSize));
    }
    if(operation.query.facets.includes('items')){
      assert.equal(value.pagination?.totalItems,oracle.paginationTotal);
      assert.equal(value.pagination?.page,1);assert.equal(value.pagination?.pageSize,25);
      assert.equal(value.pagination?.totalPages,Math.ceil(oracle.paginationTotal/25));assert.equal(value.pagination?.hasNext,oracle.paginationTotal>25);assert.equal(value.pagination?.hasPrev,false);
      assert.deepEqual(value.items?.map(row=>row.id),oracle.itemIds);
    }
  }
  try{
    if(ownsTemporary)db.transaction(()=>seedEconomicsScale(db,{rowsPerTable}));
    assert.equal(db.get('SELECT COUNT(*) AS n FROM requestStats').n,rowsPerTable);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM usageHistory').n,rowsPerTable);
    for(const operation of operations){
      const query=operation.query;
      let captured;
      const tracing={get:(sql,args=[])=>db.get(sql,args),all:(sql,args=[])=>{if(!captured&&sql.includes(' AS MATERIALIZED')&&sql.includes(' UNION ALL '))captured={sql,args};return db.all(sql,args);}};
      readActivityAnalytics(tracing,query);
      plans.push({operation:operation.name,view:query.view,facets:query.facets,steps:db.all(`EXPLAIN QUERY PLAN ${captured.sql}`,captured.args).map(row=>row.detail)});
    }
    if(growthOnly)for(const operation of operations)correctnessOracles.push(buildCorrectnessOracle(operation));
    const beforeParity=parity();
    client=createContextAnalyticsClient({file:join(temporary,'db','data.sqlite'),driver:db.driver,cacheTtlMs:1000,timeoutMs:15000,traceLifecycle:true});
    rssTimer=setInterval(()=>{peakRss=Math.max(peakRss,measuredPeakRss());},20);
    rssTimer.unref?.();
    let writes=0,overlappingWrites=0,writerFailures=0,activeReads=0,maxWriterTickDelayMs=0,lastWriterTick=null;
    const write=()=>{
      const started=performance.now();
      try{
        const ordinal=++writes,id=`economics-benchmark-write-${ordinal}`;
        db.transaction(()=>{
          db.run('INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,logicalRequestId,attempt,dispatchCoverage) VALUES(?,?,?,?,?,?,?,?,?)',
            [id,'2026-01-01T00:00:00.000Z','provider-write','model-before','account-write','success',id,1,'physical-dispatch']);
          db.run('INSERT INTO usageHistory(timestamp,provider,model,connectionId,status,promptTokens,completionTokens,tokens,requestId,logicalRequestId,attempt,dispatchCoverage,costSource) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
            ['2026-01-01T00:00:00.000Z','provider-write','model-before','account-write','ok',100,10,'{"cached_tokens":5,"cache_creation_input_tokens":0}',id,id,1,'physical-dispatch','application-estimate']);
          db.run("UPDATE requestStats SET model='model-after',latencyTotal=42 WHERE id=?",[id]);
          db.run("UPDATE usageHistory SET model='model-after',cost=0.001 WHERE requestId=?",[id]);
          db.run('DELETE FROM usageHistory WHERE requestId=?',[id]);
          db.run('DELETE FROM requestStats WHERE id=?',[id]);
          db.run("INSERT INTO _meta(key,value) VALUES('economics-benchmark-write',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[String(ordinal)]);
        });
        writeCommits.push(Date.now());
        if(activeReads)overlappingWrites++;
      }
      catch{writerFailures++;}
      writeDurations.push(performance.now()-started);
    };
    async function load(operation,scenario,expectedDelivery=null,record=true,onComputationStarted=null){
      const started=performance.now();
      try{
        activeReads++;
        const value=await client.run(operation.query,{authorizedScope:'synthetic-benchmark',onComputationStarted});
        const durationMs=performance.now()-started;
        assert.equal(operation.expected(value),operation.expectedRows??rowsPerTable);
        assertCorrectnessOracle(operation,value);
        if(expectedDelivery)assert.equal(value.freshness.delivery,expectedDelivery);
        if(record)samples.push({operation:operation.name,...scenario,durationMs,delivery:value.freshness.delivery,cacheHit:value.freshness.cacheHit,
          queueDurationMs:value.freshness.queueDurationMs,executionDurationMs:value.freshness.executionDurationMs,
          computationQueueDurationMs:value.freshness.computationQueueDurationMs,computationExecutionDurationMs:value.freshness.computationExecutionDurationMs,
          queryDurationMs:value.freshness.queryDurationMs});
        return value;
      }catch(error){failures.push({operation:operation.name,...scenario,error:error.constructor.name});return null;}
      finally{activeReads--;}
    }
    async function cold(operation,count,concurrency,writer=false){
      const scenario={cacheState:'result-cache-cold',concurrency,writer};
      for(let offset=0;offset<count;offset+=concurrency){
        client.invalidate();
        let startSignal=null,wroteAtStart=false;
        const onComputationStarted=value=>{startSignal=value;if(!wroteAtStart){wroteAtStart=true;write();}};
        const values=await Promise.all(Array.from({length:Math.min(concurrency,count-offset)},()=>load(operation,scenario,'computed',true,writer?onComputationStarted:null)));
        if(writer){
          const result=values.find(Boolean),snapshotStartedAt=Date.parse(result?.freshness?.snapshotStartedAt),snapshotCompletedAt=Date.parse(result?.freshness?.snapshotCompletedAt);
          const committedWritesWithinWorkerSnapshot=writeCommits.filter(at=>at>=snapshotStartedAt&&at<=snapshotCompletedAt).length;
          writerComputationCoverage.push({operation:operation.name,concurrency,startSignal:startSignal?.snapshotStartedAt??null,
            snapshotStartedAt:result?.freshness?.snapshotStartedAt??null,snapshotCompletedAt:result?.freshness?.snapshotCompletedAt??null,committedWritesWithinWorkerSnapshot});
        }
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
      lastWriterTick=performance.now();
      const writer=setInterval(()=>{const now=performance.now();maxWriterTickDelayMs=Math.max(maxWriterTickDelayMs,now-lastWriterTick);lastWriterTick=now;write();},25);
      await new Promise(resolve=>setTimeout(resolve,15));
      await cold(operation,50,concurrency,true);
      clearInterval(writer);
    }
    const profileRows=()=>{
      const result=[];
      for(const operation of operations)for(const cacheState of ['result-cache-cold','result-cache-warm'])for(const concurrency of [1,5])for(const writer of [false,true]){
        const rows=samples.filter(row=>row.operation===operation.name&&row.cacheState===cacheState&&row.concurrency===concurrency&&row.writer===writer);
        if(rows.length)result.push({operation:operation.name,facets:operation.query.facets,cacheState,concurrency,writer,count:rows.length,p95Ms:percentile(rows.map(row=>row.durationMs),0.95),p99Ms:percentile(rows.map(row=>row.durationMs),0.99)});
      }
      return result;
    };
    const scheduledSamples=operations.length*2*(50+200+50),scheduledProfiles=operations.length*2*3;
    const projectionParity=()=>({sourceRows:db.get('SELECT COUNT(*) AS n FROM usageHistory').n,
      projectionRows:db.get('SELECT COUNT(*) AS n FROM usageEconomicsProjection').n,
      missingRows:db.get('SELECT COUNT(*) AS n FROM usageHistory u LEFT JOIN usageEconomicsProjection p ON p.id=u.id WHERE p.id IS NULL').n,
      orphanRows:db.get('SELECT COUNT(*) AS n FROM usageEconomicsProjection p LEFT JOIN usageHistory u ON u.id=p.id WHERE u.id IS NULL').n});
    const receipt=(status,currentProfile=null)=>({fixture:{version:'economics-analytics-v1',rowsPerTable,requestRows:rowsPerTable,usageRows:rowsPerTable,prebuilt:!ownsTemporary},
      settings:{cacheTtlMs:1000,serviceDeadlineMs:15000},progress:{status,completedSamples:samples.length,scheduledSamples,completedProfiles:profileRows().length,scheduledProfiles,currentProfile},
      profiles:profileRows(),samples,
      syntheticWriteHealth:{writes,pendingReadOverlappingWrites:overlappingWrites,failures:writerFailures,p95Ms:percentile(writeDurations,0.95),maxMs:writeDurations.length?Math.max(...writeDurations):null,maxTickDelayMs:maxWriterTickDelayMs,
        computations:writerComputationCoverage.length,minimumCommittedWritesWithinWorkerSnapshot:writerComputationCoverage.length?Math.min(...writerComputationCoverage.map(row=>row.committedWritesWithinWorkerSnapshot)):null,
        computationCoverage:writerComputationCoverage,finalValue:db.get("SELECT value FROM _meta WHERE key='economics-benchmark-write'")?.value??null,projectionParity:projectionParity()},
      plans,failures,peakAnalyticsProcessRssBytes:Math.max(peakRss,measuredPeakRss()),isolatedTemporaryData:true});
    const checkpoint=(status,currentProfile=null)=>{
      if(!output)return;
      const temporaryOutput=`${output}.tmp`;
      writeFileSync(temporaryOutput,JSON.stringify(receipt(status,currentProfile),null,2)+'\n');
      renameSync(temporaryOutput,output);
    };
    if(growthOnly){
      for(const operation of operations){
        for(let iteration=1;iteration<=3;iteration++){
          client.invalidate();
          let lifecycle=null;
          const value=await load(operation,{profile:'growth-smoke',cacheState:'result-cache-cold',concurrency:1,writer:false,iteration},'computed',true,event=>{lifecycle=event;});
          computations.push({operation:operation.name,concurrency:1,writer:false,iteration,durationMs:value?.freshness?.computationExecutionDurationMs??null,
            snapshotStartedAt:lifecycle?.snapshotStartedAt??value?.freshness?.snapshotStartedAt??null,snapshotCompletedAt:value?.freshness?.snapshotCompletedAt??null});
        }
        client.invalidate();
        let startSignal=null,wroteAtStart=false;
        const onComputationStarted=value=>{startSignal=value;if(!wroteAtStart){wroteAtStart=true;write();}};
        const values=await Promise.all(Array.from({length:5},(_,delivery)=>load(operation,
          {profile:'growth-smoke',cacheState:'result-cache-cold',concurrency:5,writer:true,deliveryOrdinal:delivery+1},'computed',true,onComputationStarted)));
        const result=values.find(Boolean),snapshotStartedAt=Date.parse(result?.freshness?.snapshotStartedAt),snapshotCompletedAt=Date.parse(result?.freshness?.snapshotCompletedAt);
        const committedWritesWithinWorkerSnapshot=writeCommits.filter(at=>at>=snapshotStartedAt&&at<=snapshotCompletedAt).length;
        const coverage={operation:operation.name,concurrency:5,startSignal:startSignal?.snapshotStartedAt??null,
          snapshotStartedAt:result?.freshness?.snapshotStartedAt??null,snapshotCompletedAt:result?.freshness?.snapshotCompletedAt??null,committedWritesWithinWorkerSnapshot};
        writerComputationCoverage.push(coverage);
        computations.push({operation:operation.name,concurrency:5,writer:true,iteration:1,durationMs:result?.freshness?.computationExecutionDurationMs??null,
          snapshotStartedAt:coverage.snapshotStartedAt,snapshotCompletedAt:coverage.snapshotCompletedAt});
      }
      peakRss=Math.max(peakRss,measuredPeakRss());
      const afterParity=parity();
      const qualification=evaluateGrowthQualification({deliveries:samples,computations,writerCoverage:writerComputationCoverage,failures,writerFailures,
        beforeParity,afterParity,plans,rowsPerTable,peakRssBytes:peakRss,deadlineMs:15000});
      const finalReceipt={fixture:{version:'economics-analytics-v1',rowsPerTable,requestRows:beforeParity.requestRows,usageRows:beforeParity.usageRows,
          prebuilt:true,completed:true,freshProcessOnly:true},settings:{cacheTtlMs:1000,serviceDeadlineMs:15000,affinityPreflight},
        progress:{status:qualification.passed?'qualification-passed':'qualification-failed',completedDeliveries:samples.length,scheduledDeliveries:32,
          completedComputations:computations.length,scheduledComputations:16},labels:qualification.labels,latencyQualified:false,qualification,deliveries:samples,computations,correctnessOracles,
        syntheticWriteHealth:{writes,failures:writerFailures,computations:writerComputationCoverage.length,committedSnapshots:writerComputationCoverage.filter(row=>row.committedWritesWithinWorkerSnapshot>=1).length,
          computationCoverage:writerComputationCoverage,writeDurationsMs:writeDurations,parity:{before:beforeParity,after:afterParity}},
        plans,failures,peakAnalyticsProcessRssBytes:peakRss,isolatedTemporaryData:true};
      if(output){writeFileSync(`${output}.tmp`,JSON.stringify(finalReceipt,null,2)+'\n');renameSync(`${output}.tmp`,output);}
      console.log(JSON.stringify(finalReceipt,null,2));
      assert(qualification.passed,JSON.stringify(qualification.violations));
      return;
    }
    checkpoint('fixture-ready');
    for(const operation of operations)for(const concurrency of [1,5]){
      await cold(operation,50,concurrency);
      checkpoint('running',{operation:operation.name,cacheState:'result-cache-cold',concurrency,writer:false});
      await warm(operation,200,concurrency);
      checkpoint('running',{operation:operation.name,cacheState:'result-cache-warm',concurrency,writer:false});
      await withWriter(operation,concurrency);
      checkpoint('running',{operation:operation.name,cacheState:'result-cache-cold',concurrency,writer:true});
    }
    const profiles=profileRows();
    const violations=profiles.filter(row=>row.cacheState==='result-cache-cold'&&(row.p95Ms>=2000||row.p99Ms>=5000))
      .map(row=>({operation:row.operation,concurrency:row.concurrency,writer:row.writer,p95Ms:row.p95Ms,p99Ms:row.p99Ms}));
    if(failures.length)violations.push({kind:'read-failures',count:failures.length});
    if(writerFailures)violations.push({kind:'writer-failures',count:writerFailures});
    if(!overlappingWrites)violations.push({kind:'missing-write-overlap'});
    if(writerComputationCoverage.some(row=>row.committedWritesWithinWorkerSnapshot<1))violations.push({kind:'missing-write-overlap-per-computation',count:writerComputationCoverage.filter(row=>row.committedWritesWithinWorkerSnapshot<1).length});
    const finalProjectionParity=projectionParity();
    if(finalProjectionParity.sourceRows!==rowsPerTable||finalProjectionParity.projectionRows!==rowsPerTable||finalProjectionParity.missingRows||finalProjectionParity.orphanRows)
      violations.push({kind:'projection-parity',...finalProjectionParity});
    peakRss=Math.max(peakRss,measuredPeakRss());
    if(peakRss>=512*1024*1024)violations.push({kind:'rss',bytes:peakRss});
    const finalReceipt={...receipt(violations.length?'qualification-failed':'qualification-passed'),qualification:{passed:violations.length===0,violations}};
    if(output){writeFileSync(`${output}.tmp`,JSON.stringify(finalReceipt,null,2)+'\n');renameSync(`${output}.tmp`,output);}
    console.log(JSON.stringify(finalReceipt,null,2));
    assert.equal(failures.length,0);
    assert.equal(writerFailures,0);assert(overlappingWrites>0);
    for(const profile of profiles.filter(row=>row.cacheState==='result-cache-cold')){assert(profile.p95Ms<2000);assert(profile.p99Ms<5000);}
    assert(peakRss<512*1024*1024);
  }finally{
    clearInterval(rssTimer);await client?.close();db.close();if(ownsTemporary)rmSync(temporary,{recursive:true,force:true});
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
}

const invokedPath=process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href;
if(import.meta.url===invokedPath)await main();
