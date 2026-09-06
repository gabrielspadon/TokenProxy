import { test, expect } from 'playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn, json } from './helpers.mjs';
import {
  installOperatorFixture,
  contextOverview,
  turns,
  contextSummary,
} from './operator-fixture.mjs';
test.beforeEach(async ({ page }) => {
  await signIn(page);
  await installOperatorFixture(page);
});

test('overview renders measured provider traffic and inspectable animated routes', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/dashboard');
  await expect(page.getByText('4,195', { exact: true })).toBeVisible();
  await expect(page.locator('.graph-provider')).toHaveCount(5);
  await expect(page.locator('.react-flow__edge.animated')).toHaveCount(5);
  await page.getByRole('button', { name: 'Pause route animation' }).click();
  await expect(page.locator('.react-flow__edge.animated')).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume route animation' }).click();
  await expect(page.locator('.react-flow__edge.animated')).toHaveCount(5);
  await page.locator('.graph-provider').filter({ hasText: 'Anthropic' }).click();
  await expect(page.getByLabel('Inspect connection')).toHaveValue('visual-0');
  await page.getByText('Provider traffic today', { exact: true }).click();
  await expect(page.locator('.route-inspector')).toContainText('2,890,000 input tokens');
  await expect(page.locator('.route-inspector')).toContainText('410,000 output tokens');
  await page.locator('.flight-row').first().click();
  await expect(page.locator('.live-request-details')).toContainText('Input not yet reported');
  await page.getByRole('button', { name: 'Close request details' }).click();
  await expect(page.locator('.live-request-details')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(page.getByRole('img', { name: /tokens over time/ })).toBeVisible();
  await page.getByRole('button', { name: '7 days', exact: true }).click();
  await expect(page.getByRole('button', { name: '7 days', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(errors).toEqual([]);
});

test('semantic search is keyboard contained and restores focus', async ({ page }) => {
  await page.goto('/dashboard');
  const open = page.getByRole('button', { name: /Find a control/ });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Find a control' });
  await dialog.getByRole('textbox').fill('quota');
  await expect(dialog.getByRole('link', { name: 'Connections' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill('cache');
  await expect(dialog.getByRole('link', { name: 'Context', exact: true })).toBeVisible();
  await dialog.getByRole('link', { name: 'Context', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/context$/);
});

test('routing refits late arriving work and desktop resize without clipped nodes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__operatorStreamDelayMs = 1500;
  });
  await page.goto('/dashboard');
  await expect(page.locator('.graph-provider')).toHaveCount(5);
  await expect(page.locator('.graph-request')).toHaveCount(3);
  for (const width of [1440, 1120, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() =>
        page.locator('.routing-canvas').evaluate((canvas) => {
          const bounds = canvas.getBoundingClientRect();
          return [...canvas.querySelectorAll('.react-flow__node')].every((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.left >= bounds.left &&
              rect.right <= bounds.right &&
              rect.top >= bounds.top &&
              rect.bottom <= bounds.bottom
            );
          });
        })
      )
      .toBe(true);
    await expect(page.locator('.react-flow__edge.animated')).toHaveCount(5);
  }
});

test('context shows explicit measurement sources and request stage changes', async ({ page }) => {
  await page.goto('/dashboard/context');
  await expect(page.getByRole('heading', { name: 'OceanStack', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /Context evolution in tokens/ })).toBeVisible();
  await page.getByLabel('Inspect request').selectOption('turn-1');
  await expect(page.locator('.request-inspector')).toContainText('claude-opus-4-6');
  await page.getByText('Measured shaping stages', { exact: true }).click();
  await expect(page.locator('.request-inspector')).toContainText('semantic-preserving');
  await expect(page.locator('.request-inspector')).toContainText('content-changing');
  await expect(page.locator('.decision-note')).toContainText('session-affinity');
  await expect(
    page.getByText('Body reduction is measured in bytes.', { exact: false })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit project' }).click();
  await page.locator('.project-editor input').fill('Research');
  const sent = page.waitForRequest(
    (r) => r.method() === 'PATCH' && r.url().includes('/api/context/sessions/1')
  );
  await page.getByRole('button', { name: 'Save label' }).click();
  expect((await sent).postDataJSON()).toEqual({ projectLabel: 'Research' });
});

test('unknown provider usage is rendered as unknown and failures retain meaning', async ({
  page,
}) => {
  await page.route('**/api/context?*', (r) =>
    r.fulfill(
      json(200, {
        ...contextOverview,
        summary: {
          ...contextSummary,
          providerInputTokens: null,
          cacheHitRate: null,
          savedBytes: null,
        },
      })
    )
  );
  await page.goto('/dashboard/context');
  await expect(page.locator('.context-stats .context-stat').nth(1)).toContainText('—');
  await expect(page.locator('.context-stats .context-stat').nth(2)).toContainText('—');
  await page.route('**/api/context?*', (r) =>
    r.fulfill(json(500, { error: 'Context history unavailable', code: 'state_unavailable' }))
  );
  await page.reload();
  await expect(page.locator('.notice[role=alert]')).toBeVisible();
});

test('overview and context fit mobile with accessible labels and reduced motion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const path of ['/dashboard', '/dashboard/context']) {
    await page.goto(path);
    await page.locator('.kpi,.context-stat').first().waitFor();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))
    ).toEqual([]);
  }
  await page.goto('/dashboard');
  await expect(page.locator('.routing-mobile-list')).toBeVisible();
  await expect(page.locator('.routing-mobile-list button')).toHaveCount(5);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Sections' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Sections' })).not.toBeVisible();
});

