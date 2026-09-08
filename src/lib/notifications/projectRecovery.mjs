import { enqueueCapturedNotificationEvent } from './outbox.mjs';

export function materializeProjectNotification(db, alert, at = new Date().toISOString()) {
  const transactionActive = db.raw?.inTransaction === true;
  try {
    const targets = JSON.parse(alert.notificationTargets);
    if (!Array.isArray(targets) || targets.some(target => typeof target.id !== 'string' || !/^[a-f0-9]{64}$/.test(target.destinationHash)))
      throw new Error('Invalid retained notification intent');
    enqueueCapturedNotificationEvent(db, 'project.budget.alert', alert.id, {
      alertId: alert.id, projectId: alert.projectId, policyRevision: alert.policyRevision,
      firedAt: alert.firedAt, evidence: typeof alert.evidence === 'string' ? JSON.parse(alert.evidence) : alert.evidence,
    }, targets, alert.firedAt);
    db.run(`UPDATE projectBudgetAlerts SET notificationQueuedAt=?,notificationRetryAt=NULL,
      notificationErrorCode=NULL,notificationAttempts=notificationAttempts+1 WHERE id=?`, [at, alert.id]);
    return true;
  } catch (error) {
    // SQLite can roll back a surrounding transaction after a storage error.
    // Such an error must reach accounting instead of claiming its source survived.
    if (transactionActive && db.raw?.inTransaction === false) throw error;
    const attempts = (alert.notificationAttempts ?? 0) + 1;
    const retryAt = new Date(Date.parse(at) + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8))).toISOString();
    db.run(`UPDATE projectBudgetAlerts SET notificationRetryAt=?,notificationErrorCode='delivery-materialization-failed',
      notificationAttempts=notificationAttempts+1 WHERE id=?`, [retryAt, alert.id]);
    return false;
  }
}

export function recoverProjectNotifications(db, { now = Date.now(), limit = 20 } = {}) {
  const at = new Date(now).toISOString();
  const rows = db.all(`SELECT * FROM projectBudgetAlerts WHERE notificationQueuedAt IS NULL
    AND notificationTargets IS NOT NULL AND notificationRetryAt<=? ORDER BY notificationRetryAt,firedAt,id LIMIT ?`,
  [at, Math.max(1, Math.min(20, Number.isSafeInteger(limit) ? limit : 20))]);
  let recovered = 0;
  for (const row of rows) {
    db.transaction(() => {
      const current = db.get('SELECT * FROM projectBudgetAlerts WHERE id=? AND notificationQueuedAt IS NULL AND notificationRetryAt<=?', [row.id, at]);
      if (current && materializeProjectNotification(db, current, at)) recovered++;
    });
  }
  return { examined: rows.length, recovered };
}
