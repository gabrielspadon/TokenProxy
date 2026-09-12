import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('open-sse/utils/proxyFetch.js',()=>({proxyAwareFetch:vi.fn()}));
import {proxyAwareFetch} from 'open-sse/utils/proxyFetch.js';
import {refreshAccessToken,refreshKiroToken} from 'open-sse/services/tokenRefresh/providers.js';
import {refreshProviderCredentials} from 'open-sse/services/oauthCredentialManager.js';
let n=0;const fresh=()=>`context-${++n}`;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const response=()=>({ok:true,json:async()=>({access_token:'rotated-access',refresh_token:'rotated-refresh',accessToken:'rotated-access',refreshToken:'rotated-refresh',expires_in:3600})});
beforeEach(()=>proxyAwareFetch.mockReset());
it('refuses a generic direct refresh under a changed proxy without a second redemption',async()=>{
 const token=fresh(),d=deferred();proxyAwareFetch.mockReturnValue(d.promise);
 const a=refreshAccessToken('claude',token,{providerSpecificData:{connectionProxyEnabled:true,connectionProxyUrl:'http://proxy-a.invalid'}},null);await flush();
 await expect(refreshAccessToken('claude',token,{providerSpecificData:{connectionProxyEnabled:true,connectionProxyUrl:'http://proxy-b.invalid'}},null)).rejects.toMatchObject({code:'REFRESH_CONTEXT_CONFLICT'});
 d.resolve(response());await a;expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
});
it('coalesces direct calls on one transport and refuses a conflicting one',async()=>{
 const token=fresh(),d=deferred(),psd={authMethod:'social',region:'us-east-1',profileArn:'known'};
 const proxy={connectionProxyEnabled:true,connectionProxyUrl:'http://proxy.invalid'};proxyAwareFetch.mockReturnValue(d.promise);
 const a=refreshKiroToken(token,psd,null,proxy),b=refreshKiroToken(token,psd,null,{...proxy});await flush();
 await expect(refreshKiroToken(token,psd,null,{...proxy,strictProxy:true})).rejects.toMatchObject({code:'REFRESH_CONTEXT_CONFLICT'});
 d.resolve(response());expect(await a).toEqual(await b);expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
});
it('does not reuse Kiro credentials under different client registration metadata',async()=>{
 const token=fresh(),d=deferred();proxyAwareFetch.mockReturnValue(d.promise);
 const a=refreshKiroToken(token,{authMethod:'social',region:'us-east-1',profileArn:'known'},null);await flush();
 await expect(refreshKiroToken(token,{authMethod:'social',region:'eu-west-1',profileArn:'known'},null)).rejects.toMatchObject({code:'REFRESH_CONTEXT_CONFLICT'});
 d.resolve(response());await a;expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
});
it('carries manager transport into specialized provider refresh and does not merge incompatible revisions',async()=>{
 const token=fresh(),d=deferred(),credentials={id:'account',refreshToken:token,accessToken:'old',providerSpecificData:{connectionProxyEnabled:true,connectionProxyUrl:'http://proxy.invalid',strictProxy:true}};proxyAwareFetch.mockReturnValue(d.promise);
 const a=refreshProviderCredentials('codex',credentials,null);await flush();
 expect(proxyAwareFetch.mock.calls[0][2]).toMatchObject(credentials.providerSpecificData);
 await expect(refreshProviderCredentials('codex',{...credentials,accessToken:'operator-change'},null)).rejects.toMatchObject({code:'REFRESH_CONTEXT_CONFLICT'});
 d.resolve(response());expect((await a).refreshToken).toBe('rotated-refresh');expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
});

it('keeps xAI discovery and redemption on the bounded refresh transport',async()=>{
 proxyAwareFetch.mockResolvedValue(response());
 const native=vi.fn(()=>{throw new Error('Native transport forbidden');});vi.stubGlobal('fetch',native);
 try {
  const providerSpecificData={connectionProxyEnabled:true,connectionProxyUrl:'http://proxy.invalid',strictProxy:true};
  await refreshProviderCredentials('xai',{refreshToken:fresh(),providerSpecificData},null);
  expect(proxyAwareFetch.mock.calls.length).toBeGreaterThan(0);expect(native).not.toHaveBeenCalled();
  for(const call of proxyAwareFetch.mock.calls){expect(call[1].signal).toBeInstanceOf(AbortSignal);expect(call[2]).toMatchObject(providerSpecificData);}
 } finally {vi.unstubAllGlobals();}
});

it('shares a physical token chain across compatible accounts while rejecting a repeated owner at a newer revision',async()=>{
 const token=fresh(),d=deferred();proxyAwareFetch.mockReturnValue(d.promise);
 const base={refreshToken:token,accessToken:'old'};
 const a=refreshProviderCredentials('codex',{...base,id:'peer-a',credentialRevisionId:'revision-a'},null);
 const b=refreshProviderCredentials('codex',{...base,id:'peer-b',credentialRevisionId:'revision-b'},null);await flush();
 await expect(refreshProviderCredentials('codex',{...base,id:'peer-a',credentialRevisionId:'revision-a-after-aba'},null)).rejects.toMatchObject({code:'REFRESH_CONTEXT_CONFLICT'});
 d.resolve(response());expect(await a).toEqual(await b);expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
});
