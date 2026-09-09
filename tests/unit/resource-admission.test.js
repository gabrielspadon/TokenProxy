import { describe, it, expect, vi, afterEach } from 'vitest';
import { createResourceAdmission, releaseOnResponse, validateAdmissionPolicy } from '@/sse/services/resourceAdmission.js';
const fixed = { adaptive: false, minStreams: 1, maxStreams: 4, maxHandlers: 4, clientStreams: 2, clientHandlers: 2 };
afterEach(() => vi.useRealTimers());
describe('resource admission lifecycle and fairness', () => {
  it('holds stream capacity beyond handler return; release is idempotent', async () => {
    const c = createResourceAdmission({ policy: fixed }); const a = await c.acquire({ client: 'a' });
    a.releaseHandler(); a.releaseHandler(); expect(c.snapshot()).toMatchObject({ activeHandlers: 0, activeStreams: 1 });
    a.release(); a.release(); expect(c.snapshot()).toMatchObject({ activeHandlers: 0, activeStreams: 0, activeClients: 0 });
  });
  it('client FIFO and bounded queues prevent monopolization', async () => {
    const c = createResourceAdmission({ policy: { ...fixed, maxStreams: 2, clientStreams: 1, queueDepth: 3, clientQueueDepth: 2 } });
    const a = await c.acquire({ client: 'a' }); const b = await c.acquire({ client: 'b' }); const order = [];
    const a1 = c.acquire({ client: 'a' }).then(v => { order.push('a1'); return v; });
    const a2 = c.acquire({ client: 'a' }).then(v => { order.push('a2'); return v; });
    expect(await c.acquire({ client: 'a' })).toMatchObject({ admitted: false, why: 'queue-full' });
    const b1 = c.acquire({ client: 'b' }).then(v => { order.push('b1'); return v; });
    expect(await c.acquire({ client: 'c' })).toMatchObject({ admitted: false });
    a.release(); (await a1).release(); (await a2).release(); b.release(); (await b1).release();
    expect(order).toEqual(['a1','a2','b1']); expect(c.snapshot().activeStreams).toBe(0);
  });
  it('cancels queued clients immediately and honors absolute deadlines', async () => {
    vi.useFakeTimers(); const c = createResourceAdmission({ policy: { ...fixed, maxStreams: 1 } });
    const first = await c.acquire(); const abort = new AbortController(); const queued = c.acquire({ signal: abort.signal }); abort.abort();
    expect(await queued).toMatchObject({ why: 'aborted' });
    const timed = c.acquire({ deadline: Date.now() + 30 }); await vi.advanceTimersByTimeAsync(30);
    expect(await timed).toMatchObject({ why: 'wait-timeout' }); first.release(); expect(c.snapshot()).toMatchObject({ activeStreams: 0, queued: 0 });
  });
  it('body pull preserves backpressure and EOF releases exactly once', async () => {
    const release = vi.fn(); let pulls = 0;
    const source = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array([1])); controller.close(); } }, { highWaterMark: 0 });
    const response = releaseOnResponse(new Response(source), release); await Promise.resolve();
    expect(pulls).toBe(0); expect(release).not.toHaveBeenCalled(); await response.arrayBuffer();
    expect(pulls).toBe(1); expect(release).toHaveBeenCalledTimes(1);
  });
  it('caller abort cancels an unread upstream and frees its permit', async () => {
    const cancelled = vi.fn(), release = vi.fn(), abort = new AbortController();
    const response = releaseOnResponse(new Response(new ReadableStream({ cancel: cancelled })), release, abort.signal);
    abort.abort(); await expect(response.text()).rejects.toThrow(); expect(cancelled).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
  });
  it('body failures, client cancellation and bodyless responses finalize once', async () => {
    const release = vi.fn(); const broken = releaseOnResponse(new Response(new ReadableStream({ pull() { throw new Error('mock failure'); } })), release);
    await expect(broken.text()).rejects.toThrow('mock failure'); expect(release).toHaveBeenCalledTimes(1);
    await releaseOnResponse(new Response('data'), release).body.cancel(); releaseOnResponse(new Response(null, {status:204}), release);
    expect(release).toHaveBeenCalledTimes(3);
  });
});
describe('measured bounded adaptation', () => {
  it('minimum samples, smoothing, cooldown, hysteresis and gradual recovery resist oscillation', async () => {
    let now = 0; const c = createResourceAdmission({ now: () => now, policy: { minStreams: 2, maxStreams: 8, minSamples: 3, cooldownMs: 100 } });
    const permits = [await c.acquire({client:'a'}), await c.acquire({client:'b'})];
    const sample = pressure => { now += 100; return c.observe({ eventLoopMs: pressure * 100, memoryMb: pressure * 2048 }); };
    sample(.1); sample(.1); expect(c.snapshot().effectiveStreams).toBe(2);
    for (let i=0;i<10;i++) sample(.1); expect(c.snapshot().effectiveStreams).toBe(3);
    sample(4); sample(4); expect(c.snapshot().effectiveStreams).toBe(2); const before = c.snapshot().effectiveStreams;
    for (let i=0;i<30;i++) { now += 1; c.observe({eventLoopMs:200,memoryMb:4000}); } expect(c.snapshot().effectiveStreams).toBe(before);
    for(let i=0;i<30;i++) sample(.1); expect(c.snapshot().effectiveStreams).toBe(3); permits.forEach(p=>p.release());
  });
  it('long stream duration and missing evidence never create congestion or recovery', async () => {
    let now = 0; const c = createResourceAdmission({now:()=>now}); const permit = await c.acquire(); now = 600000;
    c.observe({ eventLoopMs: null, memoryMb: 20, generationMs: 600000 });
    expect(c.snapshot()).toMatchObject({ effectiveStreams:8, decision:'pressure-evidence-unavailable', smoothedPressure:null }); permit.release();
  });
  it('operator override is bounded and existing streams survive contraction', async () => {
    const c = createResourceAdmission({policy:fixed}); const permit = await c.acquire(); c.configure({...fixed,overrideStreams:1});
    expect(c.snapshot().effectiveStreams).toBe(1); expect(c.snapshot().activeStreams).toBe(1); permit.release();
    expect(()=>validateAdmissionPolicy({...fixed,overrideStreams:5})).toThrow(); expect(()=>validateAdmissionPolicy({ maxStreams:NaN })).toThrow(); expect(()=>validateAdmissionPolicy({ unknown:1 })).toThrow();
  });
  it('provider reservation is atomic, bounded and releases independently', () => {
    const c = createResourceAdmission({policy:fixed}); const p1=c.reserveProvider('mock',2), p2=c.reserveProvider('mock',2);
    expect(c.reserveProvider('mock',2)).toBeNull(); p1.release(); p1.release(); expect(c.snapshot().providers.mock.active).toBe(1); p2.release();
    c.providerThrottle('mock'); expect(c.snapshot().providers.mock.effectiveLimit).toBe(1);
  });
});

