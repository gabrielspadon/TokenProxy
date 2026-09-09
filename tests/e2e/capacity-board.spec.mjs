import { test, expect } from 'playwright/test';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { captureAccountControls } from '../../src/shared/utils/accountControls.js';

// This suite mutates only the launcher's representative, credentialless fixture.
// E2E_FIXTURE_ROOT must be its owned run root, and E2E_BASE its exact loopback URL.
// Tracing is disabled because the fixture's private login is not an output artifact.
test.use({ serviceWorkers: 'block', timezoneId: 'UTC', reducedMotion: 'reduce', trace: 'off' });

const ACCOUNT = 'capacity-fixture-a';
const NAME = 'Synthetic research account';

async function fixture({ page, context, baseURL }) {
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
  return { runtime, safety };
}

test('the account board is one surface: glance, filter, edit in place, expand for evidence', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(15000);
  const { runtime, safety } = await fixture({ page, context, baseURL });
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
  const current = async () => (await read(`/api/providers/${ACCOUNT}`)).connection;
  const accountPath = `/api/providers/${ACCOUNT}`;
  const put = () => page.waitForResponse(response => new URL(response.url()).pathname === accountPath && response.request().method() === 'PUT');
  async function goto(path) {
    const response = await page.goto(`${runtime.url}${path}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    expect(response.status()).toBe(200);
    expect(response.headers()['x-tokenproxy-preview-version']).toBe(runtime.fixtureVersion);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  }
  async function capture(label) {
    await expect(page.locator('.mantine-AppShell-header')).toContainText('Synthetic fixture', { timeout: 60000 });
    await page.mouse.move(0, 0);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const path = testInfo.outputPath(`${label}.png`);
    const bytes = await page.screenshot({ path, animations: 'disabled' });
    report.images.push({ label, path, sha256: createHash('sha256').update(bytes).digest('hex'), viewport: page.viewportSize(), url: page.url(), imageInspected: false });
    await testInfo.attach(label, { path, contentType: 'image/png' });
  }
  async function check(label, action) {
    await test.step(label, action);
    report.checks.push({ label, passed: true });
  }
  // The chart canvas follows a resize on the next frame, so poll rather than read once.
  const fits = label => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth), { message: `${label} fits the viewport` }).toBeLessThanOrEqual(0);
  const level = async value => {
    const sections = page.getByRole('navigation', { name: 'Sections', exact: true });
    const burger = page.getByRole('button', { name: 'Open navigation', exact: true });
    if (await burger.isVisible()) await burger.click();
    await sections.getByText(value, { exact: true }).click();
    await expect(sections.getByRole('radio', { name: value, exact: true })).toBeChecked();
    const close = page.getByRole('button', { name: 'Close navigation', exact: true });
    if (await close.isVisible()) await close.click();
  };
  // A background re-read can land between Playwright's select-all and insert,
  // and the formatted number field then keeps its old value. Type until the
  // field reads back what was typed, which is what a person sees before Enter.
  const fillNumber = (field, text) => expect(async () => {
    await field().fill(text);
    await expect(field()).toHaveValue(new RegExp(`^${text}%?$`));
  }).toPass({ timeout: 20000 });
  const board = page.getByRole('region', { name: 'Account control panel', exact: true });
  const row = board.locator(`[data-account-id="${ACCOUNT}"]`);
  const summary = board.getByRole('group', { name: 'Account summary', exact: true });
  const initial = await current();
  expect(initial).toMatchObject({ id: ACCOUNT, name: NAME, isActive: true });
  const windowKey = initial.lastQuotaSnapshot.windows[0].key;
  try {
    await goto('/dashboard');
    await level('Everyday');
    await expect(board.locator('[data-account-id]')).toHaveCount(12, { timeout: 60000 });
    await expect(board.getByRole('meter').first()).toBeVisible({ timeout: 60000 });
    await check('The summary strip accounts for every configured account exactly once', async () => {
      const counts = await summary.locator('button strong').allInnerTexts();
      const [total, ...buckets] = counts.map(Number);
      expect(total).toBe(12);
      expect(buckets.reduce((sum, value) => sum + value, 0)).toBe(12);
      report.summary = counts;
    });
    for (const [width, height] of [[1440, 1000], [1920, 1080], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.scrollTo(0, 0));
      await capture(`board-everyday-${width}`);
      await check(`Everyday board fits ${width}px without a horizontal scroll`, () => fits(`everyday ${width}`));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await check('Everyday is compact cards grouped by state; Advanced is rows; both switch density', async () => {
      await expect(board).toHaveAttribute('data-layout', 'cards');
      await expect(board.getByRole('region', { name: 'Ready accounts', exact: true })).toBeVisible();
      await expect(board.getByRole('region', { name: 'Paused accounts', exact: true })).toBeVisible();
      const densityControl = board.getByRole('radiogroup', { name: 'Density', exact: true });
      await expect(board).toHaveAttribute('data-density', 'tidy');
      await densityControl.getByText('Comfy', { exact: true }).click();
      await expect(board).toHaveAttribute('data-density', 'comfy');
      await page.reload();
      await expect(board).toHaveAttribute('data-density', 'comfy', { timeout: 60000 });
      await board.getByRole('radiogroup', { name: 'Density', exact: true }).getByText('Tidy', { exact: true }).click();
      await expect(board).toHaveAttribute('data-density', 'tidy');
      await capture('board-everyday-cards-1440');
    });
    await check('The three views keep the activity table, reset horizon and model support reachable', async () => {
      const views = page.getByRole('radiogroup', { name: 'Capacity view', exact: true });
      await views.getByText('Activity & analysis', { exact: true }).click();
      const analysis = page.getByRole('region', { name: 'Activity and analysis', exact: true });
      await expect(page.getByRole('textbox', { name: 'Search configured accounts', exact: true })).toBeVisible();
      // Everyday is the board's grouped cards; Advanced keeps the sortable table.
      await expect(analysis).toHaveAttribute('data-layout', 'cards', { timeout: 60000 });
      await expect(analysis.getByRole('region', { name: 'Ready accounts', exact: true })).toBeVisible();
      expect(await analysis.getByRole('region', { name: /accounts$/ }).count()).toBeGreaterThan(0);
      await expect(analysis.getByRole('table', { name: 'Configured account capacity', exact: true })).toHaveCount(0);
      await expect(page.getByText('Reset horizon', { exact: true })).toBeVisible();
      await capture('board-analysis-everyday-1440');
      await level('Advanced');
      await expect(analysis).toHaveAttribute('data-layout', 'table', { timeout: 60000 });
      await expect(page.getByRole('table', { name: 'Configured account capacity', exact: true })).toBeVisible({ timeout: 60000 });
      await expect(page.getByText('Reset horizon', { exact: true })).toBeVisible();
      await capture('board-analysis-1440');
      await level('Everyday');
      await expect(analysis).toHaveAttribute('data-layout', 'cards', { timeout: 60000 });
      await views.getByText('Model support', { exact: true }).click();
      await expect(page.getByRole('combobox', { name: 'Model to inspect', exact: true })).toBeVisible();
      // Only providers with an account are offered, under their own names.
      await page.getByRole('combobox', { name: 'Model to inspect', exact: true }).fill('claude');
      const offered = await page.getByRole('option').allInnerTexts();
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.every(label => label.startsWith('Claude / '))).toBe(true);
      await page.getByRole('combobox', { name: 'Model to inspect', exact: true }).fill('gpt-5.2');
      const gpt = await page.getByRole('option').allInnerTexts();
      expect(gpt.every(label => /^(OpenAI|Codex) \/ /.test(label))).toBe(true);
      await page.getByRole('option', { name: 'OpenAI / gpt-5.2', exact: true }).click();
      const archive = 'Synthetic archive workload';
      await expect(page.getByRole('table')).toContainText(archive, { timeout: 30000 });
      await capture('board-model-support-1440');
      // A chosen account lands back on the board, expanded.
      await page.getByRole('table').getByRole('button', { name: archive, exact: true }).click();
      await expect(board).toBeVisible();
      await expect(board.locator('[data-expanded]')).toHaveCount(1);
      await expect(board.getByRole('region', { name: 'Selection details', exact: true })).toBeVisible();
      await board.getByRole('button', { name: `Collapse ${archive}`, exact: true }).click();
    });
    await check('Everyday keeps pause, rename and expand direct and hides priority, drain and thresholds', async () => {
      await expect(row.getByRole('button', { name: `Pause ${NAME}`, exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: `Rename ${NAME}`, exact: true })).toBeAttached();
      await expect(row.getByRole('button', { name: `Expand ${NAME}`, exact: true })).toBeVisible();
      await expect(row.getByLabel(`Priority for ${NAME}`, { exact: true })).toHaveCount(0);
      await expect(row.getByRole('button', { name: `Drain ${NAME}`, exact: true })).toHaveCount(0);
      await expect(row.getByLabel(`Auto-pause threshold for ${windowKey}`, { exact: true })).toHaveCount(0);
      await expect(board.getByRole('checkbox', { name: `Compare ${NAME}`, exact: true })).toHaveCount(0);
    });
    await check('A window hides from its line, returns from its chip, and the choice survives a reload', async () => {
      const meters = () => row.getByRole('meter');
      const before = await meters().count();
      expect(before).toBeGreaterThan(0);
      await expect(board.locator('[data-level]').first()).toBeAttached();
      const hide = row.getByRole('button', { name: /^Hide / }).first();
      const label = (await hide.getAttribute('aria-label')).replace(/^Hide /, '');
      await hide.click();
      await expect(meters()).toHaveCount(before - 1);
      await expect(row.getByRole('button', { name: `Show ${label}`, exact: true })).toBeVisible();
      await capture('board-everyday-hidden-window-1440');
      await page.reload();
      await expect(row.getByRole('button', { name: `Show ${label}`, exact: true })).toBeVisible({ timeout: 60000 });
      await expect(meters()).toHaveCount(before - 1);
      await row.getByRole('button', { name: `Show ${label}`, exact: true }).click();
      await expect(meters()).toHaveCount(before);
      await expect(row.getByRole('button', { name: `Show ${label}`, exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tokenproxy.capacity-hidden-windows') || '[]'))).toEqual([]);
    });
    await check('Search and the paused chip change the actual row collection', async () => {
      const search = board.getByRole('searchbox', { name: 'Search accounts', exact: true });
      await search.fill(NAME);
      await expect(board.locator('[data-account-id]')).toHaveCount(1);
      await search.fill('');
      await summary.getByRole('button', { name: /paused$/ }).click();
      await expect(board.locator('[data-account-id]')).toHaveCount(4);
      await summary.getByRole('button', { name: /paused$/ }).click();
      await expect(board.locator('[data-account-id]')).toHaveCount(12);
      await board.getByRole('button', { name: 'Codex accounts', exact: true }).click();
      await expect(board.locator('[data-account-id]')).toHaveCount(2);
      await expect.poll(() => new URL(page.url()).searchParams.get('provider')).toBe('codex');
      await board.getByRole('button', { name: 'Codex accounts', exact: true }).click();
      await expect(board.locator('[data-account-id]')).toHaveCount(12);
    });
    await check('Rename saves on Enter, reads back after reload, and Escape discards without a write', async () => {
      await row.getByRole('button', { name: `Rename ${NAME}`, exact: true }).click({ force: true });
      const input = row.getByLabel(`Account name for ${NAME}`, { exact: true });
      await input.fill('Research account renamed');
      const saved = put();
      await input.press('Enter');
      expect((await saved).status()).toBe(200);
      await expect(row.getByRole('button', { name: /^Research account renamed/ })).toBeVisible();
      expect((await current()).name).toBe('Research account renamed');
      await page.reload();
      await expect(row.getByRole('button', { name: /^Research account renamed/ })).toBeVisible({ timeout: 60000 });
      const writes = report.writes.length;
      await row.getByRole('button', { name: 'Rename Research account renamed', exact: true }).click({ force: true });
      const discard = row.getByLabel('Account name for Research account renamed', { exact: true });
      await discard.fill('discarded');
      await expect(discard).toBeFocused();
      // Escape unmounts the field on keydown; a locator press would wait for the
      // detached element to settle, so the key goes to the page.
      await page.keyboard.press('Escape');
      await expect(row.getByRole('button', { name: /^Research account renamed/ })).toBeVisible();
      expect(report.writes.length).toBe(writes);
      await row.getByRole('button', { name: 'Rename Research account renamed', exact: true }).click({ force: true });
      const restore = row.getByLabel('Account name for Research account renamed', { exact: true });
      await restore.fill(NAME);
      const restored = put();
      await restore.press('Enter');
      expect((await restored).status()).toBe(200);
      expect((await current()).name).toBe(NAME);
    });
    await check('Pause and resume persist through the actual API and a full reload', async () => {
      for (const active of [false, true]) {
        const saved = put();
        await row.getByRole('button', { name: `${active ? 'Resume' : 'Pause'} ${NAME}`, exact: true }).click();
        expect((await saved).status()).toBe(200);
        await expect(row.getByRole('button', { name: `${active ? 'Pause' : 'Resume'} ${NAME}`, exact: true })).toBeEnabled();
        await expect(row).toContainText(active ? 'Ready' : 'Paused');
        expect((await current()).isActive).toBe(active);
        await page.reload();
        await expect(row.getByRole('button', { name: `${active ? 'Pause' : 'Resume'} ${NAME}`, exact: true })).toBeEnabled({ timeout: 30000 });
      }
    });
    await level('Advanced');
    await check('Advanced exposes priority, drain, thresholds and comparison beside each account', async () => {
      await expect(board).toHaveAttribute('data-layout', 'rows');
      await expect(row.getByLabel(`Priority for ${NAME}`, { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: `Drain ${NAME}`, exact: true })).toBeVisible();
      await expect(row.getByLabel(`Auto-pause threshold for ${windowKey}`, { exact: true })).toBeVisible();
      await expect(row.getByRole('checkbox', { name: `Compare ${NAME}`, exact: true })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await capture('board-advanced-1440');
    });
    await check('A threshold commits on Enter, marks the meter, and zero on blur removes it', async () => {
      const threshold = () => row.getByLabel(`Auto-pause threshold for ${windowKey}`, { exact: true });
      await fillNumber(threshold, '25');
      const saved = put();
      await threshold().press('Enter');
      const response = await saved;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toMatchObject({ quotaPauseThresholds: { [windowKey]: 25 }, expectedControls: captureAccountControls(initial) });
      await expect.poll(async () => (await current()).quotaPauseThresholds[windowKey]).toBe(25);
      await expect(threshold()).toHaveValue('25%');
      await page.reload();
      await expect(threshold()).toHaveValue('25%', { timeout: 60000 });
      await fillNumber(threshold, '0');
      const cleared = put();
      await board.getByRole('searchbox', { name: 'Search accounts', exact: true }).focus();
      expect((await cleared).status()).toBe(200);
      await expect.poll(async () => (await current()).quotaPauseThresholds[windowKey]).toBeUndefined();
      await expect(threshold()).toHaveValue('0%');
    });
    await check('A stale row still saves against the current policy because it reads before it writes', async () => {
      const before = await current();
      const competing = await context.request.put(`${runtime.url}${accountPath}`, { data: { isActive: false, expectedControls: captureAccountControls(before) } });
      expect(competing.status()).toBe(200);
      report.writes.push({ path: accountPath, method: 'PUT', source: 'competing synthetic operator; no response interception' });
      const threshold = () => row.getByLabel(`Auto-pause threshold for ${windowKey}`, { exact: true });
      await fillNumber(threshold, '30');
      const saved = put();
      await threshold().press('Enter');
      const response = await saved;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON().expectedControls.isActive).toBe(false);
      const after = await current();
      expect(after.isActive).toBe(false);
      expect(after.quotaPauseThresholds[windowKey]).toBe(30);
      await expect(row).toContainText('Paused');
      await expect(row.getByRole('button', { name: `Resume ${NAME}`, exact: true })).toBeEnabled();
      const restored = put();
      await row.getByRole('button', { name: `Resume ${NAME}`, exact: true }).click();
      expect((await restored).status()).toBe(200);
      await fillNumber(threshold, '0');
      const cleared = put();
      await threshold().press('Enter');
      expect((await cleared).status()).toBe(200);
      const final = await current();
      expect(final.isActive).toBe(true);
      expect(final.quotaPauseThresholds).toEqual(initial.quotaPauseThresholds ?? {});
    });
    await check('Priority commits on Enter and the maintained route renumbers the provider', async () => {
      // The route renumbers every account of the provider after a write, so the
      // typed value is asserted on the request and the stored value only as valid.
      const priority = () => row.getByLabel(`Priority for ${NAME}`, { exact: true });
      const before = (await current()).priority;
      const target = before === 1 ? 2 : 1;
      await fillNumber(priority, String(target));
      const saved = put();
      await priority().press('Enter');
      const response = await saved;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toMatchObject({ priority: target });
      await expect.poll(async () => Number.isSafeInteger((await current()).priority) && (await current()).priority >= 1).toBe(true);
      await expect.poll(() => priority().inputValue(), { timeout: 30000 }).toMatch(/^[1-9]\d*$/);
      const stored = (await current()).priority;
      report.priorityNormalization = { initial: before, requested: target, stored, note: 'The maintained route normalizes priorities per provider.' };
    });
    await check('Drain and stop drain persist and change the state word', async () => {
      const drained = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/drain/${ACCOUNT}` && response.request().method() === 'POST');
      await row.getByRole('button', { name: `Drain ${NAME}`, exact: true }).click();
      expect((await drained).status()).toBe(200);
      await expect(row).toContainText('Draining');
      expect((await read('/api/admin/drain?all=true')).connections.find(item => item.connectionId === ACCOUNT).isDraining).toBe(true);
      const stopped = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/drain/${ACCOUNT}` && response.request().method() === 'DELETE');
      await row.getByRole('button', { name: `Stop drain for ${NAME}`, exact: true }).click();
      expect((await stopped).status()).toBe(200);
      await expect(row).toContainText('Ready');
      expect((await read('/api/admin/drain?all=true')).connections.find(item => item.connectionId === ACCOUNT).isDraining).toBe(false);
    });
    await check('Comparison opens inline, persists in the URL, and clears', async () => {
      await row.getByRole('checkbox', { name: `Compare ${NAME}`, exact: true }).check();
      await board.getByRole('checkbox', { name: 'Compare Synthetic batch account', exact: true }).check();
      await expect.poll(() => new URL(page.url()).searchParams.get('compare')).toBe(`${ACCOUNT},capacity-fixture-b`);
      await board.getByRole('button', { name: 'Compare (2)', exact: true }).click();
      const totals = board.getByRole('region', { name: 'Exact account comparison totals', exact: true });
      await expect(totals.locator('tbody tr')).toHaveCount(2);
      const expected = await read(`/api/analytics?view=activity&groupBy=account&pageSize=50&connectionId=${ACCOUNT}`);
      await expect(totals.getByRole('row').filter({ has: page.getByRole('cell', { name: NAME, exact: true }) }).locator('td').nth(2)).toHaveText(new Intl.NumberFormat('en').format(expected.summary.records));
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await capture('board-comparison-1440');
      await board.getByRole('button', { name: 'Clear comparison selection', exact: true }).click();
      await expect(totals).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).searchParams.get('compare')).toBeNull();
    });
    await check('Expanding a row shows evidence tabs inline; a quota line opens its window and survives reload', async () => {
      await row.getByRole('button', { name: `Expand ${NAME}`, exact: true }).click();
      const details = row.getByRole('region', { name: 'Selection details', exact: true });
      await expect(details.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(details).toContainText(ACCOUNT);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await row.getByRole('button', { name: `Collapse ${NAME}`, exact: true }).click();
      await expect(details).toHaveCount(0);
      await row.locator('button', { hasText: /Session|Weekly/ }).first().click();
      await expect(details.getByRole('tab', { name: /^Quota windows/ })).toHaveAttribute('aria-selected', 'true');
      await expect(details.getByRole('region', { name: 'Quota observation analysis', exact: true })).toBeVisible({ timeout: 30000 });
      const selected = JSON.parse(new URL(page.url()).searchParams.get('selected'));
      expect(selected).toMatchObject({ kind: 'account', id: ACCOUNT });
      expect(selected.windowScope).toBeTruthy();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 });
      await expect(board.locator('[data-account-id]')).toHaveCount(12, { timeout: 120000 });
      await expect(row.getByRole('region', { name: 'Selection details', exact: true }).getByRole('tab', { name: /^Quota windows/ })).toHaveAttribute('aria-selected', 'true', { timeout: 60000 });
      await capture('board-expanded-quota-1440');
      await row.getByRole('button', { name: `Collapse ${NAME}`, exact: true }).click();
    });
    await check('Add account opens an inline form and cancels without a write', async () => {
      const writes = report.writes.length;
      await board.getByRole('button', { name: 'Add account', exact: true }).click();
      const form = board.getByRole('form', { name: 'Add account', exact: true });
      await form.getByRole('combobox', { name: 'Provider', exact: true }).click();
      // Popular providers lead the list and appear again in the full list.
      await expect(page.getByText('Popular', { exact: true })).toBeVisible();
      await expect(page.getByText('All providers', { exact: true })).toBeVisible();
      await expect(page.getByRole('option', { name: 'Claude Code', exact: true })).toHaveCount(2);
      await page.getByRole('option', { name: 'OpenAI', exact: true }).first().click();
      await expect(form.getByLabel('API key', { exact: true })).toBeVisible();
      await expect(form.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await capture('board-add-account-1440');
      await form.getByRole('button', { name: 'Cancel adding an account', exact: true }).click();
      await expect(form).toHaveCount(0);
      expect(report.writes.length).toBe(writes);
    });
    await check('Advanced board fits desktop and phone widths with readable text', async () => {
      for (const [width, height] of [[1920, 1080], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture(`board-advanced-${width}`);
        await fits(`advanced ${width}`);
        const sizes = await board.locator('article span, article small, article button').evaluateAll(elements => elements.filter(element => element.childElementCount === 0 && element.textContent.trim() && element.getBoundingClientRect().width > 0 && !element.classList.contains('material-symbol')).map(element => parseFloat(getComputedStyle(element).fontSize)));
        expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
      }
    });
    expect(report.errors).toEqual([]);
    expect(report.apiFailures).toEqual([]);
    expect(safety.outboundFailures).toEqual([]);
  } finally {
    // Later specs address the fixture by its seeded name and policy, so an
    // aborted run must not leave a rename or a pause behind.
    const left = await current();
    if (left.name !== NAME) await context.request.put(`${runtime.url}${accountPath}`, { data: { name: NAME } });
    const controls = captureAccountControls(left), wanted = captureAccountControls(initial);
    if (JSON.stringify(controls) !== JSON.stringify(wanted)) {
      await context.request.put(`${runtime.url}${accountPath}`, { data: { isActive: wanted.isActive, quotaPauseThresholds: wanted.quotaPauseThresholds, ...(wanted.priority === null ? {} : { priority: wanted.priority }), expectedControls: controls } });
    }
    const final = await current();
    report.restored = { name: final.name === NAME, isActive: final.isActive === initial.isActive, thresholds: JSON.stringify(final.quotaPauseThresholds ?? {}) === JSON.stringify(initial.quotaPauseThresholds ?? {}) };
    report.outboundFailures = safety.outboundFailures;
    const receiptPath = testInfo.outputPath('capacity-board-receipt.json');
    await writeFile(receiptPath, JSON.stringify(report, null, 2));
    await testInfo.attach('capacity-board-receipt', { path: receiptPath, contentType: 'application/json' });
  }
});

test.describe('board touch targets', () => {
  test.use({ hasTouch: true });
  test('compare checkboxes keep a 44px hit area and a 20px glyph on a coarse pointer', async ({ page, context, baseURL }) => {
    test.setTimeout(120000);
    const { runtime, safety } = await fixture({ page, context, baseURL });
    const writes = [];
    page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.method()); });
    await page.goto(`${runtime.url}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.evaluate(() => localStorage.setItem('tokenproxy.navigation-mode', JSON.stringify('advanced')));
    await page.reload();
    const board = page.getByRole('region', { name: 'Account control panel', exact: true });
    await expect(board.locator('[data-account-id]')).toHaveCount(12, { timeout: 60000 });
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const checkbox = board.locator(`[data-account-id="${ACCOUNT}"]`).getByRole('checkbox', { name: `Compare ${NAME}`, exact: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await checkbox.scrollIntoViewIfNeeded();
      const geometry = await checkbox.evaluate(input => {
        const box = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
        return { hit: box(input.closest('label')), glyph: box(input), content: document.documentElement.scrollWidth };
      });
      expect(geometry.hit.width).toBeGreaterThanOrEqual(44);
      expect(geometry.hit.height).toBeGreaterThanOrEqual(44);
      expect(geometry.glyph.width).toBeGreaterThanOrEqual(18);
      expect(geometry.glyph.width).toBeLessThanOrEqual(20);
      expect(geometry.content).toBeLessThanOrEqual(width);
      const wasChecked = await checkbox.isChecked();
      await page.touchscreen.tap(geometry.hit.x + 2, geometry.hit.y + 2);
      await expect(checkbox).toBeChecked({ checked: !wasChecked });
    }
    expect(writes).toEqual([]);
    expect(safety.outboundFailures).toEqual([]);
  });
});
