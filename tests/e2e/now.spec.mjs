import { test, expect } from 'playwright/test';
import { signIn, json } from './helpers.mjs';

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test('unauthenticated dashboard goes to login', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await ctx.close();
});

test('the usage stream reports reconnecting then stale when it cannot connect', async ({
  page,
}) => {
  await page.route('**/api/usage/stream*', (r) => r.abort());
  await page.goto('/dashboard');
  const status = page.locator('.routing-tools .fresh').first();
  await expect(status).toHaveAttribute('data-state', /connecting|reconnecting/);
  await expect(status).toHaveAttribute('data-state', 'stale', { timeout: 15000 });
  await expect(page.getByText('The usage stream stopped.')).toBeVisible();
});

test('a null latency measure renders as unknown, never zero', async ({ page }) => {
  await page.route('**/api/system/state*', (r) =>
    r.fulfill(
      json(200, {
        measures: { latencyP95: { value: null, unavailable: 'No measured response times.' } },
      })
    )
  );
  await page.goto('/dashboard');
  const latency = page.locator('.kpi', { hasText: 'Response latency' });
  await expect(latency.locator('.kpi-value')).toHaveText('—');
  await expect(latency).not.toContainText(/\b0\b/);
});

test('admin refusal shapes are rendered as their own sentences', async ({ page }) => {
  await page.route('**/api/admin/quota', (r) =>
    r.fulfill(
      json(403, {
        error:
          'An operator credential is required. An inference API key does not satisfy this endpoint.',
        code: 'forbidden_class',
        source: 'tokenproxy-admin',
      })
    )
  );
  await page.route('**/api/admin/health/detail', (r) =>
    r.fulfill(
      json(500, { error: 'db locked', code: 'state_unavailable', source: 'tokenproxy-admin' })
    )
  );
  await page.goto('/dashboard');
  await expect(
    page.getByText('An inference API key does not satisfy this endpoint.')
  ).toBeVisible();
  await expect(page.getByText('The gateway could not read its own state.')).toBeVisible();
});

test('no session identity is rendered from the stream', async ({ page }) => {
  await page.route('**/api/usage/stream*', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ totalCost: 1.5, activeSessions: [{ requestId: 'req-SECRET-1', clientId: 'cli-SECRET-2', sessionId: 'sess-SECRET-3', model: 'm1', provider: 'prov-a', account: 'acct', startedAt: new Date().toISOString(), status: 'active' }], activeRequests: [], recentRequests: [], errorProvider: null })}\n\n`,
    })
  );
  await page.goto('/dashboard');
  await expect(page.getByText('1 requests in flight')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('SECRET');
  await expect(page.locator('body')).toContainText('prov-a');
});
