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

// The board is the whole surface: one article per entry, its window edited in
// the article, its precedence evidence expanded under it. Nothing opens a layer.
const entry = (page, text) => page.locator('article[data-account-id]').filter({ hasText: text });
const astra = page => entry(page, 'codex/gpt-6-astra');
const tokens = locator => locator.locator('[data-context-token-input]');
const detail = page => page.locator('[id^="context-detail-"]');
const toast = page => page.locator('[class*="Notification-root"]');
const notice = page => page.locator('p[role="alert"]');

async function open(page) {
  await page.goto('/dashboard/model-context');
  await expect(page.getByRole('heading', { name: 'Context limits', exact: true })).toBeVisible();
}
async function expand(locator) {
  await locator.locator('button[aria-label^="Expand "]').first().click();
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test('local catalog quantities retain unknown windows and exact configured identity', async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await expect(astra(page)).toContainText('Astra fixture');
  await expect(astra(page)).toContainText('300K');
  await expect(tokens(astra(page))).toHaveValue('300000');
  await expect(astra(page)).toHaveAttribute('data-bucket', 'override');
  const unknown = entry(page, 'custom-fixture/unreported');
  await expect(unknown).toHaveAttribute('data-bucket', 'unknown');
  await expect(tokens(unknown)).toHaveValue('');
  await expand(unknown);
  await expect(detail(page)).toContainText('cannot by itself force a client’s auto-compaction threshold to 100%');
  expect(state.writes).toEqual([]);
});

test('a committed window sends exactly one exact key and integer, then reads back', async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await tokens(astra(page)).fill('400000');
  expect(state.writes).toHaveLength(0);
  await tokens(astra(page)).press('Enter');
  await expect(toast(page)).toContainText('Override saved and verified after refresh: codex/gpt-6-astra.');
  await expect(astra(page)).toContainText('400K');
  expect(state.writes).toEqual([{ method: 'PUT', body: { key: 'codex/gpt-6-astra', contextWindow: 400000 }, key: null }]);
  expect(state.reads()).toBeGreaterThanOrEqual(2);
});

test('blank and non-positive limits are never submitted', async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  for (const value of ['', '0']) {
    await tokens(astra(page)).fill(value);
    await tokens(astra(page)).press('Enter');
  }
  expect(state.writes).toEqual([]);
  await expect(page.getByText('Enter a positive whole number of tokens.')).toBeVisible();
});

test('a refusal is reported and no success is claimed', async ({ page }) => {
  await fixture(page, { refusal: true });
  await open(page);
  await tokens(astra(page)).fill('400000');
  await tokens(astra(page)).press('Enter');
  await expect(toast(page)).toContainText('This action is not allowed from here.');
  await expect(toast(page)).toContainText('Fixture operator edits refused');
  await expect(page.getByText('Override saved and verified', { exact: false })).toHaveCount(0);
});

test('a successful write with a stale readback stays unverified and blocks editing', async ({ page }) => {
  await fixture(page, { stale: true });
  await open(page);
  await tokens(astra(page)).fill('400000');
  await tokens(astra(page)).press('Enter');
  await expect(toast(page)).toContainText('readback did not verify the change to codex/gpt-6-astra');
  await expect(page.getByText('Readback is unverified. Refresh before another change.')).toBeVisible();
  await expect(tokens(astra(page))).toBeDisabled();
});

test('a readback failure preserves uncertainty after an accepted write', async ({ page }) => {
  await fixture(page, { readbackFailure: true });
  await open(page);
  await tokens(astra(page)).fill('400000');
  await tokens(astra(page)).press('Enter');
  await expect(toast(page)).toContainText('readback did not verify the change');
  await expect(notice(page)).toContainText('Fixture readback unavailable');
});

test('a saved wildcard is its own entry and is removed inline, without inventing a catalog model', async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  const orphan = entry(page, '*orphan-fixture*');
  await expect(orphan).toHaveCount(1);
  await expand(orphan);
  await expect(detail(page)).toContainText('Not a catalog model');
  await orphan.locator('[aria-label="Remove the override for *orphan-fixture*"]').click();
  expect(state.writes).toHaveLength(0);
  await orphan.getByRole('group', { name: 'Confirm: Remove the override for *orphan-fixture*' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(toast(page)).toContainText('Override removed and verified after refresh: *orphan-fixture*.');
  expect(state.writes).toEqual([{ method: 'DELETE', body: null, key: '*orphan-fixture*' }]);
  await expect(entry(page, '*orphan-fixture*')).toHaveCount(0);
});

test('the board bounds what it renders and search narrows it without a page control', async ({ page }) => {
  await fixture(page, { many: true });
  await open(page);
  await expect(page.locator('article[data-account-id]')).toHaveCount(48);
  await page.getByLabel('Find a model or saved key').fill('Unknown window fixture');
  await expect(page.locator('article[data-account-id]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
});

test('an unavailable configuration remains unknown without manufactured editable models', async ({ page }) => {
  await page.route('**/api/model-context*', route => route.fulfill(json(403, { error: 'Fixture context read refused' })));
  await open(page);
  await expect(notice(page)).toContainText('This action is not allowed from here.');
  await expect(notice(page)).toContainText('Fixture context read refused');
  await expect(page.locator('article[data-account-id]')).toHaveCount(0);
  await expect(page.locator('[data-context-token-input]')).toHaveCount(0);
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
    return { direction: getComputedStyle(element).direction, isolation: getComputedStyle(element).unicodeBidi, positions };
  });
  expect(result.direction).toBe('ltr');
  expect(result.isolation).toBe('isolate');
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
  await open(page);
  // Exercise identifier isolation under an externally changed document direction.
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await assertIsolatedLtr(astra(page).locator('.model-context-key').first(), 'codex/gpt-6-astra');
  await expect(tokens(astra(page))).toHaveAttribute('dir', 'ltr');
  await expect(tokens(astra(page))).toHaveValue('300000');
  expect(await tokens(astra(page)).evaluate(element => ({ direction: getComputedStyle(element).direction, isolation: getComputedStyle(element).unicodeBidi }))).toEqual({ direction: 'ltr', isolation: 'isolate' });

  await expand(astra(page));
  const scope = detail(page).getByLabel('Override scope and saved key');
  await expect(scope).toHaveAttribute('dir', 'ltr');
  await expect(scope).toHaveValue('codex/gpt-6-astra');
  expect(await scope.locator('option:checked').textContent()).toContain('⁦codex/gpt-6-astra⁩');
  await scope.selectOption('gpt-6-astra');
  await tokens(astra(page)).fill('400000');
  await tokens(astra(page)).press('Enter');
  await expect(toast(page)).toContainText('Override saved and verified after refresh: gpt-6-astra.');
  expect(state.writes).toEqual([{ method: 'PUT', body: { key: 'gpt-6-astra', contextWindow: 400000 }, key: null }]);

  const wildcard = entry(page, '*orphan-fixture*');
  await assertIsolatedLtr(wildcard.locator('.model-context-key').first(), '*orphan-fixture*');
  // Interface text follows the shared dense scale; nothing drops below it.
  const belowFloor = await page.locator('.model-context-page article, .model-context-page article code, .model-context-page article bdi, .model-context-page .mantine-Input-input, .model-context-page .mantine-Button-label').evaluateAll(elements =>
    elements.filter(element => element.getBoundingClientRect().height > 0 && Number.parseFloat(getComputedStyle(element).fontSize) < 12).map(element => ({ text: element.textContent, size: getComputedStyle(element).fontSize })));
  expect(belowFloor).toEqual([]);
});
