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
// The sidebar Everyday / Advanced switch is the only level switch on the page.
const useAdvanced = page => page.addInitScript(() => window.localStorage.setItem('tokenproxy.navigation-mode', JSON.stringify('advanced')));
const controls = page => page.locator('[aria-label="Token savings control panel"]');
const everyday = page => page.locator('[aria-label="Everyday token savings"]');
const card = (page, key) => page.locator(`[data-savings-control="${key}"]`);
const review = page => page.locator('[role="group"][aria-label^="Turn on"]');
const task = (page, name) => page.getByRole('radiogroup', { name: 'Token savings task' }).getByText(name, { exact: true }).click();
async function evidence(page, key) {
  const row = card(page, key);
  await row.locator('[aria-label^="Evidence and requirements for"]').click();
  return row;
}
// Narrowing the board first keeps the target row clear of the sticky header.
const only = (page, name) => controls(page).getByRole('searchbox').fill(name);
// The visible track is what an operator clicks; the input itself sits under it.
const flip = (page, key) => card(page, key).locator('.mantine-Switch-track').click();
const stageRow = (page, key) => page.locator('.shaping-evidence-table tbody tr').filter({ has: page.locator('code').filter({ hasText: new RegExp(`^${key}$`) }) });

test.beforeEach(async ({ page }) => { await signIn(page); });

test('inventory exposes all new controls with separate configured and historical evidence', async ({ page }) => {
  await fixture(page);
  await useAdvanced(page);
  await page.goto('/dashboard/shaping');
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
  await useAdvanced(page);
  await page.goto('/dashboard/shaping');
  await task(page, 'Evidence');
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
  await useAdvanced(page);
  await page.goto('/dashboard/shaping');
  await expect(await evidence(page, 'rtkEnabled')).toContainText('Byte coverage unknown');
  await expect(card(page, 'rtkEnabled')).toContainText('coverage unknown');
  await task(page, 'Evidence');
  await expect(stageRow(page, 'rtk')).toContainText('Not reported');
  await expect(stageRow(page, 'rtk')).not.toContainText('-2,048 B');
});

test('the level governs the board and an expanded row survives a level change', async ({ page }) => {
  await fixture(page);
  await useAdvanced(page);
  await page.goto('/dashboard/shaping');
  await evidence(page, 'epochMicroEnabled');
  await expect(card(page, 'epochMicroEnabled')).toContainText('Boundary-aware clearing');
  const level = page.getByRole('radiogroup', { name: 'Navigation view' });
  await level.getByText('Everyday', { exact: true }).click();
  await expect(everyday(page)).toBeVisible();
  await expect(everyday(page).locator('[data-savings-control]')).toHaveCount(4);
  await level.getByText('Advanced', { exact: true }).click();
  await expect(card(page, 'epochMicroEnabled')).toHaveAttribute('data-expanded', 'true');
});

test('everyday carries no editor and an Advanced switch reviews in place from the keyboard', async ({ page }) => {
  await fixture(page);
  await page.goto('/dashboard/shaping');
  await expect(everyday(page).locator('details, input[type="number"], textarea, select')).toHaveCount(0);
  await expect(page.locator('dialog')).toHaveCount(0);
  const level = page.getByRole('radiogroup', { name: 'Navigation view' });
  await level.getByText('Advanced', { exact: true }).click();
  const toggle = card(page, 'epochMicroEnabled').getByRole('switch');
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await toggle.press('Space');
  await expect(review(page)).toBeVisible();
  await expect(page.locator('dialog')).toHaveCount(0);
});

test('the in-place review sends only the selected setting and reports the verified readback', async ({ page }) => {
  const patches = await fixture(page);
  await useAdvanced(page);
  await page.goto('/dashboard/shaping');
  await only(page, 'Boundary-aware clearing');
  await flip(page, 'epochMicroEnabled');
  await expect(review(page)).toContainText('a request already in flight retains its settings');
  expect(patches).toHaveLength(0);
  await review(page).getByRole('checkbox').check();
  await review(page).getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(page.getByText('Boundary-aware clearing saved and verified after refresh.', { exact: true })).toBeVisible();
  await expect(card(page, 'epochMicroEnabled').getByRole('switch')).toBeChecked();
  expect(patches).toEqual([{ epochMicroEnabled: true }]);
});

test('a refused save stays at the control with the gateway explanation', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/admin/shaping/controls', route => route.fulfill(json(400, { error: 'epochMicroEnabled must be a boolean' })));
  await useAdvanced(page);
  await page.goto('/dashboard/shaping');
  await only(page, 'Boundary-aware clearing');
  await flip(page, 'epochMicroEnabled');
  await review(page).getByRole('checkbox').check();
  await review(page).getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(review(page)).toContainText('The gateway refused the input.');
  await expect(review(page)).toContainText('epochMicroEnabled must be a boolean');
});

test('an empty required threshold is not silently submitted as zero', async ({ page }) => {
  const patches = await fixture(page);
  await useAdvanced(page);
  await page.goto('/dashboard/shaping');
  const field = controls(page).getByLabel('Transform timeout');
  await field.fill('');
  await field.blur();
  expect(patches).toEqual([]);
  await field.fill('12000');
  await field.blur();
  await expect(page.getByText('Transform timeout saved and verified after refresh.', { exact: true })).toBeVisible();
  expect(patches).toEqual([{ pxpipeTimeoutMs: 12000 }]);
});

test('reading controls and service status never starts a health check', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/admin/shaping/runtime', route => route.fulfill(json(503, { error: 'Service settings unavailable in this fixture' })));
  const healthCalls = [];
  await page.route('**/api/pxpipe/health', route => { healthCalls.push(route.request().method()); return route.fulfill(json(200, { healthy: true, checks: [] })); });
  await page.route('**/api/pxpipe/status', route => route.fulfill(json(200, { installed: false, running: false, enabled: false, npmAvailable: true, autoInstall: true })));
  await page.route('**/api/pxpipe/logs*', route => route.fulfill(json(200, {})));
  await useAdvanced(page);
  await page.goto('/dashboard/shaping');
  await expect(page.getByRole('heading', { name: 'Token savings', exact: true })).toBeVisible();
  await task(page, 'Services');
  await expect(page.getByText('Not run in this view', { exact: true })).toBeVisible();
  expect(healthCalls).toEqual([]);
  await page.getByRole('button', { name: 'Run local check', exact: true }).click();
  const strip = page.locator('[role="group"][aria-label="Run the local compression check"]');
  await expect(strip).toContainText('This can change the loaded state.');
  expect(healthCalls).toEqual([]);
  await strip.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(strip).toHaveCount(0);
  expect(healthCalls).toEqual([]);
});

test('forbidden settings stay unknown and disable mutation', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/admin/shaping', route => route.fulfill(json(403, { error: 'Loopback only' })));
  await useAdvanced(page);
  await page.goto('/dashboard/shaping');
  await expect(page.getByText('This action is not allowed from here.', { exact: true })).toBeVisible();
  await expect(page.getByText('Loopback only', { exact: true })).toBeVisible();
  await expect(await evidence(page, 'rtkEnabled')).toContainText('Unknown globally');
  await expect(card(page, 'rtkEnabled').getByRole('switch')).toBeDisabled();
});
