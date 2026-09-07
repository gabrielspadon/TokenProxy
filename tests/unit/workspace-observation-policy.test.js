// @vitest-environment jsdom
import { act, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ObservationProvider, useObservationPolicy } from '../../src/shared/workspace/ObservationPolicy';
import { useResource } from '../../src/shared/workspace/useResource';
import { usePoll } from '../../src/shared/hooks/usePoll';
import { useEventStream } from '../../src/shared/hooks/useEventStream';

let root, container, current, streams, messages;
function Probe({ url='/api/evidence' }) {
  const policy=useObservationPolicy();
  const evidence=useResource(url);
  const legacy=usePoll(url,1000);
  const stream=useEventStream('/api/events',messages);
  useEffect(()=>{current={policy,evidence,legacy,stream};});
  return <span>{evidence.data?.revision ?? 'Loading'}</span>;
}
const render = async (url) => act(async()=>root.render(<StrictMode><ObservationProvider><Probe url={url}/></ObservationProvider></StrictMode>));
beforeEach(()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  vi.useFakeTimers();streams=[];messages=vi.fn();
  let sequence=0;
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({revision:++sequence}),{status:200})));
  vi.stubGlobal('EventSource',class {constructor(url){this.url=url;this.close=vi.fn();streams.push(this);}});
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(()=>{act(()=>root.unmount());container.remove();vi.unstubAllGlobals();vi.useRealTimers();});
it('summary reads visible evidence once, survives StrictMode, and does not start background work',async()=>{
  await render();expect(current.evidence.loading).toBe(false);expect(current.legacy.loading).toBe(false);
  const initial=fetch.mock.calls.length;
  await act(async()=>vi.advanceTimersByTimeAsync(60000));
  expect(fetch).toHaveBeenCalledTimes(initial);expect(streams).toHaveLength(0);
});
it('live refreshes, pause closes streams and cancels timers, and late events cannot update retained evidence',async()=>{
  await render();await act(async()=>current.policy.setMode('live'));
  expect(streams).toHaveLength(1);
  const stream=streams[0];await act(async()=>stream.onmessage({data:'{"id":"before-pause"}'}));
  expect(messages).toHaveBeenCalledOnce();
  const liveCalls=fetch.mock.calls.length;
  await act(async()=>vi.advanceTimersByTimeAsync(1000));expect(fetch.mock.calls.length).toBeGreaterThan(liveCalls);
  await act(async()=>current.policy.setMode('paused'));
  expect(stream.close).toHaveBeenCalledOnce();expect(current.stream.status).toBe('paused');
  const pausedCalls=fetch.mock.calls.length;
  await act(async()=>{stream.onmessage({data:'{"id":"late"}'});vi.advanceTimersByTime(60000);});
  expect(messages).toHaveBeenCalledOnce();expect(fetch).toHaveBeenCalledTimes(pausedCalls);
  await act(async()=>current.policy.refresh());expect(fetch.mock.calls.length).toBe(pausedCalls+2);
  expect(current.stream.status).toBe('paused');expect(streams).toHaveLength(1);
  await render('/api/evidence?record=other');expect(current.evidence.loading).toBe(false);
});
it.each(['setHistorical','setSnapshot'])('%s prevents background work and preserves manual inspection',async(setBoundary)=>{
  await render();await act(async()=>current.policy.setMode('live'));
  await act(async()=>current.policy[setBoundary](true));
  expect(current.policy.background).toBe(false);expect(streams[0].close).toHaveBeenCalledOnce();
  const calls=fetch.mock.calls.length;
  await act(async()=>vi.advanceTimersByTimeAsync(60000));expect(fetch).toHaveBeenCalledTimes(calls);
  await act(async()=>current.evidence.refresh());expect(fetch.mock.calls.length).toBe(calls+1);
});

it('reopening a conditional inspector reads fresh evidence instead of reusing its last body',async()=>{
  await render();const initial=fetch.mock.calls.length;
  await render(null);await render();
  expect(fetch.mock.calls.length).toBe(initial+2);
});

