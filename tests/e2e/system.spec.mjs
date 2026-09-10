import { test, expect } from 'playwright/test';
import { readFile, realpath } from 'node:fs/promises';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { json } from './helpers.mjs';

// System against the launcher's representative, credentialless fixture.
// E2E_FIXTURE_ROOT must be its owned run root and E2E_BASE its exact loopback
// URL. Shutdown, update and the database routes are fulfilled by page.route, so
// no spec run can stop, replace or overwrite the preview.
test.use({ serviceWorkers: 'block', timezoneId: 'UTC', reducedMotion: 'reduce', trace: 'off' });

const NEVER = ['**/api/version/shutdown', '**/api/version/update', '**/api/settings/database', '**/api/system/admission'];

async function fixture({ page, context, baseURL }, { level = 'advanced', density = 'tidy' } = {}) {
  expect(process.env.E2E_FIXTURE_ROOT, 'An owned representative fixture root is required').toBeTruthy();
  const root = await realpath(process.env.E2E_FIXTURE_ROOT);
  const runtime = JSON.parse(await readFile(`${root}/process.json`, 'utf8'));
  const owner = JSON.parse(await readFile(`${root}/owner.json`, 'utf8'));
  expect(owner).toMatchObject({ kind: 'tokenproxy-redesign-preview-v1', root, runId: runtime.runId });
  expect(process.env.E2E_BASE).toBe(runtime.url);
  expect(baseURL).toBe(runtime.url);
  await authenticateRedesign(context, root);
  await installRedesignBrowser(page, { baseUrl: runtime.url, runtimeReceipt: runtime });
  await context.addInitScript(
    ([mode, chosen]) => {
      localStorage.setItem('tokenproxy.navigation-mode', JSON.stringify(mode));
      localStorage.setItem('tokenproxy.capacity-density', JSON.stringify(chosen));
    },
    [level, density]
  );
  // Gateway writes only. Next's dev overlay POSTs /__nextjs_* to symbolicate a
  // warning, and counting that as a write makes the guard read false.
  const writes = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
      writes.push({ path, method: request.method() });
  });
  // Fail loudly rather than silently if a mutation escapes a per-test route.
  for (const pattern of NEVER)
    await page.route(pattern, route =>
      ['GET', 'HEAD'].includes(route.request().method())
        ? route.fallback()
        : route.fulfill(json(500, { error: 'unmocked write reached the gateway' }))
    );
  return { runtime, writes };
}

async function open(page, runtime) {
  const response = await page.goto(`${runtime.url}/dashboard/system`, { waitUntil: 'domcontentloaded' });
  expect(response.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'System' })).toBeVisible();
  // The header's snapshot label arrives from a client read, so it is the signal
  // that hydration finished and a click will reach a handler.
  await expect(page.locator('.mantine-AppShell-header')).toContainText('Synthetic fixture', { timeout: 60000 });
}

test('system is one control panel of rows, in groups, with every unserved reading marked', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime } = await fixture({ page, context, baseURL });
  await open(page, runtime);
  const board = page.locator('section[aria-label="System"]');
  await expect(board).toBeVisible();
  await expect(board).toHaveAttribute('data-density', 'tidy');
  await expect(board.getByRole('group', { name: 'System summary' })).toBeVisible();
  for (const group of ['Runtime', 'Backup', 'Request capacity', 'Reads', 'Retention', 'Network defaults', 'Observability', 'Sharing', 'Configuration workflows', 'Health checks', 'Stop'])
    await expect(board.locator(`section[aria-label="${group} settings"]`)).toBeVisible();
  for (const id of ['process', 'version', 'update', 'export', 'import', 'admission', 'database', 'shutdown'])
    await expect(board.locator(`[data-row="${id}"]`)).toBeVisible();
  await expect(board.locator('[data-row="database"]')).toContainText('Database');
  // The runtime facts no route serves say so rather than guessing a path.
  for (const id of ['datadir', 'dbfile', 'timers', 'restart'])
    await expect(board.locator(`[data-row="${id}"] .unreported`)).toHaveText('Not reported');
  // No card anywhere on the panel, and no dialog over it.
  await expect(board.locator('article')).toHaveCount(0);
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
});

