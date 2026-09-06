import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.E2E_BASE || 'http://localhost:20160';
const out =
  process.env.EVIDENCE_DIR ||
  new URL('../../../output/playwright/sweep/', import.meta.url).pathname;
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.request.post(`${base}/api/auth/login`, {
  data: { password: process.env.SMOKE_PASSWORD || 'astra-ui-local-test' },
});
const paths = [
  '',
  'context',
  'connections',
  'sessions',
  'network',
  'models',
  'keys',
  'usage',
  'shaping',
  'translation',
  'tools',
  'remote',
  'notifications',
  'access',
  'system',
];
const report = [];
for (const p of paths) {
  const errors = [];
  const fn = (e) => errors.push(e.message);
  page.on('pageerror', fn);
  const r = await page.goto(`${base}/dashboard${p ? '/' + p : ''}`);
  await page.locator('h1').waitFor();
  await page.waitForTimeout(1200);
  const title = await page.locator('h1').innerText();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await page.screenshot({ path: `${out}/${p || 'overview'}-desktop.png`, fullPage: true });
  await page.screenshot({ path: `${out}/${p || 'overview'}-desktop-viewport.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/${p || 'overview'}-mobile.png`, fullPage: true });
  await page.screenshot({ path: `${out}/${p || 'overview'}-mobile-viewport.png` });
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  report.push({
    path: p || 'overview',
    status: r.status(),
    title,
    overflow,
    mobileOverflow,
    errors,
  });
  page.off('pageerror', fn);
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
await browser.close();
