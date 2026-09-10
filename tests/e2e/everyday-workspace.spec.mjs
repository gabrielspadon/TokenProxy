import { test, expect } from 'playwright/test';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';

// The launcher owns the credentialless runtime. No operational action is submitted.
test.use({ serviceWorkers: 'block', timezoneId: 'UTC', reducedMotion: 'reduce', trace: 'off', screenshot: 'off', video: 'off' });

for (const width of [1440, 1920, 390]) {
  test(`everyday navigation and task drafts remain usable at ${width}px`, async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(180000);
    page.setDefaultTimeout(15000);
    expect(process.env.E2E_FIXTURE_ROOT, 'Use an owned isolated fixture root').toBeTruthy();
    const root = await realpath(process.env.E2E_FIXTURE_ROOT);
    const runtime = JSON.parse(await readFile(`${root}/process.json`, 'utf8'));
    const owner = JSON.parse(await readFile(`${root}/owner.json`, 'utf8'));
    expect(owner).toMatchObject({ kind: 'tokenproxy-redesign-preview-v1', root, runId: runtime.runId });
    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(['production', 'dev']).toContain(runtime.mode);
    expect(baseURL).toBe(runtime.url);
    expect(process.env.E2E_BASE).toBe(runtime.url);
    if (runtime.mode === 'production') expect(runtime.buildId).toBeTruthy();
    await authenticateRedesign(context, root);
    const safety = await installRedesignBrowser(page, { baseUrl: runtime.url, runtimeReceipt: runtime });
    const report = { runId: runtime.runId, mode: runtime.mode, buildId: runtime.buildId ?? null, fixtureVersion: runtime.fixtureVersion, width, checks: [], captures: [], pageErrors: [], apiFailures: [], blockedMutations: [] };
    page.on('pageerror', error => report.pageErrors.push({ name: error.name }));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === runtime.url && url.pathname.startsWith('/api/') && response.status() >= 400) report.apiFailures.push({ path: url.pathname, status: response.status() });
    });
    await page.route(`${runtime.url}/**`, async route => {
      const request = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.fallback();
      report.blockedMutations.push({ path: new URL(request.url()).pathname, method: request.method() });
      return route.abort('blockedbyclient');
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const sections = page.getByRole('navigation', { name: 'Sections', exact: true });
    async function openNavigation() {
      const button = page.getByRole('button', { name: 'Open navigation', exact: true });
      if (await button.isVisible()) await button.click();
      await expect(sections).toBeVisible();
    }
    async function closeNavigation() {
      const button = page.getByRole('button', { name: 'Close navigation', exact: true });
      if (await button.isVisible()) await button.click();
    }
    async function navigate(path) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(response.headers()['x-tokenproxy-preview-kind']).toBe('synthetic-fixture');
      await expect(page.locator('.mantine-AppShell-header')).toContainText('Synthetic fixture');
    }
    async function capture(label) {
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} page overflow`).toBe(true);
      const path = testInfo.outputPath(`${label}-${width}.png`);
      const bytes = await page.screenshot({ path, animations: 'disabled', fullPage: true });
      report.captures.push({ label, path, sha256: createHash('sha256').update(bytes).digest('hex'), viewport: page.viewportSize(), pathname: new URL(page.url()).pathname, imageInspected: false });
    }
    try {
      await navigate('/dashboard/tools');
      await openNavigation();
      await expect(sections.getByRole('radio', { name: 'Everyday', exact: true })).toBeChecked();
      await expect(sections.locator('a[href="/dashboard/compatibility"]')).toHaveCount(0);
      await sections.getByText('Advanced', { exact: true }).click();
      await expect(sections.getByRole('radio', { name: 'Advanced', exact: true })).toBeChecked();
      await expect(sections.locator('a[href="/dashboard/compatibility"]')).toBeVisible();
      await page.reload();
      await openNavigation();
      await expect(sections.getByRole('radio', { name: 'Advanced', exact: true })).toBeChecked();
      await expect(sections.locator('a[href="/dashboard/remote"], a[href="/dashboard/translation"]')).toHaveCount(0);
      await sections.getByText('Everyday', { exact: true }).click();
      await page.reload();
      await openNavigation();
      await expect(sections.getByRole('radio', { name: 'Everyday', exact: true })).toBeChecked();
      await closeNavigation();
      await navigate('/dashboard/compatibility');
      await openNavigation();
      await expect(sections.getByText('Current page', { exact: true })).toBeVisible();
      await expect(sections.locator('a[href="/dashboard/compatibility"]')).toHaveAttribute('aria-current', 'page');
      await expect(sections.locator('a[href="/dashboard/remote"], a[href="/dashboard/translation"]')).toHaveCount(0);
      await capture('everyday-current-deep-link');
      await closeNavigation();
      report.checks.push('Everyday and Advanced survive reload; advanced deep links remain available; retired links absent');

      // The three Operations pages are boards: one panel per page, groups of
      // cards rather than task tabs, and a card that opens in place.
      await navigate('/dashboard/access');
      const access = page.locator('section[aria-label="Access"]');
      await expect(access).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Access tasks' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Expand OIDC', exact: true }).click();
      const issuer = page.getByLabel('Provider address', { exact: true });
      const identity = page.getByLabel('Client identity', { exact: true });
      await expect(issuer).toBeEditable();
      await expect(page.getByRole('button', { name: 'Review configuration', exact: true })).toBeEnabled();
      await issuer.fill('https://identity.example.invalid');
      await identity.fill(`synthetic-unsaved-${width}`);
      await capture('access-advanced');
      // Collapsing a card and opening it again keeps the unsaved draft: the
      // draft outlives the card, and nothing was submitted.
      await page.getByRole('button', { name: 'Collapse OIDC', exact: true }).click();
      await expect(issuer).toHaveCount(0);
      await page.getByRole('button', { name: 'Expand OIDC', exact: true }).click();
      await expect(issuer).toHaveValue('https://identity.example.invalid');
      await expect(identity).toHaveValue(`synthetic-unsaved-${width}`);
      await capture('access-unsaved-sso-draft');
      report.checks.push('Access keeps an unsaved OIDC draft across a card collapse, without submit or provider discovery');

      await navigate('/dashboard/system');
      await expect(page.locator('section[aria-label="System"]')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'System tasks' })).toHaveCount(0);
      await expect(page.locator('article[data-account-id="process"]')).toBeVisible();
      await capture('system-status');
      // Every scope is on the one board: import carries its file field and
      // shutdown its own card, with no tab hiding either.
      await expect(page.getByLabel('Backup file', { exact: true })).toBeVisible();
      await capture('system-configuration');
      await expect(page.locator('article[data-account-id="shutdown"]')).toBeVisible();
      await capture('system-maintenance');
      report.checks.push('System carries runtime, configuration and maintenance on one board with no task tabs');

      await navigate('/dashboard/notifications');
      await expect(page.locator('section[aria-label="Notification rules"]')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Notifications tasks' })).toHaveCount(0);
      await capture('notifications-overview');
      await expect(page.locator('section[aria-label="Notification delivery"]')).toBeVisible();
      await expect(page.locator('form[aria-label="Add a destination"]')).toBeVisible();
      await capture('notifications-destinations');
      await expect(page.getByRole('group', { name: 'Rule summary' })).toBeVisible();
      await capture('notifications-rules');
      report.checks.push('Notifications carries rules, destinations and deliveries on one page without a send');
      expect(report.pageErrors).toEqual([]);
      expect(report.blockedMutations).toEqual([]);
      expect(safety.outboundFailures).toEqual([]);
    } finally {
      report.outboundFailures = safety.outboundFailures;
      await writeFile(testInfo.outputPath(`everyday-workspace-${width}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
    }
  });
}
