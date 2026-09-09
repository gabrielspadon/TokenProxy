import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
let repo,adapter;const previous=process.env.DATA_DIR;const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tokenproxy-refresh-cas-'));
beforeAll(async()=>{process.env.DATA_DIR=directory;global._dbAdapter={instance:null,initPromise:null,logged:false};vi.resetModules();await (await import('@/lib/db/index.js')).initDb();repo=await import('@/lib/db/repos/connectionsRepo.js');adapter=await (await import('@/lib/db/driver.js')).getAdapter();});
afterAll(()=>{adapter?.close?.();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;fs.rmSync(directory,{recursive:true,force:true});});
const create=()=>repo.createProviderConnection({provider:'codex',authType:'oauth',name:'Synthetic refresh',accessToken:'old',refreshToken:'one-use',providerSpecificData:{strictProxy:true}});
describe('atomic credential revision guard',()=>{
 it.each([{accessToken:'operator'},{refreshToken:'rotated'},{isActive:false},{providerSpecificData:{connectionProxyUrl:'http://synthetic.invalid'}}])('rejects a late credential write after state changes %#',async patch=>{
  const before=await create();const winner=await repo.updateProviderConnection(before.id,patch);
  await expect(repo.updateProviderConnection(before.id,{accessToken:'late',refreshToken:'late'},{expectedCredentials:before})).rejects.toMatchObject({code:'CREDENTIAL_CONFLICT'});
  expect(await repo.getProviderConnectionById(before.id)).toEqual(winner);
 });
 it('allows unrelated name edits and preserves provider fields while applying a valid rotation',async()=>{
  const before=await create();await repo.updateProviderConnection(before.id,{name:'Renamed'});
  const after=await repo.updateProviderConnection(before.id,{accessToken:'fresh',refreshToken:'rotated'},{expectedCredentials:before});
  expect(after.name).toBe('Renamed');expect(after.providerSpecificData).toEqual(before.providerSpecificData);expect(after.refreshToken).toBe('rotated');
 });
 it('checks cancellation inside the transaction and leaves the row unchanged',async()=>{
  const created=await create(),before=await repo.getProviderConnectionById(created.id),controller=new AbortController();controller.abort();
  await expect(repo.updateProviderConnection(before.id,{accessToken:'late'},{expectedCredentials:before,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});expect(await repo.getProviderConnectionById(before.id)).toEqual(before);
 });
});

it('refuses token A to B to A and never trusts an injected revision ID',async()=>{
 const before=await create();await repo.updateProviderConnection(before.id,{accessToken:'intermediate'});
 const restored=await repo.updateProviderConnection(before.id,{accessToken:before.accessToken,credentialRevisionId:before.credentialRevisionId});
 expect(restored.credentialRevisionId).not.toBe(before.credentialRevisionId);
 await expect(repo.updateProviderConnection(before.id,{accessToken:'late'},{expectedCredentials:before})).rejects.toMatchObject({code:'CREDENTIAL_CONFLICT'});
 const named=await repo.updateProviderConnection(before.id,{name:'Name only',credentialRevisionId:'injected'});
 expect(named.credentialRevisionId).toBe(restored.credentialRevisionId);
});

it('invalidates revisions through reauthorization and same-account creation upserts',async()=>{
 const before=await repo.createProviderConnection({provider:'codex',authType:'oauth',email:'synthetic@example.invalid',providerSpecificData:{chatgptAccountId:'synthetic-workspace'},accessToken:'a',refreshToken:'r'});
 const updated=await repo.createProviderConnection({provider:'codex',authType:'oauth',email:'synthetic@example.invalid',providerSpecificData:{chatgptAccountId:'synthetic-workspace'},accessToken:'b',refreshToken:'s'});
 expect(updated.id).toBe(before.id);expect(updated.credentialRevisionId).not.toBe(before.credentialRevisionId);
 const authorized=await repo.reauthorizeProviderConnection(before.id,{accessToken:'a',refreshToken:'r'});
 expect(authorized.ok).toBe(true);expect(authorized.connection.credentialRevisionId).not.toBe(updated.credentialRevisionId);
 await expect(repo.updateProviderConnection(before.id,{accessToken:'late'},{expectedCredentials:before})).rejects.toMatchObject({code:'CREDENTIAL_CONFLICT'});
});
it('invalidates pool transport and strictness revisions, preserving revisions on unrelated pool edits',async()=>{
 const pools=await import('@/lib/db/repos/proxyPoolsRepo.js');
 const pool=await pools.createProxyPool({name:'Synthetic',proxyUrl:'http://proxy-a.invalid',strictProxy:false,isActive:true});
 const before=await repo.createProviderConnection({provider:'codex',authType:'oauth',accessToken:'a',refreshToken:'r',providerSpecificData:{proxyPoolId:pool.id,strictProxy:false}});
 await pools.updateProxyPool(pool.id,{name:'Renamed'});expect((await repo.getProviderConnectionById(before.id)).credentialRevisionId).toBe(before.credentialRevisionId);
 await pools.updateProxyPoolWithBoundSnapshots(pool.id,{strictProxy:true});await pools.updateProxyPoolWithBoundSnapshots(pool.id,{strictProxy:false});
 const restored=await repo.getProviderConnectionById(before.id);expect(restored.credentialRevisionId).not.toBe(before.credentialRevisionId);
 await pools.updateProxyPool(pool.id,{proxyUrl:'http://proxy-b.invalid'});const moved=await repo.getProviderConnectionById(before.id);expect(moved.credentialRevisionId).not.toBe(restored.credentialRevisionId);
 await pools.deleteProxyPool(pool.id);expect((await repo.getProviderConnectionById(before.id)).credentialRevisionId).not.toBe(moved.credentialRevisionId);
 await expect(repo.updateProviderConnection(before.id,{accessToken:'late'},{expectedCredentials:before})).rejects.toMatchObject({code:'CREDENTIAL_CONFLICT'});
});
it('never imports a trusted credential revision even when restoring identical bytes',async()=>{
 const before=await create();await (await import('@/lib/db/index.js')).importDb({providerConnections:[before]});
 const imported=await repo.getProviderConnectionById(before.id);expect(imported.accessToken).toBe(before.accessToken);expect(imported.credentialRevisionId).not.toBe(before.credentialRevisionId);
 await expect(repo.updateProviderConnection(before.id,{accessToken:'late'},{expectedCredentials:before})).rejects.toMatchObject({code:'CREDENTIAL_CONFLICT'});
});
