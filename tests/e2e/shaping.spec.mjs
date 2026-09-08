import { test, expect } from 'playwright/test';
import { signIn, json } from './helpers.mjs';
import { shapingControlFixture } from './shaping-control-fixture.mjs';
import { CONFIGURATION_FIELDS, CONTROLS } from '../../src/app/dashboard/shaping/controlCatalog.js';

// Browser interception establishes presentation and intended requests only.
// Actual persistence is verified separately against the disposable application.
const settingsFixture = () => ({
  ...Object.fromEntries(CONTROLS.map(control => [control.key, control.defaultOn === true])),
  ...Object.fromEntries(CONFIGURATION_FIELDS.map(field => [field.key, field.list ? [] : 'full'])),
  headroomTimeoutMs: null,
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
  let currentHash = 'a'.repeat(64);
  const patches = [];
  await page.route('**/api/settings', route => route.fulfill(json(200, settings)));
  await page.route('**/api/admin/shaping', route => route.fulfill(json(200, { settings, currentHash })));
  await page.route('**/api/admin/shaping/controls', async route => {
    const body = route.request().postDataJSON();
    expect(body.expectedCurrent).toBe(currentHash);
    expect(body.consent).toEqual(expect.arrayContaining(Object.keys({ ...settings, ...body.patch }).filter(key => ({ ...settings, ...body.patch })[key] === true)));
    patches.push(body.patch);
    settings = { ...settings, ...body.patch };
    currentHash = 'b'.repeat(64);
    await route.fulfill(json(200, { afterHash: currentHash }));
  });
  await page.route('**/api/token-saver/stats*', route => route.fulfill(json(200, stats)));
  await page.route('**/api/tool-disclosure/stats', route => route.fulfill(json(200, [])));
  return patches;
}
const controls = page => page.locator('[aria-label="Token savings control panel"]');
const card = (page, key) => controls(page).locator(`[data-savings-control="${key}"]`);
async function evidence(page, key) { const row = card(page, key); await row.locator('summary').click(); return row; }
const consent = page => page.locator('dialog[open]').getByRole('checkbox').check();
const stageRow = (page, key) => page.locator('.shaping-evidence-table tbody tr').filter({ has: page.locator('code').filter({ hasText: new RegExp(`^${key}$`) }) });

test.beforeEach(async ({ page }) => { await signIn(page); });

test('inventory exposes all new controls with separate configured and historical evidence', async ({ page }) => {
  await fixture(page);
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Token savings', exact: true })).toBeVisible();
  await expect(controls(page).locator('[data-savings-control]')).toHaveCount(CONTROLS.length);
  const diet = await evidence(page, 'dietEnabled');
  await expect(diet).toContainText('Off globally');
  await expect(diet).toContainText('1 applied stage records');
  await expect(diet).toContainText('2 / 2 records measured');
  await expect(diet).toContainText('eight assistant turns');
  const cache = await evidence(page, 'adaptiveCacheTtlEnabled');
  await expect(cache).toContainText('Global only');
  await expect(cache).toContainText('p90 strictly greater than 20 minutes');
  await expect(cache).toContainText('Explicit client lifetimes');
});

test('signed bytes retain growth, measured zero and partial coverage', async ({ page }) => {
  await fixture(page);
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await page.getByRole('tab', { name: 'Recorded evidence', exact: true }).click();
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
  await expect(await evidence(page, 'rtkEnabled')).toContainText('Byte coverage unknown');
  await page.getByRole('tab', { name: 'Recorded evidence', exact: true }).click();
  await expect(stageRow(page, 'rtk')).toContainText('Not reported');
  await expect(stageRow(page, 'rtk')).not.toContainText('-2,048 B');
});

test('evidence disclosure survives moving between Everyday and Advanced', async ({ page }) => {
  await fixture(page);
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await evidence(page, 'epochMicroEnabled');
  await page.getByRole('tab', { name: 'Everyday', exact: true }).click();
  await expect(page.locator('[aria-label="Everyday token savings"] input[type="checkbox"]')).toHaveCount(4);
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(card(page, 'epochMicroEnabled').locator('details')).toHaveAttribute('open', '');
  await expect(card(page, 'epochMicroEnabled').getByRole('heading', { name: 'Boundary-aware clearing' })).toBeVisible();
});

test('everyday has no nested editor and Advanced is keyboard accessible', async ({ page }) => {
  await fixture(page);
  await page.goto('/dashboard/shaping');
  const everyday = page.locator('[aria-label="Everyday token savings"]');
  await expect(everyday.locator('details, input[type="number"], textarea, select')).toHaveCount(0);
  const tab = page.getByRole('tab', { name: 'Everyday', exact: true });
  await tab.focus();
  await tab.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Advanced', exact: true })).toHaveAttribute('aria-selected', 'true');
  const toggle = card(page, 'epochMicroEnabled').getByRole('switch');
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await toggle.press('Space');
  await expect(page.locator('dialog[open]')).toBeVisible();
});

test('confirmation sends only the selected setting and displays verified readback', async ({ page }) => {
  const patches = await fixture(page);
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await card(page, 'epochMicroEnabled').getByRole('switch').click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toContainText('a request already in flight retains its settings');
  expect(patches).toHaveLength(0);
  await consent(page);
  await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(page.getByText('Boundary-aware clearing saved and verified after refresh.', { exact: true })).toBeVisible();
  await expect(card(page, 'epochMicroEnabled').getByRole('switch')).toBeChecked();
  expect(patches).toEqual([{ epochMicroEnabled: true }]);
});

test('a refused save stays at the control with the gateway explanation', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/admin/shaping/controls', route => route.fulfill(json(400, { error: 'epochMicroEnabled must be a boolean' })));
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await card(page, 'epochMicroEnabled').getByRole('switch').click();
  await consent(page);
  await page.locator('dialog[open]').getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(page.locator('dialog[open]')).toContainText('The gateway refused the input.');
  await expect(page.locator('dialog[open]')).toContainText('epochMicroEnabled must be a boolean');
});

