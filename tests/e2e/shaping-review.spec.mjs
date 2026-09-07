import { test, expect } from 'playwright/test';
import { signIn, json } from './helpers.mjs';
import { projectSettings, PROFILE_COVERAGE } from '../../src/lib/shaping/profile.js';

const NEW_FLAGS = {
  epochMicroEnabled: 'Boundary-aware clearing',
  epochAutoEnabled: 'Boundary-aware summary',
  dietEnabled: 'Expired result pruning',
  linguaEnabled: 'Selective prose compression',
  adaptiveCacheTtlEnabled: 'Adaptive cache lifetime',
};
const CURRENT_HASH = 'a'.repeat(64);
const NEXT_HASH = 'b'.repeat(64);
function currentSettings() {
  return projectSettings({
    rtkEnabled: true, schemaDistillEnabled: true, schemaAllowLossy: true, epochMicroEnabled: true,
    pxpipeMinChars: 25000, pxpipeTimeoutMs: 15000, memoryMaxToolTurnsKeepFull: 2,
    memoryMaxHistoricalToolChars: 800, memoryRecentTurnsToKeep: 8,
    memoryCompactionThresholdTokens: 32000, toolDisclosureMaxTools: 20,
    cavemanLevel: 'full', ponytailLevel: 'full', headroomTimeoutMs: null,
  });
}
const STATS = {
  windows: { all: { requests: 4, stages: {
    rtk: { requests: 3, applied: 2, measuredRequests: 1, bytesSaved: -128 },
    inject: { requests: 1, applied: 1, measuredRequests: 1, bytesSaved: 64 },
  } } }, recent: [], timeline: [], pxpipe: { timeline: [], recent: [] },
};
async function baseFixtures(page, settings = currentSettings()) {
  await page.route('**/api/settings', route => route.request().method() === 'GET'
    ? route.fulfill(json(200, settings)) : route.fulfill(json(500, { error: 'Unexpected settings mutation in intercepted review test' })));
  await page.route('**/api/token-saver/stats*', route => route.fulfill(json(200, STATS)));
  await page.route('**/api/tool-disclosure/stats', route => route.fulfill(json(200, [])));
  // These tests must never reach a real transform, service or inference route.
  await page.route('**/api/pxpipe/**', route => route.fulfill(json(500, { error: 'Unconfigured synthetic service action' })));
  await page.route('**/v1/**', route => route.abort('blockedbyclient'));
}
function experimentFixture() {
  const results = ['small-context', 'tool-transaction', 'tool-error', 'context-pressure'].map(fixtureId => ({
    fixtureId, afterBytes: 512, beforeBytes: 512, deltaBytes: 0, latencyMs: 0.1,
    beforeHash: CURRENT_HASH, afterHash: CURRENT_HASH,
    validity: { toolTransactionsValid: true, currentPreserved: true, liveThinkingPreserved: true, errorEvidencePreserved: true, schemaValidation: 'Synthetic local fixture checks' },
    stages: [{ stage: 'schema', status: 'unchanged', beforeBytes: 512, afterBytes: 512, deltaBytes: 0, latencyMs: 0.1 }],
    output: { model: 'synthetic-model', messages: [] },
  }));
  return { id: 'legacy-review-experiment', baselineVersionId: 13, candidateVersionId: 12,
    fixtureSetId: 'context-integrity-v1', persistence: 'confirmed', effectiveSettingsChanged: false,
    result: { localExecutionMs: 0.8, baseline: { results, unsupported: ['epochMicro'] }, candidate: { results, unsupported: [] } } };
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test('legacy profile defaults appear in editing and promotion without rewriting the stored version', async ({ page }) => {
  const originalCurrent = currentSettings();
  const storedOldSettings = Object.fromEntries(Object.entries(originalCurrent).filter(([key]) => !Object.hasOwn(NEW_FLAGS, key)));
  const storedOld = { id: 12, profileId: 'synthetic-legacy-profile', name: 'Legacy fixture profile', revision: 1, settings: storedOldSettings, consent: ['schemaAllowLossy'], contentHash: 'c'.repeat(64), createdAt: '2026-09-07T12:00:00.000Z' };
  const unchangedRecord = JSON.stringify(storedOld);
  const baseline = { id: 13, profileId: 'synthetic-current-profile', name: 'Current fixture profile', revision: 1, settings: originalCurrent, consent: ['epochMicroEnabled', 'schemaAllowLossy'], contentHash: CURRENT_HASH, createdAt: '2026-09-07T12:01:00.000Z' };
  const expectedLegacy = { ...storedOldSettings, ...Object.fromEntries(Object.keys(NEW_FLAGS).map(key => [key, false])) };
  let current = { settings: originalCurrent, currentHash: CURRENT_HASH, coverage: PROFILE_COVERAGE,
    consentRequired: ['epochMicroEnabled', 'schemaAllowLossy'], fixtureSets: [{ id: 'context-integrity-v1', name: 'Context integrity', revision: 1, count: 4, synthetic: true }] };
  const posts = [];
  const receipts = [];
  await baseFixtures(page, originalCurrent);
  await page.route(/\/api\/admin\/shaping(?:[/?]|$)/, route => {
    const resource = new URL(route.request().url()).pathname.replace('/api/admin/shaping', '');
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); posts.push({ resource, body });
      if (resource === '/experiments') return route.fulfill(json(200, experimentFixture()));
      if (resource === '/promote') {
        const receipt = { id: 'synthetic-legacy-promotion', action: 'promote', beforeSettings: originalCurrent, afterSettings: expectedLegacy, beforeHash: CURRENT_HASH, afterHash: NEXT_HASH, createdAt: '2026-09-07T12:02:00.000Z', consent: { contentChanging: body.consent, unsupported: [] } };
        receipts.push(receipt);
        current = { ...current, settings: expectedLegacy, currentHash: NEXT_HASH };
        return route.fulfill(json(200, { ...receipt, outcome: 'applied', persistence: 'confirmed' }));
      }
      return route.fulfill(json(500, { error: 'Unexpected shaping mutation in legacy review fixture' }));
    }
    if (resource === '') return route.fulfill(json(200, current));
    if (resource === '/profiles') return route.fulfill(json(200, { rows: [baseline, storedOld], pagination: { page: 1, pages: 1, pageSize: 10, total: 2 } }));
    if (resource === '/experiments') return route.fulfill(json(200, { rows: [], pagination: { page: 1, pages: 0, pageSize: 10, total: 0 } }));
    if (resource === '/receipts') return route.fulfill(json(200, { rows: receipts, pagination: { page: 1, pages: receipts.length ? 1 : 0, pageSize: 10, total: receipts.length } }));
    return route.fulfill(json(404, { error: 'Unknown synthetic shaping read' }));
  });
  await page.goto('/dashboard/shaping');
  await page.getByRole('button', { name: 'Profiles and comparison', exact: true }).click();
  const workbench = page.locator('.shaping-workbench');
  const oldRow = workbench.locator('.shaping-library .shaping-profile-row').filter({ has: page.getByText(storedOld.name, { exact: true }) });
  await oldRow.getByRole('button', { name: 'Revise', exact: true }).click();
  const editor = workbench.locator('.shaping-editor');
  await editor.locator('summary').filter({ hasText: /^Review and edit all/ }).click();
  for (const label of Object.values(NEW_FLAGS)) {
    const flag = editor.getByRole('checkbox', { name: label, exact: true });
    await expect(flag).toBeVisible();
    await expect(flag).not.toBeChecked();
  }
  await expect(editor.getByRole('button', { name: 'Save profile version', exact: true })).toBeDisabled();
  expect(posts).toEqual([]);
  expect(JSON.stringify(storedOld)).toBe(unchangedRecord);
  await workbench.locator('.shaping-library .shaping-profile-row').filter({ has: page.getByText(baseline.name, { exact: true }) }).getByRole('button', { name: 'Baseline', exact: true }).click();
  await oldRow.getByRole('button', { name: 'Candidate', exact: true }).click();
  await workbench.getByRole('combobox', { name: 'Synthetic fixture set', exact: true }).selectOption('context-integrity-v1');
  await workbench.getByRole('button', { name: 'Run offline comparison', exact: true }).click();
  await workbench.getByRole('button', { name: 'Review promotion', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Promote this profile', exact: true });
  const epochDiff = dialog.locator('tbody tr').filter({ has: page.locator('th').filter({ hasText: /^Boundary-aware clearing$/ }) });
  await expect(epochDiff.locator('td')).toHaveText(['true', 'false']);
  const promote = dialog.getByRole('button', { name: 'Promote profile', exact: true });
  await expect(promote).toBeDisabled();
  expect(posts.map(item => item.resource)).toEqual(['/experiments']);
  await dialog.getByRole('checkbox', { name: 'I consent to the reviewed content changes for new requests.', exact: true }).check();
  await expect(promote).toBeEnabled();
  expect(posts.map(item => item.resource)).toEqual(['/experiments']);
  await promote.click();
  await expect(dialog).not.toBeVisible();
  expect(posts.map(item => item.resource)).toEqual(['/experiments', '/promote']);
  const sent = posts[1].body;
  expect(sent).toMatchObject({ versionId: storedOld.id, experimentId: 'legacy-review-experiment', expectedCurrent: CURRENT_HASH, acknowledgeUnsupported: [] });
  expect(sent.consent).toEqual(Object.keys(expectedLegacy).filter(key => expectedLegacy[key] === true));
  expect(sent.consent).toContain('schemaAllowLossy');
  for (const key of Object.keys(NEW_FLAGS)) expect(sent.consent).not.toContain(key);
  expect(JSON.stringify(storedOld)).toBe(unchangedRecord);
  for (const key of Object.keys(NEW_FLAGS)) expect(Object.hasOwn(storedOld.settings, key)).toBe(false);
});

async function serviceFixtures(page) {
  await baseFixtures(page);
  const calls = [];
  let running = false;
  await page.route('**/api/pxpipe/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    const method = route.request().method();
    if (method === 'GET' && action === 'status') return route.fulfill(json(200, { installed: true, running, enabled: false, autoInstall: false, npmAvailable: true, version: 'synthetic-review-fixture' }));
    if (method === 'GET' && action === 'logs') return route.fulfill(json(200, { installLog: 'Synthetic installation diagnostic' }));
    calls.push({ action, method });
    if (method === 'POST' && action === 'health') { running = true; return route.fulfill(json(200, { healthy: true, checks: [] })); }
    if (method === 'POST' && action === 'install') return route.fulfill(json(200, { health: { healthy: false, error: 'Synthetic self-test failure', checks: [] } }));
    if (method === 'POST' && ['stop', 'restart'].includes(action)) { running = action === 'restart'; return route.fulfill(json(200, { ok: true })); }
    return route.fulfill(json(500, { error: 'Unexpected intercepted service action' }));
  });
  return calls;
}
async function serviceAction(page, verb, action) {
  const service = page.locator('.shaping-service');
  await service.getByRole('button', { name: verb, exact: true }).click();
  const dialog = page.locator('dialog[open]');
  const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/pxpipe/${action}` && value.request().method() === 'POST');
  await dialog.getByRole('button', { name: verb, exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(dialog).not.toBeVisible();
}
const selfTestState = page => page.locator('.shaping-service-facts > div').filter({ has: page.getByText('Local self-test', { exact: true }) }).locator('dd');
async function passingHealth(page, calls) {
  await page.goto('/dashboard/shaping');
  await page.getByRole('button', { name: 'Service', exact: true }).click();
  await expect(selfTestState(page)).toHaveText('Not run in this view');
  expect(calls).toEqual([]);
  await serviceAction(page, 'Run local check', 'health');
  await expect(selfTestState(page)).toHaveText('Passing');
}

test('an install self-test failure replaces earlier passing health and remains a warning', async ({ page }) => {
  const calls = await serviceFixtures(page);
  await passingHealth(page, calls);
  await serviceAction(page, 'Install', 'install');
  await expect(selfTestState(page)).toHaveText('Failing');
  const warning = page.locator('.notice[data-tone="warn"]').filter({ hasText: 'Operation finished, but the local self-test failed.' });
  await expect(warning).toContainText('Synthetic self-test failure');
  await expect(page.locator('.shaping-service').getByText('The local self-test did not pass.', { exact: true })).toBeVisible();
  await expect(page.locator('.notice[data-tone="ok"]')).toHaveCount(0);
  await expect(page.getByText('Install finished.', { exact: true })).toHaveCount(0);
  await page.getByText('Installation log', { exact: true }).click();
  const log = page.locator('.shaping-log');
  await expect(log).toHaveText('Synthetic installation diagnostic');
  expect(await log.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(13);
  expect(calls).toEqual([{ action: 'health', method: 'POST' }, { action: 'install', method: 'POST' }]);
});
for (const action of ['stop', 'restart']) {
  test(`${action} clears previously passing service health`, async ({ page }) => {
    const calls = await serviceFixtures(page);
    await passingHealth(page, calls);
    await serviceAction(page, action === 'stop' ? 'Stop' : 'Restart', action);
    await expect(selfTestState(page)).toHaveText('Not run in this view');
    expect(calls).toEqual([{ action: 'health', method: 'POST' }, { action, method: 'POST' }]);
  });
}

async function assertLeftToRightNumber(locator, text) {
  await expect(locator).toHaveText(text);
  await expect(locator).toHaveAttribute('dir', 'ltr');
  const positions = await locator.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const characters = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let index = 0; index < node.textContent.length; index++) {
        if (!/[\d+\-]/.test(node.textContent[index])) continue;
        const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
        characters.push(range.getBoundingClientRect().left);
      }
    }
    return { direction: getComputedStyle(element).direction, first: characters[0], last: characters.at(-1) };
  });
  expect(positions.direction).toBe('ltr');
  expect(positions.first).toBeLessThan(positions.last);
}

test('RTL and reduced motion preserve arithmetic reading order', async ({ page }) => {
  await baseFixtures(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/dashboard/shaping');
  await expect(page.getByRole('heading', { name: 'Optimization', exact: true })).toBeVisible();
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  await assertLeftToRightNumber(page.locator('.shaping-summary > div').first().locator('bdi'), '4 / 27');
  const measured = page.locator('.shaping-evidence-states > div').filter({ has: page.getByText('Measured', { exact: true }) });
  await assertLeftToRightNumber(measured.locator('bdi').filter({ hasText: '1 / 3' }), '1 / 3');
  await assertLeftToRightNumber(measured.locator('.shaping-number'), '-128 B');
  const motion = await page.locator('[data-control="rtkEnabled"]').evaluate(element => ({ transition: getComputedStyle(element).transitionDuration, animation: getComputedStyle(element).animationName }));
  expect(motion.transition.split(',').every(value => Number.parseFloat(value) === 0)).toBe(true);
  expect(motion.animation).toBe('none');
  await page.getByRole('button', { name: 'Recorded evidence', exact: true }).click();
  const row = page.locator('.shaping-evidence-table tbody tr').filter({ has: page.locator('code').filter({ hasText: /^rtk$/ }) });
  await assertLeftToRightNumber(row.locator('bdi').filter({ hasText: '1 / 3' }), '1 / 3');
  const growth = page.locator('.shaping-evidence-table tbody tr').filter({ has: page.locator('code').filter({ hasText: /^inject$/ }) });
  await assertLeftToRightNumber(growth.locator('.shaping-number'), '+64 B');
});
