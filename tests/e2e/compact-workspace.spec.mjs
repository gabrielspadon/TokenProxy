import { test, expect } from 'playwright/test';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';

// Use only a launcher's credentialless fixture and its real application handlers.
// Authentication is private; traces must never retain the synthetic password.
test.use({ serviceWorkers: 'block', timezoneId: 'UTC', reducedMotion: 'reduce', trace: 'off' });

test('compact scope, exact selection, shared comparison and responsive inspector retain context', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(15000);
  expect(process.env.E2E_FIXTURE_ROOT, 'An owned representative fixture root is required').toBeTruthy();
  const root = await realpath(process.env.E2E_FIXTURE_ROOT);
  const runtime = JSON.parse(await readFile(`${root}/process.json`, 'utf8'));
  const owner = JSON.parse(await readFile(`${root}/owner.json`, 'utf8'));
  expect(owner).toMatchObject({ kind: 'tokenproxy-redesign-preview-v1', root, runId: runtime.runId });
  expect(['dev', 'production']).toContain(runtime.mode);
  expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(process.env.E2E_BASE).toBe(runtime.url);
  expect(baseURL).toBe(runtime.url);
  if (runtime.mode === 'production') expect(runtime.buildId).toBeTruthy();
  await authenticateRedesign(context, root);
  const safety = await installRedesignBrowser(page, { baseUrl: runtime.url, runtimeReceipt: runtime });
  if (runtime.mode === 'production') await page.routeWebSocket('**/*', socket => socket.close());
  const report = { runtime, checks: [], layouts: [], comparisons: [], drafts: [], images: [], errors: [], console: [], apiFailures: [], writes: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.console.push({ type: message.type(), text: message.text() }); });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === runtime.url && url.pathname.startsWith('/api/') && response.status() >= 400) report.apiFailures.push({ path: url.pathname, status: response.status() });
  });
  page.on('request', request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) report.writes.push({ path: new URL(request.url()).pathname, method: request.method() });
  });
  const panel = page.getByRole('region', { name: 'Account control panel', exact: true });
  const scope = page.getByLabel('Shared analysis scope', { exact: true });
  const summary = page.getByRole('button', { name: 'Selected evidence', exact: true });
  const details = page.getByLabel('Selection details', { exact: true });
  const comparisonIds = () => (new URL(page.url()).searchParams.get('compare') || '').split(',').filter(Boolean);
  const selected = () => JSON.parse(new URL(page.url()).searchParams.get('selected') || 'null');
  const card = id => panel.locator(`[data-account-id="${id}"]`);
  async function read(path) {
    const response = await context.request.get(`${runtime.url}${path}`);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['x-tokenproxy-preview-version']).toBe(runtime.fixtureVersion);
    return response.json();
  }
  async function settled() {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  }
  async function capture(label) {
    await expect(page.locator('.mantine-AppShell-header')).toContainText('Synthetic fixture', { timeout: 60000 });
    await page.mouse.move(0, 0);
    await settled();
    await page.locator('img').evaluateAll(async images => {
      const visible = images.filter(image => {
        const bounds = image.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < innerHeight && bounds.left < innerWidth;
      });
      await Promise.all(visible.map(image => image.decode()));
    });
    const path = testInfo.outputPath(`${label}.png`);
    const bytes = await page.screenshot({ path, animations: 'disabled' });
    report.images.push({ label, path, sha256: createHash('sha256').update(bytes).digest('hex'), viewport: page.viewportSize(), url: page.url(), visibleImagesDecoded: true, finiteAnimationsCompleted: true, imageInspected: false });
    await testInfo.attach(label, { path, contentType: 'image/png' });
  }
  async function layout(label) {
    await settled();
    const geometry = await page.evaluate(() => {
      const rect = selector => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight }, contentWidth: document.documentElement.scrollWidth,
        scope: rect('[aria-label="Shared analysis scope"]'), summary: rect('[aria-label="Selected evidence"]'),
        selectionGroup: rect('[aria-label="Retained evidence selection"]'),
        inventory: rect('[aria-label="Inventory comparison"]'), details: rect('[aria-label="Selection details"]'),
        drawer: rect('.mantine-Drawer-content'),
      };
    });
    report.layouts.push({ label, ...geometry });
    expect(geometry.contentWidth, `${label} document fits viewport`).toBeLessThanOrEqual(geometry.viewport.width);
    return geometry;
  }
  async function check(label, action) {
    await test.step(label, action);
    report.checks.push({ label, passed: true });
  }
  async function chooseProvider(name) {
    await scope.getByRole('combobox', { name: 'Provider filter', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
  }
  async function closeDetails() {
    await page.getByRole('button', { name: 'Close selection details', exact: true }).click();
    await expect(details).toBeHidden();
  }
  try {
    const accounts = (await read('/api/providers')).connections;
    const research = accounts.find(account => account.name === 'Synthetic research account');
    const batch = accounts.find(account => account.name === 'Synthetic batch account');
    expect(research).toBeTruthy();
    expect(batch).toBeTruthy();
    const ids = [research.id, batch.id];
    report.accounts = ids;
    await page.setViewportSize({ width: 1920, height: 1080 });
    const response = await page.goto(`${runtime.url}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    expect(response.status()).toBe(200);
    expect(response.headers()['x-tokenproxy-preview-version']).toBe(runtime.fixtureVersion);
    await expect(panel.locator('[data-account-id]')).toHaveCount(12, { timeout: 60000 });
    await expect(panel.getByText('Rows', { exact: true })).toBeVisible();
    const emptyScope = {};
    await check('Empty selection and account cards fit desktop and phone widths', async () => {
      await expect(summary).toHaveCount(0);
      for (const [width, height] of [[1920, 1080], [1440, 1000], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => window.scrollTo(0, 0));
        emptyScope[width] = (await layout(`empty-${width}`)).scope;
        await capture(`compact-accounts-${width}`);
      }
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await card(research.id).getByRole('button', { name: /Synthetic research account/ }).click();
    await expect(details).toBeVisible();
    await expect.poll(selected).toMatchObject({ kind: 'account', id: research.id });
    await check('Retained selection is intrinsic within the shared scope at 1920 and 1440', async () => {
      for (const [width, height] of [[1920, 1080], [1440, 1000]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => window.scrollTo(0, 0));
        const geometry = await layout(`selected-${width}`);
        expect(geometry.summary.width).toBeLessThanOrEqual(320);
        expect(geometry.selectionGroup.width).toBeLessThan(geometry.scope.width * 0.6);
        const saved = await scope.getByRole('button', { name: 'Saved investigations', exact: true }).boundingBox();
        expect(Math.abs(geometry.summary.y - saved.y), 'Selection and saved actions share a line').toBeLessThanOrEqual(8);
        if (width === 1920) expect(geometry.scope.height).toBeLessThanOrEqual(emptyScope[width].height + 8);
        await capture(`compact-retained-${width}`);
      }
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await check('Exact selected identity survives scope changes and lens navigation', async () => {
      await chooseProvider('OpenAI');
      await expect(summary).toContainText('Outside scope');
      await summary.click();
      const popover = page.locator('.mantine-Popover-dropdown:visible');
      await expect(popover.getByText(`account · ${research.id}`, { exact: true })).toBeVisible();
      await expect(popover).toContainText('This record is outside the current filters. Its exact evidence stays selected.');
      await capture('compact-excluded-popover-1920');
      await page.keyboard.press('Escape');
      for (const lens of ['Context', 'Economics', 'Capacity']) {
        await page.getByRole('link', { name: lens, exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe({ Context: '/dashboard/context', Economics: '/dashboard/usage', Capacity: '/dashboard' }[lens]);
        await expect(scope.getByRole('combobox', { name: 'Provider filter', exact: true })).toHaveValue('OpenAI');
        await expect(summary).toContainText('Outside scope');
        await expect.poll(selected).toMatchObject({ id: research.id, provider: research.provider });
        expect(new URL(page.url()).searchParams.get('provider')).toBe('openai');
      }
      await page.reload();
      await expect(summary).toContainText('Outside scope');
      await summary.click();
      await page.locator('.mantine-Popover-dropdown:visible').getByRole('button', { name: 'Clear selection', exact: true }).click();
      await expect(summary).toHaveCount(0);
      await expect.poll(selected).toBeNull();
      await expect(scope.getByRole('button', { name: 'Export evidence', exact: true })).toBeFocused();
      await scope.getByRole('button', { name: 'Clear', exact: true }).click();
      await expect(panel.locator('[data-account-id]')).toHaveCount(12);
    });
    await check('Cards and Rows open the same real two-account comparison without losing search or IDs', async () => {
      const search = panel.getByRole('searchbox', { name: 'Search accounts', exact: true });
      for (const view of ['Cards', 'Rows']) {
        await panel.getByText(view, { exact: true }).click();
        for (const account of [research, batch]) await card(account.id).getByRole('checkbox', { name: `Compare ${account.name}`, exact: true }).check();
        await expect.poll(comparisonIds).toEqual(ids);
        await search.fill(research.name);
        await expect(panel.locator('[data-account-id]')).toHaveCount(1);
        await panel.getByRole('button', { name: 'Compare selected (2)', exact: true }).click();
        await expect(details).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Compare 2 accounts', exact: true })).toBeVisible();
        const totals = details.getByRole('region', { name: 'Exact account comparison totals', exact: true });
        await expect(totals.locator('tbody tr')).toHaveCount(2);
        const comparison = { view, ids: comparisonIds(), accounts: [] };
        for (const account of [research, batch]) {
          const expected = await read(`/api/analytics?view=activity&groupBy=account&pageSize=50&connectionId=${encodeURIComponent(account.id)}`);
          const row = totals.getByRole('row').filter({ has: page.getByRole('cell', { name: account.name, exact: true }) });
          await expect(row.locator('td').nth(2)).toHaveText(new Intl.NumberFormat('en-US').format(expected.summary.records));
          comparison.accounts.push({ id: account.id, name: account.name, apiRecords: expected.summary.records, renderedRecords: await row.locator('td').nth(2).innerText() });
        }
        report.comparisons.push(comparison);
        await capture(`compact-comparison-${view.toLowerCase()}-1920`);
        await closeDetails();
        await expect(panel.getByRole('button', { name: 'Compare selected (2)', exact: true })).toBeFocused();
        await expect(search).toHaveValue(research.name);
        await panel.getByText(view === 'Cards' ? 'Rows' : 'Cards', { exact: true }).click();
        await expect(search).toHaveValue(research.name);
        await expect.poll(comparisonIds).toEqual(ids);
        await search.fill('');
        for (const account of [research, batch]) await expect(card(account.id).getByRole('checkbox', { name: `Compare ${account.name}`, exact: true })).toBeChecked();
      }
      for (const lens of ['Context', 'Economics', 'Capacity']) {
        await page.getByRole('link', { name: lens, exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe({ Context: '/dashboard/context', Economics: '/dashboard/usage', Capacity: '/dashboard' }[lens]);
        await expect(summary).toContainText('2 accounts');
        await expect.poll(comparisonIds).toEqual(ids);
      }
      await page.reload();
      await expect(panel.getByRole('button', { name: 'Compare selected (2)', exact: true })).toBeEnabled();
      await expect.poll(comparisonIds).toEqual(ids);
      await panel.getByRole('button', { name: 'Compare selected (2)', exact: true }).click();
      await expect(details).toBeVisible();
      await summary.click();
      await page.locator('.mantine-Popover-dropdown:visible').getByRole('button', { name: 'Clear comparison', exact: true }).click();
      await expect(details).toBeHidden();
      await expect.poll(comparisonIds).toEqual([]);
      await expect(scope.getByRole('button', { name: 'Export evidence', exact: true })).toBeFocused();
      for (const account of [research, batch]) await card(account.id).getByRole('checkbox', { name: `Compare ${account.name}`, exact: true }).check();
      await expect.poll(comparisonIds).toEqual(ids);
      await expect(details).toBeHidden();
      await panel.getByRole('button', { name: 'Clear selection', exact: true }).click();
      await expect.poll(comparisonIds).toEqual([]);
    });
    await check('The inspector keeps a quota scenario draft and caret while moving between pane, drawer and phone', async () => {
      const trigger = card(research.id).getByRole('button', { name: /Synthetic research account/ });
      await trigger.click();
      await details.getByRole('tab', { name: /^Quota windows/ }).click();
      const draft = details.getByRole('textbox', { name: 'Workload multiplier', exact: true });
      await expect(draft).toBeVisible({ timeout: 30000 });
      await draft.fill('2.5');
      await draft.focus();
      await draft.evaluate(element => element.setSelectionRange(1, 2));
      const initialValue = await draft.inputValue();
      for (const [width, height] of [[1400, 1000], [390, 844], [1920, 1080]]) {
        await page.setViewportSize({ width, height });
        await expect(draft).toHaveValue(initialValue);
        await expect(draft).toBeFocused();
        await expect.poll(() => draft.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([1, 2]);
        report.drafts.push({ width, ...await draft.evaluate(element => ({ value: element.value, caret: [element.selectionStart, element.selectionEnd], focused: document.activeElement === element })) });
        const geometry = await layout(`inspector-draft-${width}`);
        if (width === 1400) {
          expect(geometry.drawer.width).toBeGreaterThanOrEqual(320);
          expect(geometry.drawer.width).toBeLessThanOrEqual(600);
          expect(geometry.drawer.x).toBeGreaterThanOrEqual(700);
          expect(geometry.inventory.width).toBeGreaterThanOrEqual(760);
          await expect(page.getByRole('button', { name: 'Return to comparison', exact: true })).toBeVisible();
        } else if (width === 390) {
          expect(geometry.drawer.width).toBeGreaterThanOrEqual(388);
          expect(geometry.drawer.width).toBeLessThanOrEqual(390);
        } else {
          expect(geometry.drawer).toBeNull();
          expect(geometry.inventory.width).toBeGreaterThanOrEqual(760);
        }
        await capture(`compact-inspector-draft-${width}`);
      }
      await closeDetails();
      await expect(trigger).toBeFocused();
    });
    expect(report.errors).toEqual([]);
    expect(report.apiFailures).toEqual([]);
    expect(report.writes, 'This navigation and scenario regression performs no persisted mutations').toEqual([]);
    expect(safety.outboundFailures).toEqual([]);
  } finally {
    report.outboundFailures = safety.outboundFailures;
    const receiptPath = testInfo.outputPath('compact-workspace-receipt.json');
    await writeFile(receiptPath, JSON.stringify(report, null, 2));
    await testInfo.attach('compact-workspace-receipt', { path: receiptPath, contentType: 'application/json' });
  }
});

test.describe('compact touch and motion', () => {
  test.use({ hasTouch: true });
  test('dark phone scope, checkbox hit areas, keyboard selection and drawer motion remain usable', async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(180000);
    expect(process.env.E2E_FIXTURE_ROOT).toBeTruthy();
    const root = await realpath(process.env.E2E_FIXTURE_ROOT);
    const runtime = JSON.parse(await readFile(`${root}/process.json`, 'utf8'));
    const owner = JSON.parse(await readFile(`${root}/owner.json`, 'utf8'));
    expect(owner).toMatchObject({ kind: 'tokenproxy-redesign-preview-v1', root, runId: runtime.runId });
    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(process.env.E2E_BASE).toBe(runtime.url);
    expect(baseURL).toBe(runtime.url);
    await authenticateRedesign(context, root);
    const safety = await installRedesignBrowser(page, { baseUrl: runtime.url, runtimeReceipt: runtime });
    if (runtime.mode === 'production') await page.routeWebSocket('**/*', socket => socket.close());
    const report = { runtime, layouts: [], motion: [], images: [], errors: [], console: [], writes: [] };
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.console.push({ type: message.type(), text: message.text() }); });
    page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) report.writes.push({ path: new URL(request.url()).pathname, method: request.method() }); });
    const panel = page.getByRole('region', { name: 'Account control panel', exact: true });
    const scope = page.getByLabel('Shared analysis scope', { exact: true });
    const summary = page.getByRole('button', { name: 'Selected evidence', exact: true });
    async function capture(label) {
      await expect(page.locator('.mantine-AppShell-header')).toContainText('Synthetic fixture', { timeout: 60000 });
      await page.mouse.move(0, 0);
      const logos = await page.locator('img').evaluateAll(async images => {
        await document.fonts.ready;
        const visible = images.filter(image => {
          const bounds = image.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < innerHeight && bounds.left < innerWidth;
        });
        await Promise.all(visible.map(image => image.decode()));
        return visible.map(image => ({ alt: image.alt, src: image.getAttribute('src'), width: image.naturalWidth, height: image.naturalHeight }));
      });
      const path = testInfo.outputPath(`${label}.png`);
      const bytes = await page.screenshot({ path, animations: 'disabled' });
      report.images.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), viewport: page.viewportSize(), logos, visibleImagesDecoded: true, finiteAnimationsCompleted: true, imageInspected: false });
      await testInfo.attach(label, { path, contentType: 'image/png' });
    }
    try {
      await page.setViewportSize({ width: 1920, height: 1080 });
      const response = await page.goto(`${runtime.url}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 90000 });
      expect(response.status()).toBe(200);
      expect(response.headers()['x-tokenproxy-preview-version']).toBe(runtime.fixtureVersion);
      await expect(panel.locator('[data-account-id]')).toHaveCount(12, { timeout: 60000 });
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      await page.getByRole('button', { name: 'Workspace preferences', exact: true }).click();
      await page.getByRole('dialog', { name: 'Workspace preferences', exact: true }).getByText('Dark', { exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
      const account = panel.locator('[data-account-id="capacity-fixture-a"]');
      const checkbox = account.getByRole('checkbox', { name: 'Compare Synthetic research account', exact: true });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await account.scrollIntoViewIfNeeded();
        const geometry = await checkbox.evaluate(input => {
          const box = element => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          return { hit: box(input.closest('label')), glyph: box(input), viewport: innerWidth, content: document.documentElement.scrollWidth };
        });
        const measurement = { width, ...geometry, edgeTapChangedCheckbox: false };
        report.layouts.push(measurement);
        expect(geometry.hit.width).toBeGreaterThanOrEqual(44);
        expect(geometry.hit.height).toBeGreaterThanOrEqual(44);
        expect(geometry.glyph.width).toBeGreaterThanOrEqual(18);
        expect.soft(geometry.glyph.width).toBeLessThanOrEqual(20);
        expect(geometry.glyph.height).toBeGreaterThanOrEqual(18);
        expect.soft(geometry.glyph.height).toBeLessThanOrEqual(20);
        expect(geometry.content).toBeLessThanOrEqual(width);
        const wasChecked = await checkbox.isChecked();
        await page.touchscreen.tap(geometry.hit.x + 2, geometry.hit.y + 2);
        await expect(checkbox).toBeChecked({ checked: !wasChecked });
        measurement.edgeTapChangedCheckbox = true;
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture(`compact-dark-coarse-${width}`);
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
      await account.getByRole('button', { name: /Synthetic research account/ }).click();
      await page.getByRole('link', { name: 'Context', exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard/context');
      await expect(page.getByRole('heading', { name: 'Context trace', exact: true })).toBeVisible();
      await expect(page.getByLabel('Selection details', { exact: true })).toBeHidden();
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await summary.focus();
        await page.keyboard.press('Enter');
        const popover = page.locator('.mantine-Popover-dropdown:visible');
        await expect(popover.getByText('account · capacity-fixture-a', { exact: true })).toBeVisible();
        const bounds = await popover.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await capture(`compact-dark-selected-popover-${width}`);
        await page.keyboard.press('Escape');
        await expect(popover).toBeHidden();
        await expect(summary).toBeFocused();
      }
      await page.keyboard.press('Enter');
      const clear = page.locator('.mantine-Popover-dropdown:visible').getByRole('button', { name: 'Clear selection', exact: true });
      await clear.focus();
      await page.keyboard.press('Enter');
      await expect(summary).toHaveCount(0);
      await expect(scope.getByRole('button', { name: 'Export evidence', exact: true })).toBeFocused();
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.getByRole('link', { name: 'Capacity', exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
      await expect(account).toBeVisible();
      await page.setViewportSize({ width: 1400, height: 1000 });
      const trigger = account.getByRole('button', { name: /Synthetic research account/ });
      for (const reducedMotion of ['no-preference', 'reduce']) {
        await page.emulateMedia({ reducedMotion });
        await page.evaluate(() => {
          const samples = [];
          let active = true;
          const sample = () => {
            const drawer = document.querySelector('.mantine-Drawer-content');
            if (drawer) samples.push({ at: performance.now(), x: drawer.getBoundingClientRect().x, duration: getComputedStyle(drawer).transitionDuration });
            if (active) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
          window.__compactMotion = () => { active = false; return samples; };
        });
        await trigger.click();
        const drawer = page.locator('.mantine-Drawer-content');
        await expect(drawer).toBeVisible();
        await expect.poll(() => drawer.evaluate(element => Math.round(element.getBoundingClientRect().x))).toBe(840);
        const samples = await page.evaluate(() => window.__compactMotion());
        expect(samples.length).toBeGreaterThan(0);
        const durations = samples.flatMap(sample => sample.duration.split(',').map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000)));
        if (reducedMotion === 'no-preference') {
          expect(Math.max(...durations)).toBeGreaterThanOrEqual(150);
          expect(samples.some(sample => sample.x > 841 && sample.x < 1399), 'At least one real intermediate drawer animation frame').toBe(true);
        } else expect(Math.max(...durations)).toBeLessThanOrEqual(1);
        report.motion.push({ reducedMotion, samples, settledX: 840, screenshotsUsedAsMotionEvidence: false });
        await page.getByRole('button', { name: 'Close selection details', exact: true }).click();
        await expect(drawer).toBeHidden();
        await expect(trigger).toBeFocused();
      }
      expect(report.errors).toEqual([]);
      expect(report.writes).toEqual([]);
      expect(safety.outboundFailures).toEqual([]);
    } finally {
      report.outboundFailures = safety.outboundFailures;
      const path = testInfo.outputPath('compact-touch-motion-receipt.json');
      await writeFile(path, JSON.stringify(report, null, 2));
      await testInfo.attach('compact-touch-motion-receipt', { path, contentType: 'application/json' });
    }
  });
});
