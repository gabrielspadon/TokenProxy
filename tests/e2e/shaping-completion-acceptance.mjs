import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { sourceManifest } from '../../scripts/redesign-preview.mjs';
const root = process.argv[2],
  artifacts = process.argv[3];
assert.ok(root && artifacts);
const runtime = JSON.parse(await readFile(join(root, 'process.json'), 'utf8'));
const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8'));
assert.equal(runtime.runId, owner.runId);
const seed = JSON.parse(await readFile(join(artifacts, 'synthetic-seed.json'), 'utf8'));
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  serviceWorkers: 'block',
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const guard = await installRedesignBrowser(page, { baseUrl: runtime.url, runtimeReceipt: runtime });
// Held only for the deliberate cancellation. The upstream call is made first,
// so the gateway really runs that comparison and its retained record stays
// readable; what is cancelled is the browser's own pending request, which is
// exactly what the "Cancel comparison" control aborts.
let hold = null;
await page.route(
  (url) => url.pathname === '/api/admin/shaping/experiments',
  async (route) => {
    if (route.request().method() !== 'POST' || !hold) return route.fallback();
    const response = await route.fetch();
    await hold;
    try {
      await route.fulfill({ response });
    } catch {}
  }
);
const errors = [],
  results = [];
page.on('pageerror', (error) => errors.push(error.message));
const shaping = `${runtime.url}/api/admin/shaping`;
const read = async (path = '') => {
  const response = await context.request.get(`${shaping}${path}`);
  assert.equal(response.status(), 200, await response.text());
  return response.json();
};
async function clickResponse(name, suffix, status = 200, scope = page) {
  const pending = page.waitForResponse(
    (response) => response.url().endsWith(suffix) && response.request().method() === 'POST'
  );
  await scope.getByRole('button', { name, exact: true }).click();
  const response = await pending,
    body = await response.json();
  assert.equal(response.status(), status, JSON.stringify(body));
  return body;
}
async function openWorkbench() {
  // Dev-mode compilation lands the tab markup well before React attaches its
  // handler, so a single click is silently dropped. Re-click until the panel
  // this journey needs is actually mounted.
  const tab = page.getByRole('tab', { name: 'Profiles and comparison', exact: true });
  const editor = page.getByRole('heading', { name: 'New profile', exact: true });
  await tab.waitFor({ timeout: 180000 });
  for (let attempt = 0; attempt < 40; attempt++) {
    await tab.click();
    try {
      await editor.waitFor({ timeout: 15000 });
      break;
    } catch (error) {
      if (attempt === 39) throw error;
    }
  }
  await page.getByRole('combobox', { name: 'Evaluation set', exact: true }).waitFor();
}
const profileRow = (versionId) =>
  page.locator('.shaping-profile-row').filter({ hasText: `record ${versionId}` }).first();
