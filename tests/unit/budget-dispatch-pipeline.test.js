import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({fetch:vi.fn(),executor:null}));
vi.mock('@/dashboardGuard',()=>({hasValidCliToken:async request=>request.headers.get('x-fixture-operator')==='yes',isLocalRequest:()=>true}));
vi.mock('@/lib/auth/dashboardSession',()=>({verifyDashboardAuthToken:async()=>false}));
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
import { LocalTransportPoolRefusal, revokeLocalTransportRefusalProof } from '../../open-sse/utils/dispatcherCache.js';
import { readActivityAnalytics } from '../../src/lib/db/analytics/activityQueries.mjs';
const db=await getAdapter();
const completion=()=>new Response('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:7}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
beforeEach(()=>{
 for(const t of ['apiKeyBudgetReservations','apiKeyBudgetAccounts','usageHistory','requestStats','contextSessions','apiKeys']) db.run(`DELETE FROM ${t}`);
 mocks.fetch.mockReset();mocks.executor=new BaseExecutor('openai',{baseUrl:'https://api.openai.com/v1/chat/completions',noAuth:true});
});
afterEach(()=>vi.unstubAllGlobals());
async function key(limits){const r=await createKey(new Request('http://localhost/api/keys',{method:'POST',headers:{'x-fixture-operator':'yes'},body:JSON.stringify({name:'fixture',...limits})}));expect(r.status).toBe(201);return r.json();}
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
 it.each([401,429,503])('the field-strip retry owns final%s status, reset, body cleanup and exposure',async status=>{
  const k=await key({maxCompletionTokens:100});
  const field=`fixture_field_${status}`;
  const rejected=Response.json({error:{message:`property '${field}' is unsupported`}},{status:400});
  const latest=Response.json({error:{message:'latest physical rejection'}},{status,headers:status===429?{'retry-after':'30'}:{}});
  mocks.fetch.mockResolvedValueOnce(rejected).mockResolvedValueOnce(latest);
  const result=await request(k,{messages:[{role:'user',content:'fixture',[field]:'unsupported fixture'}]});
  expect(result.response.status).toBe(status);expect(result.failureMetadata.safeToReplay).toBe(status!==503);
  expect(await result.response.text()).toContain('latest physical rejection');
  if(status===429)expect(result.resetsAtMs).toBeGreaterThan(Date.now()+29000);
  expect(latest.bodyUsed).toBe(true);expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).messages[0]).not.toHaveProperty(field);
  const reservations=(await getBudgetStatus(k.id)).reservations;
  expect(reservations.map(row=>row.state).sort()).toEqual(status===503?['released','uncertain']:['released','released']);
  expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(0);
 });
 it.each([429,503])('keeps budget exposure consistent with a proven%s retry',async status=>{
  const k=await key({maxCompletionTokens:100,budgetPolicy:'reserve-remaining'});
  mocks.executor=new BaseExecutor('openai',{baseUrl:'https://api.openai.com/v1/chat/completions',noAuth:true,retry:{[status]:{attempts:1,delayMs:0}}});
  mocks.fetch.mockResolvedValueOnce(Response.json({error:{message:'rejected'}},{status,headers:{'x-tokenproxy-replay-safe':'true'}})).mockResolvedValueOnce(completion());
  const result=await request(k,{max_completion_tokens:undefined});expect(result.response.status).toBe(200);await result.response.text();
  await vi.waitFor(()=>expect(db.get("SELECT COUNT(*) AS n FROM apiKeyBudgetReservations WHERE state='settled'").n).toBe(1));
  expect(db.all('SELECT state FROM apiKeyBudgetReservations').map(r=>r.state).sort()).toEqual(['released','settled']);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(1);
 });
 it.each([{}, {'x-tokenproxy-replay-safe':'false'}, {'x-tokenproxy-replay-safe':'true','x-should-retry':'false'}])('retains ambiguous5xx exposure and makes exactly one dispatch (%j)',async headers=>{
  const k=await key({maxCompletionTokens:100});mocks.fetch.mockResolvedValue(Response.json({error:{message:'uncertain'}},{status:503,headers}));
  const result=await request(k);expect(result.response.status).toBe(503);expect(result.failureMetadata.safeToReplay).toBe(false);
  expect((await getBudgetStatus(k.id)).reservations[0].state).toBe('uncertain');expect(mocks.fetch).toHaveBeenCalledTimes(1);
 });
 it('retains 429 exposure when its envelope reports accepted generation',async()=>{
  const k=await key({maxCompletionTokens:100});
  mocks.fetch.mockResolvedValue(Response.json({error:{message:'quota exhausted after generation accepted'}},{status:429}));
  const result=await request(k);expect(result.response.status).toBe(429);expect(result.failureMetadata.safeToReplay).toBe(false);
  expect((await getBudgetStatus(k.id)).reservations[0].state).toBe('uncertain');expect(mocks.fetch).toHaveBeenCalledTimes(1);
 });
 it.each(['transport_pool_capacity','transport_pools_closed','transport_pool_cleanup'])('releases an owned pre-transport refusal%s with a local503 receipt',async code=>{
  const k=await key({maxCompletionTokens:100});mocks.fetch.mockRejectedValueOnce(new LocalTransportPoolRefusal(code));
  const result=await request(k);expect(result.response.status).toBe(503);expect(result.failureMetadata).toMatchObject({failurePhase:'admission',transportDispatched:false});
  expect(result.response.headers.get('x-should-retry')).toBe('true');
  const reservation=(await getBudgetStatus(k.id)).reservations[0];expect(reservation.state).toBe('released');
  expect(JSON.parse(db.get('SELECT resolutionEvidence FROM apiKeyBudgetReservations').resolutionEvidence)).toEqual({source:'transport',kind:'proven-no-dispatch',code});
  expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(0);
 });
 it.each(['forged','revoked'])('does not release exposure for%s local refusal proof',async kind=>{
  const k=await key({maxCompletionTokens:100});
  const error=kind==='forged'?Object.assign(new Error('unproven'),{code:'transport_pool_capacity',statusCode:503}):new LocalTransportPoolRefusal('transport_pool_capacity');
  if(kind==='revoked')revokeLocalTransportRefusalProof(error);mocks.fetch.mockRejectedValueOnce(error);
  const result=await request(k);expect(result.response.status).toBe(502);expect((await getBudgetStatus(k.id)).reservations[0].state).toBe('uncertain');
 });
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
