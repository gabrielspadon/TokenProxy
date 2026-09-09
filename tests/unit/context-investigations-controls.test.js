// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextProjectFilter } from '../../src/shared/components/context-workspace/ContextProjectFilter.js';
import { ContextRoutingHistory } from '../../src/shared/components/context-workspace/ContextRoutingHistory.js';
import { StageLedger } from '../../src/shared/components/context-workspace/ContextInspector.js';
import { QuotaSchedule } from '../../src/shared/workspace/QuotaSchedule.js';
import { ContextIntervalComparison } from '../../src/shared/components/context-workspace/ContextIntervalComparison.js';

let root,container,fetchMock;
const scope={provider:'provider-a',model:'model-a',connectionId:'account-a',start:'2026-09-06T00:00:00Z',end:'2026-09-07T00:00:00Z'};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
async function flush(ms=0){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms));});}
async function render(node){await act(async()=>root.render(<MantineProvider env="test">{node}</MantineProvider>));await flush();}
async function click(text){const element=[...container.querySelectorAll('button')].find(item=>item.textContent===text || item.getAttribute('aria-label')===text);expect(element).toBeTruthy();await act(async()=>element.click());await flush();}
async function input(element,value){await act(async()=>{element.focus();Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});await flush();}
beforeEach(()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  Object.defineProperty(window.HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
  vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener(){},removeEventListener(){}})});
  fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('Context investigation controls',()=>{
  it('pages and searches server project options while retaining an off-page selected label',async()=>{
    fetchMock.mockImplementation(async url=>{
      const p=new URL(url,'http://test').searchParams, second=p.get('page')==='2', searched=p.get('projectSearch')==='Tail';
      return response({projects:[{projectLabel:searched?'Tail project':second?'Second page':'First page'}],pagination:{totalItems:searched?1:137,page:second?2:1,totalPages:searched?1:7,hasNext:!searched,hasPrev:second}});
    });
    await render(<ContextProjectFilter scope={scope} clientTool="codex" value="Saved outside page" onChange={()=>{}} />);
    const selector=container.querySelector('[aria-label="Project label filter"]');
    expect(selector.value).toBe('Saved outside page');
    await flush(240);
    expect(new URL(fetchMock.mock.calls.at(-1)[0],'http://test').searchParams.get('projectSearch')).toBe('');
    await click('Next project labels');expect(selector.value).toBe('Saved outside page');
    let query=new URL(fetchMock.mock.calls.at(-1)[0],'http://test').searchParams;
    expect(query.get('page')).toBe('2');expect(query.get('clientTool')).toBe('codex');expect(query.get('provider')).toBe('provider-a');
    await input(selector,'Tail');await flush(240);
    query=new URL(fetchMock.mock.calls.at(-1)[0],'http://test').searchParams;
    expect(query.get('projectSearch')).toBe('Tail');expect(query.get('page')).toBe('1');expect(query.get('projectLabel')).toBe('Saved outside page');
    expect(container.textContent).toContain('1 labels');
  });
  it('keeps the exact session when routing continues and reports a refused page without replacing evidence',async()=>{
    fetchMock.mockImplementation(async url=>{
      const next=new URL(url,'http://test').searchParams.has('cursor');
      return next ? response({error:{message:'Reader unavailable'}},503) : response({items:[{id:'r-137',model:'Model',toConnectionId:'a',switchedAt:scope.start,trigger:'initial-pin'}],pagination:{totalItems:137,hasMore:true,nextCursor:'cursor-1'},scope:'Exact session history'});
    });
    await render(<ContextRoutingHistory sessionId={7} accountName={id=>id || 'Unknown'} />);
    expect(container.textContent).toContain('137 retained switches');await click('Next routing page');
    expect(fetchMock.mock.calls.at(-1)[0]).toContain('/sessions/7?');expect(fetchMock.mock.calls.at(-1)[0]).toContain('cursor=cursor-1');
    expect(container.textContent).toContain('Reader unavailable');expect(container.textContent).toContain('Page 2');
    await click('Retry routing history');expect(fetchMock.mock.calls.at(-1)[0]).toContain('cursor=cursor-1');
    await click('Previous routing page');expect(fetchMock.mock.calls.at(-1)[0]).not.toContain('cursor=');expect(container.textContent).toContain('137 retained switches');
  });
  it('compares explicit UTC periods without changing shared selection or treating absent usage as zero',async()=>{
    const change=vi.fn();
    const payload={scope:'One committed snapshot',overlapMs:0,baseline:{period:{start:'2026-09-05T00:00:00Z',end:'2026-09-06T00:00:00Z',durationMs:86400000},summary:{attempts:2,requests:2,sessions:1,providerInputTokens:100,providerOutputTokens:10,cacheReadTokens:20,cacheWriteTokens:null,savedBytes:5},coverage:{providerInputSamples:1,providerOutputSamples:1,cacheReadSamples:1,cacheWriteSamples:0,bodySamples:1}},selected:{period:{start:'2026-09-06T00:00:00Z',end:'2026-09-07T00:00:00Z',durationMs:86400000},summary:{attempts:3,requests:3,sessions:1,providerInputTokens:150,providerOutputTokens:15,cacheReadTokens:30,cacheWriteTokens:null,savedBytes:-2},coverage:{providerInputSamples:2,providerOutputSamples:2,cacheReadSamples:2,cacheWriteSamples:0,bodySamples:2}}};
    fetchMock.mockResolvedValue(response(payload));
    function Workspace(){const [contextView,setContext]=useState({projectLabel:'Project',clientTool:'codex',sessionId:7});return <ContextIntervalComparison workspace={{scope,contextView,setContextView:patch=>{change(patch);setContext(old=>({...old,...patch}));}}} />;}
    await render(<Workspace />);
    const inputs=container.querySelectorAll('input[type="datetime-local"]');
    await input(inputs[0],'2026-09-05T00:00:00');await input(inputs[1],'2026-09-06T00:00:00');
    await click('Compare periods');
    expect(change).toHaveBeenCalledWith({intervalComparison:{baseline:{start:'2026-09-05T00:00:00.000Z',end:'2026-09-06T00:00:00.000Z'},selected:{start:'2026-09-06T00:00:00.000Z',end:'2026-09-07T00:00:00.000Z'}}});
    const query=new URL(fetchMock.mock.calls.at(-1)[0],'http://test').searchParams;
    expect(query.get('provider')).toBe('provider-a');expect(query.get('projectLabel')).toBe('Project');expect(query.get('baselineFrom')).toBe('2026-09-05T00:00:00.000Z');
    expect(container.textContent).toContain('1 / 2 samples');expect(container.textContent).toContain('2 / 3 samples');expect(container.textContent).toContain('Unknown');expect(container.textContent).toContain('signed UTF-8 bytes');
  });
});


