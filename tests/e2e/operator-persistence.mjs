import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const base = process.env.E2E_BASE || 'http://localhost:20160';
assert.equal(
  new URL(base).hostname,
  'localhost',
  'Persistence proof is restricted to the local preview'
);
const output = process.env.EVIDENCE_DIR || '/tmp/tokenproxy-ui-persistence-evidence';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const login = await page.request.post(`${base}/api/auth/login`, {
  data: { password: process.env.SMOKE_PASSWORD || 'astra-ui-local-test' },
});
assert.equal(login.status(), 200);
const result = await page.request.get(`${base}/api/context`);
assert.equal(result.status(), 200);
const overview = await result.json();
assert.equal(overview.summary.requests, 3);
assert.equal(overview.summary.providerInputTokens, 33000);
assert.equal(overview.summary.savedBytes, 3000);
assert.equal(
  overview.stages.reduce((n, s) => n + s.savedBytes, 0),
  3000
);
await page.goto(`${base}/dashboard/context`);
await page.getByRole('heading', { name: overview.sessions[0].projectLabel, exact: true }).waitFor();
await page.getByLabel('Inspect request').selectOption('ui-persisted-0');
await page.getByText('Measured shaping stages', { exact: true }).click();
await page.getByText('semantic-preserving', { exact: true }).waitFor();
await page.getByRole('button', { name: 'Edit project' }).click();
await page.locator('.project-editor input').fill('Persisted browser edit');
const saved = page.waitForResponse(
  (r) => r.request().method() === 'PATCH' && r.url().includes('/api/context/sessions/')
);
await page.getByRole('button', { name: 'Save label' }).click();
assert.equal((await saved).status(), 200);
await page.getByRole('heading', { name: 'Persisted browser edit', exact: true }).waitFor();
await page.reload();
await page.getByRole('heading', { name: 'Persisted browser edit', exact: true }).waitFor();
const durable = await (
  await page.request.get(`${base}/api/context/sessions/${overview.sessions[0].id}`)
).json();
assert.equal(durable.session.projectLabel, 'Persisted browser edit');
assert.equal(durable.turns.length, 3);
assert.equal(durable.turns[0].stages[0].beforeBytes, 20000);
assert.equal(durable.turns[0].stages[0].afterBytes, 19000);
assert.equal(durable.turns[0].providerInputTokens, 10000);
assert.equal(durable.turns[0].cacheReadTokens, 8000);
assert(!JSON.stringify(durable).includes('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: `${output}/context-persisted-desktop.png` });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: `${output}/context-persisted-mobile.png` });
const report = {
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  requests: 3,
  inputTokens: 33000,
  savedBytes: 3000,
  durableProjectLabel: durable.session.projectLabel,
  stagesReconciled: true,
  privateHashAbsent: true,
  pageErrors: errors,
};
assert.deepEqual(errors, []);
await writeFile(`${output}/context-persistence-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
await browser.close();
