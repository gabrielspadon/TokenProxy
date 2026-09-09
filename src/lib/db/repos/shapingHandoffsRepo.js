import { randomUUID, createHash } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { normalizeContextIdentity } from './contextEvidenceRepo.js';
import { ShapingError } from '../../shaping/profile.js';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const HANDOFF_EFFECT = 'Adds this approved summary to subsequent requests in the exact target client session while active. It does not move in-flight work or change account/model selection. Expiry or revocation removes it from future requests and may change their cache prefix. Revocation clears summary content immediately; expired content is cleared on the next handoff access. Receipts remain.';
function expireContent(db, at) {
  if (!db.get('SELECT id FROM shapingHandoffs WHERE summary IS NOT NULL AND expiresAt<=? LIMIT 1', [at])) return false;
  db.run('UPDATE shapingHandoffs SET summary=NULL WHERE summary IS NOT NULL AND expiresAt<=?', [at]);
  return true;
}
function observed(db, requestId) {
  if (typeof requestId !== 'string' || !UUID.test(requestId)) throw new ShapingError('handoff_request_id_invalid');
  const row = db.get(`SELECT r.*,p.id AS boundProjectId,p.name AS projectName FROM requestStats r
    JOIN projectBindings b ON b.apiKeyId=r.clientKeyId AND b.clientRef=r.clientRef AND b.projectRef=r.projectRef
    JOIN projects p ON p.id=b.projectId AND p.archived=0
    JOIN apiKeys k ON k.id=r.clientKeyId AND k.isActive=1
    WHERE r.id=? AND r.clientIdentitySource='client-reported' AND r.clientSessionRef IS NOT NULL`, [requestId]);
  if (!row) throw new ShapingError('handoff_explicit_project_session_required', 422);
  const identity = normalizeContextIdentity(row);
  if (!identity.clientRef || !identity.projectRef || !identity.clientSessionRef) throw new ShapingError('handoff_explicit_project_session_required', 422);
  return row;
}
const publicPacket = (row, at) => ({ id: row.id, sourceRequestId: row.sourceRequestId, targetRequestId: row.targetRequestId, projectId: row.projectId,
  contentHash: row.contentHash, createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt,
  state: row.revokedAt ? 'revoked' : row.expiresAt <= at ? 'expired' : 'active', effect: HANDOFF_EFFECT });
