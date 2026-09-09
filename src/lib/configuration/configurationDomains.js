import { randomUUID } from 'node:crypto';
import { parseJson, stringifyJson } from '../db/helpers/jsonCol.js';
import { decryptSecretJson, encryptSecretJson } from '../db/helpers/secretCol.js';
import {
  configHash,
  configDiff,
  snapshotCurrent,
  insertConfigVersion,
  appendConfigReceipt,
} from '../db/helpers/configHistory.js';
import { ConfigurationError } from './routingConfig.js';
import {
  PROFILE_KEYS,
  PLAN_CONTROL_KEYS,
  projectSettings,
  projectPlanControls,
  validateProfile,
  validateConsent,
  consentRequired,
  UNAVAILABLE_CONTROLS,
} from '../shaping/profile.js';
import { mergeWithDefaults } from '../db/repos/settingsRepo.js';
import { resolveComboTokenSaver } from '../../../open-sse/services/combo.js';

export const DOMAIN_SCOPE = 'configuration-domains-v1';
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\s\u0000-\u001f]|:\/\//.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => plain(value) && Object.hasOwn(value, key)).map((key) => [key, value[key]])
  );
const privateLists = [
  'privacyFilterTerms',
  'toolDisclosureExcludeServers',
  'toolDisclosureExcludeTools',
];
export const SAVER_SETTINGS_KEYS = PROFILE_KEYS.filter((key) => !privateLists.includes(key));
export const ACCOUNT_KEYS = [
  'globalPriority',
  'maxConcurrent',
  'defaultModel',
  'quotaPauseThresholds',
];
export const CONNECTION_NETWORK_KEYS = [
  'proxyPoolId',
  'strictProxy',
  'connectionProxyMode',
  'connectionProxyEnabled',
  'connectionNoProxy',
];
export const NETWORK_SETTINGS_KEYS = [
  'outboundProxyEnabled',
  'outboundNoProxy',
  'connectTimeoutMs',
];
export const PROVIDER_POLICY_KEYS = ['maxConcurrent'];
export const PROVIDER_NETWORK_KEYS = [
  'proxyPoolId',
  'strictProxy',
  'connectTimeoutMs',
  'rotateStrategy',
];
const POOL_KEYS = ['type', 'strictProxy', 'noProxy'];
export const DOMAIN_COVERAGE = Object.freeze({
  scope: DOMAIN_SCOPE,
  included: [
    'Existing account activity, order, capacity, quota thresholds, default model and model allowlists',
    'Provider capacity and disabled-provider policy',
    'Exact provider/account disabled-model sets including empty inheritance overrides',
    'Global nonsecret saver flags/limits and per-plan saver overrides',
    'Existing proxy-pool activity/type/strictness/bypass policy, account/provider assignments, global outbound enable/bypass/connect timeout',
  ],
  excluded: [
    'Credentials, names/emails, account creation/deletion and provider identity changes',
    'All endpoint/proxy URLs, authentication/header fields, environment and OS proxy configuration',
    'Privacy terms and tool/server exclusion text',
    'Live quota/cooldowns, drain state, leases, pins and scheduler counters',
    'Shaping experiments/profile content and promotion history, routing plans/aliases, model catalogs and context-window overrides',
    'Database/software/schema rollback',
  ],
  redaction:
    'Endpoint values and private text are never serialized. Existing account/pool ids reference current secret material. Restoring flags or assignments uses the current endpoint and credentials, not historical secret values. Missing referenced entities are refused.',
  takesEffect:
    'Subsequent requests in this process; existing streams/leases/pins are retained. Disabled-model cache is invalidated and active quota work reconciled. Other processes refresh by their existing cache TTLs or require restart; no fleet-wide refresh is claimed.',
});

