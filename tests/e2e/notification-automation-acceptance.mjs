import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { sourceManifest } from '../../scripts/redesign-preview.mjs';
import { enqueueAuthorizedAction } from '../../src/lib/notifications/remediation.mjs';

const root = process.argv[2],
  artifacts = process.argv[3],
  account = process.argv[4],
  failureRefs = (process.argv[5] || '').split(',').filter(Boolean);
assert.ok(root && artifacts && account && failureRefs.length);
const runtime = JSON.parse(await readFile(join(root, 'process.json'), 'utf8'));
const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8'));
assert.equal(runtime.runId, owner.runId);
await mkdir(artifacts, { recursive: true });

const dbFile = join(root, 'runtime/db/data.sqlite');
// The preview server holds the same file in WAL mode, so a second connection
// from this process is a concurrent writer, not a second owner. Every use is a
// short BEGIN IMMEDIATE with a busy timeout, which is the pattern the existing
// notification browser evidence already uses against a running preview.
function withDb(fn, { readOnly = false } = {}) {
  const raw = new DatabaseSync(dbFile, readOnly ? { readOnly: true } : {});
  raw.exec('PRAGMA busy_timeout=5000');
  const db = {
    get: (sql, args = []) => raw.prepare(sql).get(...args),
    all: (sql, args = []) => raw.prepare(sql).all(...args),
    run: (sql, args = []) => raw.prepare(sql).run(...args),
    transaction: (body) => { raw.exec('BEGIN IMMEDIATE'); try { const value = body(); raw.exec('COMMIT'); return value; } catch (error) { raw.exec('ROLLBACK'); throw error; } },
  };
  try { return fn(db); } finally { raw.close(); }
}
const drainDocument = () => withDb((db) => db.get("SELECT value FROM kv WHERE scope='admin.drain' AND key=?", [account]), { readOnly: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  serviceWorkers: 'block',
  reducedMotion: 'reduce',
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const guard = await installRedesignBrowser(page, { baseUrl: runtime.url, runtimeReceipt: runtime });
const errors = [],
  results = [],
  screenshots = [];
page.on('pageerror', (error) => errors.push(error.message));
const ENDPOINT = `${runtime.url}/api/admin/notification-actions`;
const shot = async (name) => {
  const path = join(artifacts, name);
  await page.screenshot({ path, fullPage: true });
  screenshots.push(name);
  return path;
};
const automation = () => page.getByRole('region', { name: 'Bounded account automation', exact: true });
async function policyState() {
  const response = await context.request.get(`${ENDPOINT}?ruleId=${encodeURIComponent(rule.id)}&limit=10`);
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
async function clickResponse(name, predicate, status = 200) {
  const pending = page.waitForResponse(
    (response) => predicate(new URL(response.url()), response.request()) && response.request().method() !== 'GET'
  );
  await page.getByRole('button', { name, exact: true }).click();
  const response = await pending,
    body = await response.json();
  assert.equal(response.status(), status, JSON.stringify(body));
  return body;
}
const isAction = (url, request) => url.pathname === '/api/admin/notification-actions' && request.method() === 'POST';
async function openRule(name) {
  const listed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/admin/notification-rules' && response.status() === 200
  );
  await page.goto(`${runtime.url}/dashboard/notifications`, { waitUntil: 'domcontentloaded' });
  await listed;
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await automation().waitFor();
}
let rule;
try {
  await authenticateRedesign(context, root);

  // 1. A rule scoped to exactly one account, on a condition that has a bounded
  //    account action, created through the real editor.
  const name = `Synthetic bounded remediation ${Date.now()}`;
  const listed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/admin/notification-rules' && response.status() === 200
  );
  await page.goto(`${runtime.url}/dashboard/notifications`, { waitUntil: 'domcontentloaded' });
  await listed;
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByRole('button', { name: 'New rule', exact: true }).click();
  await page.getByLabel(/^Name/).fill(name);
  await page.getByRole('combobox', { name: 'Condition', exact: true }).click();
  await page.getByRole('option', { name: 'Operation failures in window', exact: true }).click();
  await page.getByRole('combobox', { name: 'Scope', exact: true }).click();
  await page.getByRole('option', { name: 'One account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Account id', exact: true }).fill(account);
  await page.getByRole('textbox', { name: 'Threshold (failed operations)', exact: true }).fill('1');
  await page.getByRole('textbox', { name: 'Window (seconds)', exact: true }).fill('3600');
  await page.getByRole('textbox', { name: 'Cooldown (seconds)', exact: true }).fill('60');
  const created = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/admin/notification-rules' && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Create rule', exact: true }).click();
  const createdResponse = await created;
  assert.equal(createdResponse.status(), 201, await createdResponse.text());
  rule = await createdResponse.json();
  assert.equal(rule.scopeKind, 'connection');
  assert.equal(rule.scopeId, account);
  assert.equal(rule.enabled, true);
  await automation().waitFor();
  results.push({ case: 'one-account-rule-and-automation-section', ruleId: rule.id, revision: rule.revision, conditionKind: rule.conditionKind, scopeId: rule.scopeId });

  // 2. Explicit enablement, saved and read back by the surface itself.
  const drainSwitch = automation().getByRole('switch', { name: 'Allow automatic drain', exact: true });
  assert.equal(await drainSwitch.isChecked(), false, 'The policy must default disabled');
  await drainSwitch.check();
  const saved = await clickResponse('Save action policy', isAction);
  assert.equal(saved.policy.revision, 1);
  assert.equal(saved.policy.enabled, true);
  assert.equal(saved.policy.connectionId, account);
  assert.equal(saved.persistence, 'confirmed');
  await page.getByRole('status').filter({ hasText: 'Revision 1 saved and read back.' }).first().waitFor();
  await shot('bounded-remediation-policy-saved.png');
  results.push({ case: 'authorized-policy-save', policy: saved.policy });

  // 3. Reload and read the persisted authority back out of the fresh render.
  await openRule(name);
  const reloaded = automation().getByRole('switch', { name: 'Allow automatic drain', exact: true });
  await reloaded.waitFor();
  assert.equal(await reloaded.isChecked(), true, 'Enablement must survive a reload');
  const afterReload = await policyState();
  assert.equal(afterReload.policy.revision, 1);
  assert.equal(afterReload.policy.enabled, true);
  assert.equal(afterReload.items.length, 0, 'No action exists before an alert fires');
  results.push({ case: 'reload-readback', policy: afterReload.policy, actionsBefore: afterReload.items.length });

  // 4. Simulation over retained alert history. One historical alert is retained
  //    first so the simulation has a population to report on; it is
  //    acknowledged, which keeps the partial unique index on
  //    (ruleId, scopeKey) WHERE outcome='firing' free for the real firing in
  //    step 5, and it carries the same retained evidence refs.
  const historicalEventId = randomUUID();
  const historicalFiredAt = new Date(Date.now() - 90000).toISOString();
  withDb((db) =>
    db.run(
      `INSERT INTO notificationRuleEvents(id,ruleId,ruleRevision,scopeKey,firedAt,breachStartedAt,observedValue,evidence,outcome,acknowledgedAt)
       VALUES(?,?,?,?,?,?,?,?,'acknowledged',?)`,
      [historicalEventId, rule.id, rule.revision, account, historicalFiredAt, new Date(Date.now() - 150000).toISOString(),
        failureRefs.length, JSON.stringify({ kind: 'operationEvent', refs: failureRefs }), historicalFiredAt]
    )
  );
  const preview = await clickResponse('Simulate on alert history', isAction);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.changed, false);
  assert.equal(preview.history.length, 1);
  assert.equal(preview.history[0].eventId, historicalEventId);
  assert.equal(preview.history[0].evidenceRetained, true);
  assert.equal(preview.history[0].simulation.outcome, 'drain');
  assert.equal(preview.history[0].wouldApplyNow, false);
  assert.equal(preview.history[0].reasonCode, 'historical_authorization_not_replayed');
  await automation().getByRole('region', { name: 'Automation simulation', exact: true }).waitFor();
  await automation().getByText('1 simulated drains · 1 retained alerts', { exact: true }).waitFor();
  await automation().getByText('Simulation only. No historical alert is queued or executed.', { exact: true }).waitFor();
  const actionsAfterPreview = await policyState();
  assert.equal(actionsAfterPreview.items.length, 0, 'A simulation must not enqueue anything');
  await shot('bounded-remediation-simulation.png');
  results.push({ case: 'read-only-simulation', historicalEventId, historyLength: preview.history.length, simulated: preview.history[0].simulation, coverage: preview.coverage, assumptions: preview.assumptions.length });

  // 5. A fresh retained alert for this exact account and rule revision, fired
  //    after the authorization, whose evidence refs resolve to the retained
  //    failed operations seeded before start. Enqueue runs the shipped
  //    enqueueAuthorizedAction against the preview's own database.
  const eventId = randomUUID();
  const firedAt = new Date().toISOString();
  const event = {
    id: eventId, ruleId: rule.id, ruleRevision: rule.revision, scopeKey: account, firedAt,
    breachStartedAt: new Date(Date.now() - 200000).toISOString(), observedValue: failureRefs.length,
    evidence: JSON.stringify({ kind: 'operationEvent', refs: failureRefs }),
  };
  const enqueued = withDb((db) =>
    db.transaction(() => {
      db.run(
        `INSERT INTO notificationRuleEvents(id,ruleId,ruleRevision,scopeKey,firedAt,breachStartedAt,observedValue,evidence,outcome)
         VALUES(?,?,?,?,?,?,?,?,'firing')`,
        [event.id, event.ruleId, event.ruleRevision, event.scopeKey, event.firedAt, event.breachStartedAt, event.observedValue, event.evidence]
      );
      return enqueueAuthorizedAction(db, event);
    })
  );
  assert.equal(enqueued.state, 'queued', JSON.stringify(enqueued));
  assert.equal(enqueued.reasonCode, null);
  results.push({ case: 'fresh-alert-enqueued', eventId, actionId: enqueued.id, evidenceRefs: failureRefs });

  // 6. The queue is drained by src/lib/notifications/watcher.js:241 on a stats
  //    tick (MIN_INTERVAL_MS = 30000); no admin route calls
  //    drainAuthorizedActions, so the real path is the watcher tick and this
  //    waits for it rather than reaching past it.
  const deadline = Date.now() + 180000;
  let applied = null;
  for (;;) {
    const response = await context.request.get(`${ENDPOINT}?actionId=${encodeURIComponent(enqueued.id)}`);
    assert.equal(response.status(), 200, await response.text());
    const body = await response.json();
    if (body.action.state !== 'queued') { applied = body.action; break; }
    assert.ok(Date.now() < deadline, 'The watcher drain tick did not process the queued action within 180s');
    await new Promise((settle) => setTimeout(settle, 2000));
  }
  assert.equal(applied.state, 'applied', JSON.stringify(applied));
  assert.equal(applied.reasonCode, null);
  assert.equal(applied.connectionId, account);
  assert.equal(applied.afterState.isDraining, true);
  const persistedAction = withDb((db) => db.get('SELECT state,reasonCode,afterState,appliedAt FROM notificationActions WHERE id=?', [enqueued.id]), { readOnly: true });
  assert.equal(persistedAction.state, 'applied');
  assert.ok(persistedAction.appliedAt);
  const appliedDrain = drainDocument();
  assert.ok(appliedDrain, 'A drain document must exist for the account');
  assert.equal(JSON.parse(appliedDrain.value).isDraining, true);
  assert.ok(applied.receipts.some((receipt) => receipt.operation === 'apply' && receipt.outcome === 'applied'));
  results.push({ case: 'watcher-drain-applied', actionId: enqueued.id, drain: JSON.parse(appliedDrain.value), appliedAt: persistedAction.appliedAt, receipts: applied.receipts.map((receipt) => `${receipt.operation}:${receipt.outcome}`) });

  // 7. Rollback through the surface, verified against the resulting state.
  await page.getByRole('button', { name: 'Refresh actions', exact: true }).click();
  await page.getByRole('button', { name: 'Undo this drain', exact: true }).waitFor();
  await shot('bounded-remediation-applied.png');
  const rolledBack = await clickResponse('Undo this drain', isAction);
  assert.equal(rolledBack.state, 'rolled-back', JSON.stringify(rolledBack));
  assert.equal(rolledBack.changed, true);
  assert.equal(rolledBack.receipt.outcome, 'applied');
  await page.getByRole('status').filter({ hasText: 'Account restored.' }).first().waitFor();
  const restoredDrain = drainDocument();
  assert.equal(JSON.parse(restoredDrain.value).isDraining, false);
  const inspected = await (await context.request.get(`${ENDPOINT}?actionId=${encodeURIComponent(enqueued.id)}`)).json();
  assert.equal(inspected.action.state, 'rolled-back');
  const rollbackReceipt = inspected.action.receipts.find((receipt) => receipt.operation === 'rollback');
  assert.equal(rollbackReceipt.outcome, 'applied');
  assert.equal(rollbackReceipt.details.restored.isDraining, false);
  await shot('bounded-remediation-rolled-back.png');
  results.push({ case: 'rollback-restores-exact-state', actionId: enqueued.id, restored: JSON.parse(restoredDrain.value), rollbackReceipt });

  // 8. A stale authority save is refused rather than applied. The out-of-band
  //    save is a real authenticated request that moves the stored revision to
  //    2, leaving the open form holding 1.
  const outOfBand = await context.request.post(ENDPOINT, {
    data: { action: 'save-policy', policy: { ruleId: rule.id, ruleRevision: rule.revision, expectedRevision: 1, action: 'drain-account', enabled: true, cooldownSeconds: 3600, dailyLimit: 1, maxEvidenceAgeSeconds: 300 } },
  });
  assert.equal(outOfBand.status(), 200, await outOfBand.text());
  assert.equal((await outOfBand.json()).policy.revision, 2);
  const conflict = await clickResponse('Save action policy', isAction, 409);
  assert.equal(conflict.code, 'action_revision_conflict');
  await automation().getByRole('alert').filter({ hasText: 'action revision conflict' }).first().waitFor();
  await automation().getByRole('alert').filter({ hasText: 'No automatic retry was sent.' }).first().waitFor();
  await shot('bounded-remediation-conflict.png');
  results.push({ case: 'stale-authority-refused', code: conflict.code, storedRevision: 2 });

  // 9. Pagination. Eleven further retained actions for this rule, all skipped
  //    with appliedAt NULL so no limit or cooldown reading is perturbed.
  const seededActions = withDb((db) =>
    db.transaction(() => {
      const ids = [];
      for (let index = 0; index < 11; index++) {
        const id = randomUUID(), at = new Date(Date.now() - (11 - index) * 60000).toISOString();
        db.run(
          `INSERT INTO notificationActions(id,eventId,ruleId,policyRevision,connectionId,policy,beforeState,afterState,state,reasonCode,createdAt,appliedAt,updatedAt)
           VALUES(?,?,?,?,?,?,?,NULL,'skipped','evidence_stale',?,NULL,?)`,
          [id, randomUUID(), rule.id, 1, account, JSON.stringify({ synthetic: 'bounded-remediation-pagination' }), 'null', at, at]
        );
        ids.push(id);
      }
      return ids;
    })
  );
  assert.equal(seededActions.length, 11);
  await page.getByRole('button', { name: 'Refresh actions', exact: true }).click();
  await page.getByRole('button', { name: 'Older actions', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Older actions', exact: true }).click();
  await page.getByRole('button', { name: 'Latest actions', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Latest actions', exact: true }).click();
  const paged = await policyState();
  assert.equal(paged.items.length, 10);
  assert.ok(paged.next, 'A twelfth retained action must expose a cursor');
  results.push({ case: 'older-actions-pagination', retainedActions: 12, pageSize: paged.items.length, cursorPresent: Boolean(paged.next) });

  // 10. Widths. Desktop, wide desktop and narrow phone, with no horizontal
  //     document overflow at any of them.
  for (const [width, height] of [
    [1440, 1000],
    [1920, 1080],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('main,[data-scroll-area]').forEach((element) => element.scrollTo(0, 0)); });
    await automation().waitFor();
    await shot(`bounded-remediation-${width}.png`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `No document overflow at ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  results.push({ case: 'width-capture', widths: [1440, 1920, 390], horizontalOverflow: false });

  assert.deepEqual(guard.outboundFailures, []);
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifacts, 'browser-receipt.json'),
    JSON.stringify(
      {
        runtime,
        account,
        ruleId: rule.id,
        results,
        errors,
        screenshots,
        providerCalls: 0,
        drainTrigger: 'src/lib/notifications/watcher.js:241 stats tick calling drainAuthorizedActions; no admin route exposes the drain',
        browserGuard: guard,
        source: await sourceManifest(),
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      passed: results.map((result) => result.case),
      screenshots: screenshots.length,
      outboundFailures: 0,
      pageErrors: 0,
    })
  );
} catch (error) {
  await writeFile(join(artifacts, 'browser-failure.json'), JSON.stringify({ message: error.message, results, errors, body: await page.locator('body').innerText().catch(() => null) }, null, 2));
  await page.screenshot({ path: join(artifacts, 'bounded-remediation-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
