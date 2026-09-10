import { test, expect } from 'playwright/test';
import { signIn } from './helpers.mjs';
import { ROUTING_FIXTURE } from './routing-completion-seed.mjs';

test.use({ actionTimeout: 10_000 });

const synthetic = response => expect(response?.headers()['x-tokenproxy-preview-kind'], 'Mutations require the isolated synthetic preview').toBe('synthetic-fixture');
async function read(page,path) { const response=await page.request.get(path,{maxRedirects:0}); synthetic(response); expect(response.status()).toBe(200); return response.json(); }
async function mutation(page,method,path,action) {
  const waiting=page.waitForResponse(response=>response.request().method()===method && (typeof path==='string' ? new URL(response.url()).pathname===path : path.test(new URL(response.url()).pathname)));
  await action(); const response=await waiting; synthetic(response);
  expect(response.status()).toBeLessThan(300); return response.json();
}
test.beforeEach(async({page})=>{
  expect(process.env.E2E_BASE).toBeTruthy();expect(process.env.SMOKE_PASSWORD).toBeTruthy();
  const base=new URL(process.env.E2E_BASE);expect(['127.0.0.1','localhost','[::1]']).toContain(base.hostname);
  const gate=await page.request.get('/api/admin/health',{maxRedirects:0});synthetic(gate);
  await signIn(page);
});

test('versioned routing draft, activation readback and reviewed restoration persist through reload',async({page},testInfo)=>{
  test.setTimeout(60000);
  const initial=await read(page,'/api/admin/configuration');
  const alias='synthetic-routing-review';expect(initial.document.aliases[alias]).toBeUndefined();
  await page.goto('/dashboard/models');
  const created=await mutation(page,'POST','/api/admin/configuration/drafts',()=>page.getByRole('button',{name:'New draft from active',exact:true}).click());
  const beforeVersionId=created.version.parentVersionId;
  await page.getByRole('button',{name:'Add alias',exact:true}).first().click();
  await page.getByLabel('New alias',{exact:true}).fill(alias);
  await page.locator('input[aria-label="Physical target"]').fill('openai/gpt-4o');
  await page.getByRole('button',{name:'Add alias',exact:true}).last().click();
  const saved=await mutation(page,'PATCH',`/api/admin/configuration/drafts/${created.id}`,()=>page.getByRole('button',{name:'Save draft revision',exact:true}).click());
  expect(saved.revision).toBe(2);
  expect((await read(page,'/api/admin/configuration')).currentHash).toBe(initial.currentHash);
  const stored=await read(page,`/api/admin/configuration/drafts/${created.id}`);
  expect(stored.version.document.aliases[alias]).toBe('openai/gpt-4o');
  await mutation(page,'POST',`/api/admin/configuration/drafts/${created.id}/validate`,()=>page.getByRole('button',{name:'Validate locally',exact:true}).click());
  await page.getByRole('button',{name:'Review activation',exact:true}).click();
  const activation=page.getByRole('group',{name:'Review draft activation',exact:true});
  await expect(activation).toContainText(`/aliases/${alias}`);
  const activated=await mutation(page,'POST',`/api/admin/configuration/drafts/${created.id}/activate`,()=>activation.getByRole('button',{name:'Activate revision 2',exact:true}).click());
  expect(activated.outcome).toBe('applied');
  await expect(page.getByRole('button',{name:'Review activation',exact:true})).toBeEnabled();
  expect((await read(page,'/api/admin/configuration')).currentHash).toBe(activated.currentHash);
  await page.reload();
  const reloaded=await read(page,'/api/admin/configuration');expect(reloaded.document.aliases[alias]).toBe('openai/gpt-4o');
  await page.getByRole('tab',{name:'History',exact:true}).click();
  await page.getByRole('tab',{name:'Immutable versions',exact:true}).click();
  const versionRow=page.getByRole('table',{name:'Configuration versions'}).locator('tbody tr').filter({has:page.locator('td').filter({hasText:new RegExp(`^${beforeVersionId}$`)})});
  await expect(versionRow).toHaveCount(1);
  await versionRow.getByRole('button',{name:'Review restoration',exact:true}).click();
  const restored=await mutation(page,'POST',`/api/admin/configuration/versions/${beforeVersionId}/rollback`,()=>page.getByRole('group',{name:'Review configuration restoration',exact:true}).getByRole('button',{name:`Restore version ${beforeVersionId}`,exact:true}).click());
  expect(restored.outcome).toBe('applied');
  const final=await read(page,'/api/admin/configuration');expect(final.currentHash).toBe(initial.currentHash);expect(final.document).toEqual(initial.document);
  const receipts=await read(page,'/api/admin/configuration/receipts?limit=20');
  expect(receipts.receipts.some(row=>row.id===restored.receipt.id && row.outcome==='applied')).toBe(true);
  await testInfo.attach('routing-policy-persistence.json',{contentType:'application/json',body:JSON.stringify({fixture:ROUTING_FIXTURE.version,initialHash:initial.currentHash,draftId:created.id,revision:saved.revision,activated,restored,finalHash:final.currentHash},null,2)});
});

