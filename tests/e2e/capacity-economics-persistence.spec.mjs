import { test, expect } from 'playwright/test';
import { signIn } from './helpers.mjs';
import { CAPACITY_ECONOMICS_FIXTURE as fixture } from './capacity-economics-seed.mjs';
import { credentiallessDatabase } from './capacity-economics-fixture-guard.mjs';

const header = response => expect(response.headers()['x-tokenproxy-preview-kind']).toBe('synthetic-fixture');
async function read(page, url) {
  const response = await page.request.get(url, { maxRedirects:0 });
  header(response); expect(response.status(), url).toBe(200); return response.json();
}
async function enter(page) {
  expect(process.env.E2E_BASE).toBeTruthy(); expect(process.env.SMOKE_PASSWORD).toBeTruthy();
  expect(['127.0.0.1','localhost','[::1]']).toContain(new URL(process.env.E2E_BASE).hostname);
  const gate = await page.request.get('/api/admin/health'); header(gate);
  await signIn(page);
}
const fixed = new URLSearchParams({period:'custom',start:'2026-09-07T08:00:00.000Z',end:fixture.capturedAt});

test('Capacity saves a reviewed account drain and restores it through the actual API', async ({ page }, testInfo) => {
  test.setTimeout(90000); await enter(page);
  const db = credentiallessDatabase();
  const id = fixture.accountIds[0], receipts = [];
  const initial = (await read(page,'/api/admin/drain?all=true')).connections.find(row => row.connectionId === id);
  expect(initial?.isDraining).toBe(false);
  try {
    header(await page.goto(`/dashboard?${fixed}`));
    await page.getByRole('radio', { name: 'Activity & analysis', exact: true }).check();
    const row = page.getByRole('table',{name:'Configured account capacity'}).locator('tbody tr').filter({has:page.getByRole('button',{name:'Synthetic research account',exact:true})});
    await row.getByRole('button',{name:'Synthetic research account',exact:true}).click();
    await expect(page.getByRole('region',{name:'Account policy evidence'})).toBeVisible();
    await page.getByRole('button',{name:'Review drain',exact:true}).click();
    let dialog = page.getByRole('dialog',{name:'Review account drain'});
    await expect(dialog).toContainText('Each account is saved separately');
    await dialog.getByRole('button',{name:'Apply drain',exact:true}).click();
    await expect(dialog.getByLabel('Per-account drain outcomes')).toContainText('saved state read back');
    const saved = (await read(page,'/api/admin/drain?all=true')).connections.find(row => row.connectionId === id);
    expect(saved.isDraining).toBe(true); receipts.push({phase:'drain',...saved});
    expect(JSON.parse(db.prepare('SELECT value FROM kv WHERE scope=? AND key=?').get('admin.drain',id).value).isDraining).toBe(true);
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    header(await page.reload());
    await expect(page.getByRole('button',{name:'Review stop drain',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Review stop drain',exact:true}).click();
    dialog = page.getByRole('dialog',{name:'Review stopping the drain'});
    await dialog.getByRole('button',{name:'Stop drain',exact:true}).click();
    await expect(dialog.getByLabel('Per-account drain outcomes')).toContainText('saved state read back');
    const restored = (await read(page,'/api/admin/drain?all=true')).connections.find(row => row.connectionId === id);
    expect(restored.isDraining).toBe(false); receipts.push({phase:'restored',...restored});
    expect(JSON.parse(db.prepare('SELECT value FROM kv WHERE scope=? AND key=?').get('admin.drain',id).value).isDraining).toBe(false);
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    header(await page.reload());
    expect((await read(page,'/api/admin/drain?all=true')).connections.find(row => row.connectionId === id).isDraining).toBe(false);
    expect(db.prepare('SELECT data FROM providerConnections WHERE id=?').get(id)).toBeTruthy();
    await testInfo.attach('capacity-drain-persistence.json',{body:JSON.stringify({fixtureVersion:fixture.version,accountId:id,receipts,credentialless:true,providerCalls:0},null,2),contentType:'application/json'});
  } finally {
    try {
      const current = (await read(page,'/api/admin/drain?all=true')).connections.find(row => row.connectionId === id);
      if (current?.isDraining) {
        const recovery = await page.request.delete(`/api/admin/drain/${id}?${new URLSearchParams({ifMatch:current.version})}`);
        header(recovery); expect(recovery.status(), 'Restore a drain after a failed UI assertion').toBe(200);
        expect((await read(page,'/api/admin/drain?all=true')).connections.find(row => row.connectionId === id).isDraining).toBe(false);
      }
    } finally { db.close(); }
  }
});

test('Capacity keeps the exact historical unit series across reload and Economics opens modeled evidence', async ({ page }, testInfo) => {
  await enter(page);
  const workbench = await read(page,`/api/admin/quota/workbench?${new URLSearchParams({connectionId:fixture.accountIds[0],start:fixed.get('start'),end:fixture.capturedAt})}`);
  const usd = workbench.series.find(series => series.unit === 'USD'); expect(usd).toBeTruthy();
  const params = new URLSearchParams(fixed); params.set('selected',JSON.stringify({kind:'account',id:fixture.accountIds[0],windowScope:usd.scope,windowId:usd.id}));
  header(await page.goto(`/dashboard?${params}`));
  await expect(page.getByRole('heading',{name:'Quota history',exact:true})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'Reported quota window',exact:true})).toHaveValue(/USD/);
  header(await page.reload());
  await expect(page.getByRole('combobox',{name:'Reported quota window',exact:true})).toHaveValue(/USD/);
  const scenario = page.getByRole('region',{name:'Quota exhaustion scenario'});
  await expect(scenario).toContainText('USD/hour');
  const scenarioWrites = [];
  const watchScenario = request => { if (request.method() !== 'GET') scenarioWrites.push(request.url()); };
  page.on('request', watchScenario);
  await scenario.getByRole('textbox',{name:'Workload multiplier',exact:true}).fill('2');
  await scenario.getByRole('switch',{name:'Include this account',exact:true}).uncheck();
  await expect(scenario).toContainText('This account is excluded from the scenario');
  await scenario.getByRole('switch',{name:'Include this account',exact:true}).check();
  await expect(scenario).not.toContainText('This account is excluded from the scenario');
  expect(scenarioWrites).toEqual([]);
  page.off('request', watchScenario);
  const economics = await read(page,`/api/analytics?${new URLSearchParams({view:'economics',requestId:'economics-fixture-5'})}`);
  const record = economics.items[0]; expect(record.counterfactual.modeledDifferenceUsd).toBe(-0.01);
  params.set('selected',JSON.stringify({kind:'economics-record',id:String(record.id)}));
  header(await page.goto(`/dashboard/usage?${params}`));
  await page.getByRole('tab',{name:'Modeled difference',exact:true}).click();
  await expect(page.getByRole('region',{name:'Counterfactual cost evidence'})).toContainText('The negative difference is retained');
  await expect(page.getByRole('region',{name:'Counterfactual cost evidence'})).toContainText('-0.01');
  await testInfo.attach('capacity-economics-exact-readback.json',{body:JSON.stringify({fixtureVersion:fixture.version,windowId:usd.id,unit:usd.unit,recordId:record.id,modeledDifferenceUsd:-0.01,intercepted:false}),contentType:'application/json'});
});
