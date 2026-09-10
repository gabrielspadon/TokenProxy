import { test, expect } from 'playwright/test';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';

test.use({ serviceWorkers: 'block', timezoneId: 'UTC', reducedMotion: 'reduce', trace: 'off', screenshot: 'off', video: 'off' });

test('Everyday savings and disabled-key limits persist and restore through real local APIs', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  expect(process.env.E2E_FIXTURE_ROOT, 'An owned credentialless fixture is required').toBeTruthy();
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
  expect(safety.persistence).toBe(true);
  const keyPath = '/api/keys/redesign-budget-key';
  const report = { runId: runtime.runId, mode: runtime.mode, buildId: runtime.buildId ?? null, fixtureVersion: runtime.fixtureVersion, checks: [], writes: [], blockedMutations: [], pageErrors: [], restored: {} };
  page.on('pageerror', error => report.pageErrors.push({ name: error.name }));
  await page.route(`${runtime.url}/**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.fallback();
    const body = request.postDataJSON();
    const keyWrite = request.method() === 'PUT' && path === keyPath && Object.keys(body).length === 1 && [1, 1.25].includes(body.maxCostUsd);
    const savingsWrite = request.method() === 'POST' && path === '/api/admin/shaping/controls'
      && Object.keys(body).sort().join(',') === 'consent,expectedCurrent,patch'
      && Object.keys(body.patch || {}).join(',') === 'rtkEnabled' && typeof body.patch.rtkEnabled === 'boolean'
      && /^[a-f0-9]{64}$/.test(body.expectedCurrent) && Array.isArray(body.consent);
    if (!keyWrite && !savingsWrite) {
      report.blockedMutations.push({ path, method: request.method() });
      return route.abort('blockedbyclient');
    }
    report.writes.push({ path, method: request.method() });
    return route.fallback();
  });
  function synthetic(response) {
    expect(response.status()).toBe(200);
    expect(response.headers()['x-tokenproxy-preview-kind']).toBe('synthetic-fixture');
    expect(response.headers()['x-tokenproxy-preview-version']).toBe(runtime.fixtureVersion);
  }
  async function read(path) {
    const response = await context.request.get(`${runtime.url}${path}`);
    synthetic(response);
    return response.json();
  }
  async function navigate(path) {
    synthetic(await page.goto(path));
    await expect(page.locator('.mantine-AppShell-header')).toContainText('Synthetic fixture');
  }
  async function reload() { synthetic(await page.reload()); }
  const savingsSwitch = page.locator('[data-savings-control="rtkEnabled"]').getByRole('switch');
  // Turning a saver on grants a new content-changing transformation, so it is
  // reviewed in place with consent. Turning one off grants nothing and saves
  // from the switch itself.
  const reviewStrip = page.locator('[role="group"][aria-label^="Turn on"]');
  async function saveSavings(on, checkConsent = false) {
    await expect(savingsSwitch).toBeEnabled();
    await expect(savingsSwitch).toBeChecked({ checked: !on });
    await savingsSwitch.focus();
    await expect(savingsSwitch).toBeFocused();
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/shaping/controls' && response.request().method() === 'POST');
    await savingsSwitch.press('Space');
    if (on) {
      await expect(reviewStrip).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const submit = reviewStrip.getByRole('button', { name: 'Turn on', exact: true });
      if (checkConsent) {
        const writes = report.writes.length;
        await submit.click();
        await expect(reviewStrip).toContainText('Review and consent to the enabled content-changing controls before saving.');
        expect(report.writes).toHaveLength(writes);
        expect((await read('/api/admin/shaping')).settings.rtkEnabled).toBe(!on);
        report.checks.push('Savings refuses an unconsented change without a write');
      }
      await reviewStrip.getByRole('checkbox').check();
      await submit.click();
    }
    const response = await responsePromise;
    synthetic(response);
    const saved = await response.json();
    expect(saved).toMatchObject({ outcome: 'applied', persistence: 'confirmed', settings: { rtkEnabled: on } });
    await expect(reviewStrip).toHaveCount(0);
    await expect(savingsSwitch).toBeChecked({ checked: on });
    expect((await read('/api/admin/shaping')).currentHash).toBe(saved.afterHash);
  }
  const selectedKey = page.getByRole('region', { name: 'Selected key configuration', exact: true });
  async function configureKey() {
    await page.getByRole('button', { name: 'Configure Synthetic budget evidence', exact: true }).click();
    await expect(selectedKey.getByLabel('Cost ceiling', { exact: true })).toBeEditable();
  }
  async function saveKey(value) {
    await selectedKey.getByLabel('Cost ceiling', { exact: true }).fill(String(value));
    await selectedKey.getByRole('button', { name: 'Review key budgets and model access', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Save limits', exact: true });
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === keyPath && response.request().method() === 'PUT');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const response = await responsePromise;
    synthetic(response);
    expect(response.request().postDataJSON()).toEqual({ maxCostUsd: value });
    await expect(dialog).not.toBeVisible();
  }
  const initialSavings = await read('/api/admin/shaping');
  const initialKey = (await read(keyPath)).key;
  expect(initialSavings.settings.rtkEnabled).toBe(false);
  expect(initialKey).toMatchObject({ id: 'redesign-budget-key', name: 'Synthetic budget evidence', isActive: false, maxCostUsd: 1, budgetPolicy: 'strict', secretRedacted: true });
  expect(initialKey).not.toHaveProperty('key');
  try {
    await navigate('/dashboard/shaping');
    await saveSavings(true, true);
    await reload();
    await expect(savingsSwitch).toBeChecked();
    expect((await read('/api/admin/shaping')).settings).toEqual({ ...initialSavings.settings, rtkEnabled: true });
    report.checks.push('Consented savings setting survives browser reload and real API readback');
    await saveSavings(false);
    await reload();
    await expect(savingsSwitch).not.toBeChecked();
    expect((await read('/api/admin/shaping')).currentHash).toBe(initialSavings.currentHash);
    report.restored.savings = true;

    await navigate('/dashboard/keys');
    await configureKey();
    const cost = selectedKey.getByLabel('Cost ceiling', { exact: true });
    await cost.fill('1.25');
    const tasks = page.getByRole('navigation', { name: 'Key tasks', exact: true });
    await tasks.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(cost).toBeHidden();
    await tasks.getByRole('button', { name: 'Limits', exact: true }).click();
    await expect(cost).toHaveValue('1.25');
    expect((await read(keyPath)).key).toEqual(initialKey);
    report.checks.push('Key draft survives task changes without changing persisted limits');
    await saveKey(1.25);
    await reload();
    await configureKey();
    await expect(cost).toHaveValue('1.25');
    expect((await read(keyPath)).key).toEqual({ ...initialKey, maxCostUsd: 1.25 });
    report.checks.push('Only the disabled synthetic key cost ceiling changes and survives reload');
    await saveKey(1);
    await reload();
    await configureKey();
    await expect(cost).toHaveValue('1');
    expect((await read(keyPath)).key).toEqual(initialKey);
    report.restored.key = true;
    expect(report.writes).toHaveLength(4);
    expect(report.blockedMutations).toEqual([]);
    expect(report.pageErrors).toEqual([]);
    expect(safety.outboundFailures).toEqual([]);
  } finally {
    try {
      // Read before recovery; never replay a save whose outcome is unknown.
      const key = (await read(keyPath)).key;
      if (key.maxCostUsd !== initialKey.maxCostUsd) {
        expect(key).toEqual({ ...initialKey, maxCostUsd: 1.25 });
        await navigate('/dashboard/keys');
        await configureKey();
        await saveKey(initialKey.maxCostUsd);
      }
      expect((await read(keyPath)).key).toEqual(initialKey);
      report.restored.key = true;
      const savings = await read('/api/admin/shaping');
      if (savings.currentHash !== initialSavings.currentHash) {
        expect(savings.settings).toEqual({ ...initialSavings.settings, rtkEnabled: true });
        await navigate('/dashboard/shaping');
        await saveSavings(false);
      }
      expect((await read('/api/admin/shaping')).settings).toEqual(initialSavings.settings);
      report.restored.savings = true;
    } finally {
      report.outboundFailures = safety.outboundFailures;
      await writeFile(testInfo.outputPath('everyday-controls-persistence.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    }
  }
});
