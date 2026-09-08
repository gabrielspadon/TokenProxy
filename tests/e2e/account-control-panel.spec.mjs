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
    await expect(page.locator('.mantine-AppShell-header')).toContainText('Synthetic fixture', { timeout: 60000 });
    await page.mouse.move(0, 0);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await page.locator('img').evaluateAll(async images => {
      const visible = images.filter(image => {
        const bounds = image.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < innerHeight && bounds.left < innerWidth;
      });
      await Promise.all(visible.map(image => image.decode()));
    });
    const path = testInfo.outputPath(`${label}.png`);
    const bytes = await page.screenshot({ path, animations: 'disabled' });
    report.images.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), viewport: page.viewportSize(), url: page.url(), visibleImagesDecoded: true, finiteAnimationsCompleted: true, imageInspected: false });
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
    const settings = card.getByRole('form', { name: `Account settings for ${initial.name}`, exact: true });
    const priority = settings.getByLabel('Fallback priority', { exact: true });
    const threshold = card.getByLabel(`Auto-pause threshold for ${windowKey}`, { exact: true });
    const save = card.getByRole('button', { name: 'Save changes', exact: true });
    async function saveSettings(expectedStatus = 200) {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === accountPath && response.request().method() === 'PUT');
      await save.click();
      expect((await response).status()).toBe(expectedStatus);
      if (expectedStatus === 200) await expect(save).toHaveCount(0);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await check('Everyday controls keep pause and a keyboard reserve slider direct without exposing priority', async () => {
      await expect(priority).toBeHidden();
      await expect(threshold).toBeVisible();
      const slider = card.getByRole('slider', { name: `Adjust auto-pause for ${windowKey}`, exact: true });
      const before = await threshold.inputValue(), beforeWrites = report.writes.length;
      await slider.focus();
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      await expect(threshold).toHaveValue('1%');
      await expect(save).toBeEnabled();
      await card.getByRole('button', { name: 'Discard', exact: true }).click();
      await expect(threshold).toHaveValue(before);
      await expect(threshold).toBeFocused();
      expect(report.writes.length).toBe(beforeWrites);
    });
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
      await panel.getByLabel('Account status', { exact: true }).selectOption('Paused');
      await expect(panel.locator('[data-account-id]')).toHaveCount(4);
      await panel.getByLabel('Account status', { exact: true }).selectOption('all');
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
    await check('Inline drafts survive search, state facets, refresh and presentation changes until discarded', async () => {
      await panel.getByText('Advanced', { exact: true }).click();
      await expect(priority).toBeVisible();
      await expect(threshold).toBeVisible();
      await expect(card.getByRole('button', { name: 'Limits', exact: true })).toHaveCount(0);
      const originalThreshold = await threshold.inputValue();
      const beforeWrites = report.writes.length;
      await threshold.fill('27');
      const draft = await threshold.inputValue();
      await panel.getByText('Everyday', { exact: true }).click();
      await expect(priority).toBeHidden();
      await expect(threshold).toHaveValue(draft);
      await panel.getByText('Advanced', { exact: true }).click();
      await expect(priority).toBeVisible();
      await expect(threshold).toHaveValue(draft);
      const search = panel.getByRole('searchbox', { name: 'Search accounts', exact: true });
      await search.fill('Synthetic batch account');
      await expect(card).toHaveCount(0);
      await search.fill('');
      await expect(threshold).toHaveValue(draft);
      const states = panel.getByLabel('Account status', { exact: true });
      await states.selectOption('Paused');
      await expect(card).toHaveCount(0);
      await states.selectOption('all');
      await expect(threshold).toHaveValue(draft);
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/providers' && response.request().method() === 'GET');
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
      expect((await refreshed).status()).toBe(200);
      await expect(threshold).toHaveValue(draft);
      for (const view of ['Rows', 'Cards']) {
        await panel.getByText(view, { exact: true }).click();
        await expect(threshold).toHaveValue(draft);
      }
      await card.getByRole('button', { name: 'Discard', exact: true }).click();
      await expect(threshold).toHaveValue(originalThreshold);
      await expect(save).toHaveCount(0);
      expect(report.writes.length).toBe(beforeWrites);
      report.inlineDraft = { preservedAcross: ['Everyday', 'Advanced', 'search exclusion', 'state facet exclusion', 'actual API refresh', 'Rows', 'Cards'], value: draft, discardedTo: originalThreshold, persistedWrites: 0 };
    });
    await check('Inline thresholds save, zero disables a window, and priority renumbering reads back', async () => {
      await priority.fill('50');
      await threshold.fill('25');
      await capture('accounts-inline-settings-1440');
      await saveSettings();
      let saved = await current();
      expect(saved.quotaPauseThresholds[windowKey]).toBe(25);
      expect(saved.priority).toBeGreaterThanOrEqual(1);
      expect(saved.priority).not.toBe(50);
      await page.reload();
      await expect(threshold).toHaveValue('25%');
      await threshold.fill('0');
      await saveSettings();
      saved = await current();
      expect(saved.quotaPauseThresholds[windowKey]).toBeUndefined();
    });
    await check('Real competing policy write returns409, keeps the draft, blocks replay and permits explicit reread', async () => {
      await threshold.fill('30');
      const before = await current();
      const competing = await context.request.put(`${runtime.url}${accountPath}`, { data: { isActive: false, expectedControls: captureAccountControls(before) } });
      expect(competing.status()).toBe(200);
      report.writes.push({ path: accountPath, method: 'PUT', source: 'actual competing synthetic operator; no response interception' });
      await saveSettings(409);
      await expect(threshold).toHaveValue('30%');
      await expect(save).toBeDisabled();
      await capture('accounts-conflict-1440');
      await card.getByRole('button', { name: 'Read current settings', exact: true }).click();
      await expect(save).toBeEnabled();
      await expect(threshold).toHaveValue('30%');
      await saveSettings();
      expect((await current()).quotaPauseThresholds[windowKey]).toBe(30);
      await threshold.fill(String(initial.quotaPauseThresholds?.[windowKey] ?? 0));
      await panel.getByText('Advanced', { exact: true }).click();
      await priority.fill('1');
      await saveSettings();
      await card.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(card.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
      const restored = await current();
      expect(restored.isActive).toBe(initial.isActive);
      expect(restored.quotaPauseThresholds).toEqual(initial.quotaPauseThresholds ?? {});
      report.priorityNormalization = { initial: initial.priority, final: restored.priority, note: 'The maintained route normalizes priorities per provider; original relative ordering restored.' };
    });
    await check('A refreshed competing policy preserves the inline draft and blocks a known-stale write', async () => {
      const before = await current();
      const originalThreshold = await threshold.inputValue();
      await threshold.fill('29');
      const competing = await context.request.put(`${runtime.url}${accountPath}`, { data: { isActive: !before.isActive, expectedControls: captureAccountControls(before) } });
      expect(competing.status()).toBe(200);
      report.writes.push({ path: accountPath, method: 'PUT', source: 'actual competing synthetic operator before refresh; no response interception' });
      const beforeUiWrites = report.writes.length;
      const competingRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/providers' && response.request().method() === 'GET');
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
      expect((await competingRead).status()).toBe(200);
      await expect(threshold).toHaveValue('29%');
      await expect(save).toBeDisabled();
      await expect(card).toContainText('Stored settings changed. Your draft is retained.');
      await card.getByRole('button', { name: 'Read current settings', exact: true }).click();
      await expect(save).toBeEnabled();
      await expect(threshold).toHaveValue('29%');
      await card.getByRole('button', { name: 'Discard', exact: true }).click();
      await expect(threshold).toHaveValue(originalThreshold);
      expect(report.writes.length).toBe(beforeUiWrites);
      const restored = page.waitForResponse(response => new URL(response.url()).pathname === accountPath && response.request().method() === 'PUT');
      await card.getByRole('button', { name: before.isActive ? 'Resume' : 'Pause', exact: true }).click();
      expect((await restored).status()).toBe(200);
      expect((await current()).isActive).toBe(before.isActive);
    });
    await check('Customize persists account and quota-window visibility across full reload', async () => {
      await panel.getByRole('button', { name: 'Customize', exact: true }).click();
      const customize = page.getByRole('region', { name: 'Account panel visibility', exact: true });
      const accountToggle = customize.getByRole('checkbox', { name: `Show ${initial.name}`, exact: true });
      const preference = customize.locator('[class*="preference"]').filter({ has: page.getByRole('checkbox', { name: `Show ${initial.name}`, exact: true }) });
      await preference.getByRole('checkbox', { name: windowKey, exact: true }).uncheck();
      await customize.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(card.getByRole('meter', { name: `${windowKey} remaining`, exact: true })).toHaveCount(0);
      await page.reload();
      await expect(card).toBeVisible();
      await expect(card.getByRole('meter', { name: `${windowKey} remaining`, exact: true })).toHaveCount(0);
      await panel.getByRole('button', { name: 'Customize', exact: true }).click();
      await accountToggle.uncheck();
      await customize.getByRole('button', { name: 'Done', exact: true }).click();
      await page.reload();
      await expect(panel.locator('[data-account-id]')).toHaveCount(11);
      await panel.getByRole('button', { name: 'Customize', exact: true }).click();
      await customize.getByRole('button', { name: 'Restore default view', exact: true }).click();
      await customize.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(panel.locator('[data-account-id]')).toHaveCount(12);
    });
    await check('Cards and Rows render at all three widths with readable metadata', async () => {
      for (const [width, height] of [[1440, 1000], [1920, 1080], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await panel.getByText('Rows', { exact: true }).click();
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture(`accounts-rows-${width}`);
        const bounds = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
        expect(bounds.content).toBeLessThanOrEqual(bounds.width);
        const sizes = await panel.locator('article span, article small, article time').evaluateAll(elements => elements.filter(element => element.childElementCount === 0 && element.textContent.trim() && element.getBoundingClientRect().width > 0).map(element => parseFloat(getComputedStyle(element).fontSize)));
        expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
        await panel.getByText('Cards', { exact: true }).click();
      }
    });
    await check('Mobile priority and threshold controls are direct, fit and discard without a write', async () => {
      await panel.getByText('Advanced', { exact: true }).click();
      await expect(priority).toBeVisible();
      await expect(threshold).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const originalThreshold = await threshold.inputValue();
      const beforeWrites = report.writes.length;
      await threshold.fill('31');
      await capture('accounts-inline-settings-390');
      for (const input of [priority, threshold]) {
        const bounds = await input.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
      }
      await card.getByRole('button', { name: 'Discard', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(threshold).toHaveValue(originalThreshold);
      await expect(save).toHaveCount(0);
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