function rawSettings(db) {
  const value = parseJson(db.get('SELECT data FROM settings WHERE id = 1')?.data, {});
  if (!plain(value)) throw new ConfigurationError('settings_unreadable', 500);
  return value;
}
function scrub(value) {
  // Readers never persist an unvalidated arbitrary subtree from a secret blob.
  if (value == null || typeof value === 'boolean' || typeof value === 'number')
    return Number.isFinite(value) || typeof value !== 'number' ? value : null;
  if (typeof value === 'string') return safeKey(value) || value === '' ? value : null;
  if (Array.isArray(value))
    return value.map((item) => (typeof item === 'string' && safeKey(item) ? item : null));
  return null;
}
function values(value, keys) {
  return Object.fromEntries(
    Object.entries(pick(value, keys)).map(([key, item]) => [
      key,
      key === 'quotaPauseThresholds' && plain(item)
        ? Object.fromEntries(
            Object.entries(item)
              .filter(([name]) => safeKey(name))
              .map(([name, n]) => [name, typeof n === 'number' && Number.isFinite(n) ? n : null])
          )
        : ['noProxy', 'connectionNoProxy', 'outboundNoProxy'].includes(key) &&
            typeof item === 'string' &&
            item.length <= 4096 &&
            /^[a-zA-Z0-9.*,:[\]/_\s-]*$/.test(item)
          ? item
          : scrub(item),
    ])
  );
}
function records(value, keys) {
  return Object.fromEntries(
    Object.entries(plain(value) ? value : {})
      .filter(([key]) => safeKey(key))
      .map(([key, item]) => [key, values(item, keys)])
      .filter(([, item]) => Object.keys(item).length)
  );
}

export function readConfigurationDomains(db) {
  const raw = rawSettings(db),
    accounts = {},
    connections = {},
    pools = {};
  for (const row of db.all(
    'SELECT id, provider, priority, isActive, data FROM providerConnections'
  )) {
    if (!safeKey(row.id)) throw new ConfigurationError('configuration_identifier_unreadable', 500);
    const data = decryptSecretJson(row.data, {}),
      psd = data.providerSpecificData;
    accounts[row.id] = {
      provider: scrub(row.provider),
      isActive: row.isActive === 1 || row.isActive === true,
      priority: row.priority ?? null,
      ...values(data, ACCOUNT_KEYS),
      ...values(psd, ['enabledModels']),
    };
    connections[row.id] = values(psd, CONNECTION_NETWORK_KEYS);
  }
  for (const row of db.all('SELECT id, isActive, data FROM proxyPools')) {
    if (!safeKey(row.id)) throw new ConfigurationError('configuration_identifier_unreadable', 500);
    pools[row.id] = {
      isActive: row.isActive === 1 || row.isActive === true,
      ...values(parseJson(row.data, {}), POOL_KEYS),
    };
  }
  const plans = Object.fromEntries(
    Object.entries(plain(raw.comboStrategies) ? raw.comboStrategies : {})
      .filter(([name, entry]) => safeKey(name) && Object.hasOwn(entry || {}, 'tokenSaver'))
      .map(([name, entry]) => [name, projectPlanControls(entry.tokenSaver)])
  );
  return {
    accounts,
    providerPolicy: Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(records(raw.providerStrategies, PROVIDER_POLICY_KEYS)),
          ...Object.keys(plain(raw.disabledProviders) ? raw.disabledProviders : {}).filter(safeKey),
        ]),
      ].map((id) => [
        id,
        {
          ...values(raw.providerStrategies?.[id], PROVIDER_POLICY_KEYS),
          ...values(
            { disabled: raw.disabledProviders?.[id] },
            Object.hasOwn(raw.disabledProviders || {}, id) ? ['disabled'] : []
          ),
        },
      ])
    ),
    disabledModels: Object.fromEntries(
      db.all('SELECT key, value FROM kv WHERE scope = ?', ['disabledModels']).map((row) => {
        if (!safeKey(row.key))
          throw new ConfigurationError('configuration_identifier_unreadable', 500);
        return [row.key, scrub(parseJson(row.value))];
      })
    ),
    saver: { settings: values(raw, SAVER_SETTINGS_KEYS), plans },
    network: {
      settings: values(raw, NETWORK_SETTINGS_KEYS),
      providers: records(raw.providerStrategies, PROVIDER_NETWORK_KEYS),
      connections,
      pools,
    },
  };
}