test('cascade mapping saves with exact revision, reads back after reload and restores separately from plans',async({page},testInfo)=>{
  const initial=await read(page,'/api/routing-cascade');expect(initial.pairs).toEqual([]);
  await page.goto('/dashboard/models');await page.getByRole('tab',{name:'Routing',exact:true}).click();
  await page.getByRole('button',{name:'Add pair',exact:true}).click();
  await page.locator('input[aria-label="Strong model 1"]').fill('openai/gpt-4o');
  await page.locator('input[aria-label="Exploration model 1"]').fill('openai/gpt-4o-mini');
  await page.getByRole('button',{name:'Review change',exact:true}).click();
  expect((await read(page,'/api/routing-cascade')).revision).toBe(initial.revision);
  const review=page.getByRole('region',{name:'Reviewed cascade mapping'});
  const applied=await mutation(page,'PUT','/api/routing-cascade',()=>review.getByRole('button',{name:'Save cascade mapping',exact:true}).click());
  await expect(page.getByText('Read back and verified',{exact:true})).toBeVisible();
  await page.reload();await page.getByRole('tab',{name:'Routing',exact:true}).click();
  await expect(page.locator('input[aria-label="Exploration model 1"]')).toHaveValue('openai/gpt-4o-mini');
  expect((await read(page,'/api/routing-cascade')).revision).toBe(applied.revision);
  await page.getByRole('button',{name:'Remove pair 1',exact:true}).click();
  await page.getByRole('group',{name:'Confirm: Remove pair 1'}).getByRole('button',{name:'Remove',exact:true}).click();
  await page.getByRole('button',{name:'Review change',exact:true}).click();
  const restored=await mutation(page,'PUT','/api/routing-cascade',()=>page.getByRole('region',{name:'Reviewed cascade mapping'}).getByRole('button',{name:'Save cascade mapping',exact:true}).click());
  await expect(page.getByText('No configured pairs, so cascade is off.',{exact:false})).toBeVisible();
  const final=await read(page,'/api/routing-cascade');expect(final.revision).toBe(initial.revision);
  expect(final.receipts.slice(0,2).map(receipt=>receipt.id)).toEqual([restored.receipt.id,applied.receipt.id]);
  await testInfo.attach('cascade-persistence.json',{contentType:'application/json',body:JSON.stringify({fixture:ROUTING_FIXTURE.version,initial,applied,restored,final},null,2)});
});

