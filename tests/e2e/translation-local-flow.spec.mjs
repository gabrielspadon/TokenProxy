import { test, expect } from 'playwright/test';
import { signIn } from './helpers.mjs';

test('actual local translation exposes its route and invalidates evidence after editing the request', async ({ page }, testInfo) => {
  expect(process.env.E2E_BASE).toBeTruthy();
  expect(process.env.SMOKE_PASSWORD).toBeTruthy();
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(process.env.E2E_BASE).hostname);
  const health = await page.request.get('/api/admin/health', { maxRedirects: 0 });
  expect(health.headers()['x-tokenproxy-preview-kind']).toBe('synthetic-fixture');
  await signIn(page);
  const effects = [];
  page.on('request', request => {
    if (request.method() !== 'GET') effects.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await page.goto('/dashboard/translation');
  const pipeline = page.getByRole('region', { name: 'Walk the pipeline', exact: true });
  const source = pipeline.getByRole('textbox', { name: 'Request as received', exact: true });
  await source.fill(JSON.stringify({model:'anthropic/claude-sonnet-4-5',system:'Synthetic local instruction',messages:[{role:'user',content:[{type:'text',text:'Synthetic conversion evidence'}]}],max_tokens:32}));
  const translate = async step => {
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/translator/translate' && value.request().method() === 'POST');
    await pipeline.getByRole('button', { name: 'Translate', exact: true }).click();
    const result = await response;
    expect(result.headers()['x-tokenproxy-preview-kind']).toBe('synthetic-fixture');
    expect(result.request().postDataJSON().step).toBe(step);
    expect(result.status()).toBe(200);
    return result.json();
  };
  const detection = await translate(1);
  expect(detection.result).toMatchObject({scope:'local-format-detection',providerCalls:0});
  await expect(pipeline.getByText(/registered conversion available/)).toBeVisible();
  await pipeline.getByRole('radio', { name: 'Converted to neutral format', exact: true }).check();
  const converted = await translate(2);
  expect(converted.result).toMatchObject({scope:'local-conversion',providerCalls:0,route:{supported:true}});
  expect(converted.result.body.messages.some(message => JSON.stringify(message).includes('Synthetic conversion evidence'))).toBe(true);
  await expect(pipeline.locator('pre')).toContainText('Synthetic conversion evidence');
  await source.fill(JSON.stringify({model:'openai/gpt-4o',messages:[{role:'user',content:'Changed synthetic input'}]}));
  await expect(pipeline.locator('pre')).toHaveCount(0);
  await expect(pipeline.locator('dl')).toHaveCount(0);
  expect(effects.map(item => [item.path,item.body.step])).toEqual([['/api/translator/translate',1],['/api/translator/translate',2]]);
  await testInfo.attach('local-translation-receipt.json',{contentType:'application/json',body:JSON.stringify({detection:detection.result,converted:converted.result,sourceEditClearedEvidence:true,providerCalls:0,intercepted:false})});
});
