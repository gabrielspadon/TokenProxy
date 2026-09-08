import {it,expect,vi} from 'vitest';
vi.mock('@/lib/db/repos/apiKeysRepo.js',()=>({getExceededLimit:async()=>null}));
import {resolveClientApiKey} from '@/lib/auth/clientApiKey.js';
it('uses the recognized key after invalid first credentials and reuses only admission identity',async()=>{
  let permitted=true;const validate=vi.fn(async key=>permitted && key==='valid-second');
  const request=new Request('http://localhost',{headers:{authorization:'Bearer attacker-varies-this','x-api-key':'valid-second'}});
  const first=await resolveClientApiKey(request,validate,{admission:true});
  expect(first).toMatchObject({apiKey:'valid-second',valid:true});expect(validate).toHaveBeenCalledTimes(2);
  permitted=false;
  expect(await resolveClientApiKey(request,validate,{admission:true})).toEqual(first);expect(validate).toHaveBeenCalledTimes(2);
  expect((await resolveClientApiKey(request,validate)).valid).toBe(false);expect(validate).toHaveBeenCalledTimes(4);
  expect((await resolveClientApiKey(new Request(request),validate,{admission:true})).valid).toBe(false);
});
it('does not share a result between independent validators',async()=>{
  const request=new Request('http://localhost',{headers:{'x-api-key':'synthetic'}});
  expect((await resolveClientApiKey(request,async()=>true,{admission:true})).valid).toBe(true);
  expect((await resolveClientApiKey(request,async()=>false,{admission:true})).valid).toBe(false);
});
