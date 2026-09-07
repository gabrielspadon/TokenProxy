// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { CapacityControls } from '@/app/dashboard/CapacityControls';

let host, root;
const accounts = [{connectionId:'capacity-fixture-a',displayName:'Research'},{connectionId:'capacity-fixture-b',displayName:'Batch'}];
const drains = { data:{connections:accounts.map(account=>({...account,version:`v-${account.connectionId}`,isDraining:false,activeStreams:0}))} };
const button = text => [...document.querySelectorAll('button')].find(node=>node.textContent===text);
const mount = props => act(()=>root.render(<MantineProvider env="test"><CapacityControls accounts={accounts} drains={drains} {...props}/></MantineProvider>));
beforeEach(()=>{
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  window.matchMedia=vi.fn().mockImplementation(()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  host=document.createElement('div'); document.body.append(host); root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});

describe('reviewed Capacity controls',()=>{
  it('names the exact scope and keeps a confirmed save separate from a stale account refusal',async()=>{
    const saved={connectionId:accounts[0].connectionId,isDraining:true,version:'saved-a'};
    const request=vi.fn().mockResolvedValueOnce(Response.json(saved))
      .mockResolvedValueOnce(Response.json({connections:[saved]}))
      .mockResolvedValueOnce(Response.json({error:{message:'Batch changed since review'}},{status:412}));
    vi.stubGlobal('fetch',request);
    const onChanged=vi.fn();mount({onChanged});
    act(()=>button('Review drain for 2 accounts').click());
    const dialog=document.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain('Each account is saved separately');
    expect(dialog.textContent).toContain('capacity-fixture-a');expect(dialog.textContent).toContain('capacity-fixture-b');
    expect(dialog.textContent).toContain('active streams are not cancelled');
    await act(async()=>button('Apply drain').click());
    const outcomes=dialog.querySelector('[aria-label="Per-account drain outcomes"]');
    expect(outcomes.textContent).toContain('Research');expect(outcomes.textContent).toContain('saved state read back');
    expect(outcomes.textContent).toContain('Batch');expect(outcomes.textContent).toContain('Batch changed since review');
    expect(button('Apply drain').disabled).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);expect(onChanged).toHaveBeenCalledOnce();
  });
  it('does not offer a mutation without current versions',()=>{
    const request=vi.fn();vi.stubGlobal('fetch',request);mount({drains:{data:{connections:[]}}});
    expect(button('Review drain for 2 accounts').disabled).toBe(true);
    expect(host.textContent).toContain('Current drain versions are unavailable');expect(request).not.toHaveBeenCalled();
  });
});
