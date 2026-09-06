import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const base = process.env.E2E_BASE || 'http://127.0.0.1:20296';
assert.equal(new URL(base).hostname, '127.0.0.1');
assert(process.env.TOKENPROXY_PRIVATE_PREVIEW && process.env.EVIDENCE_DIR);
const auth = JSON.parse(
  await readFile(path.join(process.env.TOKENPROXY_PRIVATE_PREVIEW, 'preview-auth.json'))
);
const output = process.env.EVIDENCE_DIR;
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const report = { fixture: 'synthetic SQLite runtime', checks: [], pageErrors: [] };
async function firstViewRows() {
  return page.getByRole('table', { name: 'Session request attempts' }).evaluate((table) => {
    let top = 0, bottom = innerHeight;
    for (let parent = table.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
        const bounds = parent.getBoundingClientRect();
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => {
      const bounds = row.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom,
        fullyVisible: bounds.top >= top && bounds.bottom <= bottom,
        partlyVisible: bounds.bottom > top && bounds.top < bottom };
    });
    return { viewport: { width: innerWidth, height: innerHeight }, clip: { top, bottom },
      fullRows: rows.filter((row) => row.fullyVisible).length,
      intersectingRows: rows.filter((row) => row.partlyVisible).length, rows: rows.slice(0, 6) };
  });
}
async function accessibilityViolations() {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  return result.violations.map((v) => ({ id: v.id,
    nodes: v.nodes.map((n) => ({ target: n.target, failure: n.failureSummary })) }));
}
page.on('pageerror', (e) => report.pageErrors.push(e.message));
try {
  const login = await page.request.post(`${base}/api/auth/login`, {
    data: { password: auth.initialPassword },
  });
  assert.equal(login.status(), 200);
  assert.equal(login.headers()['x-tokenproxy-preview-kind'], 'synthetic-fixture');
  await page.goto(`${base}/dashboard/context`);
  const sessions = page
    .getByRole('complementary', { name: 'Recorded session cohort' })
    .locator('button[aria-pressed]');
  await sessions.first().waitFor();
  await sessions.first().focus();
  await page.keyboard.press('Enter');
  const attempts = page.getByRole('table', { name: 'Session request attempts' });
  await attempts.waitFor();
  assert.equal(await attempts.locator('tbody tr').count(), 25);
  assert.equal(await sessions.count(), 3);
  await page.evaluate(() => window.scrollTo(0, 0));
  report.firstView1440 = await firstViewRows();
  await page.screenshot({ path: path.join(output, 'synthetic-context-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(350);
  await page.evaluate(() => window.scrollTo(0, 0));
  report.firstView1920 = await firstViewRows();
  await page.screenshot({ path: path.join(output, 'synthetic-context-1920.png'), fullPage: true });
  const next = page.getByRole('button', { name: 'Next attempts page', exact: true });
  for (const number of [2, 3]) {
    const response = page.waitForResponse(
      (r) =>
        r.url().includes('/api/context/sessions/') && r.url().includes(`page=${number}`) && r.ok()
    );
    await next.click();
    await response;
    await attempts.waitFor();
  }
  assert.equal(await attempts.locator('tbody tr').count(), 10);
  const last = attempts
    .locator('tbody tr')
    .last()
    .getByRole('button', { name: /^Inspect attempt/ });
  const label = await last.getAttribute('aria-label');
  await last.focus();
  await page.keyboard.press('Enter');
  const dock = page.getByRole('complementary', { name: 'Selection details' });
  await dock.waitFor();
  assert.equal(
    await dock.getByRole('table', { name: 'Ordered shaping stages' }).locator('tbody tr').count(),
    14
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: path.join(output, 'synthetic-context-last-attempt.png'),
    fullPage: true,
  });
  report.checks.push({
    keyboardSessionSelection: true,
    serverPage: 3,
    lastAttempt: label,
    orderedStages: 14,
  });
  const animations = await page.locator('canvas').evaluateAll((elements) =>
    elements.map((canvas) => ({
      running: canvas.getAnimations().filter((animation) => animation.playState === 'running')
        .length,
    }))
  );
  assert(animations.length > 0);
  assert(animations.every((item) => item.running === 0));
  assert(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  report.checks.push({ reducedMotionPreference: true, canvasAnimations: animations });
  report.accessibility = await accessibilityViolations();
  assert.deepEqual(report.accessibility, []);
  const initialDockHeight = (await dock.boundingBox()).height;
  await page.getByRole('separator', { name: 'Resize detail panel' }).focus();
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowUp');
  const expandedDockHeight = (await dock.boundingBox()).height;
  assert(expandedDockHeight > initialDockHeight);
  report.checks.push({ keyboardDockResize: { before: initialDockHeight, after: expandedDockHeight } });
  report.inspectorTabs = [];
  for (const [name, target] of [['Recorded controls', 'controls'], ['Session routing', 'routing']]) {
    await dock.getByText(name, { exact: true }).click();
    assert(await dock.getByRole('radio', { name, exact: true }).isChecked());
    const violations = await accessibilityViolations();
    report.inspectorTabs.push({ name, violations });
    assert.deepEqual(violations, []);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, `synthetic-context-${target}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: path.join(output, 'synthetic-context-mobile.png'),
    fullPage: true,
  });
  report.mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth
  );
  report.mobileAccessibility = await accessibilityViolations();
  assert.deepEqual(report.mobileAccessibility, []);
  assert.deepEqual(report.pageErrors, []);
  assert.equal(report.mobileOverflow, false);
} catch (error) {
  report.failure = error.message;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
}