const boolKeys = new Set([
  'disabled',
  'isActive',
  'strictProxy',
  'connectionProxyEnabled',
  'outboundProxyEnabled',
  ...SAVER_SETTINGS_KEYS.filter((key) => key.endsWith('Enabled') || key.endsWith('AllowLossy')),
  'headroomCompressUserMessages',
  'headroomLossless',
]);
const intKeys = new Set([
  'priority',
  'globalPriority',
  'maxConcurrent',
  'connectTimeoutMs',
  'stickyRoundRobinLimit',
  ...SAVER_SETTINGS_KEYS.filter(
    (key) => !boolKeys.has(key) && !['cavemanLevel', 'ponytailLevel'].includes(key)
  ),
]);
function assertValues(value, keys) {
  if (!plain(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new ConfigurationError('invalid_domain_fields');
  for (const [key, item] of Object.entries(value)) {
    let valid;
    if (boolKeys.has(key)) valid = typeof item === 'boolean';
    else if (key === 'quotaPauseThresholds')
      valid =
        plain(item) &&
        Object.entries(item).every(
          ([name, n]) =>
            safeKey(name) && typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100
        );
    else if (key === 'enabledModels') valid = Array.isArray(item) && item.every(safeKey);
    else if (intKeys.has(key)) valid = item === null || (Number.isSafeInteger(item) && item >= 0);
    else if (key === 'connectionProxyMode')
      valid = ['inherit', 'direct', 'custom', 'proxy', 'pool'].includes(item);
    else if (key === 'rotateStrategy') valid = ['none', 'round-robin', 'random'].includes(item);
    else if (key === 'type')
      valid = ['http', 'https', 'socks4', 'socks5', 'socks5h'].includes(item);
    else if (['noProxy', 'connectionNoProxy', 'outboundNoProxy'].includes(key))
      valid =
        typeof item === 'string' && item.length <= 4096 && /^[a-zA-Z0-9.*,:[\]/_\s-]*$/.test(item);
    else valid = item === null || item === '' || safeKey(item);
    if (!valid) throw new ConfigurationError('invalid_domain_value', 400, { key });
  }
}
function assertMap(value, check) {
  if (!plain(value) || Object.keys(value).length > 1000)
    throw new ConfigurationError('invalid_domain_map');
  for (const [key, item] of Object.entries(value)) {
    if (!safeKey(key)) throw new ConfigurationError('invalid_domain_key');
    check(item);
  }
}
export function assertConfigurationDomains(value) {
  if (
    !plain(value) ||
    JSON.stringify(value).length > 256000 ||
    Object.keys(value).sort().join(',') !== 'accounts,disabledModels,network,providerPolicy,saver'
  )
    throw new ConfigurationError('invalid_domain_document');
  assertMap(value.accounts, (item) =>
    assertValues(item, ['provider', 'isActive', 'priority', ...ACCOUNT_KEYS, 'enabledModels'])
  );
  assertMap(value.providerPolicy, (item) =>
    assertValues(item, [...PROVIDER_POLICY_KEYS, 'disabled'])
  );
  assertMap(value.disabledModels, (item) => {
    if (!Array.isArray(item) || item.length > 5000 || !item.every(safeKey))
      throw new ConfigurationError('invalid_disabled_models');
  });
  if (!plain(value.saver) || Object.keys(value.saver).sort().join(',') !== 'plans,settings')
    throw new ConfigurationError('invalid_saver_document');
  assertValues(value.saver.settings, SAVER_SETTINGS_KEYS);
  assertMap(value.saver.plans, (item) => {
    if (
      !plain(item) ||
      Object.entries(item).some(
        ([key, v]) => !PLAN_CONTROL_KEYS.includes(key) || typeof v !== 'boolean'
      )
    )
      throw new ConfigurationError('invalid_saver_plan');
  });
  if (
    !plain(value.network) ||
    Object.keys(value.network).sort().join(',') !== 'connections,pools,providers,settings'
  )
    throw new ConfigurationError('invalid_network_document');
  assertValues(value.network.settings, NETWORK_SETTINGS_KEYS);
  assertMap(value.network.providers, (item) => assertValues(item, PROVIDER_NETWORK_KEYS));
  assertMap(value.network.connections, (item) => assertValues(item, CONNECTION_NETWORK_KEYS));
  assertMap(value.network.pools, (item) => assertValues(item, ['isActive', ...POOL_KEYS]));
  return structuredClone(value);
}

function replaceKeys(target, source, keys) {
  for (const key of keys) delete target[key];
  Object.assign(target, source);
}
function mergedSettings(raw, document) {
  const next = structuredClone(raw);
  replaceKeys(next, document.saver.settings, SAVER_SETTINGS_KEYS);
  replaceKeys(next, document.network.settings, NETWORK_SETTINGS_KEYS);
  const strategies = (next.providerStrategies ||= {});
  next.disabledProviders = Object.fromEntries(
    Object.entries(document.providerPolicy)
      .filter(([, entry]) => Object.hasOwn(entry, 'disabled'))
      .map(([id, entry]) => [id, entry.disabled])
  );
  for (const key of new Set([
    ...Object.keys(strategies),
    ...Object.keys(document.providerPolicy),
    ...Object.keys(document.network.providers),
  ])) {
    const entry = { ...strategies[key] };
    replaceKeys(
      entry,
      {
        ...pick(document.providerPolicy[key], PROVIDER_POLICY_KEYS),
        ...document.network.providers[key],
      },
      [...PROVIDER_POLICY_KEYS, ...PROVIDER_NETWORK_KEYS]
    );
    if (Object.keys(entry).length) strategies[key] = entry;
    else delete strategies[key];
  }
  const plans = (next.comboStrategies ||= {});
  for (const name of new Set([...Object.keys(plans), ...Object.keys(document.saver.plans)])) {
    const entry = { ...plans[name] },
      saver = plain(entry.tokenSaver) ? { ...entry.tokenSaver } : {};
    delete entry.tokenSaver;
    replaceKeys(saver, document.saver.plans[name] || {}, PLAN_CONTROL_KEYS);
    if (Object.keys(saver).length || Object.hasOwn(document.saver.plans, name))
      entry.tokenSaver = saver;
    if (Object.keys(entry).length) plans[name] = entry;
    else delete plans[name];
  }
  return next;
}

export function validateConfigurationDomains(
  db,
  document,
  { before = readConfigurationDomains(db), activation = false, consent = [] } = {}
) {
  const errors = [],
    warnings = [{ code: 'secret_references_current', message: DOMAIN_COVERAGE.redaction }];
  try {
    assertConfigurationDomains(document);
  } catch (error) {
    return { valid: false, errors: [{ code: error.code }], warnings, requiredConsent: [] };
  }
  const add = (code, path) => errors.push({ code, path });
  for (const field of ['accounts'])
    if (
      Object.keys(document[field]).sort().join('\n') !==
      Object.keys(before[field]).sort().join('\n')
    )
      add('account_inventory_changed', `/${field}`);
  for (const field of ['connections', 'pools'])
    if (
      Object.keys(document.network[field]).sort().join('\n') !==
      Object.keys(before.network[field]).sort().join('\n')
    )
      add('network_inventory_changed', `/network/${field}`);
  for (const [id, account] of Object.entries(document.accounts)) {
    if (account.provider !== before.accounts[id]?.provider)
      add('account_provider_changed', `/accounts/${id}/provider`);
    if (!Object.hasOwn(account, 'isActive') || !Object.hasOwn(account, 'priority'))
      add('account_fields_required', `/accounts/${id}`);
  }
  for (const [kind, entries] of [
    ['connections', document.network.connections],
    ['providers', document.network.providers],
  ])
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.proxyPoolId && !document.network.pools[entry.proxyPoolId])
        add('proxy_pool_missing', `/network/${kind}/${id}/proxyPoolId`);
      else if (
        entry.proxyPoolId &&
        (entry.strictProxy === true) !==
          (document.network.pools[entry.proxyPoolId].strictProxy === true)
      )
        add('proxy_strictness_mismatch', `/network/${kind}/${id}/strictProxy`);
    }
  const planNames = new Set(db.all('SELECT name FROM combos').map((row) => row.name));
  for (const name of Object.keys(document.saver.plans))
    if (
      !planNames.has(name) &&
      configHash(document.saver.plans[name]) !== configHash(before.saver.plans[name])
    )
      add('saver_plan_missing', `/saver/plans/${name}`);
  let required = [];
  try {
    const raw = rawSettings(db),
      settings = mergeWithDefaults(mergedSettings(raw, document)),
      profile = validateProfile(projectSettings(settings));
    const previousProfile = projectSettings(mergeWithDefaults(raw));
    for (const key of Object.keys(UNAVAILABLE_CONTROLS))
      if (profile[key] !== previousProfile[key])
        add('control_runtime_unavailable', `/saver/settings/${key}`);
    required = consentRequired(profile);
    for (const name of Object.keys(document.saver.plans))
      required.push(
        ...consentRequired({ ...profile, ...resolveComboTokenSaver([name], settings) })
      );
    required = [...new Set(required)].sort();
    if (activation && configHash(before.saver) !== configHash(document.saver))
      validateConsent(Object.fromEntries(required.map((key) => [key, true])), consent);
  } catch (error) {
    errors.push({ code: error.code || 'invalid_saver_settings', ...(error.details || {}) });
  }
  return { valid: errors.length === 0, errors, warnings, requiredConsent: required };
}

