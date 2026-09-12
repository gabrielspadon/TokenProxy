import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
vi.mock('@/lib/localDb',()=>({getProviderConnectionById:vi.fn(),updateProviderConnection:vi.fn()}));
vi.mock('open-sse/services/oauthCredentialManager.js',async original=>({...await original(),refreshProviderCredentials:vi.fn(),shouldRefreshCredentials:vi.fn(()=>true)}));
vi.mock('open-sse/services/projectId.js',()=>({getProjectIdForConnection:vi.fn(),removeConnection:vi.fn()}));
import {getProviderConnectionById,updateProviderConnection} from '@/lib/localDb';
import {refreshProviderCredentials} from 'open-sse/services/oauthCredentialManager.js';
import {waitForRefresh} from 'open-sse/services/tokenRefresh/credentialRevision.js';
import {getProjectIdForConnection} from 'open-sse/services/projectId.js';
import {checkAndRefreshToken} from '@/sse/services/tokenRefresh.js';
import {createTransactionController} from '@/lib/db/adapters/criticalTransaction.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const original={id:'synthetic',provider:'codex',authType:'oauth',isActive:true,accessToken:'old',refreshToken:'one-use',providerSpecificData:{strictProxy:true}};
beforeEach(()=>{vi.clearAllMocks();getProviderConnectionById.mockResolvedValue(original);updateProviderConnection.mockResolvedValue(original);});

const adapterFixtures=[];
afterEach(()=>{while(adapterFixtures.length){const {adapter,dir}=adapterFixtures.pop();adapter.close();rmSync(dir,{recursive:true,force:true});}});
async function nativeAdapter(kind){
 const dir=mkdtempSync(join(tmpdir(),`tokenproxy-critical-${kind}-`));
 const file=join(dir,'data.sqlite');
 const adapter=kind==='node'
  ? await (await import('@/lib/db/adapters/nodeSqliteAdapter.js')).createNodeSqliteAdapter(file)
  : (await import('@/lib/db/adapters/betterSqliteAdapter.js')).createBetterSqliteAdapter(file);
 adapterFixtures.push({adapter,dir});
 adapter.exec('CREATE TABLE critical_probe(id INTEGER PRIMARY KEY,value TEXT)');
 return adapter;
}

describe.each(['node','better'])('native %s critical transaction boundary',kind=>{
 it('uses FULL for the outer commit and restores the exact prior mode',async()=>{
  const db=await nativeAdapter(kind);
  expect(db.get('PRAGMA synchronous').synchronous).toBe(1);
  const result=db.criticalTransaction(()=>{
   expect(db.get('PRAGMA synchronous').synchronous).toBe(2);
   db.run('INSERT INTO critical_probe(id,value) VALUES(1,?)',['acknowledged']);
   return 'committed';
  });
  expect(result).toBe('committed');
  expect(db.get('PRAGMA synchronous').synchronous).toBe(1);
  expect(db.get('SELECT value FROM critical_probe WHERE id=1')).toEqual({value:'acknowledged'});
 });
 it('preserves EXTRA and rejects async or nested callbacks without committing',async()=>{
  const db=await nativeAdapter(kind);
  db.exec('PRAGMA synchronous=EXTRA');
  expect(()=>db.criticalTransaction(()=>db.transaction(()=>{}))).toThrowError(expect.objectContaining({code:'CRITICAL_TRANSACTION_NESTED'}));
  expect(()=>db.transaction(()=>db.criticalTransaction(()=>{}))).toThrowError(expect.objectContaining({code:'CRITICAL_TRANSACTION_NESTED'}));
  let callbackStarted=false;
  expect(()=>db.criticalTransaction(async()=>{
   callbackStarted=true;
   await Promise.resolve();
   db.run('INSERT INTO critical_probe(id,value) VALUES(1,?)',['must-never-run']);
  })).toThrowError(expect.objectContaining({code:'CRITICAL_TRANSACTION_ASYNC'}));
  await Promise.resolve();
  expect(callbackStarted).toBe(false);
  expect(db.get('SELECT value FROM critical_probe WHERE id=1')).toBeUndefined();
  expect(db.get('PRAGMA synchronous').synchronous).toBe(3);
 });
});