test('empty threshold input is not silently submitted as zero', async ({ page }) => {
  const patches = await fixture(page);
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await controls(page).getByLabel('Transform timeout').fill('');
  await expect(page.getByRole('button', { name: 'Review setting changes' })).toBeDisabled();
  await controls(page).getByLabel('Transform timeout').fill('12000');
  await page.getByRole('button', { name: 'Review setting changes' }).click();
  await expect(page.locator('dialog[open]')).toContainText('15,000 → 12,000 milliseconds');
  await consent(page);
  await page.locator('dialog[open]').getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Control settings saved and verified after refresh.', { exact: true })).toBeVisible();
  expect(patches).toEqual([{ pxpipeTimeoutMs: 12000 }]);
});

test('reading controls and service status never starts a health check', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/admin/shaping/runtime', route => route.fulfill(json(503, { error: 'Service settings unavailable in this fixture' })));
  const healthCalls = [];
  await page.route('**/api/pxpipe/health', route => { healthCalls.push(route.request().method()); return route.fulfill(json(200, { healthy: true, checks: [] })); });
  await page.route('**/api/pxpipe/status', route => route.fulfill(json(200, { installed: false, running: false, enabled: false, npmAvailable: true, autoInstall: true })));
  await page.route('**/api/pxpipe/logs*', route => route.fulfill(json(200, {})));
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Token savings', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Services', exact: true }).click();
  await expect(page.getByText('Not run in this view', { exact: true })).toBeVisible();
  expect(healthCalls).toEqual([]);
  await page.getByRole('button', { name: 'Run local check', exact: true }).click();
  await expect(page.locator('dialog[open]')).toContainText('This can change the loaded state.');
  expect(healthCalls).toEqual([]);
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('forbidden settings stay unknown and disable mutation', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/admin/shaping', route => route.fulfill(json(403, { error: 'Loopback only' })));
  await page.goto('/dashboard/shaping');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(page.getByText('This action is not allowed from here.', { exact: true })).toBeVisible();
  await expect(page.getByText('Loopback only', { exact: true })).toBeVisible();
  await expect(await evidence(page, 'rtkEnabled')).toContainText('Unknown globally');
  await expect(card(page, 'rtkEnabled').getByRole('switch')).toBeDisabled();
});
