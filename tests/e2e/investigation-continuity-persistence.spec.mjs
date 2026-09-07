import { test, expect } from 'playwright/test';
import { signIn } from './helpers.mjs';

async function read(page,path) {
  const response=await page.request.get(path);
  expect(response.headers()['x-tokenproxy-preview-kind']).toBe('synthetic-fixture');
  expect(response.status()).toBe(200);return response.json();
}
async function openSaved(page) {
  await page.getByRole('button',{name:'Saved investigations',exact:true}).click();
  return page.getByRole('dialog',{name:'Saved investigations',exact:true});
}
async function save(page,name) {
  const dialog=await openSaved(page);
  await dialog.getByRole('textbox',{name:'Name',exact:true}).fill(name);
  const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/investigations'&&response.request().method()==='POST');
  await dialog.getByRole('button',{name:'Save new entry',exact:true}).click();
  const response=await pending;expect(response.status()).toBe(200);
  const entry=await response.json();
  await dialog.getByText('Investigation saved as version 1.',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Close saved investigations',exact:true}).click();
  return entry;
}
test('shared filters, selected account and comparison persist across lenses, reload and evidence export',async({page},testInfo)=>{
  test.setTimeout(90000);
  page.setDefaultTimeout(10000);
  expect(process.env.E2E_BASE).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):20360$/);
  expect(process.env.SMOKE_PASSWORD).toBeTruthy();
  await signIn(page);
  const health=await read(page,'/api/admin/health/detail');
  expect(health.checks.connections.some(row=>row.connectionId==='capacity-fixture-a')).toBe(true);
  const created=[];
  try {
    await page.goto('/dashboard');
    await page.getByRole('button',{name:'Synthetic research account',exact:true}).click();
    await page.getByRole('checkbox',{name:'Compare Synthetic research account (codex)',exact:true}).check();
    await page.getByRole('checkbox',{name:'Compare Synthetic batch account (codex)',exact:true}).check();
    await page.getByRole('combobox',{name:'Provider filter',exact:true}).click();
    await page.getByRole('option',{name:'Codex',exact:true}).click();
    const entry=await save(page,'Synthetic connected investigation');created.push(entry.id);
    expect(entry.definition).toMatchObject({scope:{provider:'codex'},selection:{kind:'account',id:'capacity-fixture-a'},comparisonIds:['capacity-fixture-a','capacity-fixture-b']});
    for (const lens of ['Context','Economics','Capacity']) {
      await page.getByRole('link',{name:lens,exact:true}).click();
      await expect(page.getByRole('combobox',{name:'Provider filter',exact:true})).toHaveValue('Codex');
      await expect(page.getByLabel('Retained evidence selection')).toContainText('Synthetic research account');
      await expect(page.getByLabel('Retained evidence selection')).toContainText('2 comparison accounts');
    }
    await page.reload();
    await expect(page.getByLabel('Retained evidence selection')).toContainText('Synthetic research account');
    await page.getByRole('button',{name:'Export evidence',exact:true}).click();
    const exportDialog=page.getByRole('dialog',{name:'Export recorded evidence',exact:true});
    const download=page.waitForEvent('download');
    await exportDialog.getByRole('button',{name:'Download JSON evidence',exact:true}).click();
    const file=await download;
    const chunks=[];for await(const chunk of await file.createReadStream())chunks.push(chunk);
    const result=JSON.parse(Buffer.concat(chunks).toString());
    expect(result.items.map(row=>row.id)).toEqual(['capacity-fixture-a']);
    expect(result.manifest.preview.kind).toBe('synthetic-fixture');
    expect(result.manifest.complete).toBe(true);
    await testInfo.attach('connected-investigation',{body:JSON.stringify({fixture:'operator-workspace-v2',selected:entry.definition.selection,comparisonIds:entry.definition.comparisonIds,exported:result.manifest,upstreamCalls:0}),contentType:'application/json'});
    await exportDialog.getByRole('button',{name:'Close evidence export',exact:true}).click();

    // Keep A selected, then delete B after another operator advances B.
    const second=await save(page,'Synthetic independently deleted definition');created.push(second.id);
    let dialog=await openSaved(page);
    await dialog.getByRole('button',{name:`Restore ${entry.name}`,exact:true}).click();
    dialog=await openSaved(page);
    await dialog.getByRole('button',{name:`Delete ${second.name}`,exact:true}).click();
    const competing=await page.request.put(`/api/admin/investigations/${second.id}`,{data:{name:second.name,kind:second.kind,definition:second.definition,version:second.version}});
    expect(competing.status()).toBe(200);
    await dialog.getByRole('button',{name:'Delete saved entry',exact:true}).click();
    await expect(dialog).toContainText('Another view changed this entry');
    await dialog.getByRole('button',{name:'Reload saved version',exact:true}).click();
    await expect(dialog).toContainText('Latest saved version loaded.');
    await dialog.getByRole('button',{name:'Delete saved entry',exact:true}).click();
    await expect(dialog).toContainText('Saved entry deleted.');
    expect((await read(page,'/api/admin/investigations')).items.some(row=>row.id===entry.id)).toBe(true);
    await dialog.getByRole('button',{name:'Close saved investigations',exact:true}).click();

    await page.getByLabel('Shared analysis scope').getByRole('button',{name:'Observation mode: Snapshot',exact:true}).click();
    const observation=page.getByRole('dialog',{name:'Workspace observations',exact:true});
    await expect(observation).toContainText('Live updates are unavailable');
    await observation.getByLabel('Update behavior',{exact:true}).click();
    await page.getByRole('option',{name:'Pause background updates',exact:true}).click();
    await observation.getByRole('button',{name:'Apply observation behavior',exact:true}).click();
    await page.getByRole('button',{name:'Refresh workspace data',exact:true}).click();
    await expect(page.getByLabel('Retained evidence selection')).toContainText('Synthetic research account');
  } finally {
    for(const id of created) {
      const response=await page.request.get(`/api/admin/investigations/${id}`);
      if(response.status()===404)continue;
      expect(response.status()).toBe(200);const row=await response.json();
      expect((await page.request.delete(`/api/admin/investigations/${id}`,{data:{version:row.version}})).status()).toBe(200);
    }
  }
});