export function writeConfigurationDomains(db, document) {
  const now = new Date().toISOString();
  const before = readConfigurationDomains(db);
  const changedPools = new Set(
    Object.keys(document.network.pools).filter(
      (id) => configHash(before.network.pools[id]) !== configHash(document.network.pools[id])
    )
  );
  for (const row of db.all('SELECT id, data FROM providerConnections')) {
    const account = document.accounts[row.id],
      data = decryptSecretJson(row.data, {}),
      psd = { ...data.providerSpecificData };
    replaceKeys(data, pick(account, ACCOUNT_KEYS), ACCOUNT_KEYS);
    replaceKeys(psd, pick(account, ['enabledModels']), ['enabledModels']);
    const network = document.network.connections[row.id];
    if (
      configHash(values(psd, CONNECTION_NETWORK_KEYS)) !== configHash(network) ||
      changedPools.has(network.proxyPoolId)
    )
      data.credentialRevisionId = randomUUID();
    replaceKeys(psd, network, CONNECTION_NETWORK_KEYS);
    data.providerSpecificData = psd;
    db.run(
      'UPDATE providerConnections SET isActive = ?, priority = ?, data = ?, updatedAt = ? WHERE id = ?',
      [account.isActive ? 1 : 0, account.priority, encryptSecretJson(data), now, row.id]
    );
  }
  for (const row of db.all('SELECT id, data FROM proxyPools')) {
    const data = parseJson(row.data, {}),
      policy = document.network.pools[row.id];
    replaceKeys(data, pick(policy, POOL_KEYS), POOL_KEYS);
    db.run('UPDATE proxyPools SET isActive = ?, data = ?, updatedAt = ? WHERE id = ?', [
      policy.isActive ? 1 : 0,
      stringifyJson(data),
      now,
      row.id,
    ]);
  }
  db.run('DELETE FROM kv WHERE scope = ?', ['disabledModels']);
  for (const [key, models] of Object.entries(document.disabledModels))
    db.run('INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)', [
      'disabledModels',
      key,
      stringifyJson(models),
    ]);
  db.run(
    'INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    [stringifyJson(mergedSettings(rawSettings(db), document))]
  );
}

