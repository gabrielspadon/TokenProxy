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