function finish(db, value) {
  try { db.flush?.(); return { ...value, persistence: 'confirmed' }; }
  catch { return { ...value, outcome: 'partial', persistence: 'unconfirmed', recovery: 'State changed in this process; disk persistence is unconfirmed. Do not repeat automatically.' }; }
}
export async function createShapingHandoff({ sourceRequestId, targetRequestId, summary, expiresAt, acknowledgeContent }, { now = Date.now() } = {}) {
  if (acknowledgeContent !== true) throw new ShapingError('handoff_content_consent_required', 422);
  if (typeof summary !== 'string' || !summary.trim() || Buffer.byteLength(summary) > 16384 || summary.includes('\u0000')) throw new ShapingError('handoff_summary_invalid');
  const expiry = typeof expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(expiresAt) ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 7 * 86400000) throw new ShapingError('handoff_expiry_invalid');
  const db = await getAdapter(), at = new Date(now).toISOString();
  const result = db.transaction(() => {
    expireContent(db, at);
    const source = observed(db, sourceRequestId), target = observed(db, targetRequestId);
    if (source.boundProjectId !== target.boundProjectId) throw new ShapingError('handoff_project_mismatch', 422);
    if (source.clientKeyId === target.clientKeyId && source.clientRef === target.clientRef && source.clientSessionRef === target.clientSessionRef) throw new ShapingError('handoff_distinct_target_required', 422);
    const scope = [target.clientKeyId, target.clientRef, target.projectRef, target.clientSessionRef];
    if (db.get('SELECT id FROM shapingHandoffs WHERE targetClientKeyId=? AND targetClientRef=? AND targetProjectRef=? AND targetClientSessionRef=? AND expiresAt>? AND revokedAt IS NULL', [...scope, at])) throw new ShapingError('handoff_target_already_active', 409);
    const packet = { id: randomUUID(), sourceRequestId, targetRequestId, projectId: target.boundProjectId, summary,
      targetClientKeyId: scope[0], targetClientRef: scope[1], targetProjectRef: scope[2], targetClientSessionRef: scope[3],
      contentHash: createHash('sha256').update(summary).digest('hex'), createdAt: at, expiresAt: new Date(expiry).toISOString(), revokedAt: null };
    const fields = Object.keys(packet);
    db.run(`INSERT INTO shapingHandoffs(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`, Object.values(packet));
    return { packet: publicPacket(packet, at), outcome: 'active' };
  });
  return finish(db, result);
}
export async function revokeShapingHandoff({ id, expectedContentHash }) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new ShapingError('handoff_id_invalid');
  const db = await getAdapter(), at = new Date().toISOString();
  const result = db.transaction(() => {
    const row = db.get('SELECT * FROM shapingHandoffs WHERE id=?', [id]);
    if (!row) throw new ShapingError('handoff_not_found', 404);
    if (row.contentHash !== expectedContentHash) throw new ShapingError('handoff_content_conflict', 409);
    db.run('UPDATE shapingHandoffs SET revokedAt=COALESCE(revokedAt,?),summary=NULL WHERE id=?', [at, id]);
    return { packet: publicPacket({ ...row, revokedAt: row.revokedAt || at }, at), outcome: row.revokedAt ? 'unchanged' : 'revoked' };
  });
  return finish(db, result);
}
export async function pendingShapingHandoffs(identity, { now = Date.now() } = {}) {
  const clean = normalizeContextIdentity(identity);
  if (!clean.clientKeyId || !clean.clientRef || !clean.projectRef || !clean.clientSessionRef || clean.clientIdentitySource !== 'client-reported') return [];
  const db = await getAdapter(), at = new Date(now).toISOString();
  if (expireContent(db, at)) db.flush?.();
  return db.all(`SELECT h.id,h.summary FROM shapingHandoffs h
    JOIN projectBindings b ON b.apiKeyId=h.targetClientKeyId AND b.clientRef=h.targetClientRef AND b.projectRef=h.targetProjectRef AND b.projectId=h.projectId
    JOIN projects p ON p.id=h.projectId AND p.archived=0
    WHERE h.targetClientKeyId=? AND h.targetClientRef=? AND h.targetProjectRef=? AND h.targetClientSessionRef=?
    AND h.revokedAt IS NULL AND h.expiresAt>? AND h.summary IS NOT NULL ORDER BY h.createdAt,h.id LIMIT 1`,
  [clean.clientKeyId, clean.clientRef, clean.projectRef, clean.clientSessionRef, at]);
}
function pagination({ page = 1, pageSize = 20 } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) throw new ShapingError('invalid_pagination');
  return { page, pageSize, offset: (page - 1) * pageSize };
}
export async function listShapingHandoffs(options) {
  const { page, pageSize, offset } = pagination(options), db = await getAdapter(), at = new Date().toISOString();
  if (expireContent(db, at)) db.flush?.();
  const total = db.get('SELECT COUNT(*) AS count FROM shapingHandoffs').count;
  const rows = db.all(`SELECT h.*, (SELECT COUNT(*) FROM contextHandoffApplications a WHERE a.handoffId=h.id AND a.executionRequestId=a.requestId) AS preparations
    FROM shapingHandoffs h ORDER BY h.createdAt DESC,h.id LIMIT ? OFFSET ?`, [pageSize, offset]).map(row => ({ ...publicPacket(row, at), preparations: row.preparations }));
  return { rows, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) }, effect: HANDOFF_EFFECT };
}
export async function handoffTargets(options) {
  const { page, pageSize, offset } = pagination(options), db = await getAdapter();
  const population = `FROM requestStats r JOIN projectBindings b ON b.apiKeyId=r.clientKeyId AND b.clientRef=r.clientRef AND b.projectRef=r.projectRef
    JOIN projects p ON p.id=b.projectId AND p.archived=0 JOIN apiKeys k ON k.id=r.clientKeyId AND k.isActive=1
    WHERE r.clientIdentitySource='client-reported' AND r.clientSessionRef IS NOT NULL`;
  const total = db.get(`SELECT COUNT(*) AS count ${population}`).count;
  const rows = db.all(`SELECT r.id,r.contextSessionId,r.clientTool,r.requestedModel,r.timestamp,p.id AS projectId,p.name AS projectName ${population} ORDER BY r.timestamp DESC,r.id LIMIT ? OFFSET ?`, [pageSize, offset]);
  return { rows, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
}
export function saveHandoffApplications(db, detail) {
  const c = detail.contextTelemetry;
  for (const item of (c?.handoffs || []).slice(0, 1)) {
    if (!UUID.test(item.id || '') || !UUID.test(item.executionRequestId || '')) throw new Error('Invalid handoff application');
    db.run('INSERT INTO contextHandoffApplications(handoffId,requestId,executionRequestId,logicalRequestId,appliedAt) VALUES(?,?,?,?,?) ON CONFLICT(handoffId,requestId) DO NOTHING',
      [item.id, detail.id, item.executionRequestId, c.logicalRequestId || detail.id, detail.timestamp]);
  }
}
