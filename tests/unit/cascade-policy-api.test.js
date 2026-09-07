import { beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({deny:null,get:vi.fn(),replace:vi.fn()}));
vi.mock('@/lib/admin/guard',()=>({requireAdmin:vi.fn(async()=>state.deny)}));
vi.mock('@/lib/db/repos/cascadePolicyRepo.js',async importOriginal=>({...await importOriginal(),getCascadePolicy:state.get,replaceCascadePolicy:state.replace}));
const {GET,PUT}=await import('../../src/app/api/routing-cascade/route.js');
beforeEach(()=>{state.deny=null;state.get.mockReset().mockResolvedValue({pairs:[]});state.replace.mockReset().mockResolvedValue({receipt:{outcome:'applied'}});});
it('returns the route-local admin refusal before reads, parsing or writes',async()=>{
  state.deny=new Response('operator required',{status:403});
  expect((await GET({})).status).toBe(403);
  expect((await PUT({text:()=>{throw Error('must not parse')}})).status).toBe(403);
  expect(state.get).not.toHaveBeenCalled();expect(state.replace).not.toHaveBeenCalled();
});
it('validates bounded fields before repository mutation',async()=>{
  for(const text of ['bad','null','[]','{"pairs":[],"extra":true}',' '.repeat(70001)]) {
    const response=await PUT({text:async()=>text});expect(response.status).toBeGreaterThanOrEqual(400);
  }
  expect(state.replace).not.toHaveBeenCalled();
  expect((await PUT({text:async()=>JSON.stringify({pairs:[],expectedRevision:'a'.repeat(64)})})).status).toBe(200);
  expect(state.replace).toHaveBeenCalledOnce();
});
