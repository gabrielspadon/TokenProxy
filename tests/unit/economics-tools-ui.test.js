// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import PricingEditor from '@/shared/components/workspace/PricingEditor';
import BudgetReservations from '@/shared/components/workspace/BudgetReservations';
let root,host;
const button=label=>[...host.querySelectorAll('button')].find(node=>node.textContent===label);
const field=label=>host.querySelector(`#${[...host.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor}`);
async function input(label,value){await act(async()=>{const node=field(label);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});}
const mount=component=>act(async()=>root.render(<MantineProvider env="test">{component}</MantineProvider>));
beforeEach(()=>{globalThis.IS_REACT_ACT_ENVIRONMENT=true;vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});window.matchMedia=vi.fn(()=>({matches:false,addEventListener(){},removeEventListener(){}}));host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it('retains the pricing draft after refusal, then verifies a confirmed write by separate readback',async()=>{
  let stored={fixture:{model:{input:2,output:4}}}, refuse=true;
  const fetcher=vi.fn(async(url,options)=>{if(options?.method==='PATCH'){if(refuse)return Response.json({error:'Changed by another operator'},{status:409});stored=JSON.parse(options.body);}return Response.json(stored);});
  vi.stubGlobal('fetch',fetcher);await mount(<PricingEditor/>);
  await input('Pricing provider','fixture');await input('Pricing model','model');await input('Input USD / million tokens','3');
  await act(async()=>button('Review pricing change').click());expect(host.textContent).toContain('Replace the model override for fixture/model');
  await act(async()=>button('Confirm pricing change').click());expect(host.textContent).toContain('Changed by another operator');expect(field('Input USD / million tokens').value).toBe('3');
  refuse=false;await act(async()=>button('Confirm pricing change').click());
  expect(host.textContent).toContain('Stored pricing read back successfully');expect(stored.fixture.model.input).toBe(3);
  expect(fetcher.mock.calls.at(-1)[1].method).toBeUndefined();
});
it('reviews exact reservation reconciliation and retains the draft after a refused write',async()=>{
  const reservation={apiKeyId:'fixture-key',requestId:'fixture-request',state:'uncertain',reservedPromptTokens:100,reservedCompletionTokens:50,reservedCostUsd:null};
  const fetcher=vi.fn(async(url,options)=>url==='/api/keys'?Response.json({keys:[{id:'fixture-key',name:'Synthetic'}]}):options?.method==='POST'?Response.json({error:'The original attempt is unavailable'},{status:400}):Response.json({apiKeyId:'fixture-key',basis:'lifetime-application-ledger',policy:'strict',outstanding:{requests:1,promptTokens:100,completionTokens:50,costUsd:0},reservations:[reservation]}));
  vi.stubGlobal('fetch',fetcher);await mount(<BudgetReservations/>);
  await input('Budget client key ID','fixture-key');await act(async()=>button('Read budget').click());await act(async()=>button('fixture-request').click());
  await input('Nonsecret evidence reference','receipt-42');await input('Input tokens','120');await input('Output tokens','20');
  await act(async()=>button('Review reservation resolution').click());await act(async()=>button('Confirm reservation resolution').click());
  const write=fetcher.mock.calls.find(([,options])=>options?.method==='POST');
  expect(JSON.parse(write[1].body)).toEqual({apiKeyId:'fixture-key',requestId:'fixture-request',evidence:{kind:'provider-usage',reference:'receipt-42',tokens:{input_tokens:120,output_tokens:20}}});
  expect(host.textContent).toContain('The original attempt is unavailable');expect(field('Nonsecret evidence reference').value).toBe('receipt-42');expect(field('Input tokens').value).toBe('120');
});
it('keeps separate pricing drafts when provider and model choices change',async()=>{
  const fetcher=vi.fn(async()=>Response.json({fixture:{model:{input:2,output:4},other:{input:8,output:9}}}));
  vi.stubGlobal('fetch',fetcher);await mount(<PricingEditor/>);
  await input('Pricing provider','fixture');await input('Pricing model','model');await input('Input USD / million tokens','3');
  await input('Pricing model','other');expect(field('Input USD / million tokens').value).toBe('8');
  await input('Input USD / million tokens','12');await input('Pricing model','model');
  expect(field('Input USD / million tokens').value).toBe('3');
  await act(async()=>button('Read current pricing').click());expect(field('Input USD / million tokens').value).toBe('3');
  await act(async()=>button('Discard pricing draft').click());expect(field('Input USD / million tokens').value).toBe('2');
  await input('Pricing model','other');expect(field('Input USD / million tokens').value).toBe('12');
  expect(fetcher.mock.calls.every(([,options])=>!options?.method)).toBe(true);
});
it('reads a known budget key directly and preserves exact reservation drafts across reads and keys',async()=>{
  const budget=key=>({apiKeyId:key,basis:'lifetime-application-ledger',outstanding:{requests:2},reservations:['request-one','request-two'].map(requestId=>({apiKeyId:key,requestId,state:'uncertain'}))});
  const fetcher=vi.fn(async url=>url==='/api/keys'?Response.json({keys:[{id:'key-one',name:'Human name'},{id:'key-two',name:'Other name'}]}):Response.json(budget(new URL(url,'http://test.local').searchParams.get('apiKeyId'))));
  vi.stubGlobal('fetch',fetcher);await mount(<BudgetReservations/>);
  await input('Budget client key ID','key-one');
  expect(fetcher.mock.calls.filter(([url])=>url.startsWith('/api/admin/budgets'))).toHaveLength(1);
  expect(field('Budget client key ID').value).toBe('key-one');
  await act(async()=>button('request-one').click());await input('Nonsecret evidence reference','receipt-one');await input('Input tokens','0');
  await act(async()=>button('request-two').click());expect(field('Nonsecret evidence reference').value).toBe('');
  await act(async()=>button('request-one').click());expect(field('Nonsecret evidence reference').value).toBe('receipt-one');
  await act(async()=>button('Read budget').click());expect(field('Input tokens').value).toBe('0');
  await input('Budget client key ID','key-two');await act(async()=>button('request-one').click());expect(field('Nonsecret evidence reference').value).toBe('');
  await input('Budget client key ID','key-one');await act(async()=>button('request-one').click());expect(field('Nonsecret evidence reference').value).toBe('receipt-one');
  expect(fetcher.mock.calls.every(([,options])=>!options?.method)).toBe(true);
});
it('settles only after final confirmation and a separate matching budget readback',async()=>{
  let reservation={apiKeyId:'key',requestId:'request',state:'uncertain'};
  const fetcher=vi.fn(async(url,options)=>{
    if(url==='/api/keys')return Response.json({keys:[]});
    if(options?.method==='POST'){reservation={...reservation,state:'settled',actualPromptTokens:0,actualCompletionTokens:12,resolutionEvidence:'receipt'};return Response.json({reservation});}
    return Response.json({apiKeyId:'key',reservations:[reservation]});
  });
  vi.stubGlobal('fetch',fetcher);await mount(<BudgetReservations/>);await input('Budget client key ID','key');
  expect(fetcher.mock.calls).toHaveLength(1);
  await act(async()=>button('Read budget').click());await act(async()=>button('request').click());
  await input('Nonsecret evidence reference','receipt');await input('Input tokens','0');await input('Output tokens','12');
  await act(async()=>button('Review reservation resolution').click());
  expect(fetcher.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false);
  await act(async()=>button('Confirm reservation resolution').click());
  expect(fetcher.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
  expect(fetcher.mock.calls.at(-1)[1].method).toBeUndefined();
  expect(host.textContent).toContain('Reservation request read back as settled');
});
