import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { sourceManifest } from '../../scripts/redesign-preview.mjs';
const root = process.argv[2],
  artifacts = process.argv[3];
assert.ok(root && artifacts);
const runtime = JSON.parse(await readFile(join(root, 'process.json'), 'utf8'));
const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8'));
assert.equal(runtime.runId, owner.runId);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  serviceWorkers: 'block',
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const guard = await installRedesignBrowser(page, { baseUrl: runtime.url, runtimeReceipt: runtime });
const errors = [],
  results = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = `${runtime.url}/api/admin/configuration-domains`;
const account = 'connection-fixture-alpha';
async function update(patch) {
  const response = await context.request.put(`${runtime.url}/api/providers/${account}`, {
    data: patch,
  });
  assert.equal(response.status(), 200, await response.text());
}
async function clickResponse(name, suffix, status = 200) {
  const pending = page.waitForResponse(
    (response) => response.url().endsWith(suffix) && response.request().method() !== 'GET'
  );
  await page.getByRole('button', { name, exact: true }).click();
  const response = await pending,
    body = await response.json();
  assert.equal(response.status(), status, JSON.stringify(body));
  return body;
}
async function chooseVersion(id) {
  await page.getByRole('button', { name: 'Refresh configuration', exact: true }).click();
  // getByLabel also matches the Mantine listbox that is labelled by the same
  // control, which is a strict-mode violation; the combobox role is unique.
  await page.getByRole('combobox', { name: 'Retained version to compare', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(`^v${id} ·`) }).click();
  await page
    .getByRole('checkbox', { name: `Restore /accounts/${account}/maxConcurrent`, exact: true })
    .waitFor();
}
try {
  await authenticateRedesign(context, root);
  await page.goto(`${runtime.url}/dashboard/models`);
  await page.getByRole('tab', { name: 'Configuration versions', exact: true }).click();
  const retained = await clickResponse(
    'Retain current draft',
    '/configuration-domains/drafts',
    201
  );
  const baseline = retained.receipt.beforeVersionId;
  await update({ maxConcurrent: 6, globalPriority: 9 });
  await chooseVersion(baseline);
  const selectedPath = `/accounts/${account}/maxConcurrent`;
  await page.getByRole('checkbox', { name: `Restore ${selectedPath}`, exact: true }).check();
  for (const [width, height] of [
    [1440, 1000],
    [1920, 1080],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: join(artifacts, `configuration-${width}.png`), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `No document overflow at ${width}`
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const draft = await clickResponse(
    'Create selective restoration draft',
    `/versions/${baseline}/restore`,
    201
  );
  assert.deepEqual(
    draft.diff.map((change) => change.path),
    [selectedPath]
  );
  results.push({ case: 'selective-retained-draft', draftId: draft.id, baseline, diff: draft.diff });
  await page.reload();
  await page.getByRole('tab', { name: 'Configuration versions', exact: true }).click();
  await page.getByRole('button', { name: 'Validate configuration draft', exact: true }).waitFor();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('tokenproxy.configuration-domains.v1'))
  );
  assert.equal(saved.draftId, draft.id);
  assert.deepEqual(Object.keys(saved), ['draftId']);
  const checked = await clickResponse(
    'Validate configuration draft',
    `/drafts/${draft.id}/validate`
  );
  assert.equal(checked.valid, true);
  await update({ globalPriority: 10 });
  const conflict = await clickResponse(
    'Activate reviewed configuration',
    `/drafts/${draft.id}/activate`,
    409
  );
  assert.equal(conflict.code, 'configuration_conflict');
  await page.getByRole('alert').filter({ hasText: 'configuration_conflict' }).waitFor();
  await page.screenshot({ path: join(artifacts, 'configuration-conflict.png'), fullPage: true });
  results.push({ case: 'reload-and-optimistic-conflict', draftId: draft.id, code: conflict.code });
  // Rebuild the selected intent against current fields; the old full draft must
  // not overwrite the unrelated priority that changed after its creation.
  await chooseVersion(baseline);
  await page.getByRole('checkbox', { name: `Restore ${selectedPath}`, exact: true }).check();
  const rebuilt = await clickResponse(
    'Create selective restoration draft',
    `/versions/${baseline}/restore`,
    201
  );
  await clickResponse('Validate configuration draft', `/drafts/${rebuilt.id}/validate`);
  const activated = await clickResponse(
    'Activate reviewed configuration',
    `/drafts/${rebuilt.id}/activate`
  );
  assert.equal(activated.outcome, 'applied');
  const state = await (await context.request.get(base)).json();
  assert.equal(state.document.accounts[account].maxConcurrent, 2);
  assert.equal(state.document.accounts[account].globalPriority, 10);
  assert.equal(state.document.accounts[account].isActive, false);
  results.push({
    case: 'selective-activation-readback',
    versionId: activated.version.id,
    receipt: activated.receipt,
    account: state.document.accounts[account],
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole('button', { name: 'Inspect coverage and receipts', exact: true }).focus();
  await page.keyboard.press('Enter');
  const resize = page.getByRole('separator', { name: 'Resize detail panel' });
  await resize.waitFor();
  await resize.focus();
  await page.keyboard.press('ArrowLeft');
  await page.getByText('Recent operation receipts', { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, 'configuration-inspector.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close selection details', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: join(artifacts, 'configuration-applied.png'), fullPage: true });
  results.push({ case: 'keyboard-resize-receipts', passed: true });
  assert.deepEqual(guard.outboundFailures, []);
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifacts, 'browser-receipt.json'),
    JSON.stringify(
      { runtime, results, errors, browserGuard: guard, source: await sourceManifest() },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      passed: results.map((result) => result.case),
      screenshots: 6,
      outboundFailures: 0,
      pageErrors: 0,
    })
  );
} finally {
  await browser.close();
}