test('exact pin attempt evidence, expiry, queued reassignment and clear retain their persisted receipts',async({page},testInfo)=>{
  test.setTimeout(60000);
  const initial=await read(page,'/api/admin/session-pins');
  const pin=initial.pins.find(row=>row.connectionId===ROUTING_FIXTURE.accountId && row.model===ROUTING_FIXTURE.model);expect(pin).toBeTruthy();expect(pin.session?.id).toBeTruthy();
  const context=await read(page,`/api/context/sessions/${pin.session.id}?requestId=${ROUTING_FIXTURE.requests[1]}`);
  expect(context.turns).toHaveLength(1);expect(context.turns[0].logicalRequestId).toBe(ROUTING_FIXTURE.logicalRequestId);
  expect(context.turns[0].stages.map(row=>row.deltaBytes)).toEqual([200,-500,0]);
  await page.goto('/dashboard/sessions');await page.getByLabel(`Inspect pin ${pin.model} on ${pin.connectionId}`,{exact:true}).click();
  await page.getByRole('link',{name:'Inspect exact attempt and ordered stages',exact:true}).first().click();
  await expect(page.getByRole('table',{name:'Ordered shaping stages',exact:true})).toBeVisible({timeout:30000});
  await page.goto('/dashboard/sessions');await page.getByLabel(`Inspect pin ${pin.model} on ${pin.connectionId}`,{exact:true}).click();
  const inspector=page.getByLabel('Selected pin controls',{exact:true});
  const controls=inspector.locator('form');const change=controls.getByRole('combobox',{name:'Change',exact:true});
  const outcomes=[];
  await change.selectOption('expire');
  const deadline=await page.evaluate(()=>{const d=new Date(Date.now()+3600000);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;});
  await controls.getByLabel('Expiry in your local time',{exact:true}).fill(deadline);
  await mutation(page,'POST','/api/admin/session-pins/preview',()=>controls.getByRole('button',{name:'Preview change',exact:true}).click());
  const expired=await mutation(page,'POST','/api/admin/session-pins/apply',()=>inspector.getByRole('button',{name:'Apply this change',exact:true}).click());outcomes.push(expired);
  expect(expired.status).toBe('applied');expect((await read(page,'/api/admin/session-pins')).pins.find(row=>row.id===pin.id).operatorExpiresAt).toBe(expired.deadline);
  await expect(change).toBeEnabled();await change.selectOption('reassign');await controls.getByRole('combobox',{name:'Target account',exact:true}).selectOption(ROUTING_FIXTURE.targetId);
  const preview=await mutation(page,'POST','/api/admin/session-pins/preview',()=>controls.getByRole('button',{name:'Preview change',exact:true}).click());expect(preview.preview.inFlightAffected).toBe(false);
  const queued=await mutation(page,'POST','/api/admin/session-pins/apply',()=>inspector.getByRole('button',{name:'Apply this change',exact:true}).click());outcomes.push(queued);expect(queued.status).toBe('queued');
  expect((await read(page,'/api/admin/session-pins')).pins.find(row=>row.id===pin.id).connectionId).toBe(pin.connectionId);
  await expect(change).toBeEnabled();await change.selectOption('clear');
  const clearPreview=await mutation(page,'POST','/api/admin/session-pins/preview',()=>controls.getByRole('button',{name:'Preview change',exact:true}).click());expect(clearPreview.preview.cancelledActions).toContain(queued.id);
  const cleared=await mutation(page,'POST','/api/admin/session-pins/apply',()=>inspector.getByRole('button',{name:'Apply this change',exact:true}).click());outcomes.push(cleared);expect(cleared.status).toBe('applied');
  await expect(page.getByLabel('Retained pin control receipt',{exact:true})).toContainText('Affinity was cleared');
  expect((await read(page,'/api/admin/session-pins')).pins.some(row=>row.id===pin.id)).toBe(false);
  expect((await read(page,`/api/admin/session-pins/actions/${queued.id}`)).status).toBe('cancelled');
  await page.reload();expect((await read(page,`/api/admin/session-pins/actions/${cleared.id}`)).status).toBe('applied');
  await testInfo.attach('pin-persistence.json',{contentType:'application/json',body:JSON.stringify({fixture:ROUTING_FIXTURE.version,pinId:pin.id,sessionId:pin.session.id,outcomes},null,2)});
});
