import {afterEach,describe,it,expect,vi} from 'vitest';
import {dedupRefresh,withRefreshContext,MAX_REFRESH_ENTRIES} from 'open-sse/services/tokenRefresh/dedup.js';
import {credentialRevision,waitForRefresh} from 'open-sse/services/tokenRefresh/credentialRevision.js';
import {withCredentialRefreshLock} from 'open-sse/services/oauthCredentialManager.js';
import {runBackgroundTokenRefreshTick,startBackgroundTokenRefresh,stopBackgroundTokenRefresh,BACKGROUND_REFRESH_CONCURRENCY} from '@/sse/services/backgroundTokenRefresh.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let sequence=0;
const fresh=()=>`synthetic-${++sequence}`;
const due=id=>({id,provider:'codex',authType:'oauth',refreshToken:fresh(),isActive:true,expiresAt:new Date(Date.now()+1000).toISOString()});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
afterEach(()=>{stopBackgroundTokenRefresh();vi.useRealTimers();vi.unstubAllEnvs();});

describe('refresh runtime concurrency and exclusivity',()=>{
 it('runs only four background jobs at once and continues after failure',async()=>{
  const jobs=Array.from({length:13},(_,i)=>due(String(i))),waits=[];let active=0,max=0;
  const refresh=vi.fn(()=>{active++;max=Math.max(max,active);const d=deferred();waits.push(d);return d.promise.finally(()=>active--);});
  const tick=runBackgroundTokenRefreshTick({loadConnections:async()=>jobs,refreshConnection:refresh});await flush();
  expect(refresh).toHaveBeenCalledTimes(BACKGROUND_REFRESH_CONCURRENCY);
  waits.shift().reject(new Error('synthetic failure'));await flush();expect(refresh).toHaveBeenCalledTimes(5);
  while(waits.length){waits.shift().resolve();await flush();}await tick;
  expect(refresh).toHaveBeenCalledTimes(13);expect(max).toBe(4);
 });
 it('coalesces compatible token identities but refuses different revisions and proxy contexts',async()=>{
  const token=fresh(),d=deferred(),fn=vi.fn(()=>d.promise);
  const first=withRefreshContext({revision:'proxy-A:revision-1'},()=>dedupRefresh('codex',token,fn));
  const joined=withRefreshContext({revision:'proxy-A:revision-1'},()=>dedupRefresh('codex',token,fn));
  await expect(withRefreshContext({revision:'proxy-B:revision-1'},()=>dedupRefresh('codex',token,fn))).rejects.toMatchObject({code:'REFRESH_CONTEXT_CONFLICT'});
  d.resolve({accessToken:'new',refreshToken:'rotated'});expect(await first).toEqual(await joined);expect(fn).toHaveBeenCalledTimes(1);
  await expect(withRefreshContext({revision:'proxy-A:revision-2'},()=>dedupRefresh('codex',token,fn))).rejects.toMatchObject({code:'REFRESH_CONTEXT_CONFLICT'});
 });
 it('does not coalesce the same connection after a credential revision changes',async()=>{
  const a=deferred(),b=deferred(),id=fresh();
  const first=withCredentialRefreshLock('codex',{id,refreshToken:'old'},()=>a.promise);
  const next=withCredentialRefreshLock('codex',{id,refreshToken:'new'},()=>b.promise);
  a.resolve('old-result');b.resolve('new-result');expect(await next).toBe('new-result');expect(await first).toBe('old-result');
 });
 it('keeps a one-use redemption owned after one waiter cancels',async()=>{
  const token=fresh(),d=deferred(),fn=vi.fn(()=>d.promise),controller=new AbortController();
  const first=dedupRefresh('codex',token,fn),cancelled=waitForRefresh(first,controller.signal);
  controller.abort();await expect(cancelled).rejects.toMatchObject({name:'AbortError'});
  const joined=dedupRefresh('codex',token,fn);d.resolve('rotation');expect(await joined).toBe('rotation');expect(fn).toHaveBeenCalledTimes(1);
 });
 it('bounds active token entries without evicting an in-flight one-use owner',async()=>{
  vi.useFakeTimers();await vi.advanceTimersByTimeAsync(11000);
  const d=deferred(),pending=[];
  for(let i=0;i<MAX_REFRESH_ENTRIES;i++)pending.push(dedupRefresh('bounded',fresh(),()=>d.promise));
  await expect(dedupRefresh('bounded',fresh(),vi.fn())).rejects.toMatchObject({code:'REFRESH_CAPACITY'});
  d.resolve(null);await Promise.all(pending);await vi.advanceTimersByTimeAsync(11000);
  await expect(dedupRefresh('bounded',fresh(),async()=>1)).resolves.toBe(1);
 });
});
describe('background stop and restart',()=>{
 it('aborts active waiters and stops queued jobs, including a concurrent skipped tick',async()=>{
  const jobs=Array.from({length:10},(_,i)=>due(String(i))),waits=[];
  const refresh=vi.fn((_conn,{signal})=>{const d=deferred();waits.push({d,signal});return d.promise;});
  const tick=runBackgroundTokenRefreshTick({loadConnections:async()=>jobs,refreshConnection:refresh});await flush();
  const ignored=vi.fn();await runBackgroundTokenRefreshTick({loadConnections:ignored});expect(ignored).not.toHaveBeenCalled();
  stopBackgroundTokenRefresh();expect(waits.every(x=>x.signal.aborted)).toBe(true);
  waits.forEach(x=>x.d.resolve());await tick;expect(refresh).toHaveBeenCalledTimes(4);
  const next=vi.fn();await runBackgroundTokenRefreshTick({loadConnections:async()=>[due('new')],refreshConnection:next});expect(next).toHaveBeenCalledTimes(1);
 });
 it('stops work when shutdown happens while the database read is pending',async()=>{
  const d=deferred(),refresh=vi.fn();const tick=runBackgroundTokenRefreshTick({loadConnections:()=>d.promise,refreshConnection:refresh});
  stopBackgroundTokenRefresh();d.resolve([due('late')]);await tick;expect(refresh).not.toHaveBeenCalled();
 });
 it('cancels scheduled callbacks and explicit restart installs only one timer pair',()=>{
  vi.useFakeTimers();vi.stubEnv('DISABLE_BACKGROUND_TOKEN_REFRESH','');
  expect(startBackgroundTokenRefresh()).toBe(true);expect(startBackgroundTokenRefresh()).toBe(false);expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);
  stopBackgroundTokenRefresh();const stopped=vi.getTimerCount();expect(startBackgroundTokenRefresh()).toBe(true);expect(vi.getTimerCount()).toBe(stopped+2);stopBackgroundTokenRefresh();expect(vi.getTimerCount()).toBe(stopped);
 });
 it('canonical credential revision excludes names but includes proxy settings and deactivation',()=>{
  const base={accessToken:'a',refreshToken:'r',isActive:true,providerSpecificData:{b:2,a:1}};
  expect(credentialRevision({...base,name:'other',providerSpecificData:{a:1,b:2}})).toBe(credentialRevision(base));
  expect(credentialRevision({...base,isActive:false})).not.toBe(credentialRevision(base));
  expect(credentialRevision({...base,providerSpecificData:{connectionProxyUrl:'synthetic'}})).not.toBe(credentialRevision(base));
 });
});
