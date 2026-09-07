import { test, expect } from 'playwright/test';
import { signIn, json } from './helpers.mjs';
import { installOperatorFixture } from './operator-fixture.mjs';

for (const locale of ['ar', 'zh-CN']) {
  test(`legacy ${locale} preference leaves sign-in English and user content unchanged`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'locale', value: locale, url: baseURL }]);
    const catalogRequests = [];
    page.on('request', request => {
      if (/\/i18n\/|\/api\/locale/.test(request.url())) catalogRequests.push(request.url());
    });
    const label = 'Entrar 中文 العربية <img src=x>';
    await page.route('**/api/auth/status', route => route.fulfill(json(200, {
      requireLogin: true, authenticated: false, hasPassword: true,
      oidcConfigured: true, oidcLoginLabel: label,
    })));
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /language/i })).toHaveCount(0);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
    expect(catalogRequests).toEqual([]);
  });
}

test('workspace preferences expose appearance without a language control', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'locale', value: 'fa', url: baseURL }]);
  await signIn(page);
  await installOperatorFixture(page);
  const catalogRequests = [];
  page.on('request', request => {
    if (/\/i18n\/|\/api\/locale/.test(request.url())) catalogRequests.push(request.url());
  });
  await page.goto('/dashboard/context');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  const preferences = page.getByRole('button', { name: 'Workspace preferences', exact: true });
  await preferences.click();
  const dialog = page.getByRole('dialog', { name: 'Workspace preferences' });
  await expect(dialog.getByRole('radiogroup', { name: 'Appearance' })).toBeVisible();
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(preferences).toBeFocused();
  expect(catalogRequests).toEqual([]);
});
