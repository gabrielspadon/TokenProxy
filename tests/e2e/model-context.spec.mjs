import { test, expect } from 'playwright/test';
import { signIn, json } from './helpers.mjs';

// Synthetic operator configuration authored for this spec, not captured provider
// telemetry. Interception proves UI/request/readback handling, not persistence,
// provider access, advertised capacity, or client auto-compaction behavior.
const modelFixture = () => [
  { provider: 'codex', providerName: 'Codex', model: 'gpt-6-astra', name: 'Astra fixture', staticContextWindow: 272000, contextWindow: 300000, providerConnections: 1, providerActive: true, defaultVisible: true },
  { provider: 'custom-fixture', providerName: 'Local fixture', model: 'unreported', name: 'Unknown window fixture', staticContextWindow: null, contextWindow: null, providerConnections: 0, providerActive: false, defaultVisible: false },
];

async function fixture(page, { refusal = false, stale = false, readbackFailure = false, many = false } = {}) {
  const models = modelFixture();
  if (many) for (let index = 0; index < 45; index++) models.push({ ...models[1], model: `fixture-${index}`, name: `Pagination fixture ${index}` });
  let overrides = { 'codex/gpt-6-astra': 300000, '*orphan-fixture*': 64000 };
  const writes = [];
  let reads = 0;
  await page.route('**/api/model-context*', async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      reads++;
      if (readbackFailure && writes.length) return route.fulfill(json(503, { error: 'Fixture readback unavailable' }));
      return route.fulfill(json(200, { models: models.map(row => row.model === 'gpt-6-astra' ? { ...row, contextWindow: overrides['codex/gpt-6-astra'] ?? row.staticContextWindow } : row), overrides, activeProviders: ['codex'] }));
    }
    writes.push({ method: request.method(), body: request.postDataJSON(), key: new URL(request.url()).searchParams.get('key') });
    if (refusal) return route.fulfill(json(403, { error: 'Fixture operator edits refused' }));
    if (!stale) {
      if (request.method() === 'PUT') overrides = { ...overrides, [request.postDataJSON().key]: request.postDataJSON().contextWindow };
      if (request.method() === 'DELETE') { overrides = { ...overrides }; delete overrides[new URL(request.url()).searchParams.get('key')]; }
    }
    return route.fulfill(json(200, { success: true, overrides }));
  });
  return { writes, reads: () => reads };
}

const inspector = page => page.locator('#model-context-inspector');
const dialog = page => page.locator('dialog[open]');
async function selectAstra(page) {
  await page.getByRole('button', { name: /Astra fixture/ }).click();
  await expect(inspector(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test('local catalog quantities retain unknown windows and exact configured identity', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/dashboard/model-context');
  await expect(page.getByRole('heading', { name: 'Context windows', exact: true })).toBeVisible();
  const known = page.locator('tbody tr').filter({ hasText: 'Astra fixture' });
  await expect(known).toContainText('codex/gpt-6-astra');
  await expect(known).toContainText('272,000');
  await expect(known).toContainText('300,000');
  const unknown = page.locator('tbody tr').filter({ hasText: 'Unknown window fixture' });
  await expect(unknown.locator('td').nth(0)).toHaveText('Unknown');
  await expect(unknown.locator('td').nth(1)).toHaveText('Unknown');
  await unknown.getByRole('button').click();
  await expect(inspector(page).getByLabel('Context window in tokens')).toHaveValue('');
  await expect(inspector(page)).toContainText('cannot by themselves force a client’s auto-compaction threshold to 100%');
  expect(state.writes).toEqual([]);
});

test('save requires confirmation, sends exact key and token integer, then reads back', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/dashboard/model-context');
  await selectAstra(page);
  await inspector(page).getByLabel('Context window in tokens').fill('400000');
  await inspector(page).getByRole('button', { name: 'Review override', exact: true }).click();
  await expect(dialog(page)).toContainText('codex/gpt-6-astra');
  await expect(dialog(page)).toContainText('400,000');
  expect(state.writes).toHaveLength(0);
  await dialog(page).getByRole('button', { name: 'Save override', exact: true }).click();
  await expect(inspector(page)).toContainText('Override saved and verified after refresh.');
  await expect(inspector(page)).toContainText('400,000 tokens');
  expect(state.writes).toEqual([{ method: 'PUT', body: { key: 'codex/gpt-6-astra', contextWindow: 400000 }, key: null }]);
  expect(state.reads()).toBeGreaterThanOrEqual(2);
});

test('blank, fractional, negative and imprecise limits are never submitted', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/dashboard/model-context');
  await selectAstra(page);
  for (const value of ['', '0', '-4', '1.5', '1e6', '9007199254740992']) {
    await inspector(page).getByLabel('Context window in tokens').fill(value);
    await expect(inspector(page).getByRole('button', { name: 'Review override', exact: true })).toBeDisabled();
    await expect(inspector(page)).toContainText('Enter a positive whole number of tokens.');
  }
  expect(state.writes).toEqual([]);
});

