import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright';
import { authenticateRedesign,installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { sourceManifest } from '../../scripts/redesign-preview.mjs';
const root=process.argv[2],artifacts=process.argv[3],receipt=JSON.parse(await readFile(join(root,'process.json'),'utf8'));
await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true}),context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}}),page=await context.newPage();
const guarded=await installRedesignBrowser(page,{baseUrl:receipt.url,runtimeReceipt:receipt}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await authenticateRedesign(context,root);
 const response=await context.request.post(receipt.url+'/api/keys',{data:{name:'Client integration synthetic key'}});assert.equal(response.status(),201);const key=await response.json();
 const env={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,TOKENPROXY_BASE_URL:receipt.url,TOKENPROXY_API_KEY:key.key,TOKENPROXY_CLIENT_ID:'claude-code-controlled',TOKENPROXY_EVENT_OUTBOX:join(root,'client-outbox')};
 const emitter=resolve('scripts/tokenproxy-client-events.mjs');
 const session=randomUUID(),now=new Date().toISOString(),transcript=join(root,'client-transcript.jsonl');
 await writeFile(transcript,JSON.stringify({type:'system',subtype:'compact_boundary',sessionId:session,uuid:randomUUID(),timestamp:now,compactMetadata:{trigger:'auto',preTokens:167145,postTokens:30779}})+'\n');
 const hook={hook_event_name:'PostCompact',session_id:session,transcript_path:transcript,trigger:'auto',compact_summary:'Synthetic private summary that must never enter telemetry'};
 const invoked=spawnSync(process.execPath,[emitter,'hook'],{input:JSON.stringify(hook),env,encoding:'utf8'});assert.equal(invoked.status,0,invoked.stderr);assert.equal(invoked.stdout,'');
 const ack=JSON.parse(invoked.stderr),eventId=ack.eventId;
 const send=async(event)=>{const path=join(root,`${event.eventId}.json`);await writeFile(path,JSON.stringify(event));return JSON.parse(execFileSync(process.execPath,[emitter,'send',path],{env,encoding:'utf8'}));};
 const retry=await send(JSON.parse(await readFile(ack.retainedPath,'utf8')));assert.equal(retry.duplicate,true);
 const handoff=await send({eventId:randomUUID(),occurredAt:now,type:'handoff',clientId:env.TOKENPROXY_CLIENT_ID,clientSessionId:session,taskId:'source-task',targetClientId:'explicit-target-client',targetTaskId:'target-task'});
 const cancelled=await send({eventId:randomUUID(),occurredAt:now,type:'task_outcome',clientId:env.TOKENPROXY_CLIENT_ID,clientSessionId:session,taskId:'source-task',outcome:'cancelled'});
 const failed=await send({eventId:randomUUID(),occurredAt:now,type:'task_outcome',clientId:env.TOKENPROXY_CLIENT_ID,clientSessionId:session,taskId:'failure-task',outcome:'failure'});
 const start=await send({eventId:randomUUID(),occurredAt:now,type:'task_start',clientId:env.TOKENPROXY_CLIENT_ID,clientSessionId:session,taskId:'actual-client-task'});
 const eventUrl=receipt.url+'/api/context/events?from='+encodeURIComponent(new Date(Date.now()-3600000).toISOString())+'&to='+encodeURIComponent(new Date(Date.now()+60000).toISOString());
 const retained=await(await context.request.get(eventUrl)).json();assert.ok(retained.events,JSON.stringify(retained));
 const compact=retained.events.filter(e=>e.clientEventId===eventId);assert.equal(compact.length,1);assert.equal(compact[0].beforeTokens,null);assert.equal(compact[0].afterTokens,null);assert.equal(compact[0].requestId,null);assert.equal(compact[0].tokenMeasurementMethod,null);
 const anonymous=await browser.newContext();const missing=await anonymous.request.post(receipt.url+'/api/v1/context/events',{data:{}});assert.equal(missing.status(),401);
 const conflict=await anonymous.request.post(receipt.url+'/api/v1/context/events',{headers:{authorization:`Bearer ${key.key}`},data:{eventId,occurredAt:now,type:'compaction',clientId:'changed-client'}});assert.equal(conflict.status(),409);
 const invalidLink=await anonymous.request.post(receipt.url+'/api/v1/context/events',{headers:{authorization:`Bearer ${key.key}`},data:{eventId:randomUUID(),occurredAt:now,type:'handoff',clientId:env.TOKENPROXY_CLIENT_ID,targetClientId:'target',requestId:randomUUID()}});assert.equal(invalidLink.status(),404);await anonymous.close();
 await page.goto(receipt.url+'/dashboard/context');await page.getByRole('button',{name:'Browse client reports',exact:true}).click();
 await page.getByRole('heading',{name:'compaction',exact:true}).waitFor();
 const article=page.getByRole('heading',{name:'compaction',exact:true}).locator('..').locator('..');
 await article.getByText('Exact report links',{exact:true}).click();await article.getByText(eventId,{exact:true}).waitFor();
 await page.getByText('cancelled',{exact:true}).first().waitFor();await page.getByText('failure',{exact:true}).first().waitFor();
 for(const [width,height] of [[1440,1000],[1920,1080],[390,844]]){await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(artifacts,`context-${width}x${height}.png`),fullPage:true});}
 await page.goto(receipt.url+'/dashboard/keys');await page.getByRole('button',{name:'Configure Client integration synthetic key',exact:true}).click();await page.getByText('Client setup',{exact:true}).first().click();await page.getByRole('heading',{name:'Native client context boundary'}).waitFor();
 await page.getByLabel('Gateway advertised context tokens',{exact:true}).fill('1000000');await page.getByLabel('Native resolved window tokens',{exact:true}).fill('200000');await page.getByLabel('Native model maximum output tokens',{exact:true}).fill('32000');
 await page.getByText('167,000 tokens',{exact:true}).waitFor();for(const [width,height] of [[1440,1000],[1920,1080],[390,844]]){await page.setViewportSize({width,height});await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});await page.screenshot({path:join(artifacts,`client-setup-${width}x${height}.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
 const auth=JSON.parse(await readFile(join(root,'preview-auth.json'),'utf8')),live=await(await context.request.get(receipt.url+'/__redesign_owner',{headers:{'x-redesign-owner':auth.ownerToken}})).json();
 assert.deepEqual(guarded.outboundFailures,[]);assert.deepEqual(errors,[]);
 await writeFile(join(artifacts,'receipt.json'),JSON.stringify({scope:'controlled-client-emitter-authenticated-event-api-renderer',runtime:receipt,sourceAtVerification:await sourceManifest(),events:{compaction:compact[0],handoff,cancelled,failed,start},duplicateRetainedCount:1,http:{missingKey:missing.status(),changedPayload:conflict.status(),invalidLink:invalidLink.status()},guard:live.guard,pageErrors:errors,outboundFailures:guarded.outboundFailures,providerRequests:0,nativeCompactionTriggered:false,screenshotsInspected:false},null,2));
 console.log('PASS client integration emitter, exact retained events, duplicate/error handling, Context renderer and truthful native boundary; 0 provider calls');
}finally{await browser.close();}
