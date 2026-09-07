import { expect,it,vi } from 'vitest';
import { getSettings,updateSettings } from '@/lib/db/repos/settingsRepo.js';
import { createProviderConnection } from '@/lib/db/repos/connectionsRepo.js';
import { PATCH } from '@/app/api/settings/route.js';
const scheduler=vi.hoisted(()=>vi.fn());
vi.mock('@/shared/services/quotaAutoPing',()=>({configureQuotaAutoPing:scheduler}));
const patch=body=>PATCH(new Request('http://localhost/api/settings',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
it('merges per-account opt-ins atomically without replacing siblings or other settings',async()=>{
  await updateSettings({claudeAutoPing:{connections:{retained:true,changed:true}},codexAutoPing:{connections:{other:true}}});
  await Promise.all([updateSettings({claudeAutoPing:{connections:{changed:false}}}),updateSettings({claudeAutoPing:{connections:{newAccount:true}}})]);
  const saved=await getSettings();
  expect(saved.claudeAutoPing.connections).toEqual({retained:true,changed:false,newAccount:true});
  expect(saved.codexAutoPing.connections).toEqual({other:true});
});
it('refuses invalid warming shapes and unsupported accounts before persisting',async()=>{
  const before=await getSettings();
  for (const value of [true,[],{connections:{fixture:'true'}},{connections:[]},{connections:{fixture:true}},{connections:{},interval:1}]) {
    expect((await patch({claudeAutoPing:value})).status).toBe(400);
    expect(await getSettings()).toEqual(before);
  }
  expect(scheduler).not.toHaveBeenCalled();
});
it('reads back exact supported opt-in and disable through the real route without a provider call',async()=>{
  const account=await createProviderConnection({provider:'claude',authType:'oauth',name:'Synthetic warming account'});
  expect((await patch({claudeAutoPing:{connections:{[account.id]:true}}})).status).toBe(200);
  expect((await getSettings()).claudeAutoPing.connections[account.id]).toBe(true);
  expect((await patch({claudeAutoPing:{connections:{[account.id]:false}}})).status).toBe(200);
  expect((await getSettings()).claudeAutoPing.connections[account.id]).toBe(false);
});