test('everyday keeps the process, backup, capacity, one health row and stop; advanced adds the switches', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime } = await fixture({ page, context, baseURL }, { level: 'everyday' });
  await open(page, runtime);
  const board = page.locator('section[aria-label="System"]');
  for (const group of ['Runtime', 'Backup', 'Request capacity', 'Health checks', 'Stop'])
    await expect(board.locator(`section[aria-label="${group} settings"]`)).toBeVisible();
  for (const group of ['Reads', 'Retention', 'Network defaults', 'Observability', 'Sharing', 'Configuration workflows'])
    await expect(board.locator(`section[aria-label="${group} settings"]`)).toHaveCount(0);
  await expect(board.locator('[data-row="accounts"]').getByRole('link', { name: 'Open Capacity' })).toBeVisible();
  await expect(board.locator('[data-row="admission-maxHandlers"]')).toHaveCount(0);
  // The search narrows the rows and says so when nothing matches.
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('shut');
  await expect(board.locator('[data-row]')).toHaveCount(1);
  await expect(board.locator('[data-row="shutdown"]')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('nothing matches this');
  await expect(board).toContainText('No setting matches.');
});

test('the shutdown confirmation names what is cut and who restarts it, and posts nothing first', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime, writes } = await fixture({ page, context, baseURL });
  await open(page, runtime);
  await page.locator('[data-setting="shutdown"]').getByRole('button', { name: 'Shut down' }).click();
  const ask = page.locator('form[aria-label="Shut down"]');
  await expect(ask).toContainText('an operator credential. This holds even when sign-in is turned off.');
  await expect(ask).toContainText('Stops the process. Every request in flight is cut, and every client is refused.');
  await expect(ask).toContainText('Start TokenProxy again by hand on the machine that runs it.');
  await expect(page.locator('dialog')).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test('the import confirmation names the replacement scope and carries the password, not a file field', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime, writes } = await fixture({ page, context, baseURL });
  await open(page, runtime);
  const row = page.locator('[data-setting="import"]');
  await row
    .locator('input[type="file"]')
    .setInputFiles({ name: 'synthetic-backup.json', mimeType: 'application/json', buffer: Buffer.from('{"settings":{}}') });
  await row.getByRole('button', { name: 'Import configuration' }).click();
  const ask = page.locator('form[aria-label="Import configuration"]');
  await expect(ask).toContainText('Replaces settings, provider connections and nodes, proxy pools, client keys, routing plans, aliases, custom models and pricing with the file contents.');
  await expect(ask).toContainText('synthetic-backup.json');
  await expect(ask.locator('input[type="file"]')).toHaveCount(0);
  await expect(ask.locator('input[type="password"]')).toBeVisible();
  expect(writes).toHaveLength(0);
});

test('a wrong password says so inside the confirmation and clears the field', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime } = await fixture({ page, context, baseURL });
  await page.unroute('**/api/settings/database');
  await page.route('**/api/settings/database', route => route.fulfill(json(401, { error: 'Invalid password' })));
  await open(page, runtime);
  await page.locator('[data-setting="export"]').getByRole('button', { name: 'Export configuration' }).click();
  const ask = page.locator('form[aria-label="Export configuration"]');
  const field = ask.locator('input[type="password"]');
  await field.fill('hunter2');
  await ask.getByRole('button', { name: 'Export configuration' }).click();
  await expect(ask.locator('.notice')).toContainText('That password is not right.');
  await expect(ask.locator('.notice')).toContainText('Nothing was changed. Type it again.');
  await expect(field).toHaveValue('');
  await expect(page.locator('body')).not.toContainText('hunter2');
});

test('a failed version lookup is not rendered as up to date', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime } = await fixture({ page, context, baseURL });
  await page.route('**/api/version', route =>
    route.fulfill(json(200, { currentVersion: '0.0.1', latestVersion: null, hasUpdate: false, isTrayMode: false, buildSha: null }))
  );
  await open(page, runtime);
  const update = page.locator('[data-row="update"]');
  await expect(update).not.toContainText('Up to date');
  await expect(update.locator('.unreported')).toHaveText('Not reported');
  await expect(update).toContainText('A failed lookup is not the same as being current');
});
