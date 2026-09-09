import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { sourceManifest } from '../../scripts/redesign-preview.mjs';
const root = process.argv[2],
  artifacts = process.argv[3];
assert.ok(root && artifacts, 'Pass owned preview root and artifact directory');
const receipt = JSON.parse(await readFile(join(root, 'process.json'), 'utf8'));
const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8'));
assert.equal(receipt.runId, owner.runId);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  serviceWorkers: 'block',
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const guard = await installRedesignBrowser(page, { baseUrl: receipt.url, runtimeReceipt: receipt });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const results = [];
try {
  await authenticateRedesign(context, root);
  await page.goto(`${receipt.url}/dashboard/models`);
  await page.getByRole('tab', { name: 'Offline route preview', exact: true }).click();
  const model = page.getByLabel('Requested model or plan', { exact: true });
  await model.fill('openai/gpt-4o');
  await page.getByLabel('Existing session hash (optional)', { exact: true }).fill('d'.repeat(64));
  const captureResponse = page.waitForResponse((r) =>
    r.url().endsWith('/routing-simulator/capture')
  );
  await page.getByRole('button', { name: 'Capture current inputs', exact: true }).click();
  const captured = await captureResponse;
  const captureBody = await captured.json();
  assert.equal(captured.status(), 200, JSON.stringify(captureBody));
  const simulationResponse = page.waitForResponse((r) =>
    r.url().endsWith('/routing-simulator/simulate')
  );
  await page.getByRole('button', { name: 'Simulate captured decision', exact: true }).click();
  const response = await simulationResponse;
  const result = await response.json();
  await writeFile(join(artifacts, 'latest-result.json'), JSON.stringify(result, null, 2));
  assert.equal(response.status(), 200, JSON.stringify(result));
  assert.equal(result.after.selectedModel, 'openai/gpt-4o', JSON.stringify(result.after));
  assert.ok(result.sessionPreview.sessions.length > 0);
  results.push({ case: 'route-and-session', result });
  await page.getByRole('table', { name: 'Captured route ordering' }).waitFor();
  for (const [width, height] of [
    [1440, 1000],
    [1920, 1080],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: join(artifacts, `route-${width}.png`), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `No document overflow at ${width}`
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole('button', { name: 'Inspect exact before/after evidence', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Exact captured simulation receipt', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1920, height: 1080 });
  const resize = page.getByRole('separator', { name: 'Resize detail panel' });
  await resize.waitFor();
  await resize.focus();
  await page.keyboard.press('ArrowLeft');
  await page.screenshot({ path: join(artifacts, 'route-inspector.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close selection details', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('tab', { name: 'Offline route preview', exact: true }).click();
  assert.equal(await model.inputValue(), 'openai/gpt-4o');
  await page.getByRole('table', { name: 'Captured route ordering' }).waitFor();
  assert.equal(
    await page.getByLabel('Existing session hash (optional)', { exact: true }).inputValue(),
    ''
  );
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('tokenproxy.route-simulator.v2'))
  );
  assert.equal(saved.capture.captureId, captureBody.capture.captureId);
  assert.equal(saved.result.receipt.captureId, result.receipt.captureId);
  assert.equal(JSON.stringify(saved).includes('d'.repeat(64)), false);
  results.push({ case: 'reload-and-keyboard', captureId: saved.capture.captureId, passed: true });
  await model.fill('openai/gpt-4o-mini');
  const staleResponse = page.waitForResponse((r) =>
    r.url().endsWith('/routing-simulator/simulate')
  );
  await page.getByRole('button', { name: 'Simulate captured decision', exact: true }).click();
  const stale = await staleResponse;
  assert.equal(stale.status(), 400);
  assert.equal((await stale.json()).code, 'capture_model_mismatch');
  await page.getByText('capture_model_mismatch', { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, 'route-stale.png'), fullPage: true });
  results.push({ case: 'stale-capture-refusal', passed: true });
  await page.getByRole('tab', { name: 'Plans', exact: true }).click();
  const createdResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/admin/configuration/drafts' &&
      r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'New draft from active', exact: true }).click();
  const created = await (await createdResponse).json();
  assert.ok(created.id);
  await page.getByLabel('New alias', { exact: true }).fill('gpt-4o');
  await page.getByLabel('Physical target', { exact: true }).fill('openai/gpt-4o-mini');
  await page.getByRole('button', { name: 'Add alias', exact: true }).click();
  const savedResponse = page.waitForResponse(
    (r) => r.url().endsWith(`/drafts/${created.id}`) && r.request().method() === 'PATCH'
  );
  await page.getByRole('button', { name: 'Save draft revision', exact: true }).click();
  const stored = await (await savedResponse).json();
  assert.equal(stored.revision, 2);
  await page.getByRole('tab', { name: 'Offline route preview', exact: true }).click();
  await model.fill('gpt-4o');
  await page.getByLabel('Compare exact saved draft', { exact: true }).check();
  const draftCaptureResponse = page.waitForResponse((r) =>
    r.url().endsWith('/routing-simulator/capture')
  );
  await page.getByRole('button', { name: 'Capture current inputs', exact: true }).click();
  const dcResponse = await draftCaptureResponse,
    dc = await dcResponse.json();
  assert.equal(dcResponse.status(), 200, JSON.stringify(dc));
  const draftSimulationResponse = page.waitForResponse((r) =>
    r.url().endsWith('/routing-simulator/simulate')
  );
  await page.getByRole('button', { name: 'Simulate captured decision', exact: true }).click();
  const drResponse = await draftSimulationResponse,
    dr = await drResponse.json();
  assert.equal(drResponse.status(), 200, JSON.stringify(dr));
  assert.equal(dr.receipt.draftId, created.id);
  assert.equal(dr.receipt.draftRevision, 2);
  assert.equal(dr.before.selectedModel, 'openai/gpt-4o');
  assert.equal(dr.after.selectedModel, 'openai/gpt-4o-mini');
  await page.screenshot({ path: join(artifacts, 'route-draft.png'), fullPage: true });
  results.push({ case: 'exact-saved-draft-comparison', result: dr });
  assert.deepEqual(guard.outboundFailures, []);
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifacts, 'browser-receipt.json'),
    JSON.stringify(
      { runtime: receipt, results, errors, browserGuard: guard, source: await sourceManifest() },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      passed: results.map((r) => r.case),
      screenshots: 6,
      outboundFailures: 0,
      pageErrors: 0,
    })
  );
} finally {
  await browser.close();
}
