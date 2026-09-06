import { randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { parseJson, stringifyJson } from '../helpers/jsonCol.js';
import { mergeWithDefaults } from './settingsRepo.js';
import { PROFILE_COVERAGE, projectSettings, settingsHash, settingsDiff, validateProfile, validateConsent, consentRequired, ShapingError } from '../../shaping/profile.js';
import { FIXTURE_SETS } from '../../shaping/fixtures.mjs';
import { runExperiment } from '../../shaping/runExperiment.js';

const now = () => new Date().toISOString();
function rawSettings(db) {
  const raw = parseJson(db.get('SELECT data FROM settings WHERE id = 1')?.data, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ShapingError('settings_unreadable', 500);
  return raw;
}
const current = db => projectSettings(mergeWithDefaults(rawSettings(db)));
const decodeVersion = row => row ? { ...row, settings: parseJson(row.settings), consent: parseJson(row.consent) } : null;
const positiveId = id => { if (!Number.isSafeInteger(id) || id < 1) throw new ShapingError('invalid_version_id'); };
function version(db, id) {
  positiveId(id);
  const row = decodeVersion(db.get('SELECT * FROM shapingProfileVersions WHERE id = ?', [id]));
  if (!row) throw new ShapingError('profile_version_not_found', 404);
  return row;
}
function finish(db, result) {
  try { db.flush?.(); return { ...result, persistence: 'confirmed' }; }
  catch { return { ...result, outcome: 'partial', persistence: 'unconfirmed', recovery: 'State changed in this process; disk persistence is unconfirmed. Do not replay the operation automatically.' }; }
}
export async function shapingCurrent() {
  const db = await getAdapter(), settings = current(db);
  return { settings, currentHash: settingsHash(settings), consentRequired: consentRequired(settings), coverage: PROFILE_COVERAGE, fixtureSets: FIXTURE_SETS };
}
export async function shapingVersion(id) { return version(await getAdapter(), id); }
export async function shapingList(resource, { page = 1, pageSize = 20 } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ShapingError('invalid_pagination');
  const db = await getAdapter(), offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw new ShapingError('invalid_pagination');
  const choices = {
    profiles: ['shapingProfileVersions', '*', 'id DESC'],
    experiments: ['shapingExperiments', 'id, baselineVersionId, candidateVersionId, fixtureSetId, createdAt', 'createdAt DESC, id'],
    receipts: ['shapingReceipts', '*', 'createdAt DESC, id'],
  };
  if (!Object.hasOwn(choices, resource)) throw new ShapingError('resource_not_found', 404);
  const [table, columns, order] = choices[resource];
  const total = db.get(`SELECT COUNT(*) AS count FROM ${table}`).count;
  const rows = db.all(`SELECT ${columns} FROM ${table} ORDER BY ${order} LIMIT ? OFFSET ?`, [pageSize, offset]).map(row => resource === 'profiles' ? decodeVersion(row) : resource === 'receipts' ? { ...row, beforeSettings: parseJson(row.beforeSettings), afterSettings: parseJson(row.afterSettings), consent: parseJson(row.consent) } : row);
  return { rows, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
}
export async function saveShapingProfile({ profileId, expectedRevision, name, settings, consent }) {
  const document = validateProfile(settings), acknowledged = validateConsent(document, consent);
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new ShapingError('invalid_profile_name');
  if (profileId !== undefined && (typeof profileId !== 'string' || profileId.length > 64)) throw new ShapingError('invalid_profile_id');
  const db = await getAdapter();
  const saved = db.transaction(() => {
    const latest = profileId ? db.get('SELECT revision FROM shapingProfileVersions WHERE profileId = ? ORDER BY revision DESC LIMIT 1', [profileId]) : null;
    if (profileId && !latest) throw new ShapingError('profile_not_found', 404);
    if (latest && expectedRevision !== latest.revision) throw new ShapingError('profile_revision_conflict', 409);
    const revision = latest ? latest.revision + 1 : 1;
    const inserted = db.run('INSERT INTO shapingProfileVersions(profileId, name, revision, settings, consent, contentHash, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?)', [profileId || randomUUID(), name.trim(), revision, stringifyJson(document), stringifyJson(acknowledged), settingsHash(document), now()]);
    return version(db, inserted.lastInsertRowid);
  });
  return finish(db, { version: saved, effectiveSettingsChanged: false });
}
export async function shapingExperiment(id) {
  if (typeof id !== 'string' || id.length > 64) throw new ShapingError('invalid_experiment_id');
  const db = await getAdapter(), row = db.get('SELECT * FROM shapingExperiments WHERE id = ?', [id]);
  if (!row) throw new ShapingError('experiment_not_found', 404);
  return { ...row, result: parseJson(row.result) };
}
export async function createShapingExperiment({ baselineVersionId, candidateVersionId, fixtureSetId }, { signal } = {}) {
  if (!FIXTURE_SETS.some(set => set.id === fixtureSetId)) throw new ShapingError('fixture_set_required');
  const db = await getAdapter(), baseline = version(db, baselineVersionId), candidate = version(db, candidateVersionId);
  const result = await runExperiment({ baseline: validateProfile(baseline.settings), candidate: validateProfile(candidate.settings), fixtureSetId }, { signal });
  const id = randomUUID(), createdAt = now();
  db.run('INSERT INTO shapingExperiments(id, baselineVersionId, candidateVersionId, fixtureSetId, result, createdAt) VALUES(?, ?, ?, ?, ?, ?)', [id, baselineVersionId, candidateVersionId, fixtureSetId, stringifyJson(result), createdAt]);
  return finish(db, { id, baselineVersionId, candidateVersionId, fixtureSetId, result, createdAt, effectiveSettingsChanged: false });
}
export async function promoteShapingProfile({ versionId, expectedCurrent, consent, experimentId, acknowledgeUnsupported = [], rollbackReceiptId }) {
  if (typeof expectedCurrent !== 'string' || !/^[a-f0-9]{64}$/.test(expectedCurrent)) throw new ShapingError('expected_current_required');
  if (!Array.isArray(acknowledgeUnsupported) || acknowledgeUnsupported.some(x => typeof x !== 'string')) throw new ShapingError('invalid_unsupported_acknowledgement');
  const db = await getAdapter();
  const result = db.transaction(() => {
    const before = current(db), beforeHash = settingsHash(before);
    if (beforeHash !== expectedCurrent) throw new ShapingError('settings_conflict', 409, { currentHash: beforeHash });
    let target, action = 'promote';
    if (rollbackReceiptId !== undefined) {
      if (typeof rollbackReceiptId !== 'string' || rollbackReceiptId.length > 64) throw new ShapingError('invalid_receipt_id');
      const receipt = db.get('SELECT * FROM shapingReceipts WHERE id = ?', [rollbackReceiptId]);
      if (!receipt) throw new ShapingError('receipt_not_found', 404);
      target = parseJson(receipt.beforeSettings); versionId = receipt.versionId; action = 'rollback'; experimentId = null;
    } else {
      target = version(db, versionId).settings;
      const row = typeof experimentId === 'string' && db.get('SELECT * FROM shapingExperiments WHERE id = ? AND candidateVersionId = ?', [experimentId, versionId]);
      if (!row) throw new ShapingError('candidate_experiment_required', 422);
      const evidence = parseJson(row.result).candidate;
      const failed = evidence.results.some(r => r.stages.some(s => s.status === 'error') || !r.validity.toolTransactionsValid || !r.validity.currentPreserved || !r.validity.liveThinkingPreserved || !r.validity.errorEvidencePreserved);
      if (failed) throw new ShapingError('candidate_integrity_failed', 422);
      if (evidence.unsupported.some(stage => !acknowledgeUnsupported.includes(stage))) throw new ShapingError('unsupported_stage_acknowledgement_required', 422, { unsupported: evidence.unsupported });
    }
    const after = validateProfile(target), acknowledged = validateConsent(after, consent), afterHash = settingsHash(after);
    const id = randomUUID(), createdAt = now();
    db.run('INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', [stringifyJson({ ...rawSettings(db), ...after })]);
    db.run('INSERT INTO shapingReceipts(id, action, versionId, experimentId, beforeSettings, afterSettings, beforeHash, afterHash, consent, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, action, versionId, experimentId, stringifyJson(before), stringifyJson(after), beforeHash, afterHash, stringifyJson({ contentChanging: acknowledged, unsupported: acknowledgeUnsupported }), createdAt]);
    return { outcome: 'applied', id, action, beforeSettings: before, afterSettings: after, beforeHash, afterHash, diff: settingsDiff(before, after), createdAt, coverage: PROFILE_COVERAGE };
  });
  return finish(db, result);
}