describe('critical transaction verification',()=>{
 it.each([null,false,true,'1','2'])('rejects non-numeric synchronous state %#',value=>{
  const exec=vi.fn();
  const db=createTransactionController({exec,readSynchronous:()=>value,isInTransaction:()=>false});
  expect(()=>db.criticalTransaction(()=>{})).toThrowError(expect.objectContaining({code:'CRITICAL_TRANSACTION_SYNC_UNVERIFIED'}));
  expect(exec).not.toHaveBeenCalled();
 });
});
describe('refresh persistence revision and stop boundary',()=>{
 it('preserves the selected command transport only while its account snapshot remains current',async()=>{
  refreshProviderCredentials.mockResolvedValue(null);
  const selected={...original,_connection:original,providerSpecificData:{...original.providerSpecificData,connectionProxyEnabled:true,connectionProxyUrl:'http://synthetic-command.invalid:8080'}};
  await checkAndRefreshToken('codex',selected,{force:true});
  expect(refreshProviderCredentials.mock.calls[0][1].providerSpecificData.connectionProxyUrl).toBe('http://synthetic-command.invalid:8080');
  getProviderConnectionById.mockResolvedValue({...original,credentialRevisionId:'operator-revision'});
  await checkAndRefreshToken('codex',selected,{force:true});
  expect(refreshProviderCredentials.mock.calls[1][1].providerSpecificData.connectionProxyUrl).toBeUndefined();
 });
 it('supplies the initiating persisted revision to the atomic writer',async()=>{
  refreshProviderCredentials.mockImplementation(async(_provider,_credentials,_log,options)=>options.onCredentialsRefreshed({accessToken:'new',refreshToken:'rotated'},{expectedCredentials:options.expectedCredentials}));
  await checkAndRefreshToken('codex',original,{force:true});
  expect(updateProviderConnection.mock.calls[0][2].expectedCredentials).toEqual(original);
  expect(updateProviderConnection.mock.calls[0][2].durability).toBe('critical');
 });
 it('returns the winning operator revision on conflict without continuing with stale tokens',async()=>{
  const winner={...original,accessToken:'operator',refreshToken:'operator-rotation'};
  refreshProviderCredentials.mockImplementation(async(_provider,_credentials,_log,options)=>options.onCredentialsRefreshed({accessToken:'late',refreshToken:'late-rotation'},{expectedCredentials:options.expectedCredentials}));
  updateProviderConnection.mockImplementation(async()=>{getProviderConnectionById.mockResolvedValue(winner);throw Object.assign(new Error('conflict'),{code:'CREDENTIAL_CONFLICT'});});
  await expect(checkAndRefreshToken('codex',original,{force:true})).resolves.toMatchObject({
   ...winner,
   connectionId:winner.id,
   _connection:winner,
  });
  expect(updateProviderConnection).toHaveBeenCalledTimes(1);
 });
 it('rejects a visible candidate when COMMIT acknowledgement is uncertain',async()=>{
  let visible=original;
  getProviderConnectionById.mockImplementation(async()=>visible);
  refreshProviderCredentials.mockImplementation(async(_provider,_credentials,_log,options)=>options.onCredentialsRefreshed(
   {accessToken:'visible-but-unacknowledged',refreshToken:'rotated'},
   {expectedCredentials:options.expectedCredentials},
  ));
  updateProviderConnection.mockImplementation(async(_id,updates)=>{
   visible={...original,...updates,credentialRevisionId:'visible-revision'};
   throw Object.assign(new Error('commit result uncertain'),{
    code:'CRITICAL_TRANSACTION_COMMIT_UNCERTAIN',
    commitState:'uncertain',
   });
  });
  await expect(checkAndRefreshToken('codex',original,{force:true})).rejects.toMatchObject({
   code:'CREDENTIAL_PERSISTENCE_UNCONFIRMED',
  });
  expect(visible.accessToken).toBe('visible-but-unacknowledged');
 });
 it('persists a refresh completing after consumer cancellation',async()=>{
  const controller=new AbortController(),d=deferred();refreshProviderCredentials.mockImplementation((_provider,_credentials,_log,options)=>waitForRefresh(d.promise.then(value=>options.onCredentialsRefreshed(value,{expectedCredentials:options.expectedCredentials})),options.signal));
  const call=checkAndRefreshToken('codex',original,{force:true,signal:controller.signal});await flush();
  controller.abort();await expect(call).rejects.toMatchObject({name:'AbortError'});d.resolve({accessToken:'late'});await flush();expect(updateProviderConnection).toHaveBeenCalledTimes(1);
 });
 it('keeps background ownership until a cancelled redemption is durably stored',async()=>{
  const controller=new AbortController(),d=deferred();refreshProviderCredentials.mockImplementation((_provider,_credentials,_log,options)=>waitForRefresh(d.promise.then(value=>options.onCredentialsRefreshed(value,{expectedCredentials:options.expectedCredentials})),options.signal));
  let settled=false;const call=checkAndRefreshToken('codex',original,{force:true,signal:controller.signal,waitForSettled:true}).finally(()=>{settled=true;});await flush();
  controller.abort();await flush();expect(settled).toBe(false);d.resolve({accessToken:'late'});await expect(call).rejects.toMatchObject({name:'AbortError'});expect(updateProviderConnection).toHaveBeenCalledTimes(1);
 });
 it.each([null,{...original,isActive:false},{...original,authType:'apikey'}])('skips removed or no-longer-eligible background rows %#',async current=>{
  getProviderConnectionById.mockResolvedValue(current);await checkAndRefreshToken('codex',original,{force:true,requireCurrent:true});expect(refreshProviderCredentials).not.toHaveBeenCalled();
 });
 it('drains background project enrichment before releasing its scheduler permit',async()=>{
  const credentials={...original,provider:'antigravity'},controller=new AbortController(),d=deferred();getProviderConnectionById.mockResolvedValue(credentials);
  refreshProviderCredentials.mockImplementation(async(_provider,_credentials,_log,options)=>options.onCredentialsRefreshed({accessToken:'old',refreshToken:'one-use'},{expectedCredentials:options.expectedCredentials}));getProjectIdForConnection.mockReturnValue(d.promise);
  let settled=false;const call=checkAndRefreshToken('antigravity',credentials,{force:true,signal:controller.signal,waitForSettled:true}).finally(()=>{settled=true;});await flush();
  expect(getProjectIdForConnection).toHaveBeenCalledTimes(1);expect(settled).toBe(false);
  controller.abort();d.resolve('late-project');await expect(call).rejects.toMatchObject({name:'AbortError'});expect(updateProviderConnection).toHaveBeenCalledTimes(1);
 });
 it('does not persist a detached project lookup after the owner stops',async()=>{
  const credentials={...original,provider:'antigravity'},controller=new AbortController(),d=deferred();getProviderConnectionById.mockResolvedValue(credentials);
  refreshProviderCredentials.mockImplementation(async(_provider,_credentials,_log,options)=>options.onCredentialsRefreshed({accessToken:'old',refreshToken:'one-use'},{expectedCredentials:options.expectedCredentials}));getProjectIdForConnection.mockReturnValue(d.promise);
  await checkAndRefreshToken('antigravity',credentials,{force:true,signal:controller.signal});expect(getProjectIdForConnection).toHaveBeenCalledTimes(1);
  controller.abort();d.resolve('late-project');await flush();expect(updateProviderConnection).toHaveBeenCalledTimes(1);
 });
});
