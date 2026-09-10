import { test, expect } from 'playwright/test';
import { readFile, realpath } from 'node:fs/promises';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { json } from './helpers.mjs';

// Notifications against the launcher's representative, credentialless fixture.
// E2E_FIXTURE_ROOT must be its owned run root and E2E_BASE its exact loopback
// URL. Every write is fulfilled by page.route, so no spec run can save a rule,
// clear a destination or send a real message.
test.use({ serviceWorkers: 'block', timezoneId: 'UTC', reducedMotion: 'reduce', trace: 'off' });

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
  return { runtime, writes };
}

async function open(page, runtime) {
  const response = await page.goto(`${runtime.url}/dashboard/notifications`, { waitUntil: 'domcontentloaded' });
  expect(response.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  // The header's snapshot label arrives from a client read, so it is the signal
  // that hydration finished and a click will reach a handler.
  await expect(page.locator('.mantine-AppShell-header')).toContainText('Synthetic fixture', { timeout: 60000 });
}

test('the rules board is one surface: chips, groups and no layer', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime } = await fixture({ page, context, baseURL });
  await open(page, runtime);
  const rules = page.locator('section[aria-label="Notification rules"]');
  await expect(rules).toBeVisible();
  await expect(rules).toHaveAttribute('data-advanced', 'true');
  await expect(rules).toHaveAttribute('data-density', 'tidy');
  await expect(rules.getByRole('group', { name: 'Rule summary' })).toBeVisible();
  await expect(rules.getByRole('searchbox', { name: 'Search rules' })).toBeVisible();
  await expect(rules.getByRole('button', { name: 'Add rule' })).toBeVisible();
  await expect(page.locator('section[aria-label="Notification delivery"]')).toBeVisible();
  // No layer for routine work anywhere on the page.
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
});

test('Everyday groups rules as cards and Advanced as rows, from the same page', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime } = await fixture({ page, context, baseURL }, { level: 'everyday' });
  await open(page, runtime);
  const rules = page.locator('section[aria-label="Notification rules"]');
  await expect(rules).toHaveAttribute('data-layout', 'cards');
  const card = rules.locator('article[data-account-id]').first();
  await expect(card).toBeVisible({ timeout: 60000 });
  // A card carries the rule's evidence; a row is the Advanced shape and is absent here.
  await expect(card).toContainText('Threshold');
  await expect(rules.locator('article[data-rule-id]')).toHaveCount(0);
  await expect(rules.getByLabel(/^Threshold for /)).toHaveCount(0);
});

test('an in-place threshold edit writes the whole rule with the revision it read', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime, writes } = await fixture({ page, context, baseURL });
  let saved = null;
  await page.route('**/api/admin/notification-rules/*', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saved = route.request().postDataJSON();
    return route.fulfill(json(200, { id: 'sealed', revision: (saved.revision ?? 0) + 1 }));
  });
  await open(page, runtime);
  const field = page.getByLabel(/^Threshold for /).first();
  await expect(field).toBeVisible();
  await field.fill('42');
  await field.press('Enter');
  await expect.poll(() => saved, { timeout: 20000 }).not.toBeNull();
  expect(saved.threshold).toBe(42);
  expect(Number.isInteger(saved.revision)).toBe(true);
  expect(saved.name).toBeTruthy();
  expect(saved.conditionKind).toBeTruthy();
  expect(writes.filter(write => write.method === 'PUT')).toHaveLength(1);
});

test('deleting a rule asks in place and writes nothing until it is confirmed', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime, writes } = await fixture({ page, context, baseURL });
  await page.route('**/api/admin/notification-rules/**', async route =>
    route.request().method() === 'DELETE' ? route.fulfill(json(200, { deleted: true })) : route.fallback()
  );
  await open(page, runtime);
  const remove = page.getByRole('button', { name: /^Delete / }).first();
  await remove.click();
  const confirm = page.getByRole('group', { name: /^Delete .*\?$/ });
  await expect(confirm).toBeVisible();
  await expect(page.locator('dialog')).toHaveCount(0);
  expect(writes.filter(write => write.method === 'DELETE')).toHaveLength(0);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(writes.filter(write => write.method === 'DELETE')).toHaveLength(0);
});

test('an unsaved address is tested only after an inline confirmation, and no destination is saved', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime, writes } = await fixture({ page, context, baseURL });
  await page.route('**/api/notifications/test', route =>
    route.fulfill(json(200, { ok: false, status: null, attempts: 1, error: 'blocked: endpoint does not resolve to a public address' }))
  );
  await page.route('**/api/notifications', async route =>
    route.request().method() === 'PUT' ? route.fulfill(json(500, { error: 'a spec must never save a destination' })) : route.fallback()
  );
  await open(page, runtime);
  const add = page.locator('form[aria-label="Add a destination"]');
  await expect(add).toBeVisible();
  await add.getByLabel('Address').fill('https://example.com/synthetic-hook');
  await add.getByLabel('Signing value').fill('synthetic-signing-value');
  await add.getByRole('button', { name: 'Test this address without saving' }).click();
  // The signing value is write-only: it leaves the field the moment it is used.
  await expect(add.getByLabel('Signing value')).toHaveValue('');
  const ask = page.getByRole('group', { name: 'Test this address without saving' });
  await expect(ask).toContainText('No destination is saved');
  expect(writes).toHaveLength(0);
  await ask.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText('Test delivery was not confirmed')).toBeVisible();
  expect(writes.map(write => write.path)).toEqual(['/api/notifications/test']);
  await expect(page.locator('body')).not.toContainText('synthetic-signing-value');
});
