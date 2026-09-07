import { beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({aliases:{},disabled:{},set:vi.fn()}));
vi.mock('@/models',()=>({getModelAliases:async()=>state.aliases,setModelAlias:state.set}));
vi.mock('@/lib/disabledModelsDb',()=>({getDisabledModels:async()=>state.disabled}));
vi.mock('@/shared/constants/config',()=>({AI_MODELS:[{provider:'openai',model:'gpt-4o'}]}));
vi.mock('open-sse/providers/capabilities.js',()=>({getCapabilitiesForModel:()=>({})}));
const {GET,PUT}=await import('../../src/app/api/models/route.js');
beforeEach(()=>{state.aliases={};state.disabled={};state.set.mockReset();});
it('projects all direct aliases from alias-to-target storage with deterministic primary spelling',async()=>{
  state.aliases={fast:'openai/gpt-4o',backup:{provider:'openai',model:'gpt-4o'},unrelated:'openai/other'};
  const value=await(await GET()).json();
  expect(value.models[0]).toMatchObject({alias:'backup',aliases:['backup','fast'],fullModel:'openai/gpt-4o'});
});
it('writes in alias-to-target order and refuses reuse for another target',async()=>{
  const request=(model,alias)=>({json:async()=>({model,alias})});
  expect((await PUT(request('openai/gpt-4o','fast'))).status).toBe(200);
  expect(state.set).toHaveBeenCalledWith('fast','openai/gpt-4o');
  state.aliases={fast:'openai/other'};
  expect((await PUT(request('openai/gpt-4o','fast'))).status).toBe(400);
  expect(state.set).toHaveBeenCalledTimes(1);
});
it('uses the real global disabled policy, retaining account overrides for account admission',async()=>{
  state.disabled={openai:['gpt-4o'],'openai::account-a':[]};
  expect((await(await GET()).json()).models).toEqual([]);
  state.disabled={'openai::account-a':['gpt-4o']};
  expect((await(await GET()).json()).models).toHaveLength(1);
});
