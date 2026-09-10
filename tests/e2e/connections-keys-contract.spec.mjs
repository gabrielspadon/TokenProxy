import { test, expect } from 'playwright/test';
import { signIn, json } from './helpers.mjs';

const at = '2026-09-07T12:00:00.000Z';
const profile = { id: 'fixture-profile', name: 'Synthetic policy for a deliberately long laboratory and collaboration label', version: 1, updatedAt: at, createdAt: at, keyCount: 2, allowedModels: ['openai/*'], maxPromptTokens: null, maxCompletionTokens: null, maxCostUsd: 0, budgetPolicy: 'strict', expiryDays: null };
test.beforeEach(async ({ page }) => { await signIn(page); });

test('accepted profile with failed readback blocks further mutation and keeps uncertainty visible', async ({ page }) => {
  let written = false;
  await page.route('**/api/access-profiles', route => {
    if (route.request().method() === 'POST') { written = true; return route.fulfill(json(201, { profile })); }
    return route.fulfill(written ? json(503, { error: 'Synthetic snapshot unavailable' }) : json(200, { profiles: [] }));
  });
  await page.route('**/api/keys', route => route.fulfill(json(200, { keys: [] })));
  await page.goto('/dashboard/keys');
  await page.getByLabel('Keys workspace').getByText('Profiles', { exact: true }).click();
  await page.getByRole('button', { name: 'Create access profile', exact: true }).click();
  await page.locator('.profile-inspector').getByLabel('Profile name', { exact: true }).fill(profile.name);
  await page.getByRole('button', { name: 'Review profile', exact: true }).click();
  // The profile review confirms inline beside the inspector, not in a dialog.
  await expect(page.locator('dialog')).toHaveCount(0);
  await page.locator('.profile-inspector').getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByText('The mutation was accepted; refreshed state was not verified.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create access profile', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh profiles', exact: true })).toBeVisible();
});

test('profile inspector retains a known zero USD ceiling and long labels at narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/access-profiles', route => route.fulfill(json(200, { profiles: [profile] })));
  await page.goto('/dashboard/keys');
  await page.getByLabel('Keys workspace').getByText('Profiles', { exact: true }).click();
  await page.locator('.profile-row').click();
  await expect(page.locator('.profile-inspector')).toContainText(profile.name);
  await expect(page.locator('.profile-inspector').getByLabel('Recorded cost ceiling (USD)', { exact: true })).toHaveValue('0');
  await expect(page.locator('.profile-row')).toContainText('$0.00');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('multiple accounts remain separate and absent health never becomes healthy', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const names = ['Synthetic fixture Alpha with a deliberately long account identity', 'Synthetic fixture Beta'];
  await page.route('**/api/providers', route => route.fulfill(json(200, { connections: names.map((name, index) => ({ id: `fixture-${index}`, provider: 'openai', name, isActive: true, authType: 'apikey', priority: index + 1 })) })));
  await page.route('**/api/admin/qualification', route => route.fulfill(json(200, { connections: [] })));
  await page.route('**/api/admin/drain?all=true', route => route.fulfill(json(200, { connections: [] })));
  await page.goto('/dashboard/connections');
  // Two accounts, two cards, and an account with no qualification evidence
  // reads as not checked rather than as ready.
  await expect(page.locator('article[data-account-id]')).toHaveCount(2);
  await expect(page.locator('article[data-account-id="fixture-0"]')).toContainText('Not checked');
  await page.getByRole('button', { name: `Expand ${names[0]}`, exact: true }).click();
  const detail = page.locator('[role="region"][aria-label="Selection details"]');
  await expect(detail).toContainText('Unknown. A stored account or health result does not establish model access.');
  await expect(page.locator('article[data-expanded]')).toContainText(names[0]);
  await expect(page.locator('dialog')).toHaveCount(0);
});