describe('quota and provider evidence qualification',()=>{
  it('ignores stale quota, retains only fresh pause evidence and expires it',()=>{
    let time=Date.now();const c=createResourceAdmission({now:()=>time});
    c.recordQuota('old',{fetchedAt:new Date(time-120001).toISOString()},true);
    c.recordQuota('fresh',{fetchedAt:new Date(time).toISOString()},true);
    expect(c.snapshot().quotaEvidence).toEqual({freshAccounts:1,pausedAccounts:1});
    time+=120001;expect(c.snapshot().quotaEvidence).toEqual({freshAccounts:0,pausedAccounts:0});
  });
  it('throttle recovery advances one provider permit per cooldown without oscillation',()=>{
    let time=0;const c=createResourceAdmission({now:()=>time,policy:{cooldownMs:100}});
    c.reserveProvider('mock',8).release();c.providerThrottle('mock');
    expect(c.snapshot().providers.mock.effectiveLimit).toBe(4);
    c.providerThrottle('mock');expect(c.snapshot().providers.mock.effectiveLimit).toBe(4);
    time=100;c.reserveProvider('mock',8).release();expect(c.snapshot().providers.mock.effectiveLimit).toBe(5);
    c.reserveProvider('mock',8).release();expect(c.snapshot().providers.mock.effectiveLimit).toBe(5);
    time=200;c.reserveProvider('mock',8).release();expect(c.snapshot().providers.mock.effectiveLimit).toBe(6);
  });
});