describe('Quota schedule evidence',()=>{
  it('opens exact schedule history with a fixed end, paginates and retains failure feedback',async()=>{
    fetchMock.mockImplementation(async url=>{
      const q=new URL(url,'http://test').searchParams;
      if(url.includes('/schedule?'))return response({items:[{id:'job-a',provider:'codex',status:'scheduled',nextCheckAt:scope.end,reason:'retry-not-before',lastOutcome:'failed',targets:[{scope:'weekly',unit:'tokens',observationId:'observation-a'}]}],asOf:scope.end});
      if(q.get('page')==='2')return response({error:{message:'History reader unavailable'}},503);
      return response({items:[{id:'event-a',capturedAt:scope.start,eventType:'failed',outcome:'failed',code:'metadata-timeout',observationId:'observation-a'}],total:23,hasMore:true});
    });
    await render(<QuotaSchedule connectionId="account-a" />);
    expect(container.textContent).toContain('Failure cooldown');expect(container.textContent).toContain('weekly · tokens');
    await click('View check history');
    let q=new URL(fetchMock.mock.calls.at(-1)[0],'http://test').searchParams;
    expect(q.get('jobId')).toBe('job-a');expect(q.get('connectionId')).toBe('account-a');expect(q.get('start')).toBe('1970-01-01T00:00:00.000Z');expect(q.get('end')).toBe(scope.end);
    expect(container.textContent).toContain('metadata-timeout');await click('Next check receipts');expect(container.textContent).toContain('History reader unavailable');
    await click('Retry check receipts');q=new URL(fetchMock.mock.calls.at(-1)[0],'http://test').searchParams;expect(q.get('page')).toBe('2');expect(q.get('jobId')).toBe('job-a');
    await click('Close check history');expect(container.querySelector('[aria-label="Scheduled check history"]')).toBeNull();
  });
  it('marks retained scheduling data as stale when a refresh fails and never displays cancelled eligibility',async()=>{
    fetchMock.mockResolvedValueOnce(response({items:[{id:'job-a',provider:'codex',status:'cancelled',nextCheckAt:scope.end,cancelReason:'setting-disabled'}],asOf:scope.end})).mockResolvedValue(response({error:'Read failed'},503));
    await render(<QuotaSchedule connectionId="account-a" />);expect(container.textContent).toContain('Not scheduled');
    await click('Refresh schedule');expect(container.textContent).toContain('may be stale');expect(container.textContent).toContain('setting-disabled');
  });
});

it('distinguishes recorded shaping failures and cancellation from historical byte measurements',async()=>{
  await render(<StageLedger requestId="attempt-b" stages={[
    {ordinal:0,stage:'web-search',outcome:'unchanged',beforeBytes:100,afterBytes:100,deltaBytes:0},
    {ordinal:1,stage:'rag',outcome:'failed',outcomeSource:'execution',errorCode:'service_timeout',executionRequestId:'attempt-a',beforeBytes:100,afterBytes:100,deltaBytes:0},
    {ordinal:2,stage:'pxpipe',outcome:'cancelled',outcomeSource:'execution',errorCode:'caller_cancelled',beforeBytes:100,afterBytes:100,deltaBytes:0},
  ]} />);
  const rows=container.querySelectorAll('tbody tr');
  expect(rows[0].textContent).toContain('Historical byte measurement');expect(rows[0].textContent).not.toContain('unchanged');
  expect(rows[1].textContent).toContain('failedservice timeout');expect(rows[2].textContent).toContain('cancelledcaller cancelled');
  expect(container.textContent).toContain('only when explicitly recorded');expect(container.textContent).toContain('Reused preparation from attempt attempt-a');
});
