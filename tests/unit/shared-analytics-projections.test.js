import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createUsageProjectionHub } from '@/lib/db/analytics/usageProjection.js';
import { createContextAnalyticsClient } from '@/lib/db/analytics/client.js';
import { analyticsRefreshPolicy } from '@/lib/db/analytics/refreshPolicy.js';
const hubs=[];
afterEach(()=>{for(const h of hubs)h.close();hubs.length=0;vi.useRealTimers();});
const decode = value => JSON.parse(new TextDecoder().decode(value).slice(6));
function fixture(options={}) {
  const emitter=new EventEmitter(); let total=0;
  const readStats=vi.fn(async period=>({period,totalRequests:++total,recentRequests:[]}));
  const readActive=vi.fn(async()=>({activeRequests:[],recentRequests:[]}));
  const h=createUsageProjectionHub({emitter,readStats,readActive,policy:()=>({mode:'normal',reason:'fixture',streamIntervalMs:250,refreshAfterMs:15000}),...options});hubs.push(h);
  return {h,emitter,readStats,readActive};
}
describe('shared usage projections',()=>{
  it('shares one computation across identical scopes and keeps one latest frame for a slow subscriber',async()=>{
    vi.useFakeTimers();const {h,emitter,readStats}=fixture();
    const fast=h.open({authorizedScope:'admin'}).getReader();
    const slow=h.open({authorizedScope:'admin'}).getReader();
    const initial=fast.read();await vi.advanceTimersByTimeAsync(0);expect(decode((await initial).value).totalRequests).toBe(1);
    expect(readStats).toHaveBeenCalledTimes(1);expect(emitter.listenerCount('update')).toBe(1);
    for(let i=0;i<20;i++){emitter.emit('update');const next=fast.read();await vi.advanceTimersByTimeAsync(250);await next;}
    expect(decode((await slow.read()).value).totalRequests).toBe(21);
    expect(h.status()).toMatchObject({groups:1,subscribers:2,delivery:'latest-only'});
    await fast.cancel();await slow.cancel();expect(emitter.listenerCount('update')).toBe(0);
  });
  it('separates period and authorized scope, bounds subscribers and fairly refreshes other periods',async()=>{
    vi.useFakeTimers();const {h,emitter,readStats}=fixture({maxSubscribers:3});
    const readers=[h.open({authorizedScope:'a',period:'today'}).getReader(),h.open({authorizedScope:'b',period:'today'}).getReader(),h.open({authorizedScope:'a',period:'7d'}).getReader()];
    expect(()=>h.open({authorizedScope:'a'})).toThrow('capacity');expect(()=>h.open()).toThrow('scope');
    const frames=readers.map(r=>r.read());await vi.advanceTimersByTimeAsync(10);await Promise.all(frames);
    expect(readStats).toHaveBeenCalledTimes(3);
    emitter.emit('update');const next=readers.map(r=>r.read());await vi.advanceTimersByTimeAsync(260);await Promise.all(next);
    expect(readStats.mock.calls.map(c=>c[0])).toEqual(['today','today','7d','today','today','7d']);
  });
  it('abort during pending work removes listeners and discards the abandoned projection',async()=>{
    vi.useFakeTimers();let done;const {h,emitter}=fixture({readStats:()=>new Promise(r=>{done=r;})});
    const abort=new AbortController();const reader=h.open({authorizedScope:'admin',signal:abort.signal}).getReader();
    const pending=reader.read();await vi.advanceTimersByTimeAsync(0);abort.abort();
    expect(await pending).toEqual({done:true,value:undefined});done({total:1});await Promise.resolve();
    expect(h.status().subscribers).toBe(0);expect(emitter.listenerCount('update')).toBe(0);
  });
  it('refresh pressure slows projections and recovers without serializing unrelated controls',async()=>{
    vi.useFakeTimers();let reduced=false;const {h,emitter,readStats}=fixture({policy:()=>({mode:reduced?'reduced':'normal',reason:'test',streamIntervalMs:reduced?5000:250,refreshAfterMs:reduced?60000:15000})});
    const reader=h.open({authorizedScope:'admin'}).getReader();const first=reader.read();await vi.advanceTimersByTimeAsync(0);await first;
    reduced=true;emitter.emit('update');const next=reader.read();await vi.advanceTimersByTimeAsync(250);expect(decode((await next).value).projection.mode).toBe('reduced');
    for(let i=0;i<100;i++)emitter.emit('update');
    await vi.advanceTimersByTimeAsync(1000);expect(readStats).toHaveBeenCalledTimes(2);
    let control=false;await Promise.resolve().then(()=>{control=true;});expect(control).toBe(true);
    reduced=false;const recovery=reader.read();await vi.advanceTimersByTimeAsync(4000);expect(decode((await recovery).value).projection.mode).toBe('normal');
  });
  it('failed refresh preserves old computation time and marks stale; oversize delivery closes cleanly',async()=>{
    vi.useFakeTimers();const {h,emitter,readStats}=fixture();const reader=h.open({authorizedScope:'admin'}).getReader();
    const initial=reader.read();await vi.advanceTimersByTimeAsync(0);const first=decode((await initial).value);
    readStats.mockRejectedValue(new Error('db busy'));emitter.emit('update');const pending=reader.read();await vi.advanceTimersByTimeAsync(250);
    expect(decode((await pending).value).projection).toMatchObject({stale:true,computedAt:first.projection.computedAt});
    const small=fixture({maxFrameBytes:20}).h.open({authorizedScope:'admin'}).getReader();
    const rejected=expect(small.read()).rejects.toThrow('delivery limit');await vi.advanceTimersByTimeAsync(0);await rejected;
  });
});
class Worker extends EventEmitter { messages=[];ref(){}unref(){}terminate(){return Promise.resolve();}postMessage(m){this.messages.push(m);}respond(n=0){this.emit('message',{id:this.messages[n].id,result:{freshness:{snapshotCompletedAt:'2026-09-08T00:00:00Z'},items:[n]}});}}
it('worker reuse includes canonical filters, authorization, exact page and changing data version',async()=>{
  let version='v1';const worker=new Worker();const client=createContextAnalyticsClient({workerFactory:()=>worker,version:()=>version});
  const q={operation:'activity',filter:{page:1,from:'2026-09-08',provider:'mock'}};
  const first=client.run(q,{authorizedScope:'admin'});worker.respond();await first;
  const same=await client.run({filter:{provider:'mock',from:'2026-09-08',page:1},operation:'activity'},{authorizedScope:'admin'});
  expect(same.freshness.delivery).toBe('cache-hit');
  same.items.push('mutated');expect((await client.run(q,{authorizedScope:'admin'})).items).toEqual([0]);expect(worker.messages).toHaveLength(1);
  for(const [scope,page,v] of [['other',1,'v1'],['admin',2,'v1'],['admin',1,'v2']]){version=v;const next=client.run({...q,filter:{...q.filter,page}},{authorizedScope:scope});worker.respond(worker.messages.length-1);await next;}
  expect(worker.messages).toHaveLength(4);client.invalidate();expect(client.status().cached).toBe(0);await client.close();
});
it('worker cache respects byte/entry budgets and no version disables reuse',async()=>{
  const worker=new Worker();const client=createContextAnalyticsClient({workerFactory:()=>worker,version:()=>null});
  for(let i=0;i<2;i++){const next=client.run({operation:'same'});worker.respond(i);await next;}
  expect(worker.messages).toHaveLength(2);expect(client.status().cacheBytes).toBe(0);await client.close();
  const limitedWorker=new Worker();const limited=createContextAnalyticsClient({workerFactory:()=>limitedWorker,version:()=>1,maxCacheBytes:8});
  const next=limited.run({operation:'same'});limitedWorker.respond();await next;expect(limited.status().cached).toBe(0);await limited.close();
});
it('only fresh actual admission pressure reduces refresh; stale/missing evidence cannot fabricate overload',()=>{
  expect(analyticsRefreshPolicy({samples:5,lastSample:{at:100},smoothedPressure:2,queued:0},200)).toMatchObject({mode:'reduced',refreshAfterMs:60000});
  expect(analyticsRefreshPolicy({samples:5,lastSample:{at:100},smoothedPressure:2},6000)).toMatchObject({mode:'reduced',reason:'pressure-unavailable'});
  expect(analyticsRefreshPolicy(undefined)).toMatchObject({mode:'reduced',reason:'pressure-unavailable'});
});

