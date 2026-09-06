import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({execute:vi.fn(),refresh:vi.fn()}));
vi.mock('../../open-sse/executors/index.js',()=>({getExecutor:()=>({execute:mocks.execute})}));
vi.mock('../../open-sse/services/tokenRefresh.js',async original=>({...await original(),refreshTokenByProvider:mocks.refresh}));
import {handleSearchCore} from '../../open-sse/handlers/search/index.js';
import {handleFetchCore} from '../../open-sse/handlers/fetch/index.js';
import {handleVideoProxyCore} from '../../open-sse/handlers/videoCore.js';
import {handleImageGenerationCore} from '../../open-sse/handlers/imageGenerationCore.js';
import {rejectionHeaders} from '../../open-sse/executors/rejectionHeaders.js';
const credentials={apiKey:'fixture',refreshToken:'fixture-refresh'};
const searchArgs={provider:{id:'tavily',searchViaChat:{defaultModel:'fixture-model'}},providerConfig:{format:'tavily',baseUrl:'https://fixture.invalid/search',authType:'apikey'},body:{query:'fixture'},credentials};
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn());mocks.execute.mockReset();mocks.refresh.mockReset();});
afterEach(()=>vi.unstubAllGlobals());

describe('dedicated search through its own fallback dispatcher',()=>{
  it.each([408,409,500,502,503,504])('does not dispatch a chat generation after ambiguous HTTP%i',async status=>{
    fetch.mockResolvedValueOnce(Response.json({error:'possibly accepted'},{status}));
    const result=await handleSearchCore(searchArgs);
    expect(result.status).toBe(status);expect(result.failureMetadata.safeToReplay).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['x-tokenproxy-replay-safe','x-should-retry'])('honors %s even for retryable status429',async header=>{
    fetch.mockResolvedValueOnce(Response.json({error:'accepted outcome'},{status:429,headers:{[header]:'false'}}));
    expect((await handleSearchCore(searchArgs)).failureMetadata.safeToReplay).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves the latest uncertain outcome after an explicitly rejected dedicated request',async()=>{
    // OpenAI has a registered chat-search model; Tavily supplies a valid
    // dedicated request builder for the first, separately rejected attempt.
    const args={...searchArgs,provider:{id:'openai',searchViaChat:{defaultModel:'gpt-4o-search-preview'}},providerConfig:{...searchArgs.providerConfig,format:'tavily'}};
    fetch.mockResolvedValueOnce(Response.json({error:'rejected'},{status:503,headers:{'x-tokenproxy-replay-safe':'true'}}))
      .mockRejectedValueOnce(new Error('second generation outcome unknown'));
    const result=await handleSearchCore(args);
    expect(fetch).toHaveBeenCalledTimes(2);expect(result.status).toBe(502);
    expect(result.failureMetadata.safeToReplay).toBe(false);expect(result.error).toContain('second generation outcome unknown');
  });
});

describe.each(['firecrawl','jina-reader','tavily','exa'])('%s fetch response evidence',provider=>{
  it.each([[429,{},true],[503,{},false],[503,{'x-tokenproxy-replay-safe':'true'},true],[429,{'x-should-retry':'false'},false]])('classifies actual HTTP%i (%j)',async(status,headers,safe)=>{
    fetch.mockResolvedValueOnce(Response.json({error:'fixture'},{status,headers}));
    const result=await handleFetchCore({provider,url:'https://example.com/fixture',credentials});
    expect(fetch).toHaveBeenCalledTimes(1);expect(result.status).toBe(status);expect(result.failureMetadata.safeToReplay).toBe(safe);
  });
});

it.each(['x-tokenproxy-replay-safe','x-should-retry'])('video does not refresh or resubmit when %s denies',async header=>{
  mocks.refresh.mockResolvedValue({accessToken:'new-fixture'});
  fetch.mockResolvedValueOnce(Response.json({error:'already accepted'},{status:401,headers:{[header]:'false'}}));
  const result=await handleVideoProxyCore({provider:'xai',action:'generations',rawBody:'{}',credentials:{...credentials}});
  expect(result.failureMetadata.safeToReplay).toBe(false);expect(fetch).toHaveBeenCalledTimes(1);expect(mocks.refresh).not.toHaveBeenCalled();
});

it('video cancels the rejected response before refresh replay and returns the latest uncertain outcome',async()=>{
  mocks.refresh.mockResolvedValue({accessToken:'new-fixture'});
  let cancelled=false;
  const upstream=new Response(new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}}),{status:401});
  fetch.mockResolvedValueOnce(upstream).mockImplementationOnce(async()=>{
    expect(cancelled).toBe(true);return Response.json({error:'latest uncertain outcome'},{status:503});
  });
  const result=await handleVideoProxyCore({provider:'xai',action:'generations',rawBody:'{}',credentials:{...credentials}});
  expect(result.status).toBe(503);expect(result.error).toContain('latest uncertain outcome');
  expect(result.failureMetadata.safeToReplay).toBe(false);expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([[503,{},false],[429,{'x-should-retry':'false'},false],[503,{'x-tokenproxy-replay-safe':'true'},true]])('executor image error preserves HTTP%i evidence (%j)',async(status,headers,safe)=>{
  mocks.execute.mockResolvedValueOnce({response:Response.json({error:{message:'fixture outcome'}},{status,headers})});
  const result=await handleImageGenerationCore({modelInfo:{provider:'antigravity',model:'gemini-3-pro-image'},body:{prompt:'fixture'},credentials});
  expect(result.failureMetadata.safeToReplay).toBe(safe);expect(mocks.execute).toHaveBeenCalledTimes(1);expect(fetch).not.toHaveBeenCalled();
});

it('specialized normalization preserves both denial headers and omits secrets',()=>{
  const upstream=new Response(null,{status:429,headers:{'x-tokenproxy-replay-safe':'true','x-should-retry':'false','retry-after':'4','set-cookie':'private'}});
  expect(rejectionHeaders(upstream)).toEqual({'Content-Type':'application/json','x-tokenproxy-replay-safe':'true','x-should-retry':'false','retry-after':'4'});
});
