import { beforeEach,expect,it } from 'vitest';
import { GET,PATCH,DELETE } from '@/app/api/pricing/route.js';
import { resetAllPricing } from '@/lib/db/repos/pricingRepo.js';
const patch=body=>PATCH(new Request('http://localhost/api/pricing',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
const reset=query=>DELETE(new Request(`http://localhost/api/pricing${query}`));
beforeEach(()=>resetAllPricing());
it('persists known model rates and resets only the reviewed scope',async()=>{
  expect((await patch({fixture:{a:{input:0,output:4,cached:.2},b:{input:2,output:6}}})).status).toBe(200);
  expect((await (await GET()).json()).fixture.a).toEqual({input:0,output:4,cached:.2});
  expect((await reset('?provider=fixture&model=a')).status).toBe(200);
  expect((await (await GET()).json()).fixture).toEqual({b:{input:2,output:6}});
  expect((await reset('?provider=fixture')).status).toBe(200);
  expect((await (await GET()).json()).fixture).toBeUndefined();
});
it('rejects malformed pricing and ambiguous reset scopes without mutation',async()=>{
  await patch({fixture:{model:{input:2,output:4}}});
  const before=await (await GET()).json();
  for(const body of [[],{}, {fixture:[]},{fixture:{model:[]}},{fixture:{model:{input:-1}}},JSON.parse('{"__proto__":{"model":{"input":1}}}')]) expect((await patch(body)).status).toBe(400);
  for(const query of ['?model=model','?provider=fixture&provider=other','?unknown=all','?provider=']) expect((await reset(query)).status).toBe(400);
  expect(await (await GET()).json()).toEqual(before);
});
