import { randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { parseJson, stringifyJson } from '../helpers/jsonCol.js';
import {
  CONFIG_SCOPE as ROUTING_SCOPE,
  CONFIG_COVERAGE as ROUTING_COVERAGE,
  CONFIG_SETTINGS_KEYS,
  COMBO_OVERRIDE_KEYS,
  canonicalConfig,
  configHash,
  configDiff,
  readRoutingConfig,
  readConfigVersion as readVersion,
  snapshotCurrent as snapshot,
  insertConfigVersion as insertVersion,
  appendConfigReceipt as appendReceipt,
} from '../helpers/configHistory.js';
import {
  assertRoutingDocument,
  validateRoutingDocument,
  ConfigurationError,
} from '../../configuration/routingConfig.js';
import { resetComboRotation } from '../../../../open-sse/services/combo.js';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function writeCoveredConfiguration(db, document) {
  const now = new Date().toISOString();
  const old = new Map(db.all('SELECT id, createdAt FROM combos').map((c) => [c.id, c.createdAt]));
  // The entire plan set is replaced inside one transaction. Deleting first also
  // permits atomic swaps of names protected by the existing UNIQUE constraint.
  db.run('DELETE FROM combos');
  for (const c of document.combos)
    db.run(
      'INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)',
      [c.id, c.name, c.kind ?? null, stringifyJson(c.models), old.get(c.id) || now, now]
    );
  db.run('DELETE FROM kv WHERE scope = ?', ['modelAliases']);
  for (const [name, target] of Object.entries(document.aliases))
    db.run('INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)', [
      'modelAliases',
      name,
      stringifyJson(target),
    ]);
  const raw = parseJson(db.get('SELECT data FROM settings WHERE id = 1')?.data, {});
  if (!plain(raw)) throw new ConfigurationError('settings_unreadable', 500);
  for (const key of CONFIG_SETTINGS_KEYS.slice(0, 3)) delete raw[key];
  Object.assign(
    raw,
    Object.fromEntries(
      CONFIG_SETTINGS_KEYS.slice(0, 3)
        .filter((k) => Object.hasOwn(document.settings, k))
        .map((k) => [k, document.settings[k]])
    )
  );
  // Preserve every excluded field, including per-plan saver settings and
  // overrides belonging to a removed plan; those are outside this scope.
  const overrides = Object.fromEntries(
    Object.entries(plain(raw.comboStrategies) ? raw.comboStrategies : {}).map(([name, v]) => [
      name,
      plain(v)
        ? Object.fromEntries(Object.entries(v).filter(([k]) => !COMBO_OVERRIDE_KEYS.includes(k)))
        : v,
    ])
  );
  for (const [name, v] of Object.entries(document.settings.comboStrategies || {}))
    overrides[name] = { ...(plain(overrides[name]) ? overrides[name] : {}), ...v };
  raw.comboStrategies = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => !plain(v) || Object.keys(v).length)
  );
  db.run(
    'INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    [stringifyJson(raw)]
  );
}

