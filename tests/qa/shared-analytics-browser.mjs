import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { authenticateRedesign, installRedesignBrowser } from '../e2e/redesign-fixtures/browser.mjs';
const root=process.argv[2],output=resolve(process.argv[3]);await mkdir(output,{recursive:true});
const runtimeReceipt=JSON.parse(await readFile(join(root,'process.json'),'utf8'));
const browser=await chromium.launch({headless:true});
try {
 const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});await authenticateRedesign(context,root);
 const page=await context.newPage();const fixture=await installRedesignBrowser(page,{baseUrl:runtimeReceipt.url,runtimeReceipt});
 await page.goto(`${runtimeReceipt.url}/dashboard/system`,{waitUntil:'domcontentloaded',timeout:120000});
 await page.getByRole('heading',{name:'Request capacity'}).waitFor({timeout:120000});
 await context.request.get(`${runtimeReceipt.url}/api/analytics?view=economics`);
 const original=await (await context.request.get(`${runtimeReceipt.url}/api/system/admission`)).json();
 if(original.policy.memoryBudgetMb===1){original.policy.memoryBudgetMb=2048;original.policy.minSamples=5;}
 const shared=await page.evaluate(async()=>{
   const subscribers=await Promise.all([0,1].map(async()=>{const abort=new AbortController();const response=await fetch('/api/usage/stream?period=today',{signal:abort.signal});if(!response.ok)throw Error(`stream ${response.status}`);const reader=response.body.getReader();const chunk=await reader.read();return {abort,reader,frame:JSON.parse(new TextDecoder().decode(chunk.value).slice(6))};}));
   window.analyticsSubscribers=subscribers;return subscribers.map(s=>s.frame.projection);
 });
 assert.equal(shared.length,2);assert.equal(shared[0].computedAt,shared[1].computedAt);assert.equal(shared[0].version,shared[1].version);
 // Both subscribers deliberately stop consuming while actual controls remain in use.
 await page.getByText('Handler, provider and pressure limits',{exact:true}).click();
 await page.getByLabel('Memory budget (MiB)',{exact:true}).fill('2');await page.getByLabel('Memory budget (MiB)',{exact:true}).fill('1');
 await page.getByLabel('Minimum samples',{exact:true}).fill('1');
 await page.getByRole('button',{name:'Save request capacity'}).click();
 await page.getByRole('status').filter({hasText:'Admission policy saved.'}).waitFor();
 await page.waitForFunction(async()=>{const r=await fetch('/api/system/admission');const d=await r.json();return d.smoothedPressure>1;},{},{timeout:15000});
 const analyticsUrl=`${runtimeReceipt.url}/api/analytics?view=economics&facets=summary%2Cgroups%2Cseries%2Citems&groupBy=provider&pageSize=25&groupPageSize=12&groupSortBy=recordedCostUsd&groupSortDirection=desc`;
 const analyticsPending=Promise.all(Array.from({length:8},()=>context.request.get(analyticsUrl)));
 await page.getByLabel('Maximum streams',{exact:true}).fill(String(original.policy.maxStreams===96?97:96));
 await page.getByRole('button',{name:'Save request capacity'}).click();await page.getByRole('status').filter({hasText:'Admission policy saved.'}).waitFor();
 const saved=await (await context.request.get(`${runtimeReceipt.url}/api/system/admission`)).json();assert.equal(saved.policy.memoryBudgetMb,1);
 const accountControl=await page.evaluate(async()=>{
   const path='/api/providers/connection-fixture-alpha';
   const read=async()=>{const response=await fetch(path);if(!response.ok)throw Error(`account read ${response.status}`);return (await response.json()).connection;};
   const before=await read();
   const expected=row=>({isActive:row.isActive!==false,priority:row.priority??null,quotaPauseThresholds:row.quotaPauseThresholds||{}});
   const write=async(row,isActive)=>{const response=await fetch(path,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({isActive,expectedControls:expected(row)})});if(!response.ok)throw Error(`account control ${response.status}`);};
   await write(before,!before.isActive);const changed=await read();if(changed.isActive===before.isActive)throw Error('Account control did not persist');
   await write(changed,before.isActive);const restored=await read();if(restored.isActive!==before.isActive)throw Error('Account control did not restore');
   return {id:'connection-fixture-alpha',changed:true,restored:true};
 });
 const reads=await analyticsPending;
 const analytics=[];for(const response of reads){assert.equal(response.status(),200);const body=await response.json();assert.equal(body.projection.mode,'reduced');assert.equal(response.headers()['x-tokenproxy-refresh-after-ms'],'60000');assert(Number(response.headers()['x-tokenproxy-analytics-query-ms'])>=0);analytics.push({status:response.status(),projection:body.projection,freshness:body.freshness});}
 const viewports=[];for(const [width,height] of [[1440,1000],[1920,1080],[390,844]]){await page.setViewportSize({width,height});await page.getByRole('heading',{name:'Request capacity'}).evaluate(n=>n.scrollIntoView({block:'start'}));await page.evaluate(()=>window.scrollBy(0,-72));const file=join(output,`shared-analytics-${width}x${height}.png`);await page.screenshot({path:file});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);viewports.push({width,height,file,overflow});}
 const cancelled=await page.evaluate(async()=>{for(const s of window.analyticsSubscribers){s.abort.abort();await s.reader.cancel().catch(()=>{});}return window.analyticsSubscribers.length;});assert.equal(cancelled,2);
 const initialReads=[];page.on('response',response=>{if(new URL(response.url()).pathname==='/api/analytics')initialReads.push({url:response.url(),status:response.status()});});
 await page.goto(`${runtimeReceipt.url}/dashboard/usage`,{waitUntil:'domcontentloaded',timeout:120000});
 await page.getByRole('heading',{name:'Economics'}).waitFor({timeout:120000});
 await page.waitForFunction(()=>document.querySelector('[aria-label="Economics by cohort"]') || document.body.textContent.includes('No cohorts'),{},{timeout:120000});
 assert.equal(initialReads.length,1);assert.equal(initialReads[0].status,200);assert.equal(new URL(initialReads[0].url).searchParams.get('facets'),'summary,groups,series,items');
 const restore=await context.request.put(`${runtimeReceipt.url}/api/system/admission`,{data:original.policy});assert.equal(restore.status(),200);
 const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(`${runtimeReceipt.url}/api/usage/stream`)).status(),401);await anonymous.close();
 assert.deepEqual(fixture.outboundFailures,[]);
 const receipt={runtimeReceipt,shared,analytics,economicsInitialReads:initialReads,viewports,simultaneousSubscribers:2,cancelled,controlSaveUnderPressure:true,accountControl,restoredPolicy:true,unauthenticatedStatus:401,synthetic:true,paidUpstreamCalls:0,latencyQualification:false,outboundFailures:fixture.outboundFailures};
 await writeFile(join(output,'browser-receipt.json'),JSON.stringify(receipt,null,2));console.log('SHARED ANALYTICS BROWSER PASS 2 subscribers; 8 actual analytics reads; control saved under measured pressure; 3 viewports');
}finally{await browser.close();}
