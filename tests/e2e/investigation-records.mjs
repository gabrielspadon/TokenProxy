import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const directory=process.env.EVIDENCE_DIR;
assert(directory && process.env.REAL_PREVIEW && process.env.SYNTHETIC_PREVIEW);
await mkdir(directory,{recursive:true});
const browser=await chromium.launch();
const report={checks:[],errors:[]};
const suffix=Date.now();
async function session(base,privateDirectory) {
  assert.equal(new URL(base).hostname,'127.0.0.1');
  const auth=JSON.parse(await readFile(path.join(privateDirectory,'preview-auth.json')));
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,reducedMotion:'reduce'});
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  assert.equal((await page.request.post(`${base}/api/auth/login`,{data:{password:auth.initialPassword}})).status(),200);
  return {page,context};
}
async function savedDialog(page) {
  await page.getByRole('button',{name:'Saved investigations',exact:true}).click();
  return page.getByRole('region',{name:'Saved investigations',exact:true});
}
async function save(page,kind,name) {
  const dialog=await savedDialog(page);
  await dialog.getByRole('textbox',{name:'Name',exact:true}).fill(name);
  await dialog.getByRole('combobox',{name:'Save as',exact:true}).click();
  await page.getByRole('option',{name:kind,exact:true}).click();
  const response=page.waitForResponse(response=>response.url().endsWith('/api/admin/investigations') && response.request().method()==='POST');
  await dialog.getByRole('button',{name:'Save new entry',exact:true}).click();
  const result=await response;assert.equal(result.status(),200);const entry=await result.json();
  await dialog.getByRole('status').waitFor();
  await page.getByRole('button',{name:'Close saved investigations',exact:true}).click();
  return entry;
}
async function restore(page,entry) {
  const dialog=await savedDialog(page);
  await dialog.getByRole('button',{name:`Restore ${entry.name}`,exact:true}).click();
}
async function exported(page) {
  await page.getByRole('button',{name:'Export evidence',exact:true}).click();
  const dialog=page.getByRole('region',{name:'Export recorded evidence',exact:true});
  const downloaded=page.waitForEvent('download');
  await dialog.getByRole('button',{name:'Download JSON evidence',exact:true}).click();
  const result=JSON.parse(await readFile(await (await downloaded).path(),'utf8'));
  await page.getByRole('button',{name:'Close evidence export',exact:true}).click();
  return result;
}
async function provider(page,name) {
  await page.getByRole('combobox',{name:'Provider filter',exact:true}).click();
  await page.getByRole('option',{name,exact:true}).click();
}
async function capture(page,name) {
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(directory,name),fullPage:true,mask:[page.locator('.keys-secret')]});
}
let active;
try {
  const real=await session('http://127.0.0.1:20310',process.env.REAL_PREVIEW);active=real.page;
  await active.goto('http://127.0.0.1:20310/dashboard/usage');
  const row=active.locator('table[aria-label="Recorded requests"] [aria-label^="Inspect record "]').first();
  await row.waitFor();const recordId=(await row.getAttribute('aria-label')).split(' ').at(-1);
  await row.focus();await active.keyboard.press('Enter');
  await active.getByText(`Completion record ${recordId}`,{exact:true}).waitFor();
  const bookmark=await save(active,'Record bookmark',`Ledger bookmark ${suffix}`);
  assert.equal(bookmark.definition.selection.id,recordId);
  await active.reload();await active.getByRole('button',{name:'Saved investigations',exact:true}).waitFor();
  await restore(active,bookmark);await active.getByText(`Completion record ${recordId}`,{exact:true}).waitFor();
  const ledger=await exported(active);assert.equal(ledger.items.length,1);assert.equal(String(ledger.items[0].id),recordId);assert.equal(ledger.manifest.source,'usageHistory');
  await capture(active,'legacy-ledger-bookmark.png');
  report.checks.push({legacyLedgerBookmark:true,recordId,requestId:ledger.items[0].requestId,exactExport:true});
  await provider(active,'Codex');
  const filters=await save(active,'Named filter set',`Codex filter set ${suffix}`);
  assert.equal(filters.definition.selection,null);
  await provider(active,'Claude');await restore(active,filters);
  assert.equal(new URL(active.url()).pathname,'/dashboard/usage');
  assert.equal(await active.getByRole('combobox',{name:'Provider filter',exact:true}).inputValue(),'Codex');
  await active.getByLabel(`economics-record · ${recordId}`,{exact:true}).waitFor();
  report.checks.push({namedFiltersAcrossSelection:true,keptCurrentLens:true});
  const receiptResponse=active.waitForResponse(response=>response.url().includes('/api/admin/receipts?') && response.ok());
  await active.getByRole('link',{name:'Sessions',exact:true}).click();
  const scoped=await receiptResponse;assert.equal(new URL(scoped.url()).searchParams.get('provider'),'codex');
  const first=active.getByRole('button',{name:/^Select routing receipt /}).first();await first.waitFor();
  await first.click();
  const routing=await save(active,'Record bookmark',`Routing bookmark ${suffix}`);
  await active.reload();await active.getByRole('button',{name:'Saved investigations',exact:true}).waitFor();await restore(active,routing);
  const retained=active.getByRole('region',{name:'Selected routing evidence',exact:true});await retained.waitFor();
  await retained.getByRole('button',{name:`Select routing receipt ${routing.definition.selection.id}`,exact:true}).waitFor();
  const receipt=await exported(active);assert.equal(receipt.items[0].id,routing.definition.selection.id);assert.equal(receipt.items.length,1);
  await capture(active,'routing-bookmark.png');
  report.checks.push({sharedRoutingProvider:true,exactRoutingBookmark:true,receiptId:receipt.items[0].id});
  await real.context.close();

  const synthetic=await session('http://127.0.0.1:20311',process.env.SYNTHETIC_PREVIEW);active=synthetic.page;
  await active.goto('http://127.0.0.1:20311/dashboard/context');
  const cohort=active.getByRole('complementary',{name:'Recorded session cohort'}).locator('button[aria-pressed]');
  await cohort.first().waitFor();assert.equal(await active.getByRole('complementary',{name:'Recorded session cohort'}).locator('[aria-pressed="true"]').count(),0);
  assert.equal(await active.getByRole('table',{name:'Session request attempts'}).count(),0);
  await cohort.first().focus();await active.keyboard.press('Enter');
  const attempts=active.getByRole('table',{name:'Session request attempts'});await attempts.waitFor();
  for(const page of [2,3]) {
    const response=active.waitForResponse(response=>response.url().includes('/api/context/sessions/')&&new URL(response.url()).searchParams.get('page')===String(page)&&response.ok());
    await active.getByRole('button',{name:'Next attempts page',exact:true}).click();await response;
  }
  const last=attempts.getByRole('button',{name:/^Inspect attempt /}).last();await last.focus();await active.keyboard.press('Enter');
  const contextEntry=await save(active,'Investigation',`Synthetic context investigation ${suffix}`);
  assert.equal(contextEntry.definition.context.page,3);assert.equal(contextEntry.definition.selection.kind,'context-attempt');
  await active.getByRole('link',{name:'Capacity',exact:true}).click();
  await active.getByRole('link',{name:'Context',exact:true}).click();
  const stages=active.getByRole('table',{name:'Ordered shaping stages'});await stages.waitFor();assert.equal(await stages.locator('tbody tr').count(),14);
  await active.reload();await active.getByRole('button',{name:'Saved investigations',exact:true}).waitFor();await restore(active,contextEntry);await stages.waitFor();
  const contextExport=await exported(active);assert.equal(contextExport.items.length,1);assert.equal(contextExport.items[0].id,contextEntry.definition.selection.id);assert.equal(contextExport.items[0].stages.length,14);assert.equal(contextExport.manifest.preview.kind,'synthetic-fixture');
  await capture(active,'synthetic-context-restored-1440.png');
  await active.setViewportSize({width:1920,height:1080});await capture(active,'synthetic-context-restored-1920.png');
  report.contextAccessibility=(await new AxeBuilder({page:active}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}));assert.deepEqual(report.contextAccessibility,[]);
  report.checks.push({contextAcrossLensesAndReload:true,serverPage:3,exactRequest:contextEntry.definition.selection.id,exportStages:14,noAutomaticSelection:true});
  await active.setViewportSize({width:390,height:844});await capture(active,'synthetic-context-restored-mobile.png');assert.equal(await active.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);

  await active.setViewportSize({width:1440,height:1000});
  const key=JSON.parse(await readFile(path.join(process.env.SYNTHETIC_PREVIEW,'synthetic-key.json')));
  const keysResponse=await active.request.get('http://127.0.0.1:20311/api/keys');assert.equal(keysResponse.status(),200);assert(!(await keysResponse.text()).includes(key.key));
  await active.goto('http://127.0.0.1:20311/dashboard/keys');
  const keyRow=active.locator('.keys-row').filter({hasText:key.name});await keyRow.waitFor();
  await keyRow.locator('summary').click();
  assert(!(await active.locator('body').innerText()).includes(key.key));
  await keyRow.getByRole('button',{name:'Reveal key',exact:true}).click();
  const confirmation=active.getByRole('dialog',{name:`Reveal ${key.name}`,exact:true});await confirmation.waitFor();
  assert(!(await active.locator('body').innerText()).includes(key.key));
  await confirmation.getByRole('button',{name:'Reveal',exact:true}).click();
  const revealed=active.getByRole('dialog',{name:'Key revealed',exact:true});await revealed.waitFor();assert.equal(await revealed.locator('.keys-secret').innerText(),key.key);
  // Captures deliberately omit the revealed value even though it is synthetic.
  await revealed.getByRole('button',{name:'Cancel',exact:true}).click();await revealed.waitFor({state:'hidden'});
  assert(!(await active.locator('body').innerText()).includes(key.key));await capture(active,'synthetic-keys-after-close.png');
  report.checks.push({syntheticKeyListRedacted:true,explicitReveal:true,closeClearsValue:true});
  await active.clock.install();
  await keyRow.getByRole('button',{name:'Reveal key',exact:true}).click();
  await confirmation.getByRole('button',{name:'Reveal',exact:true}).click();await revealed.waitFor();
  await active.clock.fastForward(61000);await revealed.waitFor({state:'hidden'});assert(!(await active.locator('body').innerText()).includes(key.key));
  let release;const held=new Promise(resolve=>{release=resolve;});
  let intercepted;const observed=new Promise(resolve=>{intercepted=resolve;});
  await active.route('**/api/keys/*/reveal',async route=>{intercepted();await held;await route.continue();});
  await keyRow.getByRole('button',{name:'Reveal key',exact:true}).click();
  const response=active.waitForResponse(response=>response.url().endsWith(`/api/keys/${key.id}/reveal`));
  await confirmation.getByRole('button',{name:'Reveal',exact:true}).click();await observed;
  await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();release();await response;
  await active.clock.runFor(100);assert.equal(await revealed.count(),0);assert(!(await active.locator('body').innerText()).includes(key.key));
  await active.unroute('**/api/keys/*/reveal');
  report.checks.push({syntheticKeyTimeoutClears:true,acceleratedBrowserClockMs:61000,lateResponseCannotReopen:true});
  await active.setViewportSize({width:390,height:844});await capture(active,'synthetic-keys-mobile.png');assert.equal(await active.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(report.errors,[]);
} catch(error) {report.failure=error.message;if(active)await capture(active,'records-failure.png');throw error;}
finally {await writeFile(path.join(directory,'records-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();}
