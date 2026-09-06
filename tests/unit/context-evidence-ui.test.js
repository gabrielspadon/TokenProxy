// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextStructureEvidence, ContextClientEvents, ContextAttemptComparison, ContextCostEvidence } from '../../src/shared/workspace/ContextEvidence.js';
import { measureContextStructure } from '../../open-sse/utils/contextStructure.js';
import { contextFixture } from '../fixtures/context-workspace.js';
let root,container,turn;
beforeEach(()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('ResizeObserver',class {observe(){} unobserve(){} disconnect(){}});
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener(){},removeEventListener(){}})});
  turn=contextFixture().detail.turns[0];
  turn.structures=['client-received','gateway-shaped','physical-dispatch'].map(boundary=>measureContextStructure({system:'PRIVATE instruction',messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:PRIVATE'}}]},{role:'assistant',tool_calls:[{id:'call',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',content:'PRIVATE result',tool_call_id:'call'},{role:'user',content:'PRIVATE latest'}]},boundary,Buffer.alloc(32,1)));
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
async function render(child){await act(async()=>root.render(<MantineProvider env="test">{child}</MantineProvider>));}
const table=(name)=>container.querySelector(`table[aria-label="${name}"]`);
describe('Content-free Context evidence views',()=>{
  it('shows measured boundaries, role and overlapping subset denominators without raw prompts',async()=>{
    await render(<ContextStructureEvidence turn={turn}/>);
    expect(table('Body partition · UTF-8 JSON bytes').textContent).toContain(`${turn.structures[0].bodyBytes} B`);
    expect(table('Message roles · count / bytes').textContent).toContain('User2 /');
    expect(table('Overlapping subsets · count / bytes').textContent).toContain('Attachments1 /');
    expect(container.textContent).toContain('Installation-keyed HMAC-SHA256');
    expect(container.textContent).toContain('Do not add these values');
    expect(container.textContent).not.toContain('PRIVATE');
    expect(container.textContent).toContain(turn.structures[0].fingerprints.historyPrefix);
  });
  it('shows unavailable transport or historical boundaries without fabricated zero counts',async()=>{
    turn.structures=turn.structures.slice(0,1);await render(<ContextStructureEvidence turn={turn}/>);
    const first=table('Body partition · UTF-8 JSON bytes').querySelector('tbody tr');
    expect([...first.querySelectorAll('td')].map(n=>n.textContent)).toEqual([`${turn.structures[0].bodyBytes} B`,'Unavailable','Unavailable']);
  });
  it('paginates exact linked reports independently of scope and separates observations from reports',async()=>{
    turn.compactHint=true;
    const fetch=vi.fn(async url=>Response.json({events:[{id:'report',type:'compaction',occurredAt:'2026-09-06T13:00:00Z',recordedAt:'2026-09-06T14:00:00Z',beforeTokens:100,afterTokens:120,tokenMeasurementMethod:'client-estimate',requestId:turn.id}],pagination:{page:1,totalItems:21,totalPages:2,hasPrev:false,hasNext:!String(url).includes('page=2')}}));
    vi.stubGlobal('fetch',fetch);
    await render(<ContextClientEvents turn={turn} sessionId={7}/>);
    expect(fetch.mock.calls[0][0]).toBe('/api/context/events?requestId=101&sessionId=7&page=1&pageSize=20');
    expect(container.textContent).toContain('not proof of client compaction');expect(container.textContent).toContain('Client reported · provider unverified');
    expect(container.textContent).toContain('100 / 120 client tokens');
    await act(async()=>[...container.querySelectorAll('button')].find(n=>n.textContent==='Next reports').click());
    expect(fetch.mock.calls.at(-1)[0]).toContain('page=2');
  });
  it('distinguishes empty reports from a failed read',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({events:[],pagination:{page:1,totalItems:0,totalPages:0}})));
    await render(<ContextClientEvents turn={turn} sessionId={7}/>);expect(container.textContent).toContain('No explicit client reports');
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'Reader busy'},{status:503})));
    await render(<ContextClientEvents key="new" turn={turn} sessionId={7}/>);expect(container.textContent).toContain('Client reports unavailable');expect(container.textContent).not.toContain('No explicit client reports');
  });
  it('compares all ordered stages and signed quantities without deriving cash savings',async()=>{
    const baseline={turn:structuredClone(turn),receivedAt:'2026-09-06T12:00:00Z'};
    turn={...turn,id:202,logicalRequestId:'different-logical',providerInputTokens:null,stages:turn.stages.map(s=>({...s,deltaBytes:s.deltaBytes+10}))};
    await render(<ContextAttemptComparison turn={turn} baseline={baseline} onBaseline={vi.fn()} onClear={vi.fn()}/>);
    expect(table('Signed shaping comparison').querySelectorAll('tbody tr')).toHaveLength(14);
    expect(table('Signed shaping comparison').textContent).toContain('+10 B');
    expect(table('Attempt measurement comparison').querySelectorAll('tbody tr')[1].textContent).toContain('UnknownUnavailable');
    expect(container.textContent).toContain('no causal relationship asserted');
    expect(container.textContent).toContain('Baseline values are a retained read');
  });
  it('preserves unknown cost versus zero and identifies the exact ledger denominator',async()=>{
    await render(<ContextCostEvidence records={[{ledgerId:9,recordedCostUsd:0,estimatedCostUsd:null,reportedCostUsd:null,costSource:null}]}/>);
    expect(container.textContent).toContain('Recorded amount$0.00');expect(container.textContent).toContain('Rate estimate · USDUnavailable');expect(container.textContent).toContain('Historical zero is ambiguous');
  });
});