export function recordConfigurationDomainsMutation(db, before, source) {
  const after = readConfigurationDomains(db);
  if (configHash(before) === configHash(after)) return null;
  const provenance = { source, actorClass: 'unverified' };
  const previous = snapshotCurrent(db, before, provenance, DOMAIN_SCOPE);
  const next = insertConfigVersion(db, after, {
    scope: DOMAIN_SCOPE,
    kind: 'direct',
    parentVersionId: previous.id,
    provenance,
  });
  return appendConfigReceipt(db, {
    scope: DOMAIN_SCOPE,
    action: 'direct-save',
    outcome: 'applied',
    beforeVersionId: previous.id,
    afterVersionId: next.id,
    beforeHash: previous.contentHash,
    afterHash: next.contentHash,
    details: {
      databaseCommitted: true,
      effect: DOMAIN_COVERAGE.takesEffect,
      changedPaths: configDiff(before, after).map((change) => change.path),
    },
    provenance,
  });
}

export function connectionDomainChange(db, id, patch) {
  const keys = ['provider', 'priority', 'isActive', ...ACCOUNT_KEYS];
  // An explicitly supplied providerSpecificData replaces the stored object in
  // updateProviderConnection, so a replacement holding none of the covered keys
  // (for example {}) can still remove a covered allowlist or proxy field. Any
  // own providerSpecificData property therefore requires the projected
  // before/after comparison below; only a patch touching no covered surface at
  // all skips the read.
  if (
    !Object.keys(patch || {}).some((key) => keys.includes(key)) &&
    !Object.hasOwn(patch || {}, 'providerSpecificData')
  )
    return false;
  const row = db.get(
    'SELECT id, provider, priority, isActive, data FROM providerConnections WHERE id = ?',
    [id]
  );
  if (!row) return false;
  const before = {
    ...decryptSecretJson(row.data, {}),
    ...row,
    isActive: row.isActive === 1 || row.isActive === true,
  };
  const after = { ...before, ...patch };
  const policy = (value) => ({
    ...values(value, keys),
    providerSpecificData: values(value.providerSpecificData, [
      'enabledModels',
      ...CONNECTION_NETWORK_KEYS,
    ]),
  });
  return configHash(policy(before)) !== configHash(policy(after));
}

