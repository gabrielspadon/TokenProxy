// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoryRetention } from '../../src/shared/components/context-workspace/HistoryRetention';
let container, root, current, fetchMock, onSaved, failure;
const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} });
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  current={statsRetentionMode:'preserve',statsRetentionDays:45}; failure=null; onSaved=vi.fn();
  fetchMock=vi.fn(async (url,options={})=>{
    if(options.method==='PATCH'){
      if(failure==='refused')return response({error:'Permission refused'},403);
      if(failure!=='mismatch')current={...current,...JSON.parse(options.body)};
      return response(current);
    }
    if(failure==='read')return response({error:'Read unavailable'},503);
    return response(current);
  });
  vi.stubGlobal('fetch',fetchMock);
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
const button=text=>[...document.querySelectorAll('button')].find(node=>node.textContent===text);
async function click(text){await act(async()=>button(text).click());}
async function open(){await act(async()=>root.render(<MantineProvider env="test"><HistoryRetention onSaved={onSaved}/></MantineProvider>));}
async function mode(value){await act(async()=>{const select=document.querySelector('select');select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});}
async function acknowledge(){await act(async()=>document.querySelector('input[type="checkbox"]').click());}
it('shows the stored policy directly without a modal or an implicit write',async()=>{
  await act(async()=>root.render(<MantineProvider env="test"><HistoryRetention onSaved={onSaved}/></MantineProvider>));
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(document.querySelector('[aria-label="History retention settings"]')).not.toBeNull();
  expect(document.querySelector('select').value).toBe('preserve');
  expect(document.body.textContent).toContain('Previously deleted records cannot be recovered');
  expect(fetchMock.mock.calls.every(([,options])=>options?.method!=='PATCH')).toBe(true);
});
it('requires explicit deletion acknowledgement and verifies persisted policy before reporting success',async()=>{
  await open();await mode('window');
  expect(document.body.textContent).toContain('regardless of the current filters');
  expect(document.body.textContent).toContain('Usage history and the Economics ledger remain');
  expect(button('Save history policy').disabled).toBe(true);
  await acknowledge();await click('Save history policy');
  const writes=fetchMock.mock.calls.filter(([,options])=>options?.method==='PATCH');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1].body)).toEqual({statsRetentionMode:'window',statsRetentionDays:45});
  expect(fetchMock.mock.calls.at(-1)).toEqual(['/api/settings',{cache:'no-store'}]);
  expect(onSaved).toHaveBeenCalledOnce();expect(document.body.textContent).toContain('45-day retention saved and verified');
});
it.each(['refused','mismatch'])('retains the opt-in draft after %s without claiming persistence',async(kind)=>{
  await open();await mode('window');await acknowledge();failure=kind;await click('Save history policy');
  expect(onSaved).not.toHaveBeenCalled();expect(document.querySelector('select').value).toBe('window');
  expect(document.body.textContent).toContain('Retention save not verified');
});
it('fails closed on the initial settings read and allows a read retry',async()=>{
  failure='read';await open();expect(button('Save history policy')).toBeUndefined();
  expect(document.body.textContent).toContain('History policy unavailable');failure=null;await click('Try again');expect(document.querySelector('select').value).toBe('preserve');
});
it('saves preservation without requiring deletion acknowledgement',async()=>{
  current={statsRetentionMode:'window',statsRetentionDays:30};await open();await mode('preserve');await click('Save history policy');
  expect(current).toEqual({statsRetentionMode:'preserve',statsRetentionDays:30});
  expect(document.body.textContent).toContain('History preserved. Policy saved and verified.');
});
it('requires renewed acknowledgement after changing the selected policy',async()=>{
  await open();await mode('window');await acknowledge();expect(button('Save history policy').disabled).toBe(false);
  await mode('preserve');await mode('window');expect(button('Save history policy').disabled).toBe(true);
});
it('reads current policy without discarding a draft and returns focus after an explicit discard',async()=>{
  await open();await mode('window');await acknowledge();
  current={statsRetentionMode:'preserve',statsRetentionDays:90};
  await click('Read current policy');
  expect(document.querySelector('select').value).toBe('window');
  expect(document.querySelector('input[type="text"]').value).toBe('45');
  expect(button('Save history policy').disabled).toBe(true);
  await click('Discard');
  expect(document.querySelector('select').value).toBe('preserve');
  expect(document.querySelector('input[type="text"]').value).toBe('90');
  expect(document.activeElement).toBe(document.querySelector('select'));
  expect(fetchMock.mock.calls.some(([,options])=>options?.method==='PATCH')).toBe(false);
});
it('fails closed on incomplete stored policy instead of inventing a default',async()=>{
  current={statsRetentionMode:'preserve'};await open();
  expect(document.body.textContent).toContain('No default policy was substituted');
  expect(document.querySelector('select')).toBeNull();
  expect(button('Save history policy')).toBeUndefined();
});
