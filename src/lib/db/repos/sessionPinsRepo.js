import { randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { PIN_SELECT, PENDING_PIN_SELECT, pinBinding, pinRevision } from '../helpers/sessionPinControl.js';

export class PinControlError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const iso = now => new Date(now ?? Date.now()).toISOString();
const parse = value => value ? JSON.parse(value) : null;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const revision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function encodePinId(pin) { return Buffer.from(JSON.stringify([pin.sessionHash, pin.model])).toString('base64url'); }
export function decodePinId(id) {
  let fields;
  try { fields = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')); } catch { throw new PinControlError('invalid_pin_id'); }
  if (typeof id !== 'string' || id.length > 1600 || !Array.isArray(fields) || fields.length !== 2
    || !/^[a-f0-9]{32,64}$/.test(fields[0]) || typeof fields[1] !== 'string' || !fields[1] || fields[1].length > 512
    || encodePinId({ sessionHash: fields[0], model: fields[1] }) !== id) throw new PinControlError('invalid_pin_id');
  return { sessionHash: fields[0], model: fields[1] };
}
export function publicPin(pin, now = Date.now()) {
  if (!/^[a-f0-9]{32,64}$/.test(pin?.sessionHash) || typeof pin.model !== 'string' || !pin.model || pin.model.length > 512
    || typeof pin.connectionId !== 'string' || pin.connectionId.length > 128) throw new PinControlError('pin_record_unrepresentable', 422);
  return { id: encodePinId(pin), model: pin.model, connectionId: pin.connectionId, provider: pin.provider ?? null,
    pinnedAt: pin.pinnedAt, lastSeenAt: pin.lastSeenAt, expiresAt: pin.expiresAt ?? null,
    operatorExpiresAt: pin.operatorExpiresAt ?? null, revision: pinRevision(pin),
    state: pin.expiresAt && pin.expiresAt <= iso(now) ? 'expired' : 'active' };
}
function publicAction(row) {
  return { id: row.id, version: row.version, pinId: encodePinId(row), model: row.model,
    action: row.action, targetConnectionId: row.targetConnectionId, deadline: row.deadline,
    expectedRevision: row.expectedRevision, status: row.status, reason: row.reason,
    createdAt: row.createdAt, previewExpiresAt: row.previewExpiresAt, appliedAt: row.appliedAt,
    before: publicPin(parse(row.beforeState), row.createdAt),
    after: row.afterState ? publicPin(parse(row.afterState), row.appliedAt) : null,
    preview: parse(row.preview) };
}
export function validatePinAction(body) {
  if (!body || Object.keys(body).some(k => !['id', 'pinId', 'expectedRevision', 'action', 'targetConnectionId', 'deadline'].includes(k))) throw new PinControlError('invalid_fields');
  if (body.id !== undefined && !uuid(body.id)) throw new PinControlError('invalid_action_id');
  if (!revision(body.expectedRevision)) throw new PinControlError('invalid_revision');
  if (!['clear', 'expire', 'reassign'].includes(body.action)) throw new PinControlError('invalid_action');
  if (body.action === 'reassign' ? typeof body.targetConnectionId !== 'string' || !body.targetConnectionId || body.targetConnectionId.length > 128 : body.targetConnectionId !== undefined) throw new PinControlError('invalid_target');
  if (body.action === 'expire' ? typeof body.deadline !== 'string' || !Number.isFinite(Date.parse(body.deadline)) || new Date(body.deadline).toISOString() !== body.deadline : body.deadline !== undefined) throw new PinControlError('invalid_deadline');
  return decodePinId(body.pinId);
}
export async function getSessionPin(id) {
  const key = decodePinId(id), db = await getAdapter();
  const row = db.get(PIN_SELECT, [key.sessionHash, key.model]);
  if (!row) throw new PinControlError('pin_not_found', 404);
  return row;
}
export async function getSessionPinAction(id) {
  if (!uuid(id)) throw new PinControlError('invalid_action_id');
  const db = await getAdapter(), action = db.get('SELECT * FROM sessionPinActions WHERE id=?', [id]);
  if (!action) throw new PinControlError('action_not_found', 404);
  return publicAction(action);
}
export async function listSessionPins({ limit = 25, before } = {}, { now } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new PinControlError('invalid_limit');
  const cursor = before ? decodePinId(before) : null, db = await getAdapter();
  // Primary-key pagination is independent of sliding lastSeenAt and expiry.
  const rows = db.all(`SELECT p.*, c.provider FROM sessionAffinity p LEFT JOIN providerConnections c ON c.id=p.connectionId
    ${cursor ? 'WHERE (p.sessionHash > ? OR (p.sessionHash = ? AND p.model > ?))' : ''}
    ORDER BY p.sessionHash, p.model LIMIT ?`, [...(cursor ? [cursor.sessionHash, cursor.sessionHash, cursor.model] : []), limit + 1]);
  const observedAt = iso(now);
  const pins = rows.slice(0, limit).map(row => {
    const session = db.get("SELECT id, identitySource FROM contextSessions WHERE sessionHash=? AND identitySource IN ('explicit','inferred','routing')", [row.sessionHash]);
    const requests = session ? db.all(`SELECT id, logicalRequestId, requestedModel, model, connectionId, status, timestamp, dispatchCoverage FROM requestStats
      WHERE contextSessionId=? AND model=? ORDER BY timestamp DESC, id DESC LIMIT 8`, [session.id, row.model]) : [];
    const actions = db.all('SELECT * FROM sessionPinActions WHERE sessionHash=? AND model=? ORDER BY createdAt DESC, id DESC LIMIT 8', [row.sessionHash, row.model]);
    const switches = db.all('SELECT id, fromConnectionId, toConnectionId, trigger, reason, switchedAt FROM accountSwitches WHERE sessionHash=? AND model=? ORDER BY switchedAt DESC LIMIT 8', [row.sessionHash, row.model]);
    return { ...publicPin(row, observedAt), session: session ? { id: session.id, identitySource: session.identitySource, join: 'stored-routing-hash' } : null,
      requests: requests.map(r => ({ ...r, selectedModel: r.model, servedModel: r.status === 'success' ? r.model : null })),
      actions: actions.map(publicAction), switches,
      targets: row.provider ? db.all('SELECT id, name, isActive FROM providerConnections WHERE provider=? ORDER BY id LIMIT 201', [row.provider])
        .map(c => ({ id: c.id, name: typeof c.name === 'string' ? c.name.slice(0, 160) : null, enabled: c.isActive === 1 })) : [] };
  });
  return { version: 1, observedAt, pins, next: rows.length > limit ? encodePinId(rows[limit - 1]) : null,
    boundaries: { exactPinScope: 'routing-identity-and-physical-model', rawClientIdentity: false, historyLimitPerPin: 8,
      durableControlsSupported: db.driver !== 'sql.js', targetListLimit: 201,
      pinIdentifiers: 'reversible opaque identifiers containing the stored routing hash and model',
      inFlightChanges: false, agentHierarchy: 'unavailable', expiryPolicy: '24-hour sliding idle deadline capped by operator deadline' } };
}
export async function previewSessionPin(body, evidence, { now } = {}) {
  const key = validatePinAction(body), db = await getAdapter(), at = iso(now), id = body.id ?? randomUUID();
  if (db.driver === 'sql.js') throw new PinControlError('durable_storage_required', 503);
  return db.transaction(() => {
    const previous = db.get('SELECT * FROM sessionPinActions WHERE id=?', [id]);
    if (previous) {
      if (previous.sessionHash !== key.sessionHash || previous.model !== key.model || previous.expectedRevision !== body.expectedRevision
        || previous.action !== body.action || previous.targetConnectionId !== (body.targetConnectionId ?? null) || previous.deadline !== (body.deadline ?? null)) throw new PinControlError('idempotency_conflict', 409);
      return publicAction(previous);
    }
    const pin = db.get(PIN_SELECT, [key.sessionHash, key.model]);
    if (!pin) throw new PinControlError('pin_not_found', 404);
    if (pinRevision(pin) !== body.expectedRevision) throw new PinControlError('pin_changed', 409);
    if (body.action === 'reassign' && (pin.expiresAt && pin.expiresAt <= at)) throw new PinControlError('pin_expired', 409);
    if (body.action === 'reassign' && pin.connectionId === body.targetConnectionId) throw new PinControlError('target_is_current_account');
    if (body.action === 'expire' && body.deadline > new Date(Date.parse(at) + 30 * 86400000).toISOString()) throw new PinControlError('deadline_too_far');
    const pending = db.get(PENDING_PIN_SELECT, [key.sessionHash, key.model]);
    const preview = { ...evidence, affectedPins: 1, modelSubstitution: false, inFlightAffected: false,
      conflicts: [...(evidence?.conflicts || []), ...(pending && body.action !== 'clear' ? [{ connectionId: pending.targetConnectionId, reason: 'reassignment-pending' }] : [])],
      cancelledActions: pending && body.action === 'clear' ? [pending.id] : [],
      consequence: body.action === 'clear' ? 'Future selection may choose the same account. A different account can rebuild the provider prompt cache.'
        : body.action === 'expire' ? 'Activity cannot extend this absolute deadline. Selection after expiry ranks accounts again and may choose the same account.'
          : 'Only a later selection can consume the target. Existing work continues on its admitted account. The same physical model is retained; moving account can rebuild the provider prompt cache.',
      clientAccountPreference: 'An explicit conflicting account preference waits while reassignment is pending.' };
    db.run(`INSERT INTO sessionPinActions(id,version,sessionHash,model,action,targetConnectionId,deadline,expectedRevision,expectedBinding,status,beforeState,preview,createdAt,previewExpiresAt)
      VALUES(?,1,?,?,?,?,?,?,?,'preview',?,?,?,?)`, [id, key.sessionHash, key.model, body.action, body.targetConnectionId ?? null, body.deadline ?? null,
      body.expectedRevision, pinBinding(pin), JSON.stringify(pin), JSON.stringify(preview), at, new Date(Date.parse(at) + 300000).toISOString()]);
    return publicAction(db.get('SELECT * FROM sessionPinActions WHERE id=?', [id]));
  });
}
export async function applySessionPin({ id, expectedRevision }, { now } = {}) {
  if (!uuid(id) || !revision(expectedRevision)) throw new PinControlError('invalid_apply');
  const db = await getAdapter(), at = iso(now);
  if (db.driver === 'sql.js') throw new PinControlError('durable_storage_required', 503);
  return db.transaction(() => {
    const action = db.get('SELECT * FROM sessionPinActions WHERE id=?', [id]);
    if (!action) throw new PinControlError('preview_not_found', 404);
    if (action.expectedRevision !== expectedRevision) throw new PinControlError('idempotency_conflict', 409);
    if (action.status !== 'preview') return publicAction(action);
    const pin = db.get(PIN_SELECT, [action.sessionHash, action.model]);
    const reason = action.previewExpiresAt <= at ? 'preview_expired' : !pin || pinRevision(pin) !== expectedRevision ? 'pin_changed'
      : action.action === 'reassign' && pin.expiresAt && pin.expiresAt <= at ? 'pin_expired' : null;
    if (reason) {
      db.run("UPDATE sessionPinActions SET status='conflict', reason=?, appliedAt=? WHERE id=?", [reason, at, id]);
      return publicAction(db.get('SELECT * FROM sessionPinActions WHERE id=?', [id]));
    }
    const pending = db.get(PENDING_PIN_SELECT, [action.sessionHash, action.model]);
    if (pending && action.action !== 'clear') throw new PinControlError('reassignment_pending', 409);
    if (pending) db.run("UPDATE sessionPinActions SET status='cancelled', reason='affinity-cleared', appliedAt=? WHERE id=?", [at, pending.id]);
    if (action.action === 'clear') db.run('DELETE FROM sessionAffinity WHERE sessionHash=? AND model=?', [action.sessionHash, action.model]);
    if (action.action === 'expire') {
      const expiry = pin.expiresAt && pin.expiresAt < action.deadline ? pin.expiresAt : action.deadline;
      db.run('UPDATE sessionAffinity SET operatorExpiresAt=?, expiresAt=? WHERE sessionHash=? AND model=?', [action.deadline, expiry, action.sessionHash, action.model]);
    }
    const after = db.get(PIN_SELECT, [action.sessionHash, action.model]);
    db.run('UPDATE sessionPinActions SET status=?, reason=?, afterState=?, appliedAt=? WHERE id=?',
      [action.action === 'reassign' ? 'queued' : 'applied', action.action === 'reassign' ? 'awaiting-subsequent-selection' : 'operator-applied',
        after ? JSON.stringify(after) : null, action.action === 'reassign' ? null : at, id]);
    return publicAction(db.get('SELECT * FROM sessionPinActions WHERE id=?', [id]));
  });
}
