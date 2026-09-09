import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enqueueNotificationEvent, claimDeliveries, finishDelivery, readDeliveryHistory } from '@/lib/notifications/outbox.mjs';

let db, repo, drainNotifications, tempDir;
const original = process.env.DATA_DIR;
const now = Date.now();
const rule = { name:'Quota low', conditionKind:'quota_risk', scopeKind:'global', threshold:10, durationSeconds:60, cooldownSeconds:60 };
const endpoint = { id:'endpoint-1', url:'https://example.com/private-target',secret:'private-signing-key',active:true,events:['rule.fired','project.budget.alert'] };
const config = { enabled:true,endpoints:[endpoint] };
beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(),'tokenproxy-delivery-'));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await (await import('@/lib/db/driver.js')).getAdapter();
  repo = await import('@/lib/db/repos/notificationRulesRepo.js');
  ({ drainNotifications } = await import('@/lib/notifications/delivery.js'));
  db.run('INSERT OR REPLACE INTO settings(id,data) VALUES(1,?)',[JSON.stringify({notifications:config})]);
});
afterEach(() => {
  global._dbAdapter?.instance?.close?.(); delete global._dbAdapter;
  fs.rmSync(tempDir,{recursive:true,force:true});
  if (original === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = original;
});

it('atomically queues one delivery per retained alert and survives an adapter reopen',async () => {
  const saved = await repo.createRule(rule);
  const firing = { firedAt:new Date(now).toISOString(),breachStartedAt:new Date(now-60_000).toISOString(),observedValue:5,refs:['quota-1'] };
  const alert = await repo.recordFiring(saved,firing,'global');
  expect(await repo.recordFiring(saved,firing,'global')).toBeNull();
  expect(readDeliveryHistory(db)).toHaveLength(1);
  global._dbAdapter.instance.close(); delete global._dbAdapter;
  vi.resetModules();
  db = await (await import('@/lib/db/driver.js')).getAdapter();
  const send = vi.fn(async (_target,_event,payload,options) => {
    expect(payload.alertId).toBe(alert.id);
    expect(options.deliveryId).toBe(readDeliveryHistory(db)[0].id);
    return {ok:true,status:204,attempts:1};
  });
  await drainNotifications({db,config,send});
  await drainNotifications({db,config,send});
  expect(send).toHaveBeenCalledTimes(1);
  expect(readDeliveryHistory(db)[0]).toMatchObject({eventId:alert.id,state:'delivered',status:204,attempts:1});
  expect(JSON.stringify(db.all('SELECT * FROM notificationDeliveries'))).not.toContain(endpoint.secret);
  expect(JSON.stringify(db.all('SELECT * FROM notificationDeliveries'))).not.toContain(endpoint.url);
});

it('never exports past alerts when notifications were disabled at capture',async () => {
  db.run('UPDATE settings SET data=? WHERE id=1',[JSON.stringify({notifications:{...config,enabled:false}})]);
  enqueueNotificationEvent(db,'project.budget.alert','past',{projectId:'project-1'});
  expect(readDeliveryHistory(db)).toEqual([]);
  const send = vi.fn();
  await drainNotifications({db,config,send});
  expect(send).not.toHaveBeenCalled();
});

it('recovers a pending project intent after reopening without inventing later subscriptions', async () => {
  const { createProject } = await import('@/lib/db/repos/projectsRepo.js');
  const { recordProjectBudgetAlert } = await import('@/lib/db/projectBudgetEvidence.js');
  const { project } = await createProject({ name: 'Reopen intent', maxCostUsd: 10, alertPercent: 50 });
  db.run('UPDATE projectBudgetAccounts SET recordedCostUsd=6 WHERE projectId=?', [project.id]);
  const run = db.run.bind(db);
  const failure = vi.spyOn(db, 'run').mockImplementation((sql, args) => {
    if (sql.includes('INSERT OR IGNORE INTO notificationDeliveries')) throw new Error('Synthetic storage failure');
    return run(sql, args);
  });
  const alert = recordProjectBudgetAlert(db, project.id, new Date(now).toISOString());
  failure.mockRestore();
  db.close(); delete global._dbAdapter; vi.resetModules();
  db = await (await import('@/lib/db/driver.js')).getAdapter();
  const send = vi.fn(async () => ({ ok: true, status: 204, attempts: 1 }));
  const later = { ...config, endpoints: [...config.endpoints, { ...endpoint, id: 'later' }] };
  await drainNotifications({ db, config: later, send, now: now + 3000 });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].id).toBe(endpoint.id);
  expect(db.get('SELECT notificationQueuedAt FROM projectBudgetAlerts WHERE id=?', [alert.id]).notificationQueuedAt).not.toBeNull();
  expect(readDeliveryHistory(db)[0]).toMatchObject({ eventId: alert.id, state: 'delivered' });
});

it('keeps a stable deduplication identity and limits overlapping drainers to two sends',async () => {
  for (let i=0;i<5;i++) enqueueNotificationEvent(db,'rule.fired',`alert-${i}`,{alertId:`alert-${i}`});
  enqueueNotificationEvent(db,'rule.fired','alert-0',{alertId:'alert-0'});
  const first = claimDeliveries(db,{now});
  expect(first).toHaveLength(2);
  expect(claimDeliveries(db,{now})).toEqual([]);
  for (const claim of first) finishDelivery(db,claim,{ok:true,attempts:1});
  expect(claimDeliveries(db,{now})).toHaveLength(2);
  expect(readDeliveryHistory(db)).toHaveLength(5);
});

it('retains a crashed sender as uncertain and rejects its late completion',() => {
  enqueueNotificationEvent(db,'rule.fired','crash',{alertId:'crash'});
  const [claim] = claimDeliveries(db,{now});
  expect(claimDeliveries(db,{now:now+120_001})).toEqual([]);
  finishDelivery(db,claim,{ok:true,status:200,attempts:1});
  expect(readDeliveryHistory(db)[0].state).toBe('uncertain');
});

it('cancels a queued target if the destination URL or subscription changed',async () => {
  enqueueNotificationEvent(db,'rule.fired','changed',{alertId:'changed'});
  const send = vi.fn();
  await drainNotifications({db,config:{...config,endpoints:[{...endpoint,url:'https://other.example/'}]},send});
  expect(send).not.toHaveBeenCalled();
  expect(readDeliveryHistory(db)[0].state).toBe('cancelled');
});

it('records an interrupted send as uncertain without replaying its alert',async () => {
  enqueueNotificationEvent(db,'rule.fired','abort',{alertId:'abort'});
  const controller = new AbortController();
  const send = vi.fn(async (_target,_event,_payload,{signal}) => {
    controller.abort(); signal.throwIfAborted();
  });
  await drainNotifications({db,config,send,signal:controller.signal});
  await drainNotifications({db,config,send});
  expect(readDeliveryHistory(db)[0].state).toBe('uncertain');
  expect(send).toHaveBeenCalledTimes(1);
});

it('refuses an overflowing queue with a retained failure while preserving its alert',() => {
  db.transaction(() => {for (let i=0;i<1001;i++) enqueueNotificationEvent(db,'rule.fired',String(i),{alertId:String(i)});});
  expect(db.get("SELECT COUNT(*) AS n FROM notificationDeliveries WHERE state='queued'").n).toBe(1000);
  expect(db.get("SELECT COUNT(*) AS n FROM notificationDeliveries WHERE state='failed'").n).toBe(1);
});
