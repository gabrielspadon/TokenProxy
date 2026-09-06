import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const base = process.env.E2E_BASE || 'http://127.0.0.1:20160';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
assert(process.env.TOKENPROXY_PRIVATE_PREVIEW && process.env.EVIDENCE_DIR);
const auth = JSON.parse(
  await readFile(path.join(process.env.TOKENPROXY_PRIVATE_PREVIEW, 'preview-auth.json'), 'utf8')
);
const output = process.env.EVIDENCE_DIR;
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await browserContext.newPage();
const report = { checks: [], pageErrors: [] };
page.on('pageerror', (error) => report.pageErrors.push(error.message));
try {
  const login = await page.request.post(`${base}/api/auth/login`, {
    data: { password: auth.initialPassword },
  });
  assert.equal(login.status(), 200);
  assert.equal(login.headers()['x-tokenproxy-preview'], 'historical-snapshot');
  const context = await page.request.get(`${base}/api/context`);
  assert.equal(context.status(), 200);
  const contextData = await context.json();
  assert.equal(contextData.sessions.length, 0);
  report.checks.push({
    contextApi: 200,
    historicalSessions: 0,
    retainedAttempts: contextData.recording?.totalRetainedAttempts,
  });
  const quota = await (await page.request.get(`${base}/api/admin/quota`)).json();
  const windows = quota.snapshots.flatMap((item) => item.windows);
  assert.equal(windows.length, 33);
  assert(windows.every((window) => window.percentage?.source === 'connection.lastQuotaSnapshot'));
  report.checks.push({ linkedQuotaWindows: 33, sourcedPercentages: 33 });
  await page.goto(`${base}/dashboard`);
  const book = page.getByRole('table', { name: 'Configured account capacity' });
  await book.waitFor();
  await page.getByText('77,589', { exact: true }).first().waitFor();
  const account = book.locator('tbody tr').first().getByRole('button').first();
  await account.focus();
  await page.keyboard.press('Enter');
  const dock = page.getByRole('complementary', { name: 'Selection details' });
  await dock.waitFor();
  await dock.getByRole('tab', { name: /Quota windows/ }).click();
  assert((await dock.getByRole('table').locator('tbody tr').count()) > 0);
  await page.screenshot({ path: path.join(output, 'capacity-quota-dock.png'), fullPage: true });
  report.checks.push({ keyboardAccountInspection: true, quotaDetails: true });
  await page.getByRole('button', { name: 'Close selection details' }).click();
  await book.getByRole('checkbox').nth(0).check();
  await book.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: 'Compare (2)', exact: true }).click();
  await dock.getByRole('heading', { name: 'Compare 2 accounts' }).waitFor();
  assert.equal(await dock.getByRole('table').locator('tbody tr').count(), 2);
  await page.screenshot({ path: path.join(output, 'capacity-comparison.png'), fullPage: true });
  report.checks.push({ comparedAccounts: 2 });
  await page.getByRole('button', { name: 'Close selection details' }).click();
  await page.getByRole('combobox', { name: 'Provider filter', exact: true }).click();
  const filtered = page.waitForResponse(
    (response) =>
      response.url().includes('/api/analytics?') &&
      response.url().includes('provider=codex') &&
      response.ok()
  );
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await filtered;
  assert.equal(await book.locator('tbody tr').count(), 2);
  await page.getByRole('link', { name: 'Economics', exact: true }).click();
  await page.getByRole('heading', { name: 'Economics', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('combobox', { name: 'Provider filter', exact: true }).inputValue(),
    'Codex'
  );
  report.checks.push({ providerFilter: 'Codex', scopePreservedAcrossLenses: true });
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('table', { name: 'Economics by cohort' }).waitFor();
  await page.getByRole('table', { name: 'Recorded requests', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'economics-real.png'), fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(output, 'economics-real-1920.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const recent = page.waitForResponse(
    (response) =>
      response.url().includes('/api/analytics?') &&
      response.url().includes('view=economics') &&
      response.url().includes('start=') &&
      response.ok()
  );
  await page.getByRole('button', { name: 'Focus recent activity · 7 days', exact: true }).click();
  const recentData = await (await recent).json();
  assert.equal(recentData.summary.records, 76009);
  await page.getByRole('table', { name: 'Recorded requests', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'economics-recent.png'), fullPage: true });
  const cohorts = page.getByRole('table', { name: 'Economics by cohort' });
  const cohortCount = await cohorts.locator('tbody tr').count();
  await cohorts
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: /^Inspect/ })
    .click();
  await dock.waitFor();
  await page.getByRole('table', { name: 'Recorded requests', exact: true }).waitFor();
  assert.equal(await cohorts.locator('tbody tr').count(), cohortCount);
  await page.screenshot({ path: path.join(output, 'economics-selected.png'), fullPage: true });
  report.checks.push({
    recentSelectionChangedSharedScope: true,
    recentLedgerRecords: recentData.summary.records,
    selectedCohortPreservesPopulation: true,
  });
  await page.getByRole('button', { name: 'Close selection details' }).click();

  await page.getByRole('link', { name: 'Context', exact: true }).click();
  await page.getByRole('heading', { name: 'Context trace', exact: true }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(output, 'context-real-coverage.png'), fullPage: true });
  await page.goto(`${base}/dashboard`);
  await book.waitFor();
  await page.getByRole('button', { name: 'Find a control', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Find a control' });
  await dialog.waitFor();
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press('Tab');
    assert(await dialog.evaluate((element) => element.contains(document.activeElement)));
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute('aria-label')),
    'Find a control'
  );
  report.checks.push({ searchEscape: true });
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  report.accessibility = accessibility.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => ({ target: node.target, failure: node.failureSummary })),
  }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(output, 'capacity-mobile.png'), fullPage: true });
  report.mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth
  );
  await page.evaluate(() => {
    document.documentElement.dir = 'rtl';
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(output, 'capacity-mobile-rtl.png'), fullPage: true });
  report.rtlOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.accessibility, []);
  assert.equal(report.mobileOverflow, false);
  assert.deepEqual(report.mobileAccessibility, []);
  assert.equal(report.rtlOverflow, false);
} catch (error) {
  report.failure = error.message;
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await writeFile(path.join(output, 'interactions-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
}
