import { test, expect } from 'playwright/test';
import { randomUUID } from 'node:crypto';
import { signIn } from './helpers.mjs';
import { credentiallessDatabase } from './capacity-economics-fixture-guard.mjs';

// No route interception, mocked response, or direct configuration POST/PATCH.
// Authentication follows the suite helper; every shaping mutation uses the UI.
const PREVIEW_HEADER = 'x-tokenproxy-preview-kind';
const PREVIEW_KIND = 'synthetic-fixture';
const FLAG_LABELS = {
  epochMicroEnabled: 'Boundary-aware clearing',
  schemaDistillEnabled: 'Tool schema reduction',
  schemaAllowLossy: 'Schema metadata removal',
};

function assertSynthetic(response) {
  expect(response.headers()[PREVIEW_HEADER], 'Refusing mutations outside the synthetic fixture preview').toBe(PREVIEW_KIND);
}
async function readJson(page, resource) {
  const response = await page.request.get(resource, { maxRedirects: 0 });
  assertSynthetic(response);
  expect(response.status(), `Read failed for ${resource}`).toBe(200);
  return response.json();
}
async function uiMutation(page, resource, action) {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === resource && response.request().method() === 'POST');
  await action();
  const response = await responsePromise;
  assertSynthetic(response);
  return { status: response.status(), body: await response.json() };
}
function confirmed(result) {
  expect(result.status, result.body.code || 'The mutation did not return a complete response').toBe(200);
  expect(result.body.persistence).toBe('confirmed');
  expect(result.body.outcome).not.toBe('partial');
  return result.body;
}
async function openWorkbench(page) {
  const response = await page.goto('/dashboard/shaping');
  assertSynthetic(response);
  await page.getByRole('radiogroup', { name: 'Token savings task' }).getByText('Profiles', { exact: true }).click();
  const workbench = page.locator('.shaping-workbench');
  await expect(workbench.getByRole('heading', { name: 'Profiles and offline experiments', exact: true })).toBeVisible();
  return workbench;
}
function fixtureAccountIdentities() {
  const database = credentiallessDatabase();
  try {
    return database.prepare('SELECT id, provider FROM providerConnections ORDER BY id').all();
  } finally { database.close(); }
}