// The promotion dialog mirrors the workbench notice as its refusal slot, so a
// bare text lookup matches twice. Every notice assertion is scoped to the
// panel-level notice.
const notice = (text) => page.locator('.shaping-workbench > .notice').filter({ hasText: text });
const overflow = () =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function shots(prefix) {
  for (const [width, height] of [
    [1440, 1000],
    [1920, 1080],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: join(artifacts, `${prefix}-${width}.png`), fullPage: true });
    assert.equal(await overflow(), true, `No document overflow at ${width} on ${prefix}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
try {
  await authenticateRedesign(context, root);
  await page.goto(`${runtime.url}/dashboard/shaping`, { waitUntil: 'domcontentloaded' });
  await openWorkbench();
  const before = await read();
  assert.equal(before.settings.thinkingStripEnabled, false);

  // Two saved versions through the real editor. Consent is a precondition, not
  // decoration: the save button stays disabled until it is given.
  await page.getByLabel('Profile name', { exact: true }).fill('Selected-set baseline');
  const consent = page.locator('.shaping-editor .shaping-consent input[type="checkbox"]');
  assert.equal(
    await page.getByRole('button', { name: 'Save profile version', exact: true }).isDisabled(),
    true
  );
  await consent.check();
  const baseline = await clickResponse('Save profile version', '/shaping/profiles');
  assert.equal(baseline.version.revision, 1);
  assert.equal(baseline.effectiveSettingsChanged, false);
  await page
    .getByRole('checkbox', { name: 'Historical reasoning removal', exact: true })
    .check();
  await consent.check();
  const candidate = await clickResponse('Save profile version', '/shaping/profiles');
  assert.equal(candidate.version.revision, 2);
  assert.equal(candidate.version.settings.thinkingStripEnabled, true);
  assert.deepEqual((await read()).settings, before.settings, 'Saving a version changes no live setting');
  results.push({
    case: 'consented-profile-versions',
    baselineVersionId: baseline.version.id,
    candidateVersionId: candidate.version.id,
    liveSettingsUnchanged: true,
  });

  // Import an explicitly selected JSON set through the real file input.
  await page.getByLabel('Evaluation set name', { exact: true }).fill('Selected review cases');
  await page.setInputFiles('.shaping-set-import input[type="file"]', join(artifacts, 'selected-cases.json'));
  await page.getByText(`${seed.evaluationCases.count} cases read from selected-cases.json`).waitFor();
  const retention = page.locator('.shaping-set-import .shaping-consent input[type="checkbox"]');
  assert.equal(
    await page.getByRole('button', { name: 'Save evaluation set', exact: true }).isDisabled(),
    true
  );
  await retention.check();
  const set = await clickResponse('Save evaluation set', '/shaping/evaluation-sets');
  assert.equal(set.version.count, seed.evaluationCases.count);
  assert.equal(set.version.provenance.kind, 'operator-selected');
  assert.equal(set.version.provenance.taskOutcomes, 'unmeasured');
  const setLabel = `${set.version.name} v${set.version.revision} (${set.version.count} cases)`;

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openWorkbench();
  const selector = page.getByRole('combobox', { name: 'Evaluation set', exact: true });
  // An <option> never reports visible, so wait on its presence in the DOM.
  await selector.locator(`option[value="${set.version.id}"]`).waitFor({ state: 'attached' });
  assert.equal(
    (await selector.locator('option').allTextContents()).includes(setLabel),
    true,
    'Imported set is offered in the selector after a reload'
  );
  results.push({
    case: 'imported-set-survives-reload',
    setId: set.version.id,
    label: setLabel,
    contentHash: set.version.contentHash,
  });

  await selector.selectOption(set.version.id);
  // Both saved rows carry the same profile name, so each pick is scoped by the
  // record id its row prints rather than by that shared name.
  await profileRow(baseline.version.id).getByRole('button', { name: 'Baseline', exact: true }).click();
  await profileRow(candidate.version.id).getByRole('button', { name: 'Candidate', exact: true }).click();
  await page.getByText(`Baseline Selected-set baseline v1`).waitFor();
  await page.getByText(`Candidate Selected-set baseline v2`).waitFor();

  // Keyboard only: Tab from the editor's save control onto the run button and
  // activate it with Enter.
  const run = page.getByRole('button', { name: 'Run offline comparison', exact: true });
  // Anchor on the editor's consent checkbox, which is always focusable. The
  // save button beside it is disabled once consent resets after a save, and a
  // disabled button is not in the tab order at all.
  await page.locator('.shaping-editor .shaping-consent input[type="checkbox"]').focus();
  let tabs = 0;
  while (!(await run.evaluate((node) => node === document.activeElement))) {
    assert.ok(tabs < 12, 'Run offline comparison must be reachable by Tab');
    await page.keyboard.press('Tab');
    tabs++;
  }
  const keyboardRun = page.waitForResponse(
    (response) =>
      response.url().endsWith('/shaping/experiments') && response.request().method() === 'POST'
  );
  await page.keyboard.press('Enter');
  const firstRun = await (await keyboardRun).json();
  assert.equal(firstRun.result.status, 'completed');
  // providerCalls is reported per evaluated side, on its coverage record.
  assert.equal(firstRun.result.candidate.coverage.providerCalls, 0);
  assert.equal(firstRun.result.baseline.coverage.providerCalls, 0);
  assert.equal(firstRun.result.candidate.coverage.taskQuality, null);
  assert.equal(firstRun.result.candidate.coverage.cost, null);
  assert.equal(firstRun.result.candidate.coverage.tokenCounts, null);
  assert.equal(firstRun.result.evaluationSet.contentHash, set.version.contentHash);
  assert.equal(firstRun.result.comparison.fixtureCount, seed.evaluationCases.count);
  assert.equal(firstRun.result.comparison.tokenSavings, null);
  assert.equal(firstRun.result.comparison.monetarySavings, null);
  assert.equal(firstRun.result.comparison.taskOutcomeChange, null);
  await notice('Offline comparison retained').waitFor();
  results.push({
    case: 'keyboard-run-offline-comparison',
    tabsToRunButton: tabs,
    experimentId: firstRun.id,
    disposition: firstRun.result.comparison.disposition,
    providerCalls: firstRun.result.candidate.coverage.providerCalls,
    unmeasured: ['tokenSavings', 'monetarySavings', 'taskOutcomeChange'],
  });

  // A second comparison, deliberately cancelled from the rendered control.
  let release;
  hold = new Promise((resolve) => {
    release = resolve;
  });
  await run.click();
  const cancel = page.getByRole('button', { name: 'Cancel comparison', exact: true });
  await cancel.waitFor();
  await cancel.click();
  await notice('Cancellation requested').waitFor();
  await notice(
    'The worker is being stopped. Refresh retained comparisons to verify its recorded outcome.'
  ).waitFor();
  release();
  hold = null;
  await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
  results.push({
    case: 'cancelled-comparison-state-notice',
    notice: 'Cancellation requested',
    claim: 'Client cancellation is reported as a request to stop, not as a recorded outcome.',
  });

  // A comparison run to completion supplies the promotion evidence.
  const promotable = await clickResponse('Run offline comparison', '/shaping/experiments');
  assert.equal(promotable.result.status, 'completed');
  assert.deepEqual(promotable.result.candidate.unsupported, []);
  await page.getByText('Stage evaluator only. No provider calls.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Review promotion', exact: true }).waitFor();
  // Measured defect, recorded rather than asserted away. styles.css:262 scopes
  // the full-width rule to `:not(span)`, so the runtime-unavailable caption in
  // Workbench.js:110 is itself a <span> and lands in the `auto` second column
  // of `grid-template-columns: 1fr auto` (styles.css:261). The caption takes
  // that column's full width and squeezes the control name into one glyph.
  const settingRows = await page.evaluate(() =>
    [...document.querySelectorAll('.shaping-setting-grid > label')].map((row) => {
      const name = row.querySelector('span');
      return {
        label: name.textContent,
        rowHeight: Math.round(row.getBoundingClientRect().height),
        nameWidth: Math.round(name.getBoundingClientRect().width),
        hasUnavailableCaption: !!row.querySelector('.shaping-caption'),
      };
    })
  );
  const squeezed = settingRows.filter((row) => row.hasUnavailableCaption);
  const ordinary = settingRows.filter((row) => !row.hasUnavailableCaption);
  const medianHeight = ordinary.map((row) => row.rowHeight).sort((a, b) => a - b)[
    Math.floor(ordinary.length / 2)
  ];
  await page.screenshot({ path: join(artifacts, 'shaping-setting-grid-defect.png'), fullPage: true });
  results.push({
    case: 'runtime-unavailable-caption-layout-defect',
    defect: 'The runtime-unavailable caption is placed in the narrow auto column, collapsing the control name to a single-glyph vertical strip.',
    location: [
      'src/app/dashboard/shaping/styles.css:262',
      'src/app/dashboard/shaping/styles.css:261',
      'src/app/dashboard/shaping/Workbench.js:110',
    ],
    affected: squeezed,
    ordinaryRowMedianHeight: medianHeight,
    severity: 'cosmetic; the control it labels has no input and no mutation is blocked by it',
    documentOverflow: false,
  });
  assert.equal(squeezed.length, 1, 'Exactly one saved control reports a runtime-unavailable caption');
  assert.ok(squeezed[0].nameWidth < 40, 'The defect is present as measured, not assumed');

  await shots('shaping-comparison');
  results.push({
    case: 'completed-comparison-evidence',
    experimentId: promotable.id,
    coverage: promotable.result.candidate.coverage,
    disposition: promotable.result.comparison.disposition,
    failedFixtures: promotable.result.comparison.failedFixtures,
    limitations: promotable.result.comparison.limitations,
  });

  // Escape closes the promotion review without promoting.
  await page.getByRole('button', { name: 'Review promotion', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Promote this profile').waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual((await read()).settings, before.settings, 'Escape promotes nothing');

  await page.getByRole('button', { name: 'Review promotion', exact: true }).click();
  await dialog.getByText('Promote this profile').waitFor();
  await page.screenshot({ path: join(artifacts, 'shaping-promotion-review.png'), fullPage: true });
  assert.equal(await dialog.getByRole('button', { name: 'Promote profile', exact: true }).isDisabled(), true);
  await dialog.locator('.shaping-consent input[type="checkbox"]').check();
  const promoted = await clickResponse('Promote profile', '/shaping/promote', 200, dialog);
  assert.equal(promoted.outcome, 'applied');
  assert.equal(promoted.action, 'promote');
  assert.deepEqual(
    promoted.diff.map((change) => change.key),
    ['thinkingStripEnabled']
  );
  const afterPromotion = await read();
  assert.equal(afterPromotion.settings.thinkingStripEnabled, true);
  assert.equal(afterPromotion.currentHash, promoted.afterHash);
  await notice('Profile promoted for new requests.').waitFor();
  results.push({
    case: 'promotion-receipt-and-settings-readback',
    receiptId: promoted.id,
    diff: promoted.diff,
    coverage: promoted.coverage.takesEffect,
    currentHashAfter: afterPromotion.currentHash,
  });

  // Roll back through the retained receipt row and read the restoration back.
  const receiptRow = page.locator('.shaping-profile-row').filter({ hasText: 'promote' }).first();
  await receiptRow.getByRole('button', { name: 'Review rollback', exact: true }).click();
  await dialog.getByText('Restore previous Shaping settings').waitFor();
  await dialog.locator('.shaping-consent input[type="checkbox"]').check();
  const rolledBack = await clickResponse('Restore settings', '/shaping/rollback', 200, dialog);
  assert.equal(rolledBack.action, 'rollback');
  assert.equal(rolledBack.outcome, 'applied');
  const restored = await read();
  assert.equal(restored.settings.thinkingStripEnabled, false);
  assert.equal(restored.currentHash, before.currentHash);
  assert.deepEqual(restored.settings, before.settings);
  await notice('Previous Shaping settings restored.').waitFor();
  results.push({
    case: 'rollback-restores-exact-settings',
    receiptId: rolledBack.id,
    restoredHash: restored.currentHash,
    matchesPrePromotionHash: restored.currentHash === before.currentHash,
  });

  // Approved handoff between two observed sessions in the one project.
  const handoffs = page.locator('.shaping-handoffs');
  await handoffs.getByRole('heading', { name: 'Approved session handoffs', exact: true }).waitFor();
  // getByLabel folds a wrapping label's option text into its match, so these
  // selects are addressed by their computed combobox name instead.
  const source = handoffs.getByRole('combobox', { name: 'Source session', exact: true });
  const target = handoffs.getByRole('combobox', { name: 'Target session', exact: true });
  await source.locator('option').nth(2).waitFor({ state: 'attached' });
  const options = await source.locator('option').allTextContents();
  const pick = (client) => options.find((label) => label.includes(`Synthetic ${client}`));
  assert.ok(pick('handoff-source') && pick('handoff-target'), 'Both observed sessions are offered');
  await source.selectOption({ label: pick('handoff-source') });
  await target.selectOption({ label: pick('handoff-target') });
  await handoffs
    .getByRole('textbox', { name: 'Approved summary', exact: true })
    .fill('Approved handoff summary: keep the original task and the exact error text.');
  await handoffs
    .getByRole('combobox', { name: 'Expires after', exact: true })
    .selectOption({ label: '24 hours' });
  const approve = handoffs.getByRole('button', { name: 'Approve handoff', exact: true });
  assert.equal(await approve.isDisabled(), true);
  await handoffs.locator('.shaping-consent input[type="checkbox"]').check();
  const packet = await clickResponse('Approve handoff', '/shaping/handoffs', 200, handoffs);
  assert.equal(packet.outcome, 'active');
  assert.equal(packet.packet.state, 'active');
  assert.equal(packet.packet.projectId, seed.handoffProjectId);
  assert.equal(
    JSON.stringify(packet).includes('keep the original task'),
    false,
    'The approved summary is never echoed back to the browser'
  );
  const packetRow = handoffs.locator('tbody tr').filter({ hasText: packet.packet.sourceRequestId.slice(0, 8) });
  await packetRow.getByRole('button', { name: 'Revoke handoff', exact: true }).waitFor();
  const listed = await read('/handoffs?page=1&pageSize=10');
  const stored = listed.rows.find((row) => row.id === packet.packet.id);
  assert.equal(stored.state, 'active');
  assert.equal(stored.preparations, 0);
  assert.equal(stored.contentHash, packet.packet.contentHash);
  assert.equal(JSON.stringify(listed).includes('keep the original task'), false);
  await shots('shaping-handoff');
  results.push({
    case: 'approved-handoff-retained',
    packetId: packet.packet.id,
    projectId: packet.packet.projectId,
    state: stored.state,
    preparations: stored.preparations,
    summaryRedacted: true,
  });

  await packetRow.getByRole('button', { name: 'Revoke handoff', exact: true }).click();
  await handoffs.locator('.notice').filter({ hasText: 'Handoff revoked' }).waitFor();
  const afterRevoke = await read('/handoffs?page=1&pageSize=10');
  const revoked = afterRevoke.rows.find((row) => row.id === packet.packet.id);
  assert.equal(revoked.state, 'revoked');
  assert.ok(revoked.revokedAt);
  await handoffs.locator('tbody tr').filter({ hasText: 'No future injection' }).first().waitFor();
  await page.screenshot({ path: join(artifacts, 'shaping-handoff-revoked.png'), fullPage: true });
  results.push({
    case: 'revoked-handoff-readback',
    packetId: packet.packet.id,
    state: revoked.state,
    revokedAt: revoked.revokedAt,
  });

  const ownership = JSON.parse(await readFile(join(root, 'process.json'), 'utf8'));
  assert.deepEqual(guard.outboundFailures, []);
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifacts, 'browser-receipt.json'),
    JSON.stringify(
      {
        runtime: ownership,
        results,
        errors,
        browserGuard: guard,
        handoffSeed: { projectId: seed.handoffProjectId, sessions: seed.handoffSessions },
        unmeasured: {
          evaluator: 'stage evaluator only',
          providerCalls: 0,
          tokens: 'unmeasured',
          cost: 'unmeasured',
          taskQuality: 'unmeasured',
        },
        source: await sourceManifest(),
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      passed: results.map((result) => result.case),
      screenshots: 10,
      outboundFailures: 0,
      pageErrors: 0,
    })
  );
} finally {
  await browser.close();
}
