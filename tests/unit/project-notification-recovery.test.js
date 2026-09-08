import { beforeEach, expect, it, vi } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';
import { createProject } from '@/lib/db/repos/projectsRepo.js';
import { recordProjectBudgetAlert } from '@/lib/db/projectBudgetEvidence.js';
import { recoverProjectNotifications } from '@/lib/notifications/projectRecovery.mjs';
import { drainNotifications } from '@/lib/notifications/delivery.js';

const db = await getAdapter();
const at = '2026-09-08T12:00:00.000Z', now = Date.parse(at);
const endpoint = { id: 'original', url: 'https://example.com/original', secret: 'must-not-persist', active: true, events: ['project.budget.alert'] };
const config = { enabled: true, endpoints: [endpoint] };
let projectId;
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const table of ['notificationDeliveries','projectBudgetAlerts','projectPolicyVersions','projectBudgetAccounts','projects']) db.run(`DELETE FROM ${table}`);
  db.run('INSERT OR REPLACE INTO settings(id,data) VALUES(1,?)', [JSON.stringify({ notifications: config })]);
  const result = await createProject({ name: 'Recovery fixture', maxCostUsd: 10, alertPercent: 50, alertCooldownSeconds: 60 });
  projectId = result.project.id;
  db.run('UPDATE projectBudgetAccounts SET recordedCostUsd=6,historyThroughId=42 WHERE projectId=?', [projectId]);
});
function failFirstDeliveryInsert() {
  const run = db.run.bind(db);
  let pending = true;
  return vi.spyOn(db, 'run').mockImplementation((sql, params) => {
    if (pending && sql.includes('INSERT OR IGNORE INTO notificationDeliveries')) {
      pending = false;
      throw new Error('Synthetic materialization failure');
    }
    return run(sql, params);
  });
}

it('retains event-time destinations and accounting when delivery creation fails, then recovers exactly once', async () => {
  const failure = failFirstDeliveryInsert();
  let event;
  db.transaction(() => { event = recordProjectBudgetAlert(db, projectId, at); });
  failure.mockRestore();
  const retained = db.get('SELECT * FROM projectBudgetAlerts WHERE id=?', [event.id]);
  expect(retained).toMatchObject({ notificationQueuedAt: null, notificationAttempts: 1, notificationErrorCode: 'delivery-materialization-failed' });
  expect(retained.notificationTargets).not.toContain(endpoint.url);
  expect(retained.notificationTargets).not.toContain(endpoint.secret);
  expect(db.get('SELECT recordedCostUsd FROM projectBudgetAccounts WHERE projectId=?', [projectId]).recordedCostUsd).toBe(6);
  const later = { ...config, endpoints: [endpoint, { ...endpoint, id: 'later', url: 'https://example.com/later' }] };
  db.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ notifications: later })]);
  expect(recoverProjectNotifications(db, { now: now + 1999 })).toEqual({ examined: 0, recovered: 0 });
  const send = vi.fn(async () => ({ ok: true, attempts: 1, status: 204 }));
  await drainNotifications({ db, config: later, now: now + 2000, send });
  await drainNotifications({ db, config: later, now: now + 3000, send });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].id).toBe('original');
  expect(send.mock.calls[0][2]).toMatchObject({ alertId: event.id, evidence: { historyThroughId: 42 } });
  expect(db.get('SELECT state FROM notificationDeliveries').state).toBe('delivered');
});

it('never manufactures authorization for disabled or historically unknown destinations', () => {
  db.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ notifications: { ...config, enabled: false } })]);
  const event = recordProjectBudgetAlert(db, projectId, at);
  expect(db.get('SELECT notificationTargets FROM projectBudgetAlerts WHERE id=?', [event.id]).notificationTargets).toBe('[]');
  db.run(`INSERT INTO projectBudgetAlerts(id,projectId,policyRevision,firedAt,evidence)
    VALUES('historical',?,1,?,'{}')`, [projectId, at]);
  db.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ notifications: config })]);
  expect(recoverProjectNotifications(db, { now: now + 300_000 })).toEqual({ examined: 0, recovered: 0 });
  expect(db.all('SELECT * FROM notificationDeliveries')).toEqual([]);
});

it('retains unavailable authorization explicitly instead of retrying against later configuration', () => {
  db.run("UPDATE settings SET data='invalid-json' WHERE id=1");
  const event = recordProjectBudgetAlert(db, projectId, at);
  expect(db.get('SELECT notificationTargets,notificationRetryAt,notificationErrorCode FROM projectBudgetAlerts WHERE id=?', [event.id]))
    .toEqual({ notificationTargets: null, notificationRetryAt: null, notificationErrorCode: 'event-time-authorization-unavailable' });
  db.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ notifications: config })]);
  expect(recoverProjectNotifications(db, { now: now + 300_000 }).examined).toBe(0);
});

it('cancels a recovered delivery when its original destination changed', async () => {
  const failure = failFirstDeliveryInsert();
  recordProjectBudgetAlert(db, projectId, at);
  failure.mockRestore();
  const send = vi.fn();
  await drainNotifications({ db, now: now + 2000, config: { ...config, endpoints: [{ ...endpoint, url: 'https://example.com/replacement' }] }, send });
  expect(send).not.toHaveBeenCalled();
  expect(db.get('SELECT state FROM notificationDeliveries').state).toBe('cancelled');
});

it('bounds a recovery batch and backs off invalid retained intent without starving other rows', () => {
  db.transaction(() => {
    for (let index = 0; index < 25; index++) db.run(`INSERT INTO projectBudgetAlerts
      (id,projectId,policyRevision,firedAt,evidence,notificationTargets,notificationRetryAt) VALUES(?,?,1,?,'{}',?,?)`,
    [String(index).padStart(2, '0'), projectId, at, index === 0 ? 'invalid-json' : '[]', at]);
  });
  expect(recoverProjectNotifications(db, { now, limit: 200 })).toEqual({ examined: 20, recovered: 19 });
  expect(recoverProjectNotifications(db, { now })).toEqual({ examined: 5, recovered: 5 });
  expect(db.get("SELECT notificationErrorCode FROM projectBudgetAlerts WHERE id='00'").notificationErrorCode).toBe('delivery-materialization-failed');
});