export function configurationDomainMutation(db, source, mutation, shouldRecord = () => true) {
  return () => {
    if (!shouldRecord()) return mutation();
    const before = readConfigurationDomains(db);
    const result = mutation();
    recordConfigurationDomainsMutation(db, before, source);
    return result;
  };
}

export function configurationDomainReferences(db, document) {
  // Existing immutable profile records remain authoritative. Only matching ids,
  // revisions and hashes enter this view; profile text/consent is not copied.
  const exists = db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shapingProfileVersions'"
  );
  const profileHash = configHash(
    values(projectSettings(mergeWithDefaults(rawSettings(db))), SAVER_SETTINGS_KEYS)
  );
  const matching = exists
    ? db
        .all(
          'SELECT id, profileId, revision, settings, contentHash FROM shapingProfileVersions ORDER BY id DESC LIMIT 200'
        )
        .filter(
          (row) => configHash(values(parseJson(row.settings), SAVER_SETTINGS_KEYS)) === profileHash
        )
        .map(({ id, profileId, revision, contentHash }) => ({
          id,
          profileId,
          revision,
          contentHash,
        }))
    : [];
  return {
    accounts: Object.keys(document.accounts),
    proxyPools: Object.keys(document.network.pools),
    matchingShapingProfiles: matching,
    profileSearchLimit: 200,
    secretMaterial: 'current-only, excluded from retained versions',
  };
}
