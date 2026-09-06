import { findComboCycle, getComboModelsFromData } from '../../../open-sse/services/combo.js';
import { parseModel, resolveModelAliasFromMap, resolveBareModelStaticOwner, resolveProviderAlias } from '../../../open-sse/services/model.js';
import { CONFIG_SETTINGS_KEYS, COMBO_OVERRIDE_KEYS, FUSION_KEYS, projectRoutingConfig } from '../db/helpers/configHistory.js';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s]|:\/\//.test(value) && !dangerous.has(value);
const strategy = value => ['fallback', 'round-robin', 'fusion'].includes(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const allowedKeys = (value, keys) => plain(value) && Object.keys(value).every(k => keys.includes(k));

export class ConfigurationError extends Error {
  constructor(code, status = 400, details = {}) {
    super(code);
    this.name = 'ConfigurationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Reject unsupported fields before persistence, including nested credential
// objects. Drafts may be semantically incomplete, but their storage shape is
// always the same credential-free projection as a published version.
export function assertRoutingDocument(value) {
  let nodes = 0;
  const queue = [{ value, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const item = queue.pop();
    if (++nodes > 20000 || item.depth > 12) throw new ConfigurationError('configuration_too_large');
    if (item.value && typeof item.value === 'object') {
      if (seen.has(item.value)) throw new ConfigurationError('invalid_document');
      seen.add(item.value);
      queue.push(...Object.values(item.value).map(child => ({ value: child, depth: item.depth + 1 })));
    }
  }
  if (!allowedKeys(value, ['combos', 'aliases', 'settings']) || !Array.isArray(value.combos) || !plain(value.aliases) || !plain(value.settings)) throw new ConfigurationError('invalid_document');
  if (JSON.stringify(value).length > 256000) throw new ConfigurationError('configuration_too_large');
  const invalid = () => { throw new ConfigurationError('invalid_document'); };
  for (const c of value.combos) {
    if (!allowedKeys(c, ['id', 'name', 'kind', 'models']) || !identifier(c.id) || !identifier(c.name) || !/^[a-zA-Z0-9_.\-]+$/.test(c.name) || !(c.kind == null || identifier(c.kind)) || !Array.isArray(c.models) || !c.models.every(identifier)) invalid();
  }
  for (const [name, target] of Object.entries(value.aliases)) {
    if (!identifier(name)) invalid();
    if (typeof target === 'string' ? !identifier(target) : !allowedKeys(target, ['provider', 'model']) || !identifier(target.provider) || !identifier(target.model)) invalid();
  }
  if (!allowedKeys(value.settings, CONFIG_SETTINGS_KEYS)) invalid();
  const s = value.settings;
  if ('comboStrategy' in s && !strategy(s.comboStrategy)) invalid();
  if ('comboStickyRoundRobinLimit' in s && !positiveInt(s.comboStickyRoundRobinLimit)) invalid();
  if ('exposeComboOnly' in s && typeof s.exposeComboOnly !== 'boolean') invalid();
  if ('comboStrategies' in s) {
    if (!plain(s.comboStrategies)) invalid();
    for (const [name, o] of Object.entries(s.comboStrategies)) {
      if (!identifier(name) || !allowedKeys(o, COMBO_OVERRIDE_KEYS)) invalid();
      if ('fallbackStrategy' in o && !strategy(o.fallbackStrategy)) invalid();
      if ('judgeModel' in o && !identifier(o.judgeModel)) invalid();
      if ('memberConnections' in o && (!plain(o.memberConnections) || !Object.entries(o.memberConnections).every(([m, id]) => identifier(m) && identifier(id)))) invalid();
      if ('fusionTuning' in o && (!allowedKeys(o.fusionTuning, FUSION_KEYS) || !Object.entries(o.fusionTuning).every(([k, n]) => positiveInt(n) && (k === 'minPanel' || n <= 2147483647)))) invalid();
    }
  }
  return projectRoutingConfig(value);
}

export function validateRoutingDocument(document, catalog = {}) {
  try { assertRoutingDocument(document); } catch (error) {
    return { valid: false, errors: [{ code: error.code || 'invalid_document' }], warnings: [], effectivePlans: [] };
  }
  const errors = [], warnings = [];
  const add = (code, path) => errors.push({ code, path });
  const ids = new Set(), names = new Set();
  for (const [i, c] of document.combos.entries()) {
    if (ids.has(c.id)) add('duplicate_combo_id', `/combos/${i}/id`);
    if (names.has(c.name)) add('duplicate_combo_name', `/combos/${i}/name`);
    ids.add(c.id); names.add(c.name);
    if (!c.models.length) add('empty_combo', `/combos/${i}/models`);
  }
  if (findComboCycle(document.combos)) add('combo_cycle', '/combos');
  const resolve = member => {
    const p = parseModel(member);
    if (!p.isAlias) return p.provider && p.model ? p : null;
    const custom = (catalog.customModels || []).find(m => m.type === 'llm' && m.id === member);
    if (custom) return { provider: resolveProviderAlias(custom.providerAlias), model: member };
    const alias = resolveModelAliasFromMap(member, document.aliases);
    if (alias) return alias;
    for (const [provider, entry] of Object.entries(catalog.freeModels || {})) {
      if (Array.isArray(entry?.ids) && entry.ids.includes(member)) return { provider: resolveProviderAlias(provider), model: member };
    }
    const owner = member === 'grok-build' ? resolveProviderAlias('gcli') : resolveBareModelStaticOwner(member);
    return owner ? { provider: owner, model: member } : null;
  };
  for (const name of Object.keys(document.aliases)) {
    // The gateway implements one-hop aliases. Alias-to-alias chains, including
    // cycles, cannot become routable by being stored in a draft.
    const resolved = resolveModelAliasFromMap(name, document.aliases);
    if (!resolved?.provider || !resolved.model) add('alias_requires_direct_target', `/aliases/${name}`);
  }
  const checkMember = (m, path) => {
    if (!getComboModelsFromData(m, document.combos) && !resolve(m)) add('unresolved_member', path);
  };
  const effectivePlans = document.combos.map((c, i) => {
    c.models.forEach((m, n) => checkMember(m, `/combos/${i}/models/${n}`));
    const override = document.settings.comboStrategies?.[c.name] || {};
    const effectiveStrategy = override.fallbackStrategy || document.settings.comboStrategy || 'fallback';
    return { id: c.id, name: c.name, orderedMembers: [...c.models], strategy: effectiveStrategy, stickyLimit: document.settings.comboStickyRoundRobinLimit ?? 1, judgeModel: override.judgeModel ?? null, dispatchOrderMayChange: 'Capability fit and configured round-robin can reorder members at request time.' };
  });
  for (const [name, o] of Object.entries(document.settings.comboStrategies || {})) {
    if (!getComboModelsFromData(name, document.combos)) add('missing_combo_override_target', `/settings/comboStrategies/${name}`);
    if (o.judgeModel) checkMember(o.judgeModel, `/settings/comboStrategies/${name}/judgeModel`);
    const members = new Set(), visited = new Set(), pending = [name];
    while (pending.length) {
      const member = pending.pop();
      if (visited.has(member)) continue;
      visited.add(member);
      const nested = getComboModelsFromData(member, document.combos);
      if (nested) pending.push(...nested);
      else members.add(member);
    }
    for (const [member, id] of Object.entries(o.memberConnections || {})) {
      if (!members.has(member)) add('connection_target_not_member', `/settings/comboStrategies/${name}/memberConnections/${member}`);
      const resolved = resolve(member);
      const conn = (catalog.connections || []).find(c => c.id === id);
      if (!conn) add('missing_connection', `/settings/comboStrategies/${name}/memberConnections/${member}`);
      else if (!resolved || resolveProviderAlias(conn.provider) !== resolved.provider) add('connection_provider_mismatch', `/settings/comboStrategies/${name}/memberConnections/${member}`);
    }
  }
  warnings.push({ code: 'upstream_support_unverified', message: 'Validation is local. Credentials, model entitlement, quota and upstream acceptance are not tested.' });
  return { valid: errors.length === 0, errors, warnings, effectivePlans };
}
