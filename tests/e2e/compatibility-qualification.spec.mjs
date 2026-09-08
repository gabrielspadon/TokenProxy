import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { sourceManifest } from '../../scripts/redesign-preview.mjs';
const root=process.argv[2], artifacts=process.argv[3];
assert.ok(root && artifacts,'Pass an independently owned preview root and evidence directory');
const receipt=JSON.parse(await readFile(join(root,'process.json'),'utf8'));
const marker=JSON.parse(await readFile(join(root,'compatibility-gateway.json'),'utf8'));
assert.equal(marker.runId,receipt.runId);assert.equal(marker.root,root);
await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
const page=await context.newPage();const guarded=await installRedesignBrowser(page,{baseUrl:receipt.url,runtimeReceipt:receipt});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await authenticateRedesign(context,root);
  await page.goto(receipt.url+'/dashboard/compatibility');
  await page.getByRole('button',{name:'Insert synthetic tool round trip',exact:true}).waitFor();
  await page.getByRole('button',{name:'Insert synthetic tool round trip',exact:true}).click();
  await page.getByLabel('Execution scope',{exact:true}).selectOption('controlled-gateway-routing');
  await page.getByLabel(/^Target format/).selectOption('openai');
  await page.getByLabel('Versioned scenario',{exact:true}).selectOption('tool-ordering');
  await page.getByLabel('Fixture name',{exact:true}).fill('Controlled gateway tool ordering');
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'Save fixture',exact:true}).click();
  await page.getByText('Revision 1 retained and read back. No run was started.',{exact:true}).waitFor();
  const fixtures=await (await context.request.get(receipt.url+'/api/admin/compatibility')).json();
  const fixture=fixtures.fixtures.find(item=>item.name==='Controlled gateway tool ordering');assert.ok(fixture);
  await page.getByRole('button',{name:'Run revision 1',exact:true}).first().click();
  await page.getByText('Local checks passed',{exact:true}).waitFor({timeout:20000});
  assert.equal(await page.getByRole('tab',{name:'Runs',exact:true}).getAttribute('aria-selected'),'true');
  const runList=await (await context.request.get(receipt.url+'/api/admin/compatibility/runs')).json();
  let run=runList.items.find(item=>item.fixtureId===fixture.id);assert.equal(run.status,'succeeded');assert.equal(run.scope,'controlled-gateway-routing');
  assert.ok(run.result.checks.every(check=>check.outcome==='passed'));
  const baseline=run;
  const repeat=await (await context.request.post(receipt.url+'/api/admin/compatibility/runs',{data:{fixtureId:fixture.id,revision:fixture.revision}})).json();
  for(let attempt=0;attempt<30;attempt++) { const packet=await (await context.request.get(receipt.url+'/api/admin/compatibility/runs/'+repeat.id)).json(); if(packet.run.status==='succeeded'){run=packet.run;break;} await new Promise(resolve=>setTimeout(resolve,100)); }
  assert.equal(run.id,repeat.id);
  await page.getByRole('button',{name:'Refresh retained evidence',exact:true}).click();
  await page.getByRole('button',{name:'Inspect run '+run.id,exact:true}).click();
  await page.getByRole('tab',{name:'Compare',exact:true}).click();
  await page.getByLabel('Exact baseline',{exact:true}).selectOption(baseline.id);
  await page.getByRole('button',{name:'Compare baseline',exact:true}).click();
  await page.getByText('0 observed check regressions against '+baseline.id+'.',{exact:true}).waitFor();

  await page.getByRole('tab',{name:'Receipt',exact:true}).click();
  await page.getByText(run.result.implementationHash,{exact:false}).waitFor();
  const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Export this run',exact:true}).click();
  const download=await downloadEvent;await download.saveAs(join(artifacts,'export.json'));
  const exported=JSON.parse(await readFile(join(artifacts,'export.json'),'utf8'));assert.equal(exported.run.id,run.id);assert.equal(exported.manifest.scope,run.scope);
  assert.equal(exported.comparison.comparable,true);
  await context.request.post(receipt.url+'/api/admin/compatibility/runs/'+run.id+'/cancel');
  const pending=await (await context.request.post(receipt.url+'/api/admin/compatibility/runs',{data:{fixtureId:fixture.id,revision:fixture.revision}})).json();
  const cancelled=await (await context.request.post(receipt.url+'/api/admin/compatibility/runs/'+pending.id+'/cancel')).json();
  assert.equal(cancelled.status,'cancelled');
  const retainedCancelled=await (await context.request.get(receipt.url+'/api/admin/compatibility/runs/'+pending.id)).json();assert.equal(retainedCancelled.run.status,'cancelled');

  await page.getByRole('tab',{name:'Checks',exact:true}).click();
  for(const [width,height] of [[1440,1000],[1920,1080],[390,844]]) {
    await page.setViewportSize({width,height});await page.screenshot({path:join(artifacts,`runs-${width}x${height}.png`),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'No horizontal document overflow');
  }
  await page.getByRole('button',{name:'Close selection details',exact:true}).click();
  await page.getByRole('tab',{name:'Evidence matrix',exact:true}).click();
  await page.getByRole('button',{name:'Refresh retained evidence',exact:true}).count();
  await page.screenshot({path:join(artifacts,'matrix-390.png'),fullPage:true});
  await page.goto(`${receipt.url}/dashboard/compatibility?runId=${run.id}&compareRunId=${baseline.id}&checkId=tool-ordering`);
  await page.getByText('0 observed check regressions against '+baseline.id+'.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('tab',{name:'Compare',exact:true}).getAttribute('aria-selected'),'true');

  // Real HTTP admission, model/account routing, maintained executor and complete
  // response consumption. The preload substitutes only the fixed upstream.
  const data={model:'openai/gpt-4o-mini',messages:[{role:'user',content:'compatibility-gateway-v1 synthetic request'}],stream:false,max_tokens:32};
  const anonymous=await browser.newContext({serviceWorkers:'block'});
  const missing=await anonymous.request.post(receipt.url+'/v1/chat/completions',{data});assert.ok([401,403].includes(missing.status()),await missing.text());
  const forbiddenAdmin=await anonymous.request.get(receipt.url+'/api/admin/compatibility');assert.ok([401,403].includes(forbiddenAdmin.status()));
  const keyResponse=await context.request.post(receipt.url+'/api/keys',{data:{name:'Synthetic compatibility gateway key'}});assert.equal(keyResponse.status(),201,await keyResponse.text());const key=await keyResponse.json();
  const completed=await anonymous.request.post(receipt.url+'/v1/chat/completions',{data,headers:{authorization:`Bearer ${key.key}`},timeout:60000});const completedBody=await completed.json();assert.equal(completed.status(),200,JSON.stringify(completedBody));assert.equal(completedBody.choices[0].message.content,'Controlled gateway answer.');
  const streamed=await anonymous.request.post(receipt.url+'/v1/chat/completions',{data:{...data,stream:true},headers:{authorization:`Bearer ${key.key}`},timeout:60000});const streamText=await streamed.text();assert.equal(streamed.status(),200,streamText);assert.equal(streamText.match(/data: \[DONE\]/g)?.length,1);assert.match(streamText,/Controlled gateway answer/);
  await anonymous.close();
  const auth=JSON.parse(await readFile(join(root,'preview-auth.json'),'utf8'));const live=await (await context.request.get(receipt.url+'/__redesign_owner',{headers:{'x-redesign-owner':auth.ownerToken}})).json();
  assert.equal(live.guard.compatibilityDispatches,2);assert.deepEqual(guarded.outboundFailures,[]);assert.deepEqual(errors,[]);
  await writeFile(join(artifacts,'receipt.json'),JSON.stringify({scope:'controlled-http-gateway',runtime:receipt,sourceAtVerification:await sourceManifest(),fixtureId:fixture.id,fixtureRevision:fixture.revision,fixtureHash:fixture.contentHash,runId:run.id,implementationHash:run.result.implementationHash,cancelledRunId:cancelled.id,comparison:exported.comparison,http:{missingKey:missing.status(),anonymousAdmin:forbiddenAdmin.status(),jsonStatus:completed.status(),streamStatus:streamed.status(),syntheticDispatches:live.guard.compatibilityDispatches,usage:completedBody.usage},guard:live.guard,outboundFailures:guarded.outboundFailures,pageErrors:errors,externalProviderCalls:0,credentialsRead:false,limitations:['Fixed synthetic upstream transport; no authenticated provider request or real proxy socket','Development runtime uses live source; source manifest captured at verification'],screenshotsInspected:false},null,2));
  console.log('PASS compatibility retained UI, export, responsive layout and complete HTTP gateway admission/routing/JSON/SSE; 2 controlled dispatches; 0 provider calls');
}finally{await browser.close();}
