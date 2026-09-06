import { beforeEach, expect, it, vi } from 'vitest';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../open-sse/utils/proxyFetch.js',()=>({proxyAwareFetch:fetchMock}));
import { BaseExecutor } from '../../open-sse/executors/base.js';
import { DefaultExecutor } from '../../open-sse/executors/default.js';
beforeEach(()=>{fetchMock.mockReset();});
const options={model:'fixture',body:{messages:[]},stream:false,credentials:{apiKey:'mock'}};
function executor(){return new BaseExecutor('fixture',{baseUrl:'https://fixture.invalid/chat',retry:{503:{attempts:0,delayMs:0}}});}
it('crosses admission, exact wire send and response observation in order',async()=>{
 const events=[];const response=Response.json({ok:true});
 fetchMock.mockImplementation(async(url,options)=>{events.push(['wire',url,options.body]);return response;});
 const result=await executor().execute({...options,beforeDispatch:async wire=>events.push(['before',wire.url,wire.serialized]),afterDispatch:async r=>events.push(['after',r.response.status])});
 expect(result.response).toBe(response);
 expect(events.map(e=>e[0])).toEqual(['before','wire','after']);
 expect(events[0].slice(1)).toEqual(events[1].slice(1));
});
it('a rejected admission causes zero transport calls and no response callback',async()=>{
 const afterDispatch=vi.fn();
 await expect(executor().execute({...options,beforeDispatch:async()=>{throw new Error('budget rejected');},afterDispatch})).rejects.toThrow('budget rejected');
 expect(fetchMock).not.toHaveBeenCalled();expect(afterDispatch).not.toHaveBeenCalled();
});
it('overridden execute cannot silently inherit the Base coverage claim',()=>{
 class HiddenTransport extends BaseExecutor { async execute(){return null;} }
 expect(executor().supportsBudgetDispatch).toBe(true);
 expect(new HiddenTransport('fixture',{}).supportsBudgetDispatch).toBe(false);
 expect(new DefaultExecutor('fixture',{}).supportsBudgetDispatch).toBe(true);
});