export function createConfigurationRepository({
  scope = ROUTING_SCOPE,
  coverage = ROUTING_COVERAGE,
  read = readRoutingConfig,
  assert = assertRoutingDocument,
  validateDocument,
  write = writeCoveredConfiguration,
  refresh = () => resetComboRotation(),
  references,
  requireDraftBase = false,
} = {}) {
  const CONFIG_SCOPE = scope,
    CONFIG_COVERAGE = coverage;
  const readConfigVersion = (db, id) => readVersion(db, id, scope);
  const snapshotCurrent = (db, document, provenance) => snapshot(db, document, provenance, scope);
  const insertConfigVersion = (db, document, options) =>
    insertVersion(db, document, { ...options, scope });
  const appendConfigReceipt = (db, options) => appendReceipt(db, { ...options, scope });
  const operator = { source: 'admin.configuration', actorClass: 'operator' };
  const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const requireHash = (value) => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
      throw new ConfigurationError('expected_current_required');
  };
  const requireRevision = (value) => {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new ConfigurationError('expected_revision_required');
  };
  const positiveId = (value) => {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new ConfigurationError('invalid_version_id');
  };
  const readDraft = (db, id) =>
    db.get('SELECT * FROM configDrafts WHERE id = ? AND scope = ?', [id, CONFIG_SCOPE]) || null;
  const receiptRow = (row) =>
    row ? { ...row, details: parseJson(row.details), provenance: parseJson(row.provenance) } : null;
  function requiredDraft(db, id, revision) {
    const draft = readDraft(db, id);
    if (!draft) throw new ConfigurationError('draft_not_found', 404);
    if (revision !== undefined && revision !== draft.revision)
      throw new ConfigurationError('draft_revision_conflict', 409, {
        currentRevision: draft.revision,
      });
    return draft;
  }
  function checkCurrent(db, expectedCurrent) {
    const document = read(db),
      currentHash = configHash(document);
    if (currentHash !== expectedCurrent)
      throw new ConfigurationError('configuration_conflict', 409, { currentHash });
    return document;
  }
  function readCatalog(db) {
    const kv = (scope) =>
      Object.fromEntries(
        db
          .all('SELECT key, value FROM kv WHERE scope = ?', [scope])
          .map((r) => [r.key, parseJson(r.value)])
      );
    return {
      customModels: Object.values(kv('customModels')),
      freeModels: kv('freeModels'),
      connections: db.all('SELECT id, provider FROM providerConnections'),
    };
  }
  function validate(db, document, context) {
    return validateDocument
      ? validateDocument(db, document, context)
      : validateRoutingDocument(document, readCatalog(db));
  }
  const flush = (db) => {
    if (typeof db.flush === 'function') db.flush();
  };
  function persistedTransaction(db, fn) {
    const result = db.transaction(fn);
    flush(db);
    return result;
  }

  async function getCurrentConfiguration() {
    const db = await getAdapter();
    return db.transaction(() => {
      const document = read(db),
        currentHash = configHash(document);
      const row = db.get(
        "SELECT id FROM configVersions WHERE scope = ? AND contentHash = ? AND kind != 'draft' ORDER BY id DESC LIMIT 1",
        [CONFIG_SCOPE, currentHash]
      );
      return {
        document,
        currentHash,
        versionId: row?.id ?? null,
        coverage: CONFIG_COVERAGE,
        ...(references ? { references: references(db, document) } : {}),
        validation: validate(db, document),
      };
    });
  }
  async function getConfigurationVersion(id) {
    positiveId(id);
    const version = readConfigVersion(await getAdapter(), id);
    if (!version) throw new ConfigurationError('version_not_found', 404);
    return version;
  }
  async function listConfigurationVersions({ before = Number.MAX_SAFE_INTEGER, limit = 30 } = {}) {
    positiveId(before);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ConfigurationError('invalid_limit');
    const db = await getAdapter();
    return db
      .all(
        'SELECT id, scope, kind, parentVersionId, draftId, revision, contentHash, provenance, createdAt FROM configVersions WHERE scope = ? AND id < ? ORDER BY id DESC LIMIT ?',
        [CONFIG_SCOPE, before, limit]
      )
      .map((r) => ({ ...r, provenance: parseJson(r.provenance) }));
  }
  async function listConfigurationReceipts({ before = Number.MAX_SAFE_INTEGER, limit = 30 } = {}) {
    positiveId(before);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ConfigurationError('invalid_limit');
    const db = await getAdapter();
    return db
      .all('SELECT * FROM configReceipts WHERE scope = ? AND id < ? ORDER BY id DESC LIMIT ?', [
        CONFIG_SCOPE,
        before,
        limit,
      ])
      .map(receiptRow);
  }
  async function getConfigurationDraft(id) {
    const db = await getAdapter();
    return db.transaction(() => {
      const draft = requiredDraft(db, id);
      const version = readConfigVersion(db, draft.currentVersionId),
        current = read(db);
      return {
        ...draft,
        version,
        currentHash: configHash(current),
        diff: configDiff(current, version.document),
      };
    });
  }
  async function listConfigurationDrafts({ limit = 30, before = null } = {}) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (before !== null && (typeof before !== 'string' || before.length > 64))
    )
      throw new ConfigurationError('invalid_pagination');
    const db = await getAdapter();
    return db.all(
      'SELECT * FROM configDrafts WHERE scope = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?',
      [CONFIG_SCOPE, before, before, limit]
    );
  }
  async function createConfigurationDraft({ document, expectedCurrent, restoration }) {
    requireHash(expectedCurrent);
    const projected = assert(document);
    const db = await getAdapter();
    return persistedTransaction(db, () => {
      const current = checkCurrent(db, expectedCurrent);
      const parent = snapshotCurrent(db, current, operator);
      const id = randomUUID(),
        now = new Date().toISOString();
      const version = insertConfigVersion(db, projected, {
        kind: 'draft',
        parentVersionId: parent.id,
        draftId: id,
        revision: 1,
        provenance: operator,
      });
      db.run(
        'INSERT INTO configDrafts(id, scope, baseHash, currentVersionId, revision, createdAt, updatedAt) VALUES(?, ?, ?, ?, 1, ?, ?)',
        [id, CONFIG_SCOPE, expectedCurrent, version.id, now, now]
      );
      const receipt = appendConfigReceipt(db, {
        action: 'draft-created',
        outcome: 'applied',
        beforeVersionId: parent.id,
        targetVersionId: version.id,
        beforeHash: expectedCurrent,
        afterHash: expectedCurrent,
        details: { effectiveConfigurationChanged: false, ...(restoration ? { restoration } : {}) },
        provenance: operator,
      });
      return { ...readDraft(db, id), version, diff: configDiff(current, projected), receipt };
    });
  }
  async function reviseConfigurationDraft(id, { document, expectedRevision }) {
    requireRevision(expectedRevision);
    const projected = assert(document);
    const db = await getAdapter();
    return persistedTransaction(db, () => {
      const draft = requiredDraft(db, id, expectedRevision);
      const revision = draft.revision + 1;
      const version = insertConfigVersion(db, projected, {
        kind: 'draft',
        parentVersionId: draft.currentVersionId,
        draftId: id,
        revision,
        provenance: operator,
      });
      db.run(
        'UPDATE configDrafts SET currentVersionId = ?, revision = ?, updatedAt = ? WHERE id = ? AND revision = ?',
        [version.id, revision, new Date().toISOString(), id, expectedRevision]
      );
      appendConfigReceipt(db, {
        action: 'draft-revised',
        outcome: 'applied',
        targetVersionId: version.id,
        details: { effectiveConfigurationChanged: false },
        provenance: operator,
      });
      return { ...readDraft(db, id), version };
    });
  }
  async function validateConfigurationDraft(id, { expectedRevision }) {
    requireRevision(expectedRevision);
    const db = await getAdapter();
    return persistedTransaction(db, () => {
      const draft = requiredDraft(db, id, expectedRevision),
        version = readConfigVersion(db, draft.currentVersionId);
      const result = validate(db, version.document),
        currentHash = configHash(read(db));
      const receipt = appendConfigReceipt(db, {
        action: 'validate',
        outcome: result.valid ? 'applied' : 'failed',
        targetVersionId: version.id,
        beforeHash: currentHash,
        afterHash: currentHash,
        details: {
          valid: result.valid,
          errors: result.errors,
          effectiveConfigurationChanged: false,
        },
        provenance: operator,
      });
      return {
        ...result,
        draftId: id,
        revision: draft.revision,
        versionId: version.id,
        currentHash,
        baseChanged: currentHash !== draft.baseHash,
        receipt,
      };
    });
  }

  async function publishConfiguration({
    draftId,
    expectedRevision,
    versionId,
    expectedCurrent,
    action,
    consent = [],
  }) {
    requireHash(expectedCurrent);
    if (action === 'activate') requireRevision(expectedRevision);
    else positiveId(versionId);
    const db = await getAdapter(),
      operationId = randomUUID();
    let target, staged, before;
    // No await exists between this stage and the transaction: local writers run
    // serially on the same adapter. SQLite still guards against other processes.
    db.transaction(() => {
      before = read(db);
      if (action === 'activate') {
        const draft = requiredDraft(db, draftId, expectedRevision);
        target = readConfigVersion(db, draft.currentVersionId);
      } else {
        target = readConfigVersion(db, versionId);
        if (!target || target.kind === 'draft')
          throw new ConfigurationError('published_version_required', 404);
      }
      staged = appendConfigReceipt(db, {
        operationId,
        action,
        outcome: 'staged',
        targetVersionId: target.id,
        beforeHash: configHash(before),
        details: { expectedCurrent, effectiveConfigurationChanged: false },
        provenance: operator,
      });
    });
    try {
      flush(db);
    } catch {
      throw new ConfigurationError('configuration_stage_persistence_failed', 500, {
        currentHash: staged.beforeHash,
        effectiveConfigurationChanged: false,
      });
    }
    let published, applied;
    try {
      db.transaction(() => {
        before = checkCurrent(db, expectedCurrent);
        if (action === 'activate') {
          const draft = requiredDraft(db, draftId, expectedRevision);
          if (requireDraftBase && draft.baseHash !== expectedCurrent)
            throw new ConfigurationError('draft_base_conflict', 409, {
              currentHash: expectedCurrent,
            });
        }
        const result = validate(db, target.document, { before, consent, activation: true });
        if (!result.valid)
          throw new ConfigurationError('configuration_invalid', 422, { validation: result });
        const parent = snapshotCurrent(db, before, operator);
        write(db, target.document);
        const after = read(db);
        if (canonicalConfig(after) !== canonicalConfig(target.document))
          throw new ConfigurationError('configuration_readback_mismatch', 500);
        published = insertConfigVersion(db, after, {
          kind: action === 'activate' ? 'activation' : 'rollback',
          parentVersionId: parent.id,
          provenance: operator,
        });
        applied = appendConfigReceipt(db, {
          operationId,
          action,
          outcome: 'applied',
          beforeVersionId: parent.id,
          afterVersionId: published.id,
          targetVersionId: target.id,
          beforeHash: parent.contentHash,
          afterHash: published.contentHash,
          details: {
            databaseCommitted: true,
            runtimeRefresh: 'pending',
            effect: CONFIG_COVERAGE.takesEffect,
          },
          provenance: operator,
        });
      });
    } catch (error) {
      const currentHash = configHash(read(db));
      const code = error instanceof ConfigurationError ? error.code : 'configuration_write_failed';
      const receipt = appendConfigReceipt(db, {
        operationId,
        action,
        outcome: error.status === 409 ? 'conflict' : 'failed',
        targetVersionId: target.id,
        beforeHash: staged.beforeHash,
        afterHash: currentHash,
        details: { code, databaseCommitted: false },
        provenance: operator,
      });
      let receiptPersisted = true;
      try {
        flush(db);
      } catch {
        receiptPersisted = false;
      }
      throw new ConfigurationError(code, error.status || 500, {
        ...(error instanceof ConfigurationError ? error.details : {}),
        currentHash,
        receipt,
        receiptPersisted,
      });
    }
    try {
      flush(db);
    } catch {
      return {
        outcome: 'partial',
        version: published,
        currentHash: published.contentHash,
        receipt: applied,
        completion: {
          databaseCommitted: true,
          persistence: 'failed',
          runtimeRefresh: 'not_attempted',
          recovery:
            'Effective in this process; disk persistence is unconfirmed. Preserve this process and retry an explicit flush after fixing storage. Do not replay activation automatically.',
        },
      };
    }
    let runtimeRefresh = 'applied';
    try {
      await refresh(before, published.document);
    } catch {
      runtimeRefresh = 'failed';
    }
    const outcome = runtimeRefresh === 'applied' ? 'applied' : 'partial';
    const details = {
      databaseCommitted: true,
      runtimeRefresh,
      effect: CONFIG_COVERAGE.takesEffect,
      ...(runtimeRefresh === 'failed'
        ? {
            recovery:
              'Configuration is effective; restart this process to reset rotation state. Do not replay activation automatically.',
          }
        : {}),
    };
    let receipt;
    try {
      receipt = appendConfigReceipt(db, {
        operationId,
        action,
        outcome,
        beforeVersionId: applied.beforeVersionId,
        afterVersionId: published.id,
        targetVersionId: target.id,
        beforeHash: applied.beforeHash,
        afterHash: published.contentHash,
        details,
        provenance: operator,
      });
      flush(db);
    } catch {
      // The transaction's applied receipt already proves the database commit.
      // Do not disguise that commit as a failed activation or retry its writes.
      return {
        outcome: 'partial',
        version: published,
        currentHash: published.contentHash,
        receipt: applied,
        completion: { ...details, auditFinalization: 'failed' },
      };
    }
    return {
      outcome,
      version: published,
      currentHash: published.contentHash,
      receipt,
      diff: configDiff(before, published.document),
    };
  }
  function activateConfigurationDraft(id, options) {
    return publishConfiguration({ ...options, draftId: id, action: 'activate' });
  }
  function rollbackConfigurationVersion(versionId, options) {
    return publishConfiguration({ ...options, versionId, action: 'rollback' });
  }

  async function getConfigurationComparison(id) {
    positiveId(id);
    const db = await getAdapter();
    return db.transaction(() => {
      const version = readConfigVersion(db, id);
      if (!version) throw new ConfigurationError('version_not_found', 404);
      const current = read(db);
      return {
        version,
        currentHash: configHash(current),
        diff: configDiff(current, version.document),
      };
    });
  }
  async function restoreConfigurationSelection(versionId, { expectedCurrent, paths }) {
    positiveId(versionId);
    requireHash(expectedCurrent);
    const db = await getAdapter();
    const current = checkCurrent(db, expectedCurrent),
      target = readConfigVersion(db, versionId);
    if (!target || target.kind === 'draft')
      throw new ConfigurationError('published_version_required', 404);
    const diff = configDiff(current, target.document);
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 1000 ||
      new Set(paths).size !== paths.length ||
      paths.some((path) => !diff.some((change) => change.path === path))
    )
      throw new ConfigurationError('invalid_restore_paths');
    const document = structuredClone(current);
    for (const path of paths) {
      const parts = path
        .slice(1)
        .split('/')
        .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
      if (parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part)))
        throw new ConfigurationError('invalid_restore_paths');
      let source = target.document,
        destination = document;
      for (const part of parts.slice(0, -1)) {
        source = source?.[part];
        destination = destination[part];
      }
      const key = parts.at(-1);
      if (source && Object.hasOwn(source, key)) destination[key] = structuredClone(source[key]);
      else delete destination[key];
    }
    return createConfigurationDraft({
      document,
      expectedCurrent,
      restoration: { sourceVersionId: versionId, paths },
    });
  }

  return {
    getCurrentConfiguration,
    getConfigurationVersion,
    listConfigurationVersions,
    listConfigurationReceipts,
    listConfigurationDrafts,
    getConfigurationDraft,
    createConfigurationDraft,
    reviseConfigurationDraft,
    validateConfigurationDraft,
    activateConfigurationDraft,
    rollbackConfigurationVersion,
    getConfigurationComparison,
    restoreConfigurationSelection,
  };
}
export const {
  getCurrentConfiguration,
  getConfigurationVersion,
  listConfigurationVersions,
  listConfigurationReceipts,
  listConfigurationDrafts,
  getConfigurationDraft,
  createConfigurationDraft,
  reviseConfigurationDraft,
  validateConfigurationDraft,
  activateConfigurationDraft,
  rollbackConfigurationVersion,
  getConfigurationComparison,
  restoreConfigurationSelection,
} = createConfigurationRepository();
