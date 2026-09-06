import { chromium } from 'playwright';
import { installOperatorFixture } from './operator-fixture.mjs';
import { mkdir } from 'node:fs/promises';
const base = process.env.E2E_BASE || 'http://localhost:20160';
const output =
  process.env.EVIDENCE_DIR || new URL('../../../output/playwright/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.request.post(`${base}/api/auth/login`, {
  data: { password: process.env.SMOKE_PASSWORD || 'astra-ui-local-test' },
});
await installOperatorFixture(page);
await page.goto(`${base}/dashboard`);
await page.getByText('4,195', { exact: true }).waitFor();
await page.waitForTimeout(1200);
await page.locator('.graph-provider').first().waitFor();
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: `${output}/overview-populated-desktop.png`, fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: `${output}/overview-populated-mobile.png`, fullPage: true });
await page.setViewportSize({ width: 1440, height: 1100 });
await page.goto(`${base}/dashboard/context`);
await page.getByRole('heading', { name: 'OceanStack', exact: true }).waitFor();
await page.locator('.context-chart svg').first().waitFor();
await page.screenshot({ path: `${output}/context-populated-desktop.png`, fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: `${output}/context-populated-mobile.png`, fullPage: true });
console.log(JSON.stringify({ screenshots: 4, errors }));
await browser.close();
