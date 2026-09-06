import { createHash } from 'node:crypto';

export const PIN_SELECT = 'SELECT sessionHash, model, connectionId, providerNode, pinnedAt, expiresAt, operatorExpiresAt, lastSeenAt FROM sessionAffinity WHERE sessionHash = ? AND model = ?';
export const PENDING_PIN_SELECT = "SELECT * FROM sessionPinActions WHERE sessionHash = ? AND model = ? AND status = 'queued'";
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function pinBinding(pin) {
  return hash(pin ? [pin.sessionHash, pin.model, pin.connectionId, pin.pinnedAt, pin.operatorExpiresAt ?? null] : null);
}
export function pinRevision(pin) {
  // Idle extension is part of the preview. If it changed, show the newer expiry
  // before applying an operator action rather than silently overwriting it.
  return hash([pinBinding(pin), pin?.expiresAt ?? null]);
}
export function getPendingPinAction(db, sessionHash, model, nowIso) {
  const action = db.get(PENDING_PIN_SELECT, [sessionHash, model]);
  if (!action) return null;
  if (db.driver === 'sql.js') return { ...action, storageUnavailable: true };
  const pin = db.get(PIN_SELECT, [sessionHash, model]);
  if (!pin || pinBinding(pin) !== action.expectedBinding || (pin.expiresAt && pin.expiresAt <= nowIso)) {
    db.run("UPDATE sessionPinActions SET status='conflict', reason='binding-ended', appliedAt=? WHERE id=? AND status='queued'", [nowIso, action.id]);
    return null;
  }
  return { ...action, storageUnavailable: db.driver === 'sql.js' };
}
export function completePinAction(db, action, nowIso) {
  if (!action) return;
  const after = db.get(PIN_SELECT, [action.sessionHash, action.model]);
  db.run("UPDATE sessionPinActions SET status='applied', reason='subsequent-selection', afterState=?, appliedAt=? WHERE id=? AND status='queued'",
    [JSON.stringify(after), nowIso, action.id]);
}