// One sequence owns its named profiles and receipt; no retries can replay an
// uncertain promotion. The saved records remain in the disposable evidence DB.
test('synthetic UI saves, compares, promotes and rolls back real shaping records', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  expect(process.env.E2E_BASE, 'Set E2E_BASE explicitly for this mutation test').toBeTruthy();
  expect(process.env.SMOKE_PASSWORD, 'Supply the isolated preview password explicitly').toBeTruthy();
  const base = new URL(process.env.E2E_BASE);
  expect(['127.0.0.1', 'localhost', '[::1]'], 'Persistence is loopback-only').toContain(base.hostname);
  expect(['http:', 'https:']).toContain(base.protocol);
  expect(base.username || base.password, 'Do not put credentials in E2E_BASE').toBe('');
  const gate = await page.request.get(new URL('/api/admin/health', base).href, { maxRedirects: 0 });
  assertSynthetic(gate); // Before sending credentials or any UI mutation.
  const fixtureAccounts = fixtureAccountIdentities();
  await signIn(page);
  const connections = await readJson(page, '/api/providers');
  expect(connections.connections.map(({ id, provider }) => ({ id, provider })).sort((a, b) => a.id.localeCompare(b.id)),
    'The preview must expose exactly the verified credentialless fixture accounts').toEqual(fixtureAccounts);
  const initial = await readJson(page, '/api/admin/shaping');
  const fixtures = initial.fixtureSets.find(set => set.id === 'context-integrity-v1');
  expect(fixtures).toMatchObject({ synthetic: true, count: 4, revision: 1 });
  const initialReceipts = await readJson(page, '/api/admin/shaping/receipts?pageSize=100');
  const database = credentiallessDatabase();
  const suffix = randomUUID().slice(0, 10);
  const baselineName = `Persistence baseline ${suffix}`;
  const candidateName = `Persistence candidate ${suffix}`;
  const candidateSettings = { ...initial.settings, epochMicroEnabled: true, schemaDistillEnabled: true, schemaAllowLossy: true };
  const forbiddenRequests = [];
  const observe = request => {
    const url = new URL(request.url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.origin !== base.origin || /^\/v1\//.test(url.pathname) || /^\/api\/pxpipe\/(health|start|stop|restart|install)$/.test(url.pathname))) forbiddenRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
  };
  page.on('request', observe);
  let promotion = null;
  let rollbackAttempted = false;
  let rollback = null;
  async function restoreThroughUi() {
    const workbench = await openWorkbench(page);
    const row = workbench.locator('.shaping-profile-row').filter({ hasText: `promote · ${promotion.createdAt}` });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Review rollback', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore previous Shaping settings', exact: true });
    const restore = dialog.getByRole('button', { name: 'Restore settings', exact: true });
    await expect(restore).toBeDisabled();
    await dialog.getByRole('checkbox', { name: 'I consent to the reviewed content changes for new requests.', exact: true }).check();
    rollbackAttempted = true;
    rollback = confirmed(await uiMutation(page, '/api/admin/shaping/rollback', () => restore.click()));
    await expect(dialog).not.toBeVisible();
    expect(rollback).toMatchObject({ action: 'rollback', outcome: 'applied', beforeHash: promotion.afterHash, afterHash: initial.currentHash });
    expect(rollback.afterSettings).toEqual(initial.settings);
  }
  try {
    const workbench = await openWorkbench(page);
    const editor = workbench.locator('.shaping-editor');
    const saveConsent = editor.getByRole('checkbox', { name: 'I have reviewed these settings and consent to the selected content-changing transformations in this saved profile.', exact: true });
    await editor.getByLabel('Profile name', { exact: true }).fill(baselineName);
    await saveConsent.check();
    const baseline = confirmed(await uiMutation(page, '/api/admin/shaping/profiles', () => editor.getByRole('button', { name: 'Save profile version', exact: true }).click()));
    expect(baseline.effectiveSettingsChanged).toBe(false);
    expect(baseline.version.settings).toEqual(initial.settings);
    expect((await readJson(page, '/api/admin/shaping')).currentHash).toBe(initial.currentHash);
    const baselineRow = workbench.locator('.shaping-library .shaping-profile-row').filter({ has: page.getByText(baselineName, { exact: true }) });
    await baselineRow.getByRole('button', { name: 'Baseline', exact: true }).click();

    await editor.getByRole('button', { name: 'Start from current settings', exact: true }).click();
    await editor.getByLabel('Profile name', { exact: true }).fill(candidateName);
    await editor.locator('summary').filter({ hasText: /^Review and edit all/ }).click();
    for (const [key, label] of Object.entries(FLAG_LABELS)) await editor.getByRole('checkbox', { name: label, exact: true }).setChecked(candidateSettings[key]);
    await saveConsent.check();
    const candidate = confirmed(await uiMutation(page, '/api/admin/shaping/profiles', () => editor.getByRole('button', { name: 'Save profile version', exact: true }).click()));
    expect(candidate.effectiveSettingsChanged).toBe(false);
    expect(candidate.version.settings).toEqual(candidateSettings);
    expect(candidate.version.profileId).not.toBe(baseline.version.profileId);
    expect((await readJson(page, '/api/admin/shaping')).currentHash).toBe(initial.currentHash);
    const saved = await readJson(page, `/api/admin/shaping/profiles/${candidate.version.id}`);
    expect(saved.settings).toEqual(candidateSettings);
    expect(saved.consent).toContain('epochMicroEnabled');
    if (database) {
      const stored = database.prepare('SELECT settings, contentHash FROM shapingProfileVersions WHERE id = ?').get(candidate.version.id);
      expect(JSON.parse(stored.settings)).toEqual(candidateSettings);
      expect(stored.contentHash).toBe(candidate.version.contentHash);
    }

    await workbench.locator('.shaping-library .shaping-profile-row').filter({ has: page.getByText(candidateName, { exact: true }) }).getByRole('button', { name: 'Candidate', exact: true }).click();
    await workbench.getByRole('combobox', { name: 'Synthetic fixture set', exact: true }).selectOption('context-integrity-v1');
    const experiment = confirmed(await uiMutation(page, '/api/admin/shaping/experiments', () => workbench.getByRole('button', { name: 'Run offline comparison', exact: true }).click()));
    expect(experiment.effectiveSettingsChanged).toBe(false);
    expect(experiment.result.candidate.results).toHaveLength(4);
    expect(experiment.result.candidate.coverage.providerCalls).toBe(0);
    expect(experiment.result.baseline.coverage.providerCalls).toBe(0);
    expect(experiment.result.candidate.unsupported).toContain('epochMicro');
    for (const result of experiment.result.candidate.results) {
      expect(result.stages.find(stage => stage.stage === 'epochMicro').status).toBe('unsupported');
      expect(result.stages.find(stage => stage.stage === 'schema').status).toBe('unchanged');
      expect(result.validity).toMatchObject({ toolTransactionsValid: true, currentPreserved: true, liveThinkingPreserved: true, errorEvidencePreserved: true });
    }
    const retainedExperiment = await readJson(page, `/api/admin/shaping/experiments/${experiment.id}`);
    expect(retainedExperiment.candidateVersionId).toBe(candidate.version.id);
    expect(retainedExperiment.result.candidate.unsupported).toContain('epochMicro');
    await expect(workbench.getByText(/^Unsupported candidate stages:/)).toContainText('epochMicro');
    await expect(workbench.getByRole('cell', { name: 'Passed fixture checks', exact: true })).toHaveCount(4);

    // Cancellation establishes that opening a review does not activate a draft.
    await workbench.getByRole('button', { name: 'Review promotion', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Promote this profile', exact: true });
    await expect(dialog.getByRole('button', { name: 'Promote profile', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await readJson(page, '/api/admin/shaping')).currentHash).toBe(initial.currentHash);
    expect((await readJson(page, '/api/admin/shaping/receipts?pageSize=100')).pagination.total).toBe(initialReceipts.pagination.total);

    await workbench.getByRole('button', { name: 'Review promotion', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Promote this profile', exact: true });
    await dialog.getByRole('checkbox', { name: 'I consent to the reviewed content changes for new requests.', exact: true }).check();
    await expect(dialog.getByRole('button', { name: 'Promote profile', exact: true })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /^I understand .* were not evaluated/ }).check();
    const promoted = await uiMutation(page, '/api/admin/shaping/promote', () => dialog.getByRole('button', { name: 'Promote profile', exact: true }).click());
    // Retain a returned receipt before assertions so finally can restore state
    // through its one known receipt if a subsequent verification fails.
    if (promoted.body.id && promoted.body.action === 'promote') promotion = promoted.body;
    confirmed(promoted);
    await expect(dialog).not.toBeVisible();
    expect(promotion).toMatchObject({ action: 'promote', outcome: 'applied', beforeHash: initial.currentHash });
    expect(promotion.beforeSettings).toEqual(initial.settings);
    expect(promotion.afterSettings).toEqual(candidateSettings);
    const promotedCurrent = await readJson(page, '/api/admin/shaping');
    expect(promotedCurrent.settings).toEqual(candidateSettings);
    expect(promotedCurrent.currentHash).toBe(promotion.afterHash);
    const global = await readJson(page, '/api/settings');
    for (const key of Object.keys(FLAG_LABELS)) expect(global[key]).toBe(candidateSettings[key]);
    const receipts = await readJson(page, '/api/admin/shaping/receipts?pageSize=100');
    const receipt = receipts.rows.find(row => row.id === promotion.id);
    expect(receipt).toMatchObject({ action: 'promote', versionId: candidate.version.id, experimentId: experiment.id });
    expect(receipt.consent.unsupported).toContain('epochMicro');
    expect(receipt.consent.contentChanging).toContain('epochMicroEnabled');
    if (database) {
      const stored = database.prepare('SELECT afterSettings FROM shapingReceipts WHERE id = ?').get(promotion.id);
      expect(JSON.parse(stored.afterSettings)).toEqual(candidateSettings);
    }
    await restoreThroughUi();
    const restored = await readJson(page, '/api/admin/shaping');
    expect(restored.settings).toEqual(initial.settings);
    expect(restored.currentHash).toBe(initial.currentHash);
    const restoredGlobal = await readJson(page, '/api/settings');
    for (const key of Object.keys(FLAG_LABELS)) expect(restoredGlobal[key] ?? false).toBe(initial.settings[key]);
    const rollbackReceipt = (await readJson(page, '/api/admin/shaping/receipts?pageSize=100')).rows.find(row => row.id === rollback.id);
    expect(rollbackReceipt).toMatchObject({ action: 'rollback', afterHash: initial.currentHash });
    if (database) {
      const stored = database.prepare('SELECT data FROM settings WHERE id = 1').get();
      const actual = JSON.parse(stored.data);
      for (const key of Object.keys(FLAG_LABELS)) expect(actual[key]).toBe(initial.settings[key]);
      expect(database.prepare('SELECT id, provider FROM providerConnections ORDER BY id').all()).toEqual(fixtureAccounts);
    }
    expect(fixtureAccountIdentities()).toEqual(fixtureAccounts);
    expect((await readJson(page, '/api/providers')).connections.map(({ id, provider }) => ({ id, provider })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(fixtureAccounts);
    expect(forbiddenRequests).toEqual([]);
    await testInfo.attach('shaping-persistence-receipts', { body: JSON.stringify({ fixtureSetId: 'context-integrity-v1', cases: 4, baselineVersionId: baseline.version.id, candidateVersionId: candidate.version.id, experimentId: experiment.id, promotionReceiptId: promotion.id, rollbackReceiptId: rollback.id, restoredHash: initial.currentHash, sqliteVerified: Boolean(database), providerCalls: 0 }, null, 2), contentType: 'application/json' });
  } finally {
    try {
      if (promotion && !rollbackAttempted) await restoreThroughUi();
      if (promotion) expect((await readJson(page, '/api/admin/shaping')).currentHash, 'Restoration is unconfirmed; inspect the known receipt before retrying any mutation').toBe(initial.currentHash);
    } finally { page.off('request', observe); database?.close(); }
  }
});
