import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../src/sse/services/auth.js',async original=>({...await original(),getProviderCredentials:async()=>({apiKey:'upstream-fixture',connectionId:'fixture',connectionName:'fixture'}),clearAccountError:vi.fn(),markAccountUnavailable:async()=>({shouldFallback:false})}));
vi.mock('../../src/lib/localDb.js',async original=>({...await original(),getSettings:async()=>({requireApiKey:true})}));
vi.mock('../../src/sse/services/requestModel.js',()=>({resolveRequestModel:async model=>({provider:model.split('/')[0],model:model.split('/')[1]})}));
vi.mock('../../src/sse/services/tokenRefresh.js',()=>({checkAndRefreshToken:async(_,c)=>c,updateProviderCredentials:vi.fn()}));
vi.mock('../../open-sse/executors/index.js',()=>({getExecutor:()=>({refreshCredentials:async()=>({apiKey:'refreshed-fixture'})})}));
import { handleEmbeddings } from '../../src/sse/handlers/embeddings.js';
import { handleRerank } from '../../src/sse/handlers/rerank.js';
import { getAdapter } from '../../src/lib/db/driver.js';
import { createApiKey,updateApiKey } from '../../src/lib/db/repos/apiKeysRepo.js';
import { getBudgetStatus } from '../../src/lib/db/repos/budgetRepo.js';
const db=await getAdapter();
beforeEach(()=>{for(const t of ['apiKeyBudgetReservations','apiKeyBudgetAccounts','usageHistory','requestStats','contextSessions','apiKeys'])db.run(`DELETE FROM ${t}`);});
afterEach(()=>vi.unstubAllGlobals());
const cases=[['embeddings',handleEmbeddings,{model:'openai/text-embedding-3-small',input:'fixture'},{data:[{index:0,embedding:[0.1]}],usage:{prompt_tokens:12,total_tokens:12}}],['rerank',handleRerank,{model:'cohere/rerank-v3.5',query:'fixture',documents:['fixture']},{results:[{index:0,relevance_score:0.8}],meta:{tokens:{input_tokens:12}}}]];
async function key(policy){const k=await createApiKey('media fixture','mock');return updateApiKey(k.id,{maxPromptTokens:100,budgetPolicy:policy});}
const req=(endpoint,body,k)=>new Request(`http://localhost/v1/${endpoint}`,{method:'POST',headers:{authorization:`Bearer ${k.key}`},body:JSON.stringify(body)});
it.each(cases)('%s reserves separately after a proven auth rejection and settles exact input usage',async(endpoint,handle,body,payload)=>{
 const k=await key('reserve-remaining');const ids=[];
 vi.stubGlobal('fetch',vi.fn(async()=>{const r=db.get("SELECT * FROM apiKeyBudgetReservations WHERE state='dispatched'");expect(r.reservedPromptTokens).toBe(100);ids.push(r.requestId);return ids.length===1?Response.json({error:{message:'expired'}},{status:401}):Response.json(payload);}));
 const response=await handle(req(endpoint,body,k));expect(response.status).toBe(200);
 const status=await getBudgetStatus(k.id);expect(status.account.recordedPromptTokens).toBe(12);expect(status.outstanding.promptTokens).toBe(0);
 expect(status.reservations.map(r=>r.state).sort()).toEqual(['released','settled']);expect(new Set(ids).size).toBe(2);
 expect(db.get('SELECT requestId FROM usageHistory').requestId).toBe(ids[1]);
});
it.each(cases)('%s strict prompt bounds refuse before fetch',async(endpoint,handle,body)=>{
 const k=await key('strict');const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 const response=await handle(req(endpoint,body,k));expect(response.status).toBe(402);expect(await response.json()).toMatchObject({error:{code:'budget-bound-unavailable'}});expect(fetch).not.toHaveBeenCalled();
});
