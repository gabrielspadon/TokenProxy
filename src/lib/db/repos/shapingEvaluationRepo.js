import { randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { ShapingError } from '../../shaping/profile.js';
import { normalizeEvaluationFixtures, evaluationSetHash } from '../../shaping/evaluationSets.mjs';
import { FIXTURE_SETS, fixtureSet } from '../../shaping/fixtures.mjs';

const metadata = row => ({ id: row.id, setId: row.setId, name: row.name, revision: row.revision,
  contentHash: row.contentHash, createdAt: row.createdAt, provenance: JSON.parse(row.provenance), count: row.count ?? JSON.parse(row.fixtures).length, synthetic: false });
function validId(id) { if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new ShapingError('evaluation_set_id_invalid'); }
export async function saveEvaluationSet({ setId, expectedRevision, name, fixtures, acknowledgeRetention }) {
  if (acknowledgeRetention !== true) throw new ShapingError('evaluation_retention_consent_required', 422);
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new ShapingError('evaluation_set_name_invalid');
  if (setId !== undefined) validId(setId);
  let normalized;
  try { normalized = normalizeEvaluationFixtures(fixtures); }
  catch (error) { throw new ShapingError(error.code || 'evaluation_input_invalid', error.status || 422); }
  const db = await getAdapter();
  const result = db.transaction(() => {
    const prior = setId ? db.get('SELECT revision FROM shapingEvaluationSets WHERE setId=? ORDER BY revision DESC LIMIT 1', [setId]) : null;
    if (setId && !prior) throw new ShapingError('evaluation_set_not_found', 404);
    if (prior && prior.revision !== expectedRevision) throw new ShapingError('evaluation_set_revision_conflict', 409);
    const id = randomUUID(), createdAt = new Date().toISOString(), revision = prior ? prior.revision + 1 : 1;
    const row = { id, setId: setId || randomUUID(), name: name.trim(), revision, fixtures: JSON.stringify(normalized),
      contentHash: evaluationSetHash(normalized), createdAt,
      provenance: JSON.stringify({ kind: 'operator-selected', retainedBy: 'authenticated-operator', retentionAcknowledgedAt: createdAt, taskOutcomes: 'unmeasured' }) };
    db.run('INSERT INTO shapingEvaluationSets(id,setId,name,revision,fixtures,contentHash,provenance,createdAt) VALUES(?,?,?,?,?,?,?,?)',
      [row.id, row.setId, row.name, row.revision, row.fixtures, row.contentHash, row.provenance, row.createdAt]);
    return metadata(row);
  });
  try { db.flush?.(); return { version: result, persistence: 'confirmed' }; }
  catch { return { version: result, outcome: 'partial', persistence: 'unconfirmed', recovery: 'The set is available in this process; disk persistence is unconfirmed. Do not retry automatically.' }; }
}
export async function readEvaluationSet(id) {
  validId(id);
  const db = await getAdapter(), row = db.get('SELECT * FROM shapingEvaluationSets WHERE id=?', [id]);
  if (!row) throw new ShapingError('evaluation_set_not_found', 404);
  return { ...metadata(row), fixtures: JSON.parse(row.fixtures) };
}
export async function listEvaluationSets({ page = 1, pageSize = 20 } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) throw new ShapingError('invalid_pagination');
  const db = await getAdapter(), total = db.get('SELECT COUNT(*) AS count FROM shapingEvaluationSets').count;
  const rows = db.all('SELECT id,setId,name,revision,contentHash,provenance,createdAt,json_array_length(fixtures) AS count FROM shapingEvaluationSets ORDER BY createdAt DESC,id LIMIT ? OFFSET ?', [pageSize, (page - 1) * pageSize]).map(metadata);
  return { rows, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
}
export async function resolveEvaluationSet(id) {
  const builtin = FIXTURE_SETS.find(set => set.id === id);
  if (builtin) {
    const fixtures = fixtureSet(id);
    return { ...builtin, contentHash: evaluationSetHash(fixtures), fixtures, provenance: { kind: 'built-in-synthetic', taskOutcomes: 'unmeasured' } };
  }
  return readEvaluationSet(id);
}
