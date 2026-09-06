import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const base = process.env.E2E_BASE || 'http://127.0.0.1:20160';
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname));
assert(
  process.env.TOKENPROXY_PRIVATE_PREVIEW,
  'Set the private preview directory, outside the repository.'
);
const auth = JSON.parse(
  await readFile(path.join(process.env.TOKENPROXY_PRIVATE_PREVIEW, 'preview-auth.json'), 'utf8')
);
const output = process.env.EVIDENCE_DIR;
assert(output, 'Set a private evidence directory.');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const response = await page.request.get(`${base}/login`);
  assert.equal(
    response.headers()['x-tokenproxy-preview'],
    'historical-snapshot',
    'The mandatory preview guard must be active.'
  );
  assert(
    response.headers()['x-tokenproxy-preview-captured-at'],
    'Snapshot timestamp must be supplied by the guard.'
  );
  const login = await page.request.post(`${base}/api/auth/login`, {
    data: { password: auth.initialPassword },
  });
  assert.equal(login.status(), 200);
  await page.goto(`${base}/dashboard`);
  await page.getByRole('heading', { name: 'Capacity book' }).waitFor();
  await page.getByRole('table', { name: 'Configured account capacity' }).waitFor();
  await page.getByText('77,589', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  const rows = await page
    .getByRole('table', { name: 'Configured account capacity' })
    .locator('tbody tr')
    .count();
  assert.equal(rows, 24);
  await page.screenshot({ path: path.join(output, 'capacity-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(output, 'capacity-1920.png'), fullPage: true });
  const report = {
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(
      execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
    ),
    rows,
    snapshot: response.headers()['x-tokenproxy-preview-captured-at'],
    pageErrors: errors,
  };
  await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
