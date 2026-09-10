import { test, expect } from 'playwright/test';
import { signIn, json } from './helpers.mjs';
const snapshot = {
  observedAt: '2026-09-06T15:00:00.000Z',
  presets: [
    {
      id: 'filesystem',
      name: 'Filesystem',
      transport: 'stdio',
      configured: true,
      installation: 'not-probed',
      declaredToolCount: 4,
      running: true,
      clients: 2,
      endpoint: '/api/mcp/filesystem',
    },
    {
      id: 'memory',
      name: 'Memory',
      transport: 'stdio',
      configured: true,
      installation: 'not-probed',
      declaredToolCount: 3,
      running: false,
      clients: 0,
      endpoint: '/api/mcp/memory',
    },
  ],
  summary: { presets: 2, running: 1, clients: 2 },
  scope: 'local-process',
  capabilities: { status: true, takeover: false, modelMapping: false },
};
test.beforeEach(async ({ page }) => {
  await signIn(page);
  await page.route('**/api/tools', (r) => r.fulfill(json(200, snapshot)));
});
test('bridge status reflects actual running and stopped snapshots without claiming installation', async ({
  page,
}) => {
  await page.goto('/dashboard/tools');
  // The board carries one card per preset; there is no table.
  await expect(page.locator('table')).toHaveCount(0);
  const filesystem = page.locator('article[data-account-id="filesystem"]');
  const memory = page.locator('article[data-account-id="memory"]');
  await expect(filesystem).toContainText('Running');
  await expect(filesystem).toContainText('2 clients');
  await expect(memory).toContainText('Stopped');
  await expect(page.getByLabel('Observed extension summary')).toContainText('2 presets');
  await expect(page.getByLabel('Observed extension summary')).toContainText('1 running');
  await expect(page.getByText(/Installation is not probed here/)).toBeVisible();
});
test('refresh re-reads bridge state and never starts a process', async ({ page }) => {
  const writes = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/tools') && r.method() !== 'GET') writes.push(r.method());
  });
  await page.goto('/dashboard/tools');
  await expect(page.locator('article[data-account-id]')).toHaveCount(2);
  await page.route('**/api/tools', (r) =>
    r.fulfill(
      json(200, { ...snapshot, presets: [], summary: { presets: 0, running: 0, clients: 0 } })
    )
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('No local extensions configured')).toBeVisible();
  expect(writes).toEqual([]);
});
test('an operator refusal is visible and does not imply empty configuration', async ({ page }) => {
  await page.route('**/api/tools', (r) =>
    r.fulfill(
      json(403, {
        code: 'forbidden_class',
        source: 'tokenproxy-admin',
        error: 'Operator credential required',
      })
    )
  );
  await page.goto('/dashboard/tools');
  await expect(
    page.getByText('An inference API key does not satisfy this endpoint.')
  ).toBeVisible();
  await expect(page.getByText('No local extensions configured')).toHaveCount(0);
});
test('capability disclosure preserves the connection controls', async ({ page }) => {
  await page.goto('/dashboard/tools');
  await page.getByText('Integration capabilities', { exact: true }).click();
  await expect(page.getByText(/Automatic client takeover/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Open connection details/ })).toHaveAttribute(
    'href',
    '/dashboard/keys'
  );
  await expect(page.locator('button.danger, .button.danger')).toHaveCount(0);
});
test('no secret identifiers are exposed and the page is reachable through navigation', async ({
  page,
}) => {
  await page.goto('/dashboard');
  await page.getByRole('link', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tools');
  await expect(page.locator('body')).not.toContainText(/sessionId|clientId|requestId/);
});
