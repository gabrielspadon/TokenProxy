import { describe, it, expect, vi, beforeEach } from "vitest";
const mocks=vi.hoisted(()=>({execute:vi.fn()}));
vi.mock("../../open-sse/executors/index.js",()=>({getExecutor:()=>({noAuth:true,execute:mocks.execute})}));
const {handleChatCore}=await import("../../open-sse/handlers/chatCore.js");
const {getContextOverview,getContextSession}=await import("../../src/lib/db/repos/contextRepo.js");
const {getAdapter}=await import("../../src/lib/db/driver.js");
const {buildOnStreamComplete}=await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const {createContextTelemetry,recordContextAttempt}=await import("../../open-sse/handlers/chatCore/contextTelemetry.js");
const db=await getAdapter();
const base=()=>({body:{model:"gpt-4o",messages:[{role:"user",content:"fixture question"}],stream:false},modelInfo:{provider:"openrouter",model:"gpt-4o"},credentials:{sessionHash:"a".repeat(32)},connectionId:"fixture-account",clientRawRequest:{headers:{},body:{model:"openai/gpt-4o"}},contextTelemetry:{logicalRequestId:"server-request"},log:{debug:vi.fn(),warn:vi.fn(),info:vi.fn(),error:vi.fn()}});
beforeEach(()=>{db.run("DELETE FROM requestStats");db.run("DELETE FROM contextSessions");mocks.execute.mockReset();});
const waitFor=async(fn)=>{for(let i=0;i<100;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,5));}throw Error("completion did not persist");};
it("persists the actual nonstream provider usage at the shared attempt id",async()=>{
 mocks.execute.mockImplementation(async({body})=>({response:Response.json({id:"fixture",object:"chat.completion",choices:[{index:0,message:{role:"assistant",content:"answer"},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:4,prompt_tokens_details:{cached_tokens:40}}}),body}));
 const result=await handleChatCore(base());expect(result.success).toBe(true);
 const overview=await waitFor(async()=>{const r=await getContextOverview();return r.summary.succeeded?r:null;});
 expect(overview.summary).toMatchObject({attempts:1,requests:1,providerInputTokens:100,providerOutputTokens:4,cacheReadTokens:40,cacheHitRate:0.4});
 const {turns}=await getContextSession(overview.sessions[0].id);
 expect(turns[0].stages.length).toBeGreaterThan(5);
  expect(turns[0].stages.reduce((sum,s)=>sum+s.deltaBytes,0)).toBe(turns[0].bodyAfterBytes-turns[0].bodyBeforeBytes);
});
it("records effective epoch and cache controls as explicit booleans",async()=>{
 mocks.execute.mockImplementation(async()=>({response:Response.json({id:"fixture",type:"message",role:"assistant",content:[{type:"text",text:"answer"}],usage:{input_tokens:100,output_tokens:4}})}));
 const args=base();args.body.model="claude-sonnet-4-5";args.modelInfo={provider:"anthropic",model:"claude-sonnet-4-5"};args.clientRawRequest.body={model:"claude-sonnet-4-5"};
 Object.assign(args,{dietEnabled:true,linguaEnabled:true,epochMicroEnabled:true,epochAutoEnabled:true,adaptiveCacheTtlEnabled:true});
 const events=[];args.onTokenSaverEvent=event=>events.push(event);
 const result=await handleChatCore(args);expect(result.success).toBe(true);
 const overview=await waitFor(async()=>{const r=await getContextOverview();return r.summary.succeeded?r:null;});
 const {turns}=await getContextSession(overview.sessions[0].id);
 expect(turns[0].controls).toMatchObject({diet:true,lingua:true,epochMicro:true,epochAuto:true,adaptiveCacheTtl:true});
 for(const saver of ['diet','lingua','epochMicro','epochAuto']) {
  const stageEvents=events.filter(event=>event.saver===saver);
  expect(stageEvents).toHaveLength(1);
  expect(stageEvents[0]).toMatchObject({applied:false,reason:'epoch_boundary',bytesSaved:0});
 }
});
it("records transport failures without fabricated usage and forbids uncertain replay",async()=>{
 mocks.execute.mockRejectedValue(new Error("synthetic transport failure"));
 const result=await handleChatCore(base());expect(result.success).toBe(false);expect(result.failureMetadata.safeToReplay).toBe(false);
 const overview=await waitFor(async()=>{const r=await getContextOverview();return r.summary.failed?r:null;});
 expect(overview.summary).toMatchObject({attempts:1,failed:1,missingUsageSamples:1,providerInputTokens:null});
});
it("records a malformed accepted body as failure and forbids replay",async()=>{
 mocks.execute.mockResolvedValue({response:new Response("{broken",{headers:{"content-type":"application/json"}})});
 const result=await handleChatCore(base());expect(result.success).toBe(false);expect(result.failureMetadata.safeToReplay).toBe(false);
 const overview=await waitFor(async()=>{const r=await getContextOverview();return r.summary.failed?r:null;});
 expect(overview.summary.failed).toBe(1);expect(overview.summary.providerInputTokens).toBeNull();
});
it("persists partial stream usage once across abandonment and late completion",async()=>{
 const contextTelemetry=createContextTelemetry({sessionHash:"b".repeat(32),timestamp:new Date().toISOString(),stages:[],bodyAfterBytes:80});
 const fields={provider:"openai",model:"gpt-4o",connectionId:"fixture-account"};
 await recordContextAttempt(contextTelemetry,fields);
 const {onStreamAbandoned,onStreamComplete,streamState}=buildOnStreamComplete({...fields,contextTelemetry,body:{messages:[]},requestStartTime:Date.now(),sourceFormat:"openai",rid:"abcd1234",log:{}});
 streamState.usage={prompt_tokens:100,completion_tokens:3,cached_tokens:20};streamState.content="partial";
 onStreamAbandoned("client_disconnect");onStreamComplete({content:"late"},{prompt_tokens:999,completion_tokens:100},Date.now());
 const overview=await waitFor(async()=>{const r=await getContextOverview();return r.summary.failed?r:null;});
 expect(overview.summary).toMatchObject({attempts:1,failed:1,providerInputTokens:100,providerOutputTokens:3,cacheReadTokens:20});
});
it("records usage-less completed streams as estimates rather than observed counts",async()=>{
 const contextTelemetry=createContextTelemetry({sessionHash:"c".repeat(32),timestamp:new Date().toISOString(),stages:[],bodyAfterBytes:80});
 const fields={provider:"openai",model:"gpt-4o",connectionId:"fixture-account"};
 await recordContextAttempt(contextTelemetry,fields);
 const {onStreamComplete}=buildOnStreamComplete({...fields,contextTelemetry,body:{messages:[{role:"user",content:"question"}]},requestStartTime:Date.now(),sourceFormat:"openai",rid:"abcd1234",log:{}});
 onStreamComplete({content:"estimated answer"},null,Date.now());
 const overview=await waitFor(async()=>{const r=await getContextOverview();return r.summary.succeeded?r:null;});
 expect(overview.summary).toMatchObject({attempts:1,estimatedUsageSamples:1,providerInputTokens:null});
 expect(overview.summary.estimatedInputTokens).toBeGreaterThan(0);
});
it("drives a real SSE stream through completion without a second placeholder row",async()=>{
 const sse='data: '+JSON.stringify({id:"fixture",object:"chat.completion.chunk",choices:[{index:0,delta:{content:"stream answer"},finish_reason:null}]})+'\n\n'+'data: '+JSON.stringify({id:"fixture",object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:80,completion_tokens:5,prompt_tokens_details:{cached_tokens:0}}})+'\n\ndata: [DONE]\n\n';
 mocks.execute.mockResolvedValue({response:new Response(sse,{headers:{"content-type":"text/event-stream"}})});
 const args=base();args.body.stream=true;
 const result=await handleChatCore(args);await result.response.text();
 const overview=await waitFor(async()=>{const r=await getContextOverview();return r.summary.succeeded?r:null;});
 expect(overview.summary).toMatchObject({attempts:1,succeeded:1,pending:0,providerInputTokens:80,providerOutputTokens:5,cacheReadTokens:0,cacheHitRate:0});
});
it("scopes cache-prefix measurements by session, provider, model and account",async()=>{
 mocks.execute.mockImplementation(async()=>({response:Response.json({choices:[{message:{role:"assistant",content:"answer"},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:4}})}));
 for(const account of ["cache-account-a","cache-account-a","cache-account-b"]){const args=base();args.connectionId=account;args.credentials.sessionHash="d".repeat(32);const result=await handleChatCore(args);await result.response.text();}
 const overview=await waitFor(async()=>{const r=await getContextOverview();return r.summary.succeeded===3?r:null;});
 const {turns}=await getContextSession(overview.sessions[0].id);
 const same=turns.filter(t=>t.connectionId==="cache-account-a");
 expect(same.some(t=>t.cachePrefixBytes>0)).toBe(true);
 expect(turns.find(t=>t.connectionId==="cache-account-b").cachePrefixBytes).toBeNull();
});
