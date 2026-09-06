import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
vi.hoisted(()=>{process.env.JWT_SECRET='synthetic-context-preview-only-signing-secret';});
const mocks=vi.hoisted(()=>({fetch:vi.fn(),executor:null}));
vi.mock('../../open-sse/executors/index.js',()=>({getExecutor:()=>mocks.executor}));
vi.mock('../../open-sse/utils/proxyFetch.js',()=>({proxyAwareFetch:(...args)=>mocks.fetch(...args)}));
const { BaseExecutor }=await import('../../open-sse/executors/base.js');
const { handleChatCore }=await import('../../open-sse/handlers/chatCore.js');
const { getAdapter }=await import('../../src/lib/db/driver.js');
const { ingestContextEvent }=await import('../../src/lib/db/repos/contextClientEventsRepo.js');
const { getContextSession }=await import('../../src/lib/db/repos/contextRepo.js');
const { readEvidence }=await import('../../src/lib/db/analytics/evidenceQueries.mjs');
let db;
afterAll(async()=>{vi.useRealTimers();await globalThis._contextAnalytics?.client.close();delete globalThis._contextAnalytics;db?.close();});
it.skipIf(!process.env.CONTEXT_EVIDENCE_PREVIEW_OUT)('creates a clearly synthetic preview through actual mocked capture and event ingestion',async()=>{
  expect(process.env.DATA_DIR).toContain('tokenproxy-test-file-');
  const output=path.resolve(process.env.CONTEXT_EVIDENCE_PREVIEW_OUT);
  expect(output).toContain('/implementation-evidence/telemetry/context-evidence-preview/synthetic');
  db=await getAdapter();expect(db.driver).toBe('better-sqlite3');
  const key='synthetic-context-preview-key';
  db.run('INSERT INTO apiKeys(id,key,createdAt) VALUES(?,?,?)',['synthetic-key-id',key,new Date().toISOString()]);
  mocks.executor=new BaseExecutor('openrouter',{baseUrl:'https://synthetic.invalid/v1'});
  const reports=[], clockStart=Date.now()-31*60000;
  vi.useFakeTimers({toFake:['Date']});
  for(let index=0;index<31;index++) {
    vi.setSystemTime(clockStart+index*60000);
    const headers={'x-tokenproxy-client-id':'synthetic-cli','x-tokenproxy-session-id':'synthetic-session','x-tokenproxy-task-id':'synthetic-task','x-tokenproxy-project-id':'synthetic-project'};
    const historical='Synthetic historical tool output. '.repeat(60+index*4);
    const body={model:'gpt-4o',stream:false,tools:[{type:'function',function:{name:'read_fixture',description:'Read synthetic fixture data',parameters:{type:'object',properties:{path:{type:'string'}}}}}],messages:[
      {role:'system',content:'Synthetic fixture instructions, preserve all evidence.'},
      {role:'user',content:'Read the synthetic document.'},
      {role:'assistant',content:null,tool_calls:[{id:'call-fixture',type:'function',function:{name:'read_fixture',arguments:'{"path":"fixture"}'}}]},
      {role:'tool',tool_call_id:'call-fixture',content:JSON.stringify({items:[historical],status:'synthetic'},null,2)},
      {role:'user',content:[{type:'text',text:`Synthetic current request ${index}`},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}]},
    ]};
    mocks.fetch.mockResolvedValueOnce(Response.json({choices:[{message:{role:'assistant',content:'Synthetic fixture answer'},finish_reason:'stop'}],usage:{prompt_tokens:1600+index*70,completion_tokens:80+index,prompt_tokens_details:{cached_tokens:600+index*20},cache_creation_input_tokens:0}}));
    const response=await handleChatCore({body,modelInfo:{provider:'openrouter',model:'gpt-4o'},credentials:{sessionHash:'d'.repeat(64),sessionIdentitySource:'explicit',apiKey:'synthetic-upstream-key'},connectionId:index%2?'synthetic-account-b':'synthetic-account-a',apiKey:key,
      clientRawRequest:{body:structuredClone(body),headers,endpoint:'/v1/chat/completions'},contextTelemetry:{logicalRequestId:randomUUID()},rtkEnabled:true,schemaDistillEnabled:true,log:{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()}});
    expect(response.success).toBe(true);
    const id=response.response.headers.get('x-tokenproxy-request-id');
    for(let wait=0;wait<100 && db.get('SELECT status FROM requestStats WHERE id=?',[id])?.status==='pending';wait++)await new Promise(resolve=>setTimeout(resolve,5));
    const row=db.get('SELECT * FROM requestStats WHERE id=?',[id]);expect(row.status).toBe('success');reports.push(row);
  }
  vi.useRealTimers();
  const first=reports[0];
  db.run('UPDATE contextSessions SET projectLabel=? WHERE id=?',['Synthetic evidence workshop',first.contextSessionId]);
  for(let index=0;index<23;index++) await ingestContextEvent(key,{eventId:randomUUID(),type:'compaction',occurredAt:new Date().toISOString(),clientId:'synthetic-cli',clientSessionId:'synthetic-session',taskId:'synthetic-task',projectId:'synthetic-project',requestId:first.id,logicalRequestId:first.logicalRequestId,sessionId:first.contextSessionId,beforeTokens:10000+index,afterTokens:12000+index,tokenMeasurementMethod:'client-estimate'});
  await ingestContextEvent(key,{eventId:randomUUID(),type:'handoff',occurredAt:new Date().toISOString(),clientId:'synthetic-cli',taskId:'synthetic-task',targetClientId:'synthetic-reviewer',targetTaskId:'synthetic-review',requestId:reports[1].id});
  await ingestContextEvent(key,{eventId:randomUUID(),type:'task_outcome',occurredAt:new Date().toISOString(),clientId:'synthetic-cli',taskId:'synthetic-unlinked',outcome:'success'});
  const view=await getContextSession(first.contextSessionId,{page:1,pageSize:25});expect(view.pagination.totalItems).toBe(31);expect(view.turns[0].structures).toHaveLength(3);expect(view.turns[0].stages.length).toBeGreaterThanOrEqual(13);
  const exported=readEvidence(db,{operation:'evidence',mode:'population',definition:{schemaVersion:1,lens:'context',scope:{period:'all'},comparisonIds:[]}});
  expect(exported.items).toHaveLength(31);expect(exported.clientEvents).toHaveLength(24);
  await mkdir(path.join(output,'runtime/db'),{recursive:true,mode:0o700});
  await db.raw.backup(path.join(output,'runtime/db/data.sqlite'));
  await writeFile(path.join(output,'fixture-receipt.json'),JSON.stringify({fixture:'Synthetic requests and client reports. No historical source rows or paid provider calls.',requestIds:reports.map(row=>row.id),sessionId:first.contextSessionId,attempts:31,structures:93,stages:exported.items.reduce((sum,row)=>sum+row.stages.length,0),clientEvents:25,exportedLinkedEvents:24,providerCalls:0,capturedAt:new Date().toISOString()},null,2),{mode:0o600});
});
