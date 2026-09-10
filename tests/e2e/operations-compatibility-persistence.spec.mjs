import { test, expect } from 'playwright/test';
import { signIn } from './helpers.mjs';
import { OPERATIONS_FIXTURE } from '../fixtures/operations-workspace-v1.mjs';

const rulesPath = '/api/admin/notification-rules';
const compatibilityPath = '/api/admin/compatibility';
const assertSynthetic = (response) =>
  expect(
    response.headers()['x-tokenproxy-preview-kind'],
    'Refusing mutations outside the disposable fixture preview'
  ).toBe('synthetic-fixture');
async function read(page, path) {
  const response = await page.request.get(path, { maxRedirects: 0 });
  assertSynthetic(response);
  expect(response.status()).toBe(200);
  return response.json();
}
async function preflight(page) {
  expect(process.env.E2E_BASE).toBeTruthy();
  expect(process.env.SMOKE_PASSWORD).toBeTruthy();
  const base = new URL(process.env.E2E_BASE);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(base.hostname);
  expect(base.username || base.password).toBe('');
  assertSynthetic(await page.request.get('/api/admin/health', { maxRedirects: 0 }));
  await signIn(page);
}
const responseTo = (page, path, method) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === method
  );

test('rules persist scope, absorb a competing write, replay history and retain alert dispositions', async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  await preflight(page);
  const initial = await read(page, rulesPath);
  const syntheticAlert = initial.events.find((event) => event.id === OPERATIONS_FIXTURE.alertId);
  expect(
    syntheticAlert?.outcome,
    'Seed a fresh operations-workspace-v1 alert before running this stateful scenario'
  ).toBe('firing');
  const name = `Synthetic persistence ${Date.now()}`;
  const receipts = {};
  // The per-field controls this scenario drives (threshold, duration, cooldown)
  // are the Advanced half of the board, so the level is set before the first load.
  await page.addInitScript(() =>
    localStorage.setItem('tokenproxy.navigation-mode', JSON.stringify('advanced'))
  );
  const response = await page.goto('/dashboard/notifications');
  assertSynthetic(response);
  // Rules are the board: the add row is inline, an edit commits from the field
  // itself, and a rule's evidence opens under its own row.
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  const editor = page.getByRole('form', { name: 'Add a rule' });
  await editor.getByRole('textbox', { name: 'Rule name', exact: true }).fill(name);
  await editor.getByLabel('Enabled', { exact: true }).uncheck();
  const create = responseTo(page, rulesPath, 'POST');
  await editor.getByRole('button', { name: 'Create rule', exact: true }).click();
  const createdResponse = await create;
  assertSynthetic(createdResponse);
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json();
  receipts.created = created;
  await expect(page.getByText('Rule revision 1 saved and read back.')).toBeVisible();
  expect((await read(page, `${rulesPath}/${created.id}`)).rule).toMatchObject({
    name,
    enabled: false,
    scopeKind: 'global',
    threshold: 10,
    durationSeconds: 900,
    cooldownSeconds: 3600,
    revision: 1,
  });
  const row = page.locator(`article[data-rule-id="${created.id}"]`);
  await expect(row).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // A competing operator write is absorbed rather than refused: the field save
  // reads the stored rule first and writes with THAT revision as its baseline,
  // so the concurrent threshold survives and the revision advances past it.
  const concurrent = await page.request.put(`${rulesPath}/${created.id}`, {
    data: { ...created, threshold: 8, revision: 1 },
  });
  assertSynthetic(concurrent);
  expect(concurrent.status()).toBe(200);
  const absorbed = responseTo(page, `${rulesPath}/${created.id}`, 'PUT');
  const cooldown = row.getByLabel(`Cooldown in seconds for ${name}`, { exact: true });
  await cooldown.fill('7200');
  await cooldown.press('Enter');
  expect((await absorbed).status()).toBe(200);
  await expect(page.getByText('Cooldown saved at revision 3.')).toBeVisible();
  receipts.rule = await read(page, `${rulesPath}/${created.id}`);
  expect(receipts.rule.rule).toMatchObject({ revision: 3, threshold: 8, cooldownSeconds: 7200, enabled: false });
  expect(receipts.rule.versions.map((version) => version.revision)).toEqual([3, 2, 1]);
  const dryRun = responseTo(page, `${rulesPath}/dry-run`, 'POST');
  // Creating a rule leaves its evidence open, so only open it if it is closed.
  const expand = row.getByRole('button', { name: `Expand ${name}`, exact: true });
  if (await expand.count()) await expand.click();
  await expect(row.getByRole('button', { name: `Collapse ${name}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run against history' }).click();
  const dryResponse = await dryRun;
  expect(dryResponse.status()).toBe(200);
  receipts.dryRun = await dryResponse.json();
  expect(receipts.dryRun).toHaveProperty('timeRange');
  expect((await read(page, `${rulesPath}/${created.id}`)).versions).toHaveLength(3);
  await row.getByRole('button', { name: `Collapse ${name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run against history' })).toHaveCount(0);
  const alertRow = page.locator('article').filter({ hasText: syntheticAlert.scopeKey }).last();
  await alertRow
    .getByRole('button', {
      name: `Snooze alert on ${syntheticAlert.scopeKey} for 24 hours`,
      exact: true,
    })
    .click();
  await expect(alertRow.getByText(/Snooze retained until/)).toBeVisible();
  receipts.snoozed = (await read(page, rulesPath)).events.find(
    (event) => event.id === syntheticAlert.id
  );
  expect(receipts.snoozed.outcome).toBe('firing');
  expect(Date.parse(receipts.snoozed.snoozedUntil)).toBeGreaterThan(Date.now());
  await alertRow
    .getByRole('button', { name: `Acknowledge alert on ${syntheticAlert.scopeKey}`, exact: true })
    .click();
  await expect(alertRow.getByText('Acknowledged', { exact: true })).toBeVisible();
  receipts.acknowledged = (await read(page, rulesPath)).events.find(
    (event) => event.id === syntheticAlert.id
  );
  expect(receipts.acknowledged.acknowledgedAt).toBeTruthy();
  expect(receipts.acknowledged.ruleRevision).toBe(1);
  await page.reload();
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  expect(
    (await read(page, rulesPath)).events.find((event) => event.id === syntheticAlert.id).outcome
  ).toBe('acknowledged');
  await testInfo.attach('operations-persistence-receipt.json', {
    contentType: 'application/json',
    body: JSON.stringify({ fixture: OPERATIONS_FIXTURE.version, ...receipts }, null, 2),
  });
});

test('compatible fixtures retain exact revisions, local results and terminal cancellation readback', async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  await preflight(page);
  const response = await page.goto('/dashboard/compatibility');
  assertSynthetic(response);
  // The editor is an inline add row on the board, opened from the toolbar.
  await page.getByRole('button', { name: 'New fixture', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Fixture editor', exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: /Insert .*tool/i })
    .first()
    .click();
  const name = `Synthetic compatibility ${Date.now()}`;
  await page.getByLabel('Fixture name', { exact: true }).fill(name);
  await page.getByRole('checkbox').check();
  const saved = responseTo(page, `${compatibilityPath}/fixtures`, 'POST');
  await page.getByRole('button', { name: 'Save fixture', exact: true }).click();
  const saveResponse = await saved;
  assertSynthetic(saveResponse);
  expect(saveResponse.status()).toBe(200);
  const fixture = await saveResponse.json();
  await expect(
    page.getByText('Revision 1 retained and read back. No run was started.')
  ).toBeVisible();
  expect((await read(page, `${compatibilityPath}/fixtures/${fixture.id}`)).contentHash).toBe(
    fixture.contentHash
  );
  const fixtureRow = page
    .getByRole('region', { name: 'Fixture book', exact: true })
    .locator('article')
    .filter({ has: page.getByText(name, { exact: true }) });
  const submitted = responseTo(page, `${compatibilityPath}/runs`, 'POST');
  await fixtureRow.getByRole('button', { name: 'Run revision 1', exact: true }).click();
  const runResponse = await submitted;
  assertSynthetic(runResponse);
  expect(runResponse.status()).toBe(200);
  const run = await runResponse.json();
  await expect
    .poll(async () => (await read(page, `${compatibilityPath}/runs/${run.id}`)).run.status, {
      timeout: 10000,
    })
    .toBe('succeeded');
  const returnToComparison = page.getByRole('button', { name: 'Return to comparison', exact: true });
  if (await returnToComparison.isVisible()) await returnToComparison.click();
  await page.getByRole('button', { name: 'Refresh retained evidence' }).click();
  await page.getByRole('button', { name: `Inspect run ${run.id}`, exact: true }).click();
  await expect(page.getByText('Local checks passed', { exact: true })).toBeVisible();
  const packet = await read(page, `${compatibilityPath}/runs/${run.id}`);
  expect(packet.run).toMatchObject({
    fixtureId: fixture.id,
    fixtureRevision: 1,
    fixtureHash: fixture.contentHash,
    scope: 'local-translation',
  });
  expect(packet.run.result.coverage).toMatchObject({
    providerCalls: 0,
    credentialsRead: false,
    modelReadiness: 'unknown',
  });
  expect(packet.run.result.checks.every((check) => check.outcome === 'passed')).toBe(true);
  const cancel = await page.request.post(`${compatibilityPath}/runs/${run.id}/cancel`);
  assertSynthetic(cancel);
  expect(cancel.status()).toBe(200);
  expect((await read(page, `${compatibilityPath}/runs/${run.id}`)).run).toEqual(packet.run);
  await page.reload();
  await expect(fixtureRow.getByText(name, { exact: true })).toBeVisible();
  await testInfo.attach('compatibility-persistence-receipt.json', {
    contentType: 'application/json',
    body: JSON.stringify(
      {
        fixture,
        packet,
        cancellation:
          'A completed receipt is immutable. Active cancellation is covered deterministically by the worker and mounted control tests.',
      },
      null,
      2
    ),
  });
});
