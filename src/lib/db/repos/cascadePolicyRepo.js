import { randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { parseJson, stringifyJson } from '../helpers/jsonCol.js';
import { configHash } from '../helpers/configHistory.js';
import { normalizeCascadePairs, normalizeModelRef, EXPLORATION_PROMPT_TOKEN_CEILING, CHARS_PER_TOKEN, SESSION_PIN_TTL_MS } from '../../stepRouter.js';

export class CascadePolicyError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const model = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value) && !value.includes('://');
export function validateCascadePairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length > 64) throw new CascadePolicyError('invalid_cascade_pairs');
  const seen = new Set();
  return pairs.map(pair => {
    if (!plain(pair) || Object.keys(pair).some(key => !['strong', 'cheap'].includes(key)) || !model(pair.strong) || !model(pair.cheap)) throw new CascadePolicyError('invalid_cascade_pair');
    const strong = normalizeModelRef(pair.strong), cheap = normalizeModelRef(pair.cheap);
    if (strong === cheap || seen.has(strong)) throw new CascadePolicyError('duplicate_or_self_cascade_pair');
    seen.add(strong);
    return { strong, cheap };
  });
}
function read(db) {
  const row = db.get('SELECT data FROM settings WHERE id = 1');
  const settings = row ? parseJson(row.data, null) : {};
  if (!plain(settings)) throw new CascadePolicyError('settings_unreadable', 503);
  return settings;
}
function project(settings) {
  const raw = settings.cascadePairs ?? [];
  const pairs = [...normalizeCascadePairs(raw)].map(([strong, cheap]) => ({ strong, cheap }));
  return { version: 1, revision: configHash(raw), pairs, ignoredOrMergedEntries: Array.isArray(raw) ? raw.length - pairs.length : 1,
    limits: { promptEstimateExclusive: EXPLORATION_PROMPT_TOKEN_CEILING, charactersPerEstimatedToken: CHARS_PER_TOKEN, escalationPinMs: SESSION_PIN_TTL_MS },
    scope: 'global-solo-chat-cascade', includedInRoutingPlanRollback: false, upstreamVerified: false };
}
export async function getCascadePolicy() {
  const db = await getAdapter();
  return { ...project(read(db)), receipts: db.all("SELECT value FROM kv WHERE scope = 'cascadePolicyReceipts' ORDER BY rowid DESC LIMIT 20").map(row => parseJson(row.value, null)) };
}
export async function replaceCascadePolicy({ pairs, expectedRevision } = {}) {
  const normalized = validateCascadePairs(pairs);
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new CascadePolicyError('invalid_revision');
  const db = await getAdapter();
  if (db.driver === 'sql.js') throw new CascadePolicyError('durable_storage_required', 503);
  return db.transaction(() => {
    const settings = read(db), before = project(settings);
    if (before.revision !== expectedRevision) throw new CascadePolicyError('revision_conflict', 409);
    const after = project({ ...settings, cascadePairs: normalized });
    const receipt = { id: randomUUID(), recordedAt: new Date().toISOString(), outcome: 'applied', beforeRevision: before.revision, afterRevision: after.revision, before: before.pairs, after: normalized, scope: after.scope, inFlightAffected: false, escalationPinsCleared: false };
    db.run('INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', [stringifyJson({ ...settings, cascadePairs: normalized })]);
    db.run('INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)', ['cascadePolicyReceipts', `${receipt.recordedAt}:${receipt.id}`, stringifyJson(receipt)]);
    return { ...after, receipt };
  });
}
