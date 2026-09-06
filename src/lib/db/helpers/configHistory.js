import { createHash, randomUUID } from 'node:crypto';
import { parseJson, stringifyJson } from './jsonCol.js';

export const CONFIG_SCOPE = 'routing-plans-v1';
export const CONFIG_SETTINGS_KEYS = Object.freeze(['comboStrategy', 'comboStickyRoundRobinLimit', 'exposeComboOnly', 'comboStrategies']);
export const COMBO_OVERRIDE_KEYS = Object.freeze(['fallbackStrategy', 'judgeModel', 'memberConnections', 'fusionTuning']);
export const FUSION_KEYS = Object.freeze(['minPanel', 'stragglerGraceMs', 'panelHardTimeoutMs']);
export const CONFIG_COVERAGE = Object.freeze({
  scope: CONFIG_SCOPE,
  included: ['combos.id/name/kind/ordered models', 'modelAliases direct targets', ...CONFIG_SETTINGS_KEYS.slice(0, 3), ...COMBO_OVERRIDE_KEYS.map(k => `comboStrategies.*.${k}`)],
  excluded: ['credentials', 'provider endpoints', 'proxy settings', 'account policy', 'disabled models', 'custom/free model catalogs', 'token saver overrides'],
  takesEffect: 'Subsequent request selection; in-flight requests are not migrated.',
});
const KNOWN_SOURCES = new Set(['admin.configuration', 'repo.combos.create', 'repo.combos.update', 'repo.combos.delete', 'repo.aliases.set', 'repo.aliases.delete', 'repo.settings.update']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pick = (value, keys) => Object.fromEntries(keys.filter(k => plain(value) && Object.hasOwn(value, k)).map(k => [k, value[k]]));
const number = value => Number.isFinite(value) ? value : null;
const identifier = value => typeof value === 'string' && value.length <= 512 && !/[\s]|:\/\//.test(value) ? value : null;

export function canonicalConfig(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalConfig).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalConfig(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
export const configHash = document => createHash('sha256').update(canonicalConfig(document)).digest('hex');
export function configProvenance(input = {}) {
  return {
    source: KNOWN_SOURCES.has(input.source) ? input.source : 'unknown',
    actorClass: input.actorClass === 'operator' ? 'operator' : 'unverified',
    actorId: null,
  };
}

// Only these fields may enter history. In particular, an object supplied where
// an identifier/number belongs cannot smuggle a credential subtree into a row.
export function projectRoutingConfig({ combos = [], aliases = {}, settings = {} }) {
  const selected = {};
  if (Object.hasOwn(settings, 'comboStrategy')) selected.comboStrategy = ['fallback', 'round-robin', 'fusion'].includes(settings.comboStrategy) ? settings.comboStrategy : null;
  if (Object.hasOwn(settings, 'comboStickyRoundRobinLimit')) selected.comboStickyRoundRobinLimit = number(settings.comboStickyRoundRobinLimit);
  if (Object.hasOwn(settings, 'exposeComboOnly')) selected.exposeComboOnly = typeof settings.exposeComboOnly === 'boolean' ? settings.exposeComboOnly : null;
  if (plain(settings.comboStrategies)) {
    selected.comboStrategies = Object.fromEntries(Object.entries(settings.comboStrategies).map(([name, raw]) => {
      const values = pick(raw, COMBO_OVERRIDE_KEYS);
      if (Object.hasOwn(values, 'fallbackStrategy')) values.fallbackStrategy = ['fallback', 'round-robin', 'fusion'].includes(values.fallbackStrategy) ? values.fallbackStrategy : null;
      if (Object.hasOwn(values, 'judgeModel')) values.judgeModel = identifier(values.judgeModel);
      if (Object.hasOwn(values, 'memberConnections')) values.memberConnections = plain(values.memberConnections)
        ? Object.fromEntries(Object.entries(values.memberConnections).map(([model, id]) => [identifier(model) ?? '', identifier(id)])) : null;
      if (Object.hasOwn(values, 'fusionTuning')) values.fusionTuning = Object.fromEntries(Object.entries(pick(values.fusionTuning, FUSION_KEYS)).map(([k, v]) => [k, number(v)]));
      return [identifier(name) ?? '', values];
    }).filter(([, values]) => Object.keys(values).length));
    if (!Object.keys(selected.comboStrategies).length) delete selected.comboStrategies;
  }
  return {
    combos: combos.map(c => ({ id: identifier(c.id), name: identifier(c.name), kind: c.kind == null ? null : identifier(c.kind), models: Array.isArray(c.models) ? c.models.map(identifier) : null })).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0),
    aliases: Object.fromEntries(Object.entries(plain(aliases) ? aliases : {}).map(([alias, target]) => [identifier(alias) ?? '', typeof target === 'string' ? identifier(target) : Object.fromEntries(Object.entries(pick(target, ['provider', 'model'])).map(([k, v]) => [k, identifier(v)]))])),
    settings: selected,
  };
}
export function readRoutingConfig(db) {
  const combos = db.all('SELECT id, name, kind, models FROM combos').map(r => ({ ...r, models: parseJson(r.models) }));
  const aliases = Object.fromEntries(db.all('SELECT key, value FROM kv WHERE scope = ?', ['modelAliases']).map(r => [r.key, parseJson(r.value)]));
  const row = db.get('SELECT data FROM settings WHERE id = 1');
  const settings = row ? parseJson(row.data, null) : {};
  if (!plain(settings)) throw new TypeError('Settings are unreadable; configuration cannot be captured.');
  return projectRoutingConfig({ combos, aliases, settings });
}
export function configDiff(before, after, path = '') {
  if (canonicalConfig(before) === canonicalConfig(after)) return [];
  if (plain(before) && plain(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => configDiff(before[key], after[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  }
  return [{ path: path || '/', before: before ?? null, after: after ?? null, operation: before === undefined ? 'add' : after === undefined ? 'remove' : 'replace' }];
}
export function insertConfigVersion(db, document, { kind = 'snapshot', parentVersionId = null, draftId = null, revision = null, provenance } = {}) {
  const contentHash = configHash(document), createdAt = new Date().toISOString();
  const result = db.run('INSERT INTO configVersions(scope, kind, parentVersionId, draftId, revision, contentHash, document, provenance, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [CONFIG_SCOPE, kind, parentVersionId, draftId, revision, contentHash, canonicalConfig(document), stringifyJson(configProvenance(provenance)), createdAt]);
  return { id: Number(result.lastInsertRowid), scope: CONFIG_SCOPE, kind, parentVersionId, draftId, revision, contentHash, document, provenance: configProvenance(provenance), createdAt };
}
export function readConfigVersion(db, id) {
  const row = db.get('SELECT * FROM configVersions WHERE id = ? AND scope = ?', [id, CONFIG_SCOPE]);
  return row ? { ...row, document: parseJson(row.document), provenance: parseJson(row.provenance) } : null;
}
export function snapshotCurrent(db, document, provenance) {
  const hash = configHash(document);
  const row = db.get("SELECT id FROM configVersions WHERE scope = ? AND contentHash = ? AND kind != 'draft' ORDER BY id DESC LIMIT 1", [CONFIG_SCOPE, hash]);
  return row ? readConfigVersion(db, row.id) : insertConfigVersion(db, document, { provenance });
}
export function appendConfigReceipt(db, { operationId = randomUUID(), action, outcome, beforeVersionId = null, afterVersionId = null, targetVersionId = null, beforeHash = null, afterHash = null, details = {}, provenance }) {
  const createdAt = new Date().toISOString();
  const result = db.run('INSERT INTO configReceipts(operationId, scope, action, outcome, beforeVersionId, afterVersionId, targetVersionId, beforeHash, afterHash, details, provenance, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [operationId, CONFIG_SCOPE, action, outcome, beforeVersionId, afterVersionId, targetVersionId, beforeHash, afterHash, stringifyJson(details), stringifyJson(configProvenance(provenance)), createdAt]);
  return { id: Number(result.lastInsertRowid), operationId, action, outcome, beforeVersionId, afterVersionId, targetVersionId, beforeHash, afterHash, details, provenance: configProvenance(provenance), createdAt };
}

// Called inside each existing synchronous mutation transaction. A failed history
// write aborts that same mutation, so the gateway cannot report an unaudited save.
export function recordConfigMutation(db, before, source) {
  const after = readRoutingConfig(db);
  if (configHash(before) === configHash(after)) return null;
  const provenance = { source, actorClass: 'unverified' };
  const previous = snapshotCurrent(db, before, provenance);
  const next = insertConfigVersion(db, after, { kind: 'direct', parentVersionId: previous.id, provenance });
  return appendConfigReceipt(db, { action: 'direct-save', outcome: 'applied', beforeVersionId: previous.id, afterVersionId: next.id, beforeHash: previous.contentHash, afterHash: next.contentHash, details: { effect: CONFIG_COVERAGE.takesEffect }, provenance });
}
