import { test, expect } from 'playwright/test';
import { signIn, json } from './helpers.mjs';
import { shapingControlFixture } from './shaping-control-fixture.mjs';
import { CONTROLS } from '../../src/app/dashboard/shaping/controlCatalog.js';

// Browser interception establishes presentation and intended requests only.
// Actual persistence is verified separately against the disposable application.
const settingsFixture = () => ({
  ...Object.fromEntries(CONTROLS.map(control => [control.key, control.defaultOn === true])),
  pxpipeMinChars: 25000, pxpipeTimeoutMs: 15000,
  memoryMaxToolTurnsKeepFull: 2, memoryMaxHistoricalToolChars: 800,
  memoryRecentTurnsToKeep: 8, memoryCompactionThresholdTokens: 32000,
  toolDisclosureMaxTools: 20, comboStrategies: {},
});
const stages = shapingControlFixture.events.reduce((map, event) => {
  const stage = map[event.saver] ||= { requests: 0, applied: 0, bytesSaved: 0, measuredRequests: 0 };
  stage.requests++;
  if (event.applied) stage.applied++;
  if (Number.isFinite(event.bytesSaved)) { stage.bytesSaved += event.bytesSaved; stage.measuredRequests++; }
  return map;
}, {});
const stats = {
  windows: { all: { requests: 8, applied: 4, stages }, today: { requests: 8, applied: 4, stages } },
  recent: shapingControlFixture.events,
  timeline: [], pxpipe: { timeline: [], recent: [] },
};

async function fixture(page) {
  let settings = settingsFixture();
  const patches = [];
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON(); patches.push(patch);
      settings = { ...settings, ...patch };
    }
    await route.fulfill(json(200, settings));
  });
  await page.route('**/api/token-saver/stats*', route => route.fulfill(json(200, stats)));
  await page.route('**/api/tool-disclosure/stats', route => route.fulfill(json(200, [])));
  return patches;
}
const inspector = page => page.locator('#shaping-control-inspector');
const select = (page, key) => page.locator(`[data-control="${key}"]`).click();
const stageRow = (page, key) => page.locator('.shaping-evidence-table tbody tr').filter({ has: page.locator('code').filter({ hasText: new RegExp(`^${key}$`) }) });

test.beforeEach(async ({ page }) => { await signIn(page); });

test('inventory exposes all new controls with separate configured and historical evidence', async ({ page }) => {
  await fixture(page);
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Token savings', exact: true })).toBeVisible();
  await expect(page.locator('.shaping-control-row')).toHaveCount(27);
  await select(page, 'dietEnabled');
  await expect(inspector(page).getByRole('heading', { name: 'Expired result pruning' })).toBeVisible();
  await expect(inspector(page)).toContainText('Off globally');
  await expect(inspector(page)).toContainText('1 applied stage records');
  await expect(inspector(page)).toContainText('2 / 2 records measured');
  await expect(inspector(page)).toContainText('eight assistant turns');
  await select(page, 'adaptiveCacheTtlEnabled');
  await expect(inspector(page)).toContainText('Global only');
  await expect(inspector(page)).toContainText('p90 strictly greater than 20 minutes');
  await expect(inspector(page)).toContainText('Explicit client lifetimes');
});

test('signed bytes retain growth, measured zero and partial coverage', async ({ page }) => {
  await fixture(page);
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await page.getByRole('button', { name: 'Recorded evidence', exact: true }).click();
  await expect(stageRow(page, 'rtk')).toContainText('-2,048 B');
  await expect(stageRow(page, 'rtk')).toContainText('1 / 2 records');
  await expect(stageRow(page, 'epochMicro')).toContainText('0 B');
  await expect(stageRow(page, 'epochMicro')).toContainText('1 / 1 records');
  await expect(stageRow(page, 'epochAuto')).toContainText('Not measured');
  await expect(stageRow(page, 'epochAuto')).not.toContainText('0 B');
  await expect(stageRow(page, 'inject')).toContainText('+384 B');
  await expect(page.getByText('Stage deltas are not added', { exact: false })).toBeVisible();
});

test('legacy aggregates cannot manufacture measurement coverage', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/token-saver/stats*', route => route.fulfill(json(200, { ...stats, windows: { all: { stages: { rtk: { bytesSaved: -2048, requests: 2, applied: 2 } } } } })));
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(inspector(page)).toContainText('Byte coverage unknown');
  await page.getByRole('button', { name: 'Recorded evidence', exact: true }).click();
  await expect(stageRow(page, 'rtk')).toContainText('Not reported');
  await expect(stageRow(page, 'rtk')).not.toContainText('-2,048 B');
});

