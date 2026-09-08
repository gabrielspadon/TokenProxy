// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EconomicsTools from '@/shared/components/workspace/EconomicsTools';
import EconomicsFilters from '@/shared/components/workspace/EconomicsFilters';

const navigation=vi.hoisted(()=>({setSearch:null,replace:null}));
vi.mock('next/navigation',async()=>{
  const {useState}=await import('react');
  return {useRouter:()=>({replace:navigation.replace}),useSearchParams:()=>{
    const [search,setSearch]=useState(window.location.search);navigation.setSearch=setSearch;
    return new URLSearchParams(search);
  }};
});
let root,host,fetcher;
function Surface(){
  const [filters,setFilters]=useState({});
  return <EconomicsTools filters={<EconomicsFilters value={filters} onChange={setFilters}/>} filterCount={Object.keys(filters).length}><section aria-label="Recorded analysis">Captured costs {filters.requestId || 'all requests'}</section></EconomicsTools>;
}
const button=label=>[...host.querySelectorAll('button')].find(node=>node.textContent===label);
const field=label=>host.querySelector(`#${[...host.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor}`);
async function click(label){await act(async()=>button(label).click());}
async function input(label,value){await act(async()=>{const node=field(label);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});}
beforeEach(()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  window.matchMedia=vi.fn(()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  window.history.replaceState({},'','/dashboard/usage?fixture=keep');
  navigation.replace=vi.fn(url=>{window.history.replaceState({},'',url);navigation.setSearch(window.location.search);});
  fetcher=vi.fn(async url=>Response.json(url==='/api/keys'?{keys:[]}:{fixture:{model:{input:2,output:4}}}));vi.stubGlobal('fetch',fetcher);
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it('offers one task-tab level, preserving analytics, query scope, and pricing drafts across tabs',async()=>{
  await act(async()=>root.render(<MantineProvider env="test"><Surface/></MantineProvider>));
  const analysis=host.querySelector('[aria-label="Recorded analysis"]');
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.querySelectorAll('[role=tab]')).toHaveLength(4);
  await click('Pricing');
  expect(field('Pricing provider').closest('[role=tabpanel]').style.display).not.toBe('none');
  await input('Pricing provider','fixture');await input('Pricing model','model');await input('Input USD / million tokens','7');
  const pricingInput=field('Input USD / million tokens');
  await click('Budget reservations');await click('Analysis');
  expect(host.querySelector('[aria-label="Recorded analysis"]')).toBe(analysis);
  expect(analysis.closest('[role=tabpanel]').style.display).not.toBe('none');
  expect(new URLSearchParams(window.location.search).get('fixture')).toBe('keep');
  expect(new URLSearchParams(window.location.search).has('tool')).toBe(false);
  await click('Pricing');expect(field('Input USD / million tokens')).toBe(pricingInput);expect(pricingInput.value).toBe('7');
  expect(host.querySelector('[role=dialog]')).toBeNull();
  expect(fetcher.mock.calls.every(([,options])=>!options?.method)).toBe(true);
});
it('keeps identity fields direct and retains unapplied edits until Apply or Discard',async()=>{
  await act(async()=>root.render(<MantineProvider env="test"><Surface/></MantineProvider>));
  await click('Identity filters');
  const request=field('Exact request ID');expect(request.closest('[role=tabpanel]').style.display).not.toBe('none');
  await input('Exact request ID','retained-request');
  await click('Analysis');expect(host.querySelector('[aria-label="Recorded analysis"]').textContent).toContain('all requests');
  await click('Identity filters');expect(field('Exact request ID')).toBe(request);expect(request.value).toBe('retained-request');
  await click('Apply filters');expect(host.querySelector('[aria-label="Recorded analysis"]').textContent).toContain('retained-request');
  await input('Exact request ID','unapplied');await click('Discard filter draft');expect(request.value).toBe('retained-request');expect(document.activeElement).toBe(request);
  await click('Clear identity filters');expect(request.value).toBe('');
  expect(host.querySelector('details')).toBeNull();expect(host.querySelector('[role=dialog]')).toBeNull();expect(fetcher).not.toHaveBeenCalled();
});