test('refusal stays in the scoped confirmation without a success notice', async ({ page }) => {
  await fixture(page, { refusal: true });
  await page.goto('/dashboard/model-context');
  await selectAstra(page);
  await inspector(page).getByLabel('Context window in tokens').fill('400000');
  await inspector(page).getByRole('button', { name: 'Review override', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Save override', exact: true }).click();
  await expect(dialog(page)).toContainText('This action is not allowed from here.');
  await expect(dialog(page)).toContainText('Fixture operator edits refused');
  await expect(page.getByText('Override saved and verified after refresh.', { exact: true })).toHaveCount(0);
});

test('successful mutation with stale readback remains unverified and blocks editing', async ({ page }) => {
  await fixture(page, { stale: true });
  await page.goto('/dashboard/model-context');
  await selectAstra(page);
  await inspector(page).getByLabel('Context window in tokens').fill('400000');
  await inspector(page).getByRole('button', { name: 'Review override', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Save override', exact: true }).click();
  await expect(inspector(page)).toContainText('The request succeeded, but readback did not verify the change.');
  await expect(inspector(page).getByRole('button', { name: 'Review override', exact: true })).toBeDisabled();
});

test('readback failure preserves uncertainty after accepted mutation', async ({ page }) => {
  await fixture(page, { readbackFailure: true });
  await page.goto('/dashboard/model-context');
  await selectAstra(page);
  await inspector(page).getByLabel('Context window in tokens').fill('400000');
  await inspector(page).getByRole('button', { name: 'Review override', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Save override', exact: true }).click();
  await expect(inspector(page)).toContainText('The request succeeded, but readback did not verify the change.');
  await expect(page.getByText('Fixture readback unavailable', { exact: true })).toBeVisible();
});

test('saved wildcard can be inspected and removed without inventing a catalog model', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/dashboard/model-context');
  await expect(page.locator('tbody')).not.toContainText('orphan');
  await page.getByLabel('Inventory', { exact: true }).selectOption('overrides');
  await page.getByRole('button', { name: '*orphan-fixture*', exact: true }).click();
  await expect(inspector(page)).toContainText('Not a catalog model');
  await inspector(page).getByRole('button', { name: 'Remove this override', exact: true }).click();
  expect(state.writes).toHaveLength(0);
  await dialog(page).getByRole('button', { name: 'Remove override', exact: true }).click();
  await expect(inspector(page)).toContainText('Override removed and verified after refresh.');
  expect(state.writes).toEqual([{ method: 'DELETE', body: null, key: '*orphan-fixture*' }]);
  await expect(page.locator('tbody')).not.toContainText('orphan');
});

test('pagination bounds rendered rows and search resets the page without losing selection', async ({ page }) => {
  await fixture(page, { many: true });
  await page.goto('/dashboard/model-context');
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await selectAstra(page);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Page 2 of 3 · 20 rows per page', { exact: true })).toBeVisible();
  await page.getByLabel('Find a model or saved key').fill('Unknown window fixture');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByText('Page 1 of 1 · 20 rows per page', { exact: true })).toBeVisible();
  await expect(inspector(page)).toContainText('codex/gpt-6-astra');
});

test('unavailable configuration remains unknown without manufactured editable models', async ({ page }) => {
  await page.route('**/api/model-context*', route => route.fulfill(json(403, { error: 'Fixture context read refused' })));
  await page.goto('/dashboard/model-context');
  await expect(page.getByText('This action is not allowed from here.', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture context read refused', { exact: true })).toBeVisible();
  await expect(page.getByText('Inventory unknown', { exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review override', exact: true })).toHaveCount(0);
});

async function assertIsolatedLtr(locator, text) {
  await expect(locator).toHaveText(text);
  await expect(locator).toHaveAttribute('dir', 'ltr');
  const result = await locator.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const positions = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let index = 0; index < node.textContent.length; index++) {
        const range = document.createRange();
        range.setStart(node, index); range.setEnd(node, index + 1);
        const rectangle = range.getBoundingClientRect();
        positions.push({ left: rectangle.left, top: rectangle.top });
      }
    }
    return { direction: getComputedStyle(element).direction, isolation: getComputedStyle(element).unicodeBidi, protected: element.closest('[data-i18n-skip]') !== null, positions };
  });
  expect(result.direction).toBe('ltr');
  expect(result.isolation).toBe('isolate');
  expect(result.protected).toBe(true);
  expect(result.positions.length).toBeGreaterThan(1);
  for (let index = 1; index < result.positions.length; index++) {
    if (Math.abs(result.positions[index].top - result.positions[index - 1].top) < 1) {
      expect(result.positions[index].left).toBeGreaterThan(result.positions[index - 1].left);
    }
  }
}

test('RTL isolates exact model keys, wildcard keys and token values without changing submitted values', async ({ page }) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/dashboard/model-context');
  await expect(page.getByRole('heading', { name: 'Context windows', exact: true })).toBeVisible();
  // Same deterministic RTL switch as shaping-review.spec.mjs. Fixture labels
  // remain English so this exercises bidi behavior independently of catalogs.
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const known = page.locator('tbody tr').filter({ hasText: 'Astra fixture' });
  await assertIsolatedLtr(known.locator('th .model-context-key'), 'codex/gpt-6-astra');
  await assertIsolatedLtr(known.locator('td').nth(0).locator('bdi'), '272,000');
  await assertIsolatedLtr(known.locator('td').nth(1).locator('bdi'), '300,000');
  await assertIsolatedLtr(known.locator('td').nth(2).locator('.model-context-key'), 'codex/gpt-6-astra');
  const unknown = page.locator('tbody tr').filter({ hasText: 'Unknown window fixture' }).locator('td').first();
  await expect(unknown).toHaveText('Unknown');
  expect(await unknown.evaluate(element => element.closest('[data-i18n-skip]') !== null)).toBe(false);
  await expect(unknown.locator('bdi')).toHaveCount(0);

  await selectAstra(page);
  const scope = inspector(page).getByLabel('Override scope and saved key');
  await expect(scope).toHaveAttribute('dir', 'ltr');
  await expect(scope).toHaveValue('codex/gpt-6-astra');
  expect(await scope.locator('option:checked').textContent()).toContain('\u2066codex/gpt-6-astra\u2069');
  const input = inspector(page).getByLabel('Context window in tokens');
  await expect(input).toHaveAttribute('dir', 'ltr');
  await expect(input).toHaveValue('300000');
  expect(await input.evaluate(element => ({ direction: getComputedStyle(element).direction, isolation: getComputedStyle(element).unicodeBidi }))).toEqual({ direction: 'ltr', isolation: 'isolate' });
  const primaryText = page.locator('.model-context-page table th, .model-context-page table td, .model-context-page table code, .model-context-page table bdi, .model-context-page .mantine-InputWrapper-label, .model-context-page .mantine-InputWrapper-description, .model-context-page .mantine-Input-input, .model-context-page .mantine-Button-label');
  const belowFloor = await primaryText.evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height > 0 && Number.parseFloat(getComputedStyle(element).fontSize) < 13).map(element => ({ text: element.textContent, size: getComputedStyle(element).fontSize })));
  expect(belowFloor).toEqual([]);
  await scope.selectOption('gpt-6-astra');
  await expect(scope).toHaveValue('gpt-6-astra');
  expect(await scope.locator('option:checked').textContent()).toContain('\u2066gpt-6-astra\u2069');
  await input.fill('400000');
  await inspector(page).getByRole('button', { name: 'Review override', exact: true }).click();
  await assertIsolatedLtr(dialog(page).locator('.model-context-key').first(), 'gpt-6-astra');
  await assertIsolatedLtr(dialog(page).locator('.model-context-number').first(), '400,000');
  await dialog(page).getByRole('button', { name: 'Save override', exact: true }).click();
  await expect(inspector(page)).toContainText('Override saved and verified after refresh.');
  expect(state.writes).toEqual([{ method: 'PUT', body: { key: 'gpt-6-astra', contextWindow: 400000 }, key: null }]);
  await assertIsolatedLtr(inspector(page).locator('.notice .model-context-key'), 'gpt-6-astra');

  await page.getByLabel('Inventory', { exact: true }).selectOption('overrides');
  const wildcard = page.getByRole('button', { name: '*orphan-fixture*', exact: true });
  await assertIsolatedLtr(wildcard.locator('.model-context-key'), '*orphan-fixture*');
  await wildcard.click();
  await assertIsolatedLtr(inspector(page).locator('.model-context-edit .model-context-key'), '*orphan-fixture*');
  await inspector(page).getByRole('button', { name: 'Remove this override', exact: true }).click();
  await assertIsolatedLtr(dialog(page).locator('.model-context-key').first(), '*orphan-fixture*');
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.writes).toHaveLength(1);
});
