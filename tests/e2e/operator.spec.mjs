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
  await expect(page.locator('.react-flow__edge.animated')).toHaveCount(2);
  await page.getByRole('button', { name: 'Pause route animation' }).click();
  await expect(page.locator('.react-flow__edge.animated')).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume route animation' }).click();
  await expect(page.locator('.react-flow__edge.animated')).toHaveCount(2);
  await page.locator('.graph-provider').filter({ hasText: 'Anthropic' }).click();
  await expect(page.locator('.route-inspector')).toContainText('2,890,000 input tokens');
  await expect(page.locator('.route-inspector')).toContainText('410,000 output tokens');
  await page.getByRole('button', { name: 'Close provider details' }).click();
  await expect(page.locator('.route-inspector')).toHaveCount(0);
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