it('pausing unfinished live reads aborts them without dispatching replacements',async()=>{
  await render();
  const signals=[];
  fetch.mockImplementation((_url,{signal})=>{signals.push(signal);return new Promise(()=>{});});
  await act(async()=>current.policy.setMode('live'));
  const started=fetch.mock.calls.length;
  expect(signals).toHaveLength(2);
  await act(async()=>current.policy.setMode('paused'));
  expect(fetch.mock.calls.length).toBe(started);
  expect(signals.every(signal=>signal.aborted)).toBe(true);
  expect(current.evidence.loading).toBe(false);
  await act(async()=>current.policy.refresh());
  expect(fetch.mock.calls.length).toBe(started+2);
});

it('explicit selection while paused reports pending evidence until its read completes',async()=>{
  await render('/api/first');
  await act(async()=>current.policy.setMode('paused'));
  fetch.mockImplementation(()=>new Promise(()=>{}));
  const before=fetch.mock.calls.length;
  await render('/api/second');
  expect(fetch.mock.calls.length).toBe(before+2);
  expect(current.evidence.loading).toBe(true);
  expect(current.legacy.loading).toBe(true);
});

it('switching unfinished live evidence to summary leaves one active read per resource',async()=>{
  const signals=[];
  fetch.mockImplementation((_url,{signal})=>{signals.push(signal);return new Promise(()=>{});});
  await render();
  await act(async()=>current.policy.setMode('live'));
  await act(async()=>current.policy.setMode('summary'));
  expect(signals.filter(signal=>!signal.aborted)).toHaveLength(2);
  expect(current.evidence.loading).toBe(true);
  expect(current.legacy.loading).toBe(true);
  const calls=fetch.mock.calls.length;
  await act(async()=>vi.advanceTimersByTimeAsync(60000));
  expect(fetch.mock.calls.length).toBe(calls);
});

it('pausing a pending automatic retry after failure settles both readers without replacement',async()=>{
  fetch.mockImplementation(async()=>new Response('{"error":"Unavailable"}',{status:503}));
  await render();
  await act(async()=>current.policy.setMode('live'));
  expect(current.evidence.error).toBeTruthy();
  expect(current.legacy.error).toBeTruthy();
  const pending=[];
  fetch.mockImplementation((_url,{signal})=>{pending.push(signal);return new Promise(()=>{});});
  await act(async()=>vi.advanceTimersByTimeAsync(15000));
  expect(pending).toHaveLength(2);
  const calls=fetch.mock.calls.length;
  await act(async()=>current.policy.setMode('paused'));
  expect(fetch.mock.calls.length).toBe(calls);
  expect(pending.every(signal=>signal.aborted)).toBe(true);
  expect(current.evidence.loading).toBe(false);
  expect(current.legacy.loading).toBe(false);
  expect(current.evidence.error).toBeTruthy();
  expect(current.legacy.error).toBeTruthy();
});

it('retains a failed refresh and the last successful observation through retry and pause until replacement succeeds',async()=>{
  await render();
  const evidence = current.evidence.data, legacy = current.legacy.data;
  const receivedAt = current.evidence.receivedAt, goodAt = current.legacy.goodAt;
  fetch.mockImplementation(async()=>new Response('{"error":"Unavailable"}',{status:503}));
  await act(async()=>current.policy.setMode('live'));
  expect(current.evidence.error).toBe('Unavailable');
  expect(current.legacy.error).toEqual({error:'Unavailable'});
  fetch.mockImplementation(()=>new Promise(()=>{}));
  await act(async()=>vi.advanceTimersByTimeAsync(15000));
  expect(current.evidence.error).toBe('Unavailable');
  expect(current.legacy.status).toBe(503);
  await act(async()=>current.policy.setMode('paused'));
  expect(current.evidence).toMatchObject({data:evidence,error:'Unavailable',loading:false,receivedAt});
  expect(current.legacy).toMatchObject({data:legacy,error:{error:'Unavailable'},status:503,loading:false,goodAt});
  fetch.mockImplementation(async()=>new Response('{"revision":"recovered"}',{status:200}));
  await act(async()=>current.policy.refresh());
  expect(current.evidence).toMatchObject({data:{revision:'recovered'},error:null,loading:false});
  expect(current.legacy).toMatchObject({data:{revision:'recovered'},error:null,status:200,loading:false});
});
