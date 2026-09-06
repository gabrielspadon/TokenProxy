import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({fetch:vi.fn(),executor:null}));
vi.mock('../../open-sse/utils/proxyFetch.js',()=>({proxyAwareFetch:(...a)=>mocks.fetch(...a)}));
vi.mock('../../open-sse/executors/index.js',()=>({getExecutor:()=>mocks.executor}));
vi.mock('../../src/shared/utils/machineId.js',()=>({getConsistentMachineId:async()=> 'budget-fixture-machine'}));
import { BaseExecutor } from '../../open-sse/executors/base.js';
import { handleChatCore } from '../../open-sse/handlers/chatCore.js';
import { POST as createKey } from '../../src/app/api/keys/route.js';
import { getAdapter } from '../../src/lib/db/driver.js';
import { validateApiKey } from '../../src/lib/db/repos/apiKeysRepo.js';
import { resolveClientApiKey } from '../../src/lib/auth/clientApiKey.js';
import { getRequestIdentity } from '../../src/sse/services/requestIdentity.js';
import { getBudgetStatus } from '../../src/lib/db/repos/budgetRepo.js';
import { dispatchBudgetBounds } from '../../src/sse/services/budgetDispatch.js';
import { readActivityAnalytics } from '../../src/lib/db/analytics/activityQueries.mjs';
const db=await getAdapter();
const completion=()=>new Response('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:7}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
beforeEach(()=>{
 for(const t of ['apiKeyBudgetReservations','apiKeyBudgetAccounts','usageHistory','requestStats','contextSessions','apiKeys']) db.run(`DELETE FROM ${t}`);
 mocks.fetch.mockReset();mocks.executor=new BaseExecutor('openai',{baseUrl:'https://api.openai.com/v1/chat/completions',noAuth:true});
});
afterEach(()=>vi.unstubAllGlobals());
async function key(limits){const r=await createKey(new Request('http://localhost/api/keys',{method:'POST',body:JSON.stringify({name:'fixture',...limits})}));expect(r.status).toBe(201);return r.json();}
async function request(k,body={}){
 const req=new Request('http://localhost/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${k.key}`},body:JSON.stringify({model:'openai/gpt-4o',messages:[{role:'user',content:'fixture'}],stream:false,max_completion_tokens:20,...body})});
 const auth=await resolveClientApiKey(req,validateApiKey);if(auth.refusal)return {success:false,response:auth.refusal};
 expect(auth.valid).toBe(true);
 return handleChatCore({body:await req.json(),modelInfo:{provider:'openai',model:'gpt-4o'},apiKey:auth.apiKey,
 credentials:{apiKey:'synthetic-provider-key'},connectionId:'fixture-account',contextTelemetry:getRequestIdentity(req),
 clientRawRequest:{headers:{},body:{model:'openai/gpt-4o',stream:body.stream===true},endpoint:'/v1/chat/completions'},
 log:{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()}});
}
async function settled(k){await vi.waitFor(async()=>expect((await getBudgetStatus(k.id)).reservations[0],JSON.stringify(db.all("SELECT tokens,cost,usageSource FROM usageHistory"))).toMatchObject({state:'settled'}));return getBudgetStatus(k.id);}
describe('API key through real admission, transport, ledger and query',()=>{
 it('strict default admits a documented output bound and joins one exact request',async()=>{
  const k=await key({maxCompletionTokens:100});expect(k.budgetPolicy).toBe('strict');
  let atWire;mocks.fetch.mockImplementation(async()=>{atWire=db.get("SELECT * FROM apiKeyBudgetReservations WHERE state='dispatched'");expect(atWire.reservedCompletionTokens).toBe(20);return completion();});
  const result=await request(k);expect(result.response.status).toBe(200);await result.response.text();
  const status=await settled(k);expect(status.account.recordedCompletionTokens).toBe(7);
  const usage=readActivityAnalytics(db,{operation:'activity',view:'economics',requestId:atWire.requestId,pageSize:1});
  expect(usage.items).toHaveLength(1);expect(usage.items[0].requestId).toBe(status.reservations[0].requestId);
  expect(usage.items[0].rateSnapshotId).toBe(atWire.rateSnapshotId);expect(status.outstanding.completionTokens).toBe(0);
 });
 it('strict missing prompt bound refuses before transport with an explicit terminal error',async()=>{
  const k=await key({maxPromptTokens:100});
  const result=await request(k);expect(result.response.status).toBe(402);
  expect(await result.response.json()).toMatchObject({error:{code:'budget-bound-unavailable'}});
  expect(mocks.fetch).not.toHaveBeenCalled();expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(0);
 });
 it('unknown best-effort exposure permits one concurrent wire and retains failed exposure',async()=>{
  const k=await key({maxPromptTokens:100,budgetPolicy:'reserve-remaining'});
  let finish;mocks.fetch.mockImplementation(()=>new Promise((_,reject)=>{finish=reject;}));
  const first=request(k);await vi.waitFor(()=>expect(mocks.fetch).toHaveBeenCalledTimes(1));
  const second=await request(k);expect(second.response.status).toBe(402);
  finish(new Error('connection lost after potential acceptance'));
  const r=await first;expect(r.response.status).toBe(502);
  const status=await getBudgetStatus(k.id);expect(status.reservations[0].state).toBe('uncertain');expect(status.outstanding.promptTokens).toBe(100);
 });
 it('direct authentication rejection releases only its own attempt before the retry',async()=>{
  const k=await key({maxCompletionTokens:100,budgetPolicy:'reserve-remaining'});
  mocks.executor.noAuth=false;mocks.executor.refreshCredentials=async()=>({accessToken:'refreshed'});
  mocks.fetch.mockResolvedValueOnce(Response.json({error:{message:'expired'}},{status:401})).mockResolvedValueOnce(completion());
  const r=await request(k,{max_completion_tokens:undefined});expect(r.response.status).toBe(200);await r.response.text();
  await vi.waitFor(()=>expect(db.get("SELECT COUNT(*) AS n FROM apiKeyBudgetReservations WHERE state='settled'").n).toBe(1));
  const rows=db.all('SELECT * FROM apiKeyBudgetReservations ORDER BY createdAt');
  expect(rows.map(r=>r.state).sort()).toEqual(['released','settled']);expect(new Set(rows.map(r=>r.logicalRequestId)).size).toBe(1);
  expect(new Set(rows.map(r=>r.requestId)).size).toBe(2);expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(1);
 });
 it('client cancellation retains partial exposure after streaming output',async()=>{
  const k=await key({maxCompletionTokens:100});let cancelled=false;
  const frame='data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta:{content:'partial'}}],usage:{prompt_tokens:10,completion_tokens:3}})+'\n\n';
  mocks.fetch.mockResolvedValue(new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));
  const result=await request(k,{stream:true,max_completion_tokens:100});expect(result.response.status).toBe(200);
  const reader=result.response.body.getReader();await reader.read();await reader.cancel('fixture-client-disconnect');
  await vi.waitFor(async()=>expect((await getBudgetStatus(k.id)).reservations[0].state).toBe('uncertain'));
  const status=await getBudgetStatus(k.id);expect(status.account.recordedCompletionTokens+status.outstanding.completionTokens).toBeGreaterThanOrEqual(100);
  expect(cancelled).toBe(true);expect(mocks.fetch).toHaveBeenCalledTimes(1);
 });
 it('no structural or compatible endpoint assumption manufactures a token bound',()=>{
  expect(dispatchBudgetBounds({url:'https://api.openai.com/v1/chat/completions',body:{max_completion_tokens:10,n:3}}).completionTokens).toBe(30);
  for(const value of [{url:'https://compatible.invalid/v1/chat/completions',body:{max_completion_tokens:10}},
   {url:'https://api.openai.com/v1/chat/completions',body:{max_tokens:10}},
   {url:'https://api.openai.com/v1/chat/completions',body:{max_completion_tokens:10,prediction:{content:'x'}}}]) expect(dispatchBudgetBounds(value)).toEqual({});
 });
});
