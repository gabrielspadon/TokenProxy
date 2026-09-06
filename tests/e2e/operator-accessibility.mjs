import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { installOperatorFixture } from './operator-fixture.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.E2E_BASE || 'http://localhost:20160';
const out = process.env.EVIDENCE_DIR || '/tmp/tokenproxy-ui-accessibility';
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage();
await page.request.post(`${base}/api/auth/login`, {
  data: { password: process.env.SMOKE_PASSWORD || 'astra-ui-local-test' },
});
await installOperatorFixture(page);
const results = [];
for (const path of ['/dashboard', '/dashboard/context', '/dashboard/shaping']) {
  await page.goto(base + path);
  await page.waitForTimeout(800);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  results.push({
    path,
    violations: result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
    })),
  });
}
await page.goto(`${base}/dashboard`);
const node = page.getByRole('button', { name: 'Inspect Engineering team, Healthy' });
await node.focus();
await page.keyboard.press('Enter');
assert.equal(await page.getByLabel('Inspect connection').inputValue(), 'visual-1');
await page.evaluate(() => (document.documentElement.dir = 'rtl'));
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: `${out}/overview-rtl-mobile.png` });
results.push({
  rtlOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
  keyboardAccountSelection: true,
});
await writeFile(`${out}/accessibility-report.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
await browser.close();
assert.equal(results.flatMap((r) => r.violations || []).length, 0);
assert.equal(results.at(-1).rtlOverflow, false);
