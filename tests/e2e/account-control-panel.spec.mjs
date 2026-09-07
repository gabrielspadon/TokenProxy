import { test, expect } from 'playwright/test';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { captureAccountControls } from '../../src/shared/utils/accountControls.js';

// This suite mutates only the launcher's representative, credentialless fixture.
// E2E_FIXTURE_ROOT must be its owned run root, and E2E_BASE its exact loopback URL.
// Tracing is disabled because the fixture's private login is not an output artifact.
test.use({ serviceWorkers: 'block', timezoneId: 'UTC', reducedMotion: 'reduce', trace: 'off' });
test('account cards persist scoped controls and visibility, reject conflicts, and retain accessible navigation', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(180000);
  expect(process.env.E2E_FIXTURE_ROOT, 'An owned representative fixture root is required').toBeTruthy();
  const root = await realpath(process.env.E2E_FIXTURE_ROOT);
  const runtime = JSON.parse(await readFile(`${root}/process.json`, 'utf8'));
  const owner = JSON.parse(await readFile(`${root}/owner.json`, 'utf8'));
  expect(owner.kind).toBe('tokenproxy-redesign-preview-v1');
  expect(owner.root).toBe(root);
  expect(owner.runId).toBe(runtime.runId);
  expect(['dev', 'production']).toContain(runtime.mode);
  expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(process.env.E2E_BASE).toBe(runtime.url);
  expect(baseURL).toBe(runtime.url);
  if (runtime.mode === 'production') expect(runtime.buildId).toBeTruthy();
  await authenticateRedesign(context, root);
  await context.addCookies([{ name: 'locale', value: 'ar', url: runtime.url }]);
  const safety = await installRedesignBrowser(page, { baseUrl: runtime.url, runtimeReceipt: runtime, operator: false });
  if (runtime.mode === 'production') await page.routeWebSocket('**/*', socket => socket.close());
  const report = { runtime, checks: [], images: [], apiFailures: [], errors: [], writes: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === runtime.url && url.pathname.startsWith('/api/') && response.status() >= 400) report.apiFailures.push({ path: url.pathname, method: response.request().method(), status: response.status() });
  });
  page.on('request', request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) report.writes.push({ path: new URL(request.url()).pathname, method: request.method() });
  });
  async function read(path) {
    const response = await context.request.get(`${runtime.url}${path}`);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['x-tokenproxy-preview-version']).toBe(runtime.fixtureVersion);
    return response.json();
  }
  async function goto(path) {
    const response = await page.goto(`${runtime.url}${path}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    expect(response.status()).toBe(200);
    expect(response.headers()['x-tokenproxy-preview-version']).toBe(runtime.fixtureVersion);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  }
  async function capture(label) {
    await page.mouse.move(0, 0);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const path = testInfo.outputPath(`${label}.png`);
    const bytes = await page.screenshot({ path });
    report.images.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), viewport: page.viewportSize(), url: page.url(), imageInspected: false });
    await testInfo.attach(label, { path, contentType: 'image/png' });
  }
  async function check(label, action) {
    await test.step(label, action);
    report.checks.push({ label, passed: true });
  }
  try {
  await goto('/dashboard');
  const panel = page.getByRole('region', { name: 'Account control panel', exact: true });
  await expect(panel.locator('[data-account-id]')).toHaveCount(12, { timeout: 60000 });
  await expect(panel.getByRole('meter').first()).toBeVisible({ timeout: 60000 });
  for (const [width, height] of [[1440, 1000], [1920, 1080], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await capture(`accounts-cards-${width}`);
    await check(`Account cards ${width}px fit viewport`, async () => {
      const bounds = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
      expect(bounds.content).toBeLessThanOrEqual(bounds.width);
    });
  }
  {
    const initial = (await read('/api/providers')).connections.find(account => account.name === 'Synthetic research account');
    expect(initial).toBeTruthy();
    const accountPath = `/api/providers/${encodeURIComponent(initial.id)}`;
    const current = async () => (await read(accountPath)).connection;
    const card = panel.locator(`[data-account-id="${initial.id}"]`);
    const windowKey = initial.lastQuotaSnapshot.windows[0].key;
    const limits = () => card.getByRole('button', { name: 'Limits', exact: true });
    const dialog = page.getByRole('dialog', { name: `Limits for ${initial.name}`, exact: true });
    async function saveLimits(expectedStatus = 200) {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === accountPath && response.request().method() === 'PUT');
      await dialog.getByRole('button', { name: 'Save limits', exact: true }).click();
      expect((await response).status()).toBe(expectedStatus);
      if (expectedStatus === 200) await expect(dialog).toBeHidden();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await check('Remaining and used meters describe complementary percentages', async () => {
      const meter = card.getByRole('meter', { name: `${windowKey} remaining`, exact: true });
      const remaining = Number(await meter.getAttribute('aria-valuenow'));
      await panel.getByText('Used', { exact: true }).click();
      expect(Number(await card.getByRole('meter', { name: `${windowKey} used`, exact: true }).getAttribute('aria-valuenow'))).toBeCloseTo(100 - remaining);
      await panel.getByText('Remaining', { exact: true }).click();
    });
    await check('Search and configured-state filters change the actual card collection', async () => {
      await panel.getByRole('searchbox', { name: 'Search accounts', exact: true }).fill(initial.name);
      await expect(panel.locator('[data-account-id]')).toHaveCount(1);
      await panel.getByRole('searchbox', { name: 'Search accounts', exact: true }).fill('');
      await panel.getByRole('combobox', { name: 'Account status', exact: true }).selectOption('Paused');
      await expect(panel.locator('[data-account-id]')).toHaveCount(4);
      await panel.getByRole('combobox', { name: 'Account status', exact: true }).selectOption('all');
    });
    await check('Pause and resume persist through actual API and full reload', async () => {
      for (const active of [false, true]) {
        const response = page.waitForResponse(response => new URL(response.url()).pathname === accountPath && response.request().method() === 'PUT');
        await card.getByRole('button', { name: active ? 'Resume' : 'Pause', exact: true }).click();
        expect((await response).status()).toBe(200);
        await expect(card.getByRole('button', { name: active ? 'Pause' : 'Resume', exact: true })).toBeEnabled();
        expect((await current()).isActive).toBe(active);
        await page.reload();
        await expect(card.getByRole('button', { name: active ? 'Pause' : 'Resume', exact: true })).toBeEnabled({ timeout: 30000 });
      }
    });
    await check('Limits save thresholds, zero disables a window, priority renumbering reads back', async () => {
      await limits().click();
      await dialog.getByLabel('Fallback priority', { exact: true }).fill('50');
      await dialog.getByLabel(windowKey, { exact: true }).fill('25');
      await capture('accounts-limits-1440');
      await saveLimits();
      let saved = await current();
      expect(saved.quotaPauseThresholds[windowKey]).toBe(25);
      expect(saved.priority).toBeGreaterThanOrEqual(1);
      expect(saved.priority).not.toBe(50);
      await page.reload();
      await limits().click();
      await expect(dialog.getByLabel(windowKey, { exact: true })).toHaveValue('25%');
      await dialog.getByLabel(windowKey, { exact: true }).fill('0');
      await saveLimits();
      saved = await current();
      expect(saved.quotaPauseThresholds[windowKey]).toBeUndefined();
    });
    await check('Real competing policy write returns409, keeps the draft, blocks replay and permits explicit reread', async () => {
      await limits().click();
      await dialog.getByLabel(windowKey, { exact: true }).fill('30');
      const before = await current();
      const competing = await context.request.put(`${runtime.url}${accountPath}`, { data: { isActive: false, expectedControls: captureAccountControls(before) } });
      expect(competing.status()).toBe(200);
      report.writes.push({ path: accountPath, method: 'PUT', source: 'actual competing synthetic operator; no response interception' });
      await saveLimits(409);
      await expect(dialog.getByLabel(windowKey, { exact: true })).toHaveValue('30%');
      await expect(dialog.getByRole('button', { name: 'Save limits', exact: true })).toBeDisabled();
      await capture('accounts-conflict-1440');
      await dialog.getByRole('button', { name: 'Read current settings', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Save limits', exact: true })).toBeEnabled();
      await saveLimits();
      expect((await current()).quotaPauseThresholds[windowKey]).toBe(30);
      await limits().click();
      await dialog.getByLabel(windowKey, { exact: true }).fill(String(initial.quotaPauseThresholds?.[windowKey] ?? 0));
      await dialog.getByLabel('Fallback priority', { exact: true }).fill('1');
      await saveLimits();
      await card.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(card.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
      const restored = await current();
      expect(restored.isActive).toBe(initial.isActive);
      expect(restored.quotaPauseThresholds).toEqual(initial.quotaPauseThresholds ?? {});
      report.priorityNormalization = { initial: initial.priority, final: restored.priority, note: 'The maintained route normalizes priorities per provider; original relative ordering restored.' };
    });
    await check('Customize persists account and quota-window visibility across full reload', async () => {
      await panel.getByRole('button', { name: 'Customize', exact: true }).click();
      const customize = page.getByRole('dialog', { name: 'Customize account panel', exact: true });
      const accountToggle = customize.getByRole('checkbox', { name: `Show ${initial.name}`, exact: true });
      const preference = customize.locator('[class*="preference"]').filter({ has: page.getByRole('checkbox', { name: `Show ${initial.name}`, exact: true }) });
      await preference.getByRole('checkbox', { name: windowKey, exact: true }).uncheck();
      await page.keyboard.press('Escape');
      await expect(card.getByRole('meter', { name: `${windowKey} remaining`, exact: true })).toHaveCount(0);
      await page.reload();
      await expect(card).toBeVisible();
      await expect(card.getByRole('meter', { name: `${windowKey} remaining`, exact: true })).toHaveCount(0);
      await panel.getByRole('button', { name: 'Customize', exact: true }).click();
      await accountToggle.uncheck();
      await page.keyboard.press('Escape');
      await page.reload();
      await expect(panel.locator('[data-account-id]')).toHaveCount(11);
      await panel.getByRole('button', { name: 'Customize', exact: true }).click();
      await customize.getByRole('button', { name: 'Restore default view', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(panel.locator('[data-account-id]')).toHaveCount(12);
    });
    await check('Cards and Compare render at all three widths with readable metadata', async () => {
      for (const [width, height] of [[1440, 1000], [1920, 1080], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await panel.getByText('Compare', { exact: true }).click();
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture(`accounts-compare-${width}`);
        const bounds = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
        expect(bounds.content).toBeLessThanOrEqual(bounds.width);
        const sizes = await panel.locator('article span, article small, article time').evaluateAll(elements => elements.filter(element => element.childElementCount === 0 && element.textContent.trim() && element.getBoundingClientRect().width > 0).map(element => parseFloat(getComputedStyle(element).fontSize)));
        expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
        await panel.getByText('Cards', { exact: true }).click();
      }
    });
    await check('Mobile limits modal fits, retains keyboard focus, and cancels without a write', async () => {
      await limits().click();
      await capture('accounts-limits-390');
      const beforeWrites = report.writes.length;
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(limits()).toBeFocused();
      expect(report.writes.length).toBe(beforeWrites);
    });
    await check('Historical Activity and analysis remains reachable from the primary panel', async () => {
      await page.getByText('Activity & analysis', { exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Search configured accounts', exact: true })).toBeVisible();
      await page.getByText('Control panel', { exact: true }).click();
      await expect(panel).toBeVisible();
    });
  }
  expect(report.errors).toEqual([]);
  expect(report.apiFailures.filter(entry => !(entry.status === 409 && entry.method === 'PUT'))).toEqual([]);
    expect(safety.outboundFailures).toEqual([]);
  } finally {
    report.outboundFailures = safety.outboundFailures;
    const receiptPath = testInfo.outputPath('account-control-panel-receipt.json');
    await writeFile(receiptPath, JSON.stringify(report, null, 2));
    await testInfo.attach('account-control-panel-receipt', { path: receiptPath, contentType: 'application/json' });
  }
});
