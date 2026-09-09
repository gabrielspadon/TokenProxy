import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { compactEvent, sendClientEvent } from '../../src/lib/clientSetup/events.mjs';
import { claudeClientSettings, eventEndpoint } from '../../src/lib/clientSetup/claudeAdapter.mjs';
import { nativeCompactionBoundary } from '../../src/lib/clientSetup/nativeCompaction.mjs';
const id='13c662ae-a06c-4e26-bfe0-76d08f4c2622';
const boundary={uuid:id,sessionId:'session-exact',timestamp:new Date().toISOString(),type:'system',subtype:'compact_boundary',compactMetadata:{trigger:'auto',preTokens:167123}};
const input={hook_event_name:'PostCompact',session_id:'session-exact',trigger:'auto',compact_summary:'Never transmit this'};
const event=compactEvent(input,{clientId:'claude-code',eventId:id,occurredAt:boundary.timestamp});
const ack=(duplicate=false)=>Response.json({event:{id:'retained',clientEventId:id},duplicate},{status:duplicate?200:201});
test('100 percent retains both native reserves, unknown versions stay unknown',()=>{
 const result=nativeCompactionBoundary({version:'2.1.263',advertisedContext:1000000,resolvedWindow:200000,maxOutput:32000});
 assert.equal(result.threshold,167000);assert.equal(result.advertisedContext,1000000);assert.equal(result.outputReserve,20000);assert.equal(result.compactionReserve,13000);
 assert.equal(nativeCompactionBoundary({version:'future',resolvedWindow:200000,maxOutput:32000}).threshold,null);
});
test('supported config preserves existing hooks and env, is idempotent and leaves pct unchanged',()=>{
 const old={permissions:{allow:['Read']},autoCompactWindow:200000,env:{OTHER:'preserve',CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:'95'},hooks:{PostCompact:[{hooks:[{type:'command',command:'old'}]}]}};
 const options={scriptPath:'/tmp/a b.mjs',nodePath:'/bin/node',baseUrl:'http://127.0.0.1:9000',clientId:'claude-code',autoCompactWindow:1000000};
 const next=claudeClientSettings(old,options);assert.equal(next.hooks.PostCompact.length,2);assert.equal(old.hooks.PostCompact.length,1);assert.deepEqual(next.permissions,old.permissions);assert.equal(next.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,'95');assert.deepEqual(claudeClientSettings(next,options),next);
 assert.throws(()=>claudeClientSettings(old,{...options,autoCompactWindow:9999999}));
});
test('endpoint refuses remote plaintext, embedded credentials, path and redirect targets',()=>{
 for(const url of ['http://remote.example','https://key@remote.example','https://remote.example/v1','https://remote.example/?key=x'])assert.throws(()=>eventEndpoint(url));
 assert.equal(eventEndpoint('https://gateway.example'), 'https://gateway.example/api/v1/context/events');
});
test('1m selection is explicit and bounded by both exact route declarations',()=>{
 const options={scriptPath:'/tmp/hook.mjs',nodePath:'/bin/node',baseUrl:'http://127.0.0.1:9000',clientId:'client',model:'claude-fable-5-1',contextTokens:1000000,capabilityContextTokens:1000000};
 assert.equal(claudeClientSettings({},options).model,'claude-fable-5-1[1m]');
 assert.equal(claudeClientSettings({}, {...options,model:'claude-fable-5-1[1m]'}).model,'claude-fable-5-1[1m]');
 assert.throws(()=>claudeClientSettings({}, {...options,capabilityContextTokens:200000}));
 assert.throws(()=>claudeClientSettings({}, {...options,contextTokens:undefined}));
});
test('PostCompact reports exact session but never infers counts from summary or stale transcript',()=>{
 assert.equal(event.eventId,id);assert.equal(event.clientSessionId,boundary.sessionId);assert.equal(event.beforeTokens,undefined);assert.equal(event.afterTokens,undefined);assert.equal(event.tokenMeasurementMethod,undefined);assert.ok(!JSON.stringify(event).includes('Never transmit'));
 for(const patch of [{hook_event_name:'PreCompact'},{session_id:''},{trigger:'unknown'}]) assert.throws(()=>compactEvent({...input,...patch},{clientId:'claude-code'}));
 assert.notEqual(compactEvent(input,{clientId:'claude-code'}).eventId,compactEvent(input,{clientId:'claude-code'}).eventId);
});
test('authenticated delivery retains exact payload and duplicate uses same identity without retries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'client-event-outbox-'));let calls=0;
 const options={baseUrl:'http://127.0.0.1:9000',apiKey:'synthetic-local-key',outboxDir:dir,fetchImpl:async(url,init)=>{assert.equal(new URL(url).pathname,'/api/v1/context/events');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer synthetic-local-key');assert.deepEqual(JSON.parse(init.body),event);return ack(calls++>0);}};
 const first=await sendClientEvent(event,options),second=await sendClientEvent(event,options);assert.equal(first.status,201);assert.equal(second.duplicate,true);assert.equal(calls,2);assert.equal((await readdir(dir)).length,1);assert.deepEqual(JSON.parse(await readFile(first.retainedPath,'utf8')),event);
});
test('abort before send makes zero requests; uncertain send is retained and never replayed',async()=>{
 let calls=0;const dir=await mkdtemp(join(tmpdir(),'client-event-error-'));const options={baseUrl:'http://127.0.0.1:9000',apiKey:'synthetic-local-key',outboxDir:dir,fetchImpl:async()=>{calls++;throw new Error('uncertain');}};
 await assert.rejects(sendClientEvent(event,{...options,signal:AbortSignal.abort()}));assert.equal(calls,0);
 await assert.rejects(sendClientEvent(event,options),/uncertain/);assert.equal(calls,1);assert.equal((await readdir(dir)).length,1);
});
test('refusals, wrong acknowledgements, excessive responses and unsupported fields fail closed',async()=>{
 const options={baseUrl:'http://127.0.0.1:9000',apiKey:'synthetic-local-key'};
 for(const response of [Response.json({},{status:401}),Response.json({},{status:409}),Response.json({event:{clientEventId:'wrong'},duplicate:false},{status:201}),new Response('x'.repeat(65537))])await assert.rejects(sendClientEvent(event,{...options,fetchImpl:async()=>response}));
 await assert.rejects(sendClientEvent({...event,compact_summary:'private'},options));
});
test('outbox capacity, admission lock and incomplete retained packet refuse unsafe replay',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'client-event-bounds-'));let calls=0;const options={baseUrl:'http://127.0.0.1:9000',apiKey:'synthetic-local-key',outboxDir:dir,fetchImpl:async()=>{calls++;return ack();}};
 const saved=await sendClientEvent(event,options);await writeFile(saved.retainedPath,'partial');await assert.rejects(sendClientEvent(event,options),/incomplete or changed/);assert.equal(calls,1);
 const full=await mkdtemp(join(tmpdir(),'client-event-full-'));await Promise.all(Array.from({length:256},(_,i)=>writeFile(join(full,`${i}.json`),'{}')));await assert.rejects(sendClientEvent(event,{...options,outboxDir:full}),/outbox is full/);assert.equal(calls,1);
});
test('mid-request cancellation keeps the exact event and does not repeat delivery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'client-event-cancel-'));const controller=new AbortController();let calls=0;
 const pending=sendClientEvent(event,{baseUrl:'http://127.0.0.1:9000',apiKey:'synthetic-local-key',outboxDir:dir,signal:controller.signal,fetchImpl:async(_url,{signal})=>{calls++;queueMicrotask(()=>controller.abort());return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
 await assert.rejects(pending);assert.equal(calls,1);assert.equal((await readdir(dir)).length,1);
});
test('configuration CLI creates reviewable settings and refuses output overwrite',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'client-config-cli-')),source=join(dir,'source.json'),output=join(dir,'review.json');
 const original={env:{UNCHANGED:'preserve'},hooks:{Stop:[{hooks:[{type:'command',command:'old-hook'}]}]}};await writeFile(source,JSON.stringify(original));
 const args=['scripts/tokenproxy-client-config.mjs',source,output,'https://gateway.example','actual-client','1000000','claude-opus-5','1000000','1000000'];
 execFileSync(process.execPath,args,{stdio:'pipe'});const result=JSON.parse(await readFile(output,'utf8'));assert.equal(result.model,'claude-opus-5[1m]');assert.deepEqual(result.hooks.Stop,original.hooks.Stop);assert.deepEqual(JSON.parse(await readFile(source,'utf8')),original);
 assert.throws(()=>execFileSync(process.execPath,args,{stdio:'pipe'}));
});