test('account allocation keeps a constrained sibling visible', async ({ page }) => {
  const { connections } = await import('./operator-fixture.mjs');
  const accounts = [
    ...connections,
    {
      ...connections[0],
      id: 'visual-reserve',
      connectionId: 'visual-reserve',
      displayName: 'Reserve research',
      status: 'cooldown',
      lastError: 'Quota cooldown',
    },
  ];
  await page.route('**/api/admin/health/detail', (r) =>
    r.fulfill(json(200, { checks: { connections: accounts, database: { status: 'healthy' } } }))
  );
  await page.goto('/dashboard');
  const reserve = page.locator('.graph-provider').filter({ hasText: 'Reserve research' });
  await expect(reserve).toHaveAttribute('data-tone', 'warn');
  await reserve.click();
  await expect(page.getByLabel('Inspect connection')).toHaveValue('visual-reserve');
  await expect(page.locator('.account-inspector')).toContainText('Cooling down');
  await expect(page.locator('.account-inspector')).toContainText('No quota measurement reported.');
  await expect(page.locator('.inspector-pair').getByText('—', { exact: true })).toBeVisible();
});

test('rejected context records expose the coverage gap and session changes clear old details', async ({
  page,
}) => {
  await page.route('**/api/context?*', (r) =>
    r.fulfill(
      json(200, {
        ...contextOverview,
        recording: { rejectedAttempts: 2, scope: 'all retained attempts' },
      })
    )
  );
  await page.goto('/dashboard/context');
  await expect(page.getByText('2 context records were rejected.')).toBeVisible();
  await expect(page.locator('.session-label-note')).toContainText(
    'Inferred locality may combine multiple agents'
  );
  await page.locator('.context-session').filter({ hasText: 'TokenProxy' }).click();
  await expect(page.getByRole('heading', { name: 'TokenProxy', exact: true })).toBeVisible();
  await expect(page.locator('.context-detail')).toContainText('Inferred locality');
  await expect(page.getByLabel('Inspect request').locator('option')).toHaveCount(18);
});

test('workspace preferences preserve native keyboard focus and project text is escaped', async ({
  page,
}) => {
  await page.goto('/dashboard/context');
  const open = page.getByRole('button', { name: 'Workspace account and language' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Workspace account and language' });
  await expect(dialog.getByRole('combobox')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();
  await page.getByRole('button', { name: 'Edit project' }).click();
  await page.locator('.project-editor input').fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Save label' }).click();
  await expect(
    page.getByRole('heading', { name: '<img src=x onerror=alert(1)>', exact: true })
  ).toBeVisible();
  await expect(page.locator('.context-detail img[src="x"]')).toHaveCount(0);
});
