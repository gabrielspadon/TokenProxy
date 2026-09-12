import { test, expect } from 'playwright/test';
import { readFile, realpath } from 'node:fs/promises';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { json } from './helpers.mjs';

// Access against the launcher's representative, credentialless fixture.
// E2E_FIXTURE_ROOT must be its owned run root and E2E_BASE its exact loopback
// URL. Every write is fulfilled by page.route, so a spec run can never change
// the auth of the instance it is pointed at.
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
  // Nothing this suite does may reach a settings write.
  await page.route('**/api/settings', route =>
    route.request().method() === 'GET'
      ? route.fallback()
      : route.fulfill(json(500, { error: 'a spec must never write settings' }))
  );
  return { runtime, writes };
}

async function open(page, runtime) {
  const response = await page.goto(`${runtime.url}/dashboard/access`, { waitUntil: 'domcontentloaded' });
  expect(response.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Access' })).toBeVisible();
  // The header's snapshot label arrives from a client read, so it is the signal
  // that hydration finished and a click will reach a handler.
  await expect(page.locator('.mantine-AppShell-header')).toContainText('Synthetic fixture', { timeout: 60000 });
}

test('access is one board of sign-in methods, with no layer anywhere', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime } = await fixture({ page, context, baseURL });
  await open(page, runtime);
  const board = page.locator('section[aria-label="Access"]');
  await expect(board).toBeVisible();
  await expect(board).toHaveAttribute('data-density', 'tidy');
  await expect(board.getByRole('group', { name: 'Sign-in summary' })).toBeVisible();
  for (const method of ['Password', 'OIDC', 'SAML'])
    await expect(board.locator(`article[data-account-id="${method.toLowerCase()}"]`)).toBeVisible();
  await expect(board.locator('article[data-account-id="require-login"]')).toContainText('Signing in');
  await expect(board.locator('article[data-account-id="lockout"]')).toContainText('30s');
  await expect(board.locator('article[data-account-id="lockout"] .unreported')).toHaveText('Not reported');
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
});

test('a method opens its settings in place and reviews a frozen request before any write', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime, writes } = await fixture({ page, context, baseURL });
  await open(page, runtime);
  await page.getByRole('button', { name: 'Expand OIDC' }).click();
  const card = page.locator('article[data-account-id="oidc"]');
  await expect(card.getByLabel('Provider address')).toBeVisible();
  await card.getByLabel('Client identity').fill('synthetic-client');
  await card.getByRole('button', { name: 'Review configuration' }).click();
  const review = page.getByRole('group', { name: 'Configure single sign-on' });
  await expect(review).toContainText('synthetic-client');
  await expect(review).toContainText('This does not test sign-in completion.');
  // A review is a reading, not a write, and it carries no field of its own.
  await expect(review.locator('input')).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test('turning sign-in off asks in place and names exactly what stays protected', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime, writes } = await fixture({ page, context, baseURL });
  await open(page, runtime);
  const card = page.locator('article[data-account-id="require-login"]');
  await expect(card).toContainText('Shutting the gateway down.');
  await card.getByRole('button', { name: 'Turn sign-in off' }).click();
  const ask = page.getByRole('group', { name: 'Turn sign-in off' });
  await expect(ask).toContainText('Anyone who can reach this port reads the dashboard and changes most settings without a password.');
  await expect(ask).toContainText('Shutdown, database export and import, and update still ask for a session');
  await expect(ask).toContainText('every change under the operator interface stays bound to this machine');
  await expect(page.locator('dialog')).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(writes).toHaveLength(0);
});

test('a stored secret reads as a state word and its value never reaches the page', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const secret = 'oidc-client-secret-DO-NOT-RENDER';
  const { runtime } = await fixture({ page, context, baseURL });
  await page.route('**/api/settings', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill(
      json(200, {
        ...body,
        oidcConfigured: true,
        oidcIssuerUrl: 'https://idp.example.test',
        oidcClientId: 'tokenproxy',
        oidcClientSecret: secret,
      })
    );
  });
  await open(page, runtime);
  const card = page.locator('article[data-account-id="oidc"]');
  await expect(card).toContainText('tokenproxy');
  await expect(page.locator('body')).not.toContainText(secret);
  await expect(page.locator('body')).not.toContainText('DO-NOT-RENDER');
});

test('a refused settings read renders as its own sentence, not a raw status', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime } = await fixture({ page, context, baseURL });
  await page.route('**/api/settings', route =>
    route.request().method() === 'GET'
      ? route.fulfill(json(403, { error: 'Local only: CLI token required' }))
      : route.fallback()
  );
  await open(page, runtime);
  await expect(page.getByText('This action is not allowed from here.')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('HTTP 403');
});

test('an acknowledged password change clears the initiating session and routes to sign-in', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const { runtime, writes } = await fixture({ page, context, baseURL });
  await page.route('**/api/settings', route =>
    route.request().method() === 'PATCH'
      ? route.fulfill(json(200, { sessionRevoked: true, redirectTo: '/login' }))
      : route.fallback()
  );
  await open(page, runtime);
  await page.getByRole('button', { name: 'Expand Password' }).click();
  const card = page.locator('article[data-account-id="password"]');
  await card.getByLabel('Current password').fill('synthetic-current');
  await card.getByLabel('New password', { exact: true }).fill('synthetic-next');
  await card.getByLabel('New password again').fill('synthetic-next');
  await card.getByRole('button', { name: 'Change password' }).click();
  await page.getByRole('group', { name: 'Change password' })
    .getByRole('button', { name: 'Change password' })
    .click();

  await expect(page).toHaveURL(`${runtime.url}/login`);
  expect(writes).toContainEqual({ path: '/api/settings', method: 'PATCH' });
});
