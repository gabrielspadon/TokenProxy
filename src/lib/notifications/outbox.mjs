import { createHash, randomUUID } from 'node:crypto';

const MAX_PENDING = 1000;
const LEASE_MS = 120_000;
export const destinationHash = url => createHash('sha256').update(url).digest('hex');

// Called inside the source event's transaction. Configuration is captured at
// that boundary; enabling a destination later never exports historical alerts.
// No credential or destination URL is retained in the delivery ledger.
export function enqueueNotificationEvent(db, event, eventId, payload, at = new Date().toISOString()) {
  return enqueueCapturedNotificationEvent(db, event, eventId, payload, captureNotificationTargets(db, event), at);
}

export function captureNotificationTargets(db, event) {
  const raw = db.get('SELECT data FROM settings WHERE id=1');
  const config = raw ? JSON.parse(raw.data).notifications : null;
  if (!config?.enabled) return [];
  return (config.endpoints ?? []).filter(e => e.active !== false &&
    typeof e.id === 'string' && typeof e.url === 'string' && e.events?.includes(event))
    .map(e => ({ id: e.id, destinationHash: destinationHash(e.url) }));
}

export function enqueueCapturedNotificationEvent(db, event, eventId, payload, targets, at = new Date().toISOString()) {
  if (!targets.length) return 0;
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error('Notification evidence exceeds delivery limit');
  let pending = db.get("SELECT COUNT(*) AS n FROM notificationDeliveries WHERE state IN ('queued','delivering')").n;
  for (const endpoint of targets) {
    const id = createHash('sha256').update(JSON.stringify([event, eventId, endpoint.id])).digest('hex');
    const overflow = pending >= MAX_PENDING;
    const result = db.run(`INSERT OR IGNORE INTO notificationDeliveries
      (id,eventId,event,endpointId,destinationHash,payload,createdAt,updatedAt,state,error)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [id,eventId,event,endpoint.id,endpoint.destinationHash,body,at,at,
      overflow ? 'failed' : 'queued',overflow ? 'Delivery queue capacity reached' : null]);
    if (!overflow) pending += result.changes ?? 0;
  }
  return targets.length;
}

export function claimDeliveries(db, { now = Date.now(), limit = 2 } = {}) {
  const at = new Date(now).toISOString();
  const owner = randomUUID();
  let claimed = [];
  db.transaction(() => {
    // A crashed sender may have reached its receiver. Retain uncertainty and
    // require a fresh operator decision rather than replaying automatically.
    db.run(`UPDATE notificationDeliveries SET state='uncertain',updatedAt=?,owner=NULL,
      leaseUntil=NULL,error='Sender stopped before delivery was confirmed'
      WHERE state='delivering' AND leaseUntil<=?`, [at,at]);
    const active = db.get("SELECT COUNT(*) AS n FROM notificationDeliveries WHERE state='delivering'").n;
    const rows = db.all(`SELECT * FROM notificationDeliveries WHERE state='queued'
      ORDER BY createdAt,id LIMIT ?`, [Math.max(0,Math.min(2-active,limit))]);
    for (const row of rows) {
      db.run(`UPDATE notificationDeliveries SET state='delivering',owner=?,leaseUntil=?,updatedAt=?
        WHERE id=? AND state='queued'`, [owner,new Date(now+LEASE_MS).toISOString(),at,row.id]);
    }
    claimed = rows.map(row => ({ ...row, owner }));
  });
  return claimed;
}

export function finishDelivery(db, claim, result, { now = Date.now() } = {}) {
  const state = result.uncertain ? 'uncertain' : result.cancelled ? 'cancelled' : result.ok ? 'delivered' : 'failed';
  db.run(`UPDATE notificationDeliveries SET state=?,updatedAt=?,owner=NULL,leaseUntil=NULL,
    attempts=?,status=?,error=? WHERE id=? AND state='delivering' AND owner=?`,
  [state,new Date(now).toISOString(),result.attempts ?? 0,result.status ?? null,
    result.error ?? null,claim.id,claim.owner]);
}

export function readDeliveryHistory(db, limit = 50) {
  return db.all(`SELECT id,eventId,event,endpointId,createdAt,updatedAt AS at,state,
    attempts,status,error FROM notificationDeliveries ORDER BY updatedAt DESC,id DESC LIMIT ?`,
  [Math.max(1,Math.min(200,limit))]).map(row => ({...row,ok:row.state === 'delivered'}));
}