test('selection survives moving between control and evidence depths', async ({ page }) => {
  await fixture(page);
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await select(page, 'epochMicroEnabled');
  await page.getByRole('button', { name: 'Recorded evidence', exact: true }).click();
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(page.locator('[data-control="epochMicroEnabled"]')).toHaveAttribute('aria-current', 'true');
  await expect(inspector(page).getByRole('heading', { name: 'Boundary-aware clearing' })).toBeVisible();
});

test('desktop panels retain bounded scrolling and keyboard resizing', async ({ page }) => {
  await fixture(page);
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  const layout = page.locator('.shaping-resizable');
  await expect(layout).toBeVisible();
  expect((await layout.boundingBox()).height).toBeLessThanOrEqual(761);
  const separator = page.getByRole('separator', { name: 'Resize control inspector' });
  const before = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus();
  await separator.press('ArrowRight');
  expect(Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
  expect(await page.locator('.shaping-control-list').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
});

test('confirmation sends only the selected setting and displays verified readback', async ({ page }) => {
  const patches = await fixture(page);
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await select(page, 'epochMicroEnabled');
  await inspector(page).getByRole('button', { name: 'Turn on', exact: true }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toContainText('a request already in flight retains its settings');
  expect(patches).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(page.getByText('Boundary-aware clearing saved and verified after refresh.', { exact: true })).toBeVisible();
  await expect(inspector(page)).toContainText('On globally');
  expect(patches).toEqual([{ epochMicroEnabled: true }]);
});

test('a refused save stays at the control with the gateway explanation', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/settings', route => route.request().method() === 'PATCH' ? route.fulfill(json(400, { error: 'epochMicroEnabled must be a boolean' })) : route.fallback());
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await select(page, 'epochMicroEnabled');
  await inspector(page).getByRole('button', { name: 'Turn on', exact: true }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(page.locator('dialog[open]')).toContainText('The gateway refused the input.');
  await expect(page.locator('dialog[open]')).toContainText('epochMicroEnabled must be a boolean');
});

test('empty threshold input is not silently submitted as zero', async ({ page }) => {
  const patches = await fixture(page);
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await select(page, 'pxpipeEnabled');
  await inspector(page).getByText('Edit this stage’s thresholds', { exact: true }).click();
  await inspector(page).getByLabel('Transform timeout').fill('');
  await expect(page.getByRole('button', { name: 'Review threshold changes' })).toBeDisabled();
  await inspector(page).getByLabel('Transform timeout').fill('12000');
  await page.getByRole('button', { name: 'Review threshold changes' }).click();
  await expect(page.locator('dialog[open]')).toContainText('15,000 → 12,000 milliseconds');
  await page.locator('dialog[open]').getByRole('button', { name: 'Save thresholds', exact: true }).click();
  await expect(page.getByText('Thresholds saved and verified after refresh.', { exact: true })).toBeVisible();
  expect(patches).toEqual([{ pxpipeTimeoutMs: 12000 }]);
});

test('reading controls and service status never starts a health check', async ({ page }) => {
  await fixture(page);
  const healthCalls = [];
  await page.route('**/api/pxpipe/health', route => { healthCalls.push(route.request().method()); return route.fulfill(json(200, { healthy: true, checks: [] })); });
  await page.route('**/api/pxpipe/status', route => route.fulfill(json(200, { installed: false, running: false, enabled: false, npmAvailable: true, autoInstall: true })));
  await page.route('**/api/pxpipe/logs*', route => route.fulfill(json(200, {})));
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Token savings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Service', exact: true }).click();
  await expect(page.getByText('Not run in this view', { exact: true })).toBeVisible();
  expect(healthCalls).toEqual([]);
  await page.getByRole('button', { name: 'Run local check', exact: true }).click();
  await expect(page.locator('dialog[open]')).toContainText('This can change the loaded state.');
  expect(healthCalls).toEqual([]);
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('forbidden settings stay unknown and disable mutation', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/settings', route => route.fulfill(json(403, { error: 'Loopback only' })));
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(page.getByText('This action is not allowed from here.', { exact: true })).toBeVisible();
  await expect(page.getByText('Loopback only', { exact: true })).toBeVisible();
  await expect(inspector(page)).toContainText('Unknown globally');
  await expect(inspector(page).getByRole('button', { name: 'Turn on', exact: true })).toBeDisabled();
});