it('worker queue serves a second scope ahead of a saturated scope and bounds each share',async()=>{
  const worker=new Worker();const client=createContextAnalyticsClient({workerFactory:()=>worker,maxQueued:4});
  const requests=[client.run({n:1},{authorizedScope:'a'}),client.run({n:2},{authorizedScope:'a'}),client.run({n:3},{authorizedScope:'a'})];
  await expect(client.run({n:4},{authorizedScope:'a'})).rejects.toThrow('unavailable');
  requests.push(client.run({n:5},{authorizedScope:'b'}));
  worker.respond(0);expect(worker.messages[1].query.n).toBe(5);
  worker.respond(1);worker.respond(2);worker.respond(3);await Promise.all(requests);await client.close();
});
it('reports queue and execution time separately while retaining one total deadline',async()=>{
  let clock=0;const worker=new Worker();const client=createContextAnalyticsClient({workerFactory:()=>worker,version:()=>1,monotonic:()=>clock,timeoutMs:100});
  const first=client.run({n:1});clock=5;const second=client.run({n:2});
  clock=10;worker.respond(0);await first;
  clock=25;worker.respond(1);const result=await second;
  expect(result.freshness).toMatchObject({cacheHit:false,delivery:'computed',queueDurationMs:5,executionDurationMs:15,
    computationQueueDurationMs:5,computationExecutionDurationMs:15,serviceDeadlineMs:100});
  await client.close();
});
it('reports cache-hit delivery timing without relabeling the original computation',async()=>{
  let clock=0,now=0;const worker=new Worker();const client=createContextAnalyticsClient({workerFactory:()=>worker,version:()=>1,monotonic:()=>clock,now:()=>now});
  const computed=client.run({n:1});clock=12;worker.respond();const first=await computed;
  clock=40;now=25;const hit=await client.run({n:1});
  expect(first.freshness).toMatchObject({cacheHit:false,queueDurationMs:0,executionDurationMs:12,computationExecutionDurationMs:12});
  expect(hit.freshness).toMatchObject({cacheHit:true,delivery:'cache-hit',queueDurationMs:0,executionDurationMs:0,
    computationQueueDurationMs:0,computationExecutionDurationMs:12,cacheAgeMs:25});
  await client.close();
});
it('explicit invalidation during computation cannot repopulate old cache, and TTL preserves bounded reuse',async()=>{
  let now=0;const worker=new Worker();const client=createContextAnalyticsClient({workerFactory:()=>worker,version:()=>1,now:()=>now,maxCacheEntries:1,cacheTtlMs:100});
  const first=client.run({n:1});client.invalidate();worker.respond();await first;expect(client.status().cached).toBe(0);
  for(let n=2;n<=3;n++){const request=client.run({n});worker.respond(worker.messages.length-1);await request;expect(client.status().cached).toBe(1);}
  now=101;const expired=client.run({n:3});expect(worker.messages).toHaveLength(4);worker.respond(3);await expired;await client.close();
});

it('policy changes that reset admission samples retain conservative analytics refresh until measurements return',()=>{
 expect(analyticsRefreshPolicy({samples:0,lastSample:{at:100},smoothedPressure:null,policy:{minSamples:5}},200)).toMatchObject({mode:'reduced',reason:'pressure-unavailable'});
 expect(analyticsRefreshPolicy({samples:5,lastSample:{at:100},smoothedPressure:0.2,policy:{minSamples:5}},200)).toMatchObject({mode:'normal',reason:'gateway-healthy'});
});
