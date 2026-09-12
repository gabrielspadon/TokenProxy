import { setMetaSync } from './helpers/metaStore.js';
import { telemetryFilterSql } from './analytics/telemetryFilter.mjs';

export const ECONOMICS_PROJECTION_VERSION = 3;
export const ECONOMICS_PROJECTION_META_KEY = 'economicsProjectionVersion';
export const ECONOMICS_FLAGS = Object.freeze({
  linked: 1,
  conflict: 2,
  unavailable: 4,
  explicitSession: 8,
  clientProject: 16,
  task: 32,
  client: 64,
  initialAttempt: 128,
  additionalAttempt: 256,
  physicalDispatch: 512,
  executorInvocation: 1024,
  unknownDispatch: 2048,
  succeeded: 4096,
  failed: 8192,
  pending: 16384,
  rateSnapshot: 32768,
  confirmedCost: 65536,
  providerReportedCost: 131072,
  unknownCostSource: 262144,
});

export const ECONOMICS_PROJECTION_TABLES = {
  usageEconomicsProjection: {
    columns: {
      id: 'INTEGER PRIMARY KEY REFERENCES usageHistory(id) ON DELETE CASCADE',
      dataOrigin: "TEXT DEFAULT 'unknown'",
      timestamp: 'TEXT NOT NULL',
      timestampMs: 'INTEGER',
      provider: 'TEXT',
      model: 'TEXT',
      connectionId: 'TEXT',
      status: 'TEXT',
      requestId: 'TEXT',
      logicalRequestId: 'TEXT',
      attempt: 'INTEGER',
      contextSessionId: 'INTEGER',
      projectId: 'TEXT',
      rateSnapshotId: 'TEXT',
      costSource: 'TEXT',
      estimatedCostUsd: 'REAL',
      reportedCostUsd: 'REAL',
      dispatchCoverage: 'TEXT',
      requestLink: 'TEXT NOT NULL',
      clientKeyId: 'TEXT',
      clientIdentitySource: 'TEXT',
      clientRef: 'TEXT',
      clientSessionRef: 'TEXT',
      taskRef: 'TEXT',
      projectRef: 'TEXT',
      prompt: 'INTEGER',
      output: 'INTEGER',
      // BLOB affinity preserves the integer/real storage class returned by JSON.
      cacheRead: 'BLOB',
      cacheWrite: 'BLOB',
      recordedCost: 'REAL',
      invalidTokens: 'INTEGER NOT NULL',
      missingTokenDetail: 'INTEGER NOT NULL',
      latencyMs: 'REAL',
      ttftMs: 'REAL',
      uncachedInput: 'BLOB',
      inconsistentCache: 'INTEGER NOT NULL',
      economicsFlags: 'INTEGER NOT NULL',
      aggregateEstimatedCost: 'REAL',
      aggregateReportedCost: 'REAL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_uep_time ON usageEconomicsProjection(timestamp,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_provider_time ON usageEconomicsProjection(provider,timestamp,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_model_time ON usageEconomicsProjection(model,timestamp,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_connection_time ON usageEconomicsProjection(connectionId,timestamp,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_provider_logical ON usageEconomicsProjection(provider,logicalRequestId)',
      'CREATE INDEX IF NOT EXISTS idx_uep_model_logical ON usageEconomicsProjection(provider,model,logicalRequestId)',
      'CREATE INDEX IF NOT EXISTS idx_uep_connection_logical ON usageEconomicsProjection(provider,connectionId,logicalRequestId)',
      'CREATE INDEX IF NOT EXISTS idx_uep_latency ON usageEconomicsProjection(latencyMs)',
      'CREATE INDEX IF NOT EXISTS idx_uep_provider_latency ON usageEconomicsProjection(provider,latencyMs)',
      'CREATE INDEX IF NOT EXISTS idx_uep_request ON usageEconomicsProjection(requestId)',
      'CREATE INDEX IF NOT EXISTS idx_uep_logical ON usageEconomicsProjection(logicalRequestId,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_session ON usageEconomicsProjection(contextSessionId,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_project ON usageEconomicsProjection(projectId,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_client_project ON usageEconomicsProjection(clientKeyId,clientRef,projectRef,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_client_ref ON usageEconomicsProjection(clientRef,timestamp,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_client_session ON usageEconomicsProjection(clientSessionRef,timestamp,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_task_ref ON usageEconomicsProjection(taskRef,timestamp,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_project_ref ON usageEconomicsProjection(projectRef,timestamp,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_request_link ON usageEconomicsProjection(requestLink,timestamp,id)',
      'CREATE INDEX IF NOT EXISTS idx_uep_cost_source ON usageEconomicsProjection(costSource,timestamp,id)',
    ],
  },
};

const TABLE = 'usageEconomicsProjection';
const TRIGGERS = [
  'usage_economics_after_insert',
  'usage_economics_after_update',
  'usage_economics_after_delete',
  'request_economics_after_insert',
  'request_economics_after_update',
  'request_economics_after_delete',
  'quarantine_row_economics_after_insert',
  'quarantine_row_economics_after_update',
  'quarantine_row_economics_after_delete',
  'quarantine_receipt_economics_after_insert',
  'quarantine_receipt_economics_after_update',
  'quarantine_receipt_economics_after_delete',
];
const COLUMNS = Object.keys(ECONOMICS_PROJECTION_TABLES[TABLE].columns);
const STORAGE_CLASS_COLUMNS = ['cacheRead', 'cacheWrite', 'uncachedInput'];
const storageClassesPreserved = db => {
  const types = new Map(db.all(`PRAGMA table_info(${TABLE})`).map(row => [row.name, row.type.toUpperCase()]));
  return COLUMNS.every(name => types.has(name)) && STORAGE_CLASS_COLUMNS.every(name => types.get(name) === 'BLOB');
};
const validNumber = field => `(typeof(${field}) IN ('integer','real') AND ${field}>=0 AND ${field}<=1.7976931348623157e308)`;
const validToken = field => `(${validNumber(field)} AND ${field}<=9007199254740991)`;
const quantity = field => `CASE WHEN ${validToken(field)} THEN ${field} END`;
const safeTokens = "CASE WHEN json_valid(u.tokens) AND json_type(u.tokens)='object' THEN u.tokens ELSE '{}' END";
const token = field => `json_extract(${safeTokens},'$.${field}')`;
const exactAgreement = ['logicalRequestId', 'contextSessionId', 'attempt', 'provider', 'model', 'connectionId']
  .map(field => `(u.${field} IS NULL OR u.${field}=r.${field})`).join(' AND ');
const exact = 'r.id IS NOT NULL';
const durableIdentity = "u.clientIdentitySource='client-reported' AND u.clientKeyId IS NOT NULL";
const requestIdentity = `${exact} AND r.clientIdentitySource='client-reported' AND r.clientKeyId IS NOT NULL`;
const retainedRef = field => `CASE WHEN length(u.${field})=69 AND substr(u.${field},1,5)='ctx1_' AND substr(u.${field},6) NOT GLOB '*[^a-f0-9]*' THEN u.${field} END`;
const requestRef = field => `CASE WHEN ${requestIdentity} AND length(r.${field})=69 AND substr(r.${field},1,5)='ctx1_' AND substr(r.${field},6) NOT GLOB '*[^a-f0-9]*' THEN r.${field} END`;
const identityRef = field => `CASE WHEN ${durableIdentity} THEN ${retainedRef(field)} ELSE ${requestRef(field)} END`;
const prompt = `CASE WHEN ${token('input_tokens_present')}=0 THEN NULL ELSE ${quantity('u.promptTokens')} END`;
const output = `CASE WHEN ${token('output_tokens_present')}=0 THEN NULL ELSE ${quantity('u.completionTokens')} END`;
const cacheRead = quantity(token('cached_tokens'));
const cacheWrite = quantity(token('cache_creation_input_tokens'));
const invalidTokenDetail = `CASE WHEN json_valid(u.tokens) THEN CASE WHEN json_type(u.tokens)='object' THEN 0 ELSE 1 END ELSE 1 END`;
const invalidTokens = `CASE WHEN ${invalidTokenDetail} OR NOT ${validToken('u.promptTokens')} OR NOT ${validToken('u.completionTokens')}
  OR (json_type(${safeTokens},'$.cached_tokens') IS NOT NULL AND NOT ${validToken(token('cached_tokens'))})
  OR (json_type(${safeTokens},'$.cache_creation_input_tokens') IS NOT NULL AND NOT ${validToken(token('cache_creation_input_tokens'))}) THEN 1 ELSE 0 END`;
const missingTokenDetail = `CASE WHEN NOT ${validToken(token('cached_tokens'))} OR NOT ${validToken(token('cache_creation_input_tokens'))} THEN 1 ELSE 0 END`;
const requestLink = `CASE WHEN u.requestId IS NULL THEN 'unattributed' WHEN ${exact} THEN 'linked'
  WHEN EXISTS(SELECT 1 FROM requestStats request_match WHERE request_match.id=u.requestId
    AND ${telemetryFilterSql('requestStats', 'request_match')}) THEN 'conflict' ELSE 'unavailable' END`;
const flag = (condition, bit) => `CASE WHEN ${condition} THEN ${bit} ELSE 0 END`;
const economicsFlags = [
  `CASE ${requestLink} WHEN 'linked' THEN ${ECONOMICS_FLAGS.linked} WHEN 'conflict' THEN ${ECONOMICS_FLAGS.conflict}
    WHEN 'unavailable' THEN ${ECONOMICS_FLAGS.unavailable} ELSE 0 END`,
  flag('u.contextSessionId IS NOT NULL', ECONOMICS_FLAGS.explicitSession),
  flag(`${identityRef('projectRef')} IS NOT NULL`, ECONOMICS_FLAGS.clientProject),
  flag(`${identityRef('taskRef')} IS NOT NULL`, ECONOMICS_FLAGS.task),
  flag(`${identityRef('clientRef')} IS NOT NULL`, ECONOMICS_FLAGS.client),
  `CASE WHEN u.logicalRequestId IS NOT NULL AND u.dispatchCoverage='physical-dispatch' AND typeof(u.attempt)='integer'
    THEN CASE WHEN u.attempt=1 THEN ${ECONOMICS_FLAGS.initialAttempt} WHEN u.attempt>1 THEN ${ECONOMICS_FLAGS.additionalAttempt} ELSE 0 END ELSE 0 END`,
  `CASE u.dispatchCoverage WHEN 'physical-dispatch' THEN ${ECONOMICS_FLAGS.physicalDispatch}
    WHEN 'executor-invocation' THEN ${ECONOMICS_FLAGS.executorInvocation}
    ELSE CASE WHEN u.dispatchCoverage IS NULL THEN ${ECONOMICS_FLAGS.unknownDispatch} ELSE 0 END END`,
  `CASE u.status WHEN 'success' THEN ${ECONOMICS_FLAGS.succeeded} WHEN 'ok' THEN ${ECONOMICS_FLAGS.succeeded}
    WHEN 'error' THEN ${ECONOMICS_FLAGS.failed} WHEN 'aborted' THEN ${ECONOMICS_FLAGS.failed}
    WHEN 'cancelled' THEN ${ECONOMICS_FLAGS.failed} WHEN 'pending' THEN ${ECONOMICS_FLAGS.pending} ELSE 0 END`,
  flag('u.rateSnapshotId IS NOT NULL', ECONOMICS_FLAGS.rateSnapshot),
  `CASE u.costSource WHEN 'provider-confirmed' THEN ${ECONOMICS_FLAGS.confirmedCost}
    WHEN 'provider-reported' THEN ${ECONOMICS_FLAGS.providerReportedCost}
    WHEN 'unknown' THEN ${ECONOMICS_FLAGS.unknownCostSource}
    ELSE CASE WHEN u.costSource IS NULL THEN ${ECONOMICS_FLAGS.unknownCostSource} ELSE 0 END END`,
].join('+');

function projectionSelect(where = '') {
  return `SELECT u.id,u.dataOrigin,u.timestamp,CAST(strftime('%s',u.timestamp) AS INTEGER)*1000,u.provider,u.model,u.connectionId,u.status,
    u.requestId,u.logicalRequestId,u.attempt,u.contextSessionId,u.projectId,u.rateSnapshotId,u.costSource,u.estimatedCostUsd,u.reportedCostUsd,u.dispatchCoverage,
    ${requestLink},
    COALESCE(u.clientKeyId,CASE WHEN ${exact} THEN r.clientKeyId END),
    COALESCE(u.clientIdentitySource,CASE WHEN ${exact} THEN r.clientIdentitySource END),
    ${identityRef('clientRef')},${identityRef('clientSessionRef')},${identityRef('taskRef')},${identityRef('projectRef')},
    ${prompt},${output},${cacheRead},${cacheWrite},
    CASE WHEN ${validNumber('u.cost')} THEN u.cost END,${invalidTokens},${missingTokenDetail},
    CASE WHEN ${exact} AND ${validNumber('r.latencyTotal')} AND r.latencyTotal>0 THEN r.latencyTotal END,
    CASE WHEN ${exact} AND ${validNumber('r.latencyTtft')} AND r.latencyTtft>0 THEN r.latencyTtft END,
    MAX(0,${prompt}-${cacheRead}-${cacheWrite}),CASE WHEN ${cacheRead}+${cacheWrite}>${prompt} THEN 1 ELSE 0 END,
    ${economicsFlags},CASE WHEN ${validNumber('u.estimatedCostUsd')} THEN u.estimatedCostUsd END,
    CASE WHEN ${validNumber('u.reportedCostUsd')} THEN u.reportedCostUsd END
    FROM usageHistory u LEFT JOIN requestStats r ON r.id=u.requestId AND ${exactAgreement}
      AND ${telemetryFilterSql('requestStats', 'r')} ${where}`;
}

const replaceProjection = where => `INSERT OR REPLACE INTO ${TABLE}(${COLUMNS.join(',')}) ${projectionSelect(where)};`;

// Refresh exact dependent identities through the existing request/source indexes.
// Every source usage row remains projected, including excluded rows. Visibility
// belongs to reads; these refreshes only change linked request evidence.
const usageDependents = reference => `SELECT linked.id FROM requestStats source JOIN usageHistory linked ON linked.requestId=source.id
  WHERE source.sourceUsageId=${reference}.id`;
const quarantineIdentity = reference => `WHERE u.id IN (
    SELECT id FROM usageHistory WHERE ${reference}.sourceTable='usageHistory' AND id=${reference}.rowId
    UNION SELECT linked.id FROM requestStats source JOIN usageHistory linked ON linked.requestId=source.id
      WHERE ${reference}.sourceTable='usageHistory' AND source.sourceUsageId=${reference}.rowId
    UNION SELECT id FROM usageHistory WHERE ${reference}.sourceTable='requestStats' AND requestId=${reference}.rowId)`;
const quarantineReceipt = receiptIds => `WHERE u.id IN (
    SELECT linked.id FROM telemetryQuarantineRows q JOIN usageHistory linked ON linked.id=q.rowId
      WHERE q.receiptId IN (${receiptIds}) AND q.sourceTable='usageHistory'
    UNION SELECT linked.id FROM telemetryQuarantineRows q JOIN usageHistory linked ON linked.requestId=q.rowId
      WHERE q.receiptId IN (${receiptIds}) AND q.sourceTable='requestStats'
    UNION SELECT linked.id FROM telemetryQuarantineRows q JOIN requestStats source ON source.sourceUsageId=q.rowId
      JOIN usageHistory linked ON linked.requestId=source.id
      WHERE q.receiptId IN (${receiptIds}) AND q.sourceTable='usageHistory')`;

const triggerDefinitions = () => ({
  usage_economics_after_insert: `CREATE TRIGGER usage_economics_after_insert AFTER INSERT ON usageHistory BEGIN
    ${replaceProjection(`WHERE u.id IN (SELECT NEW.id UNION ${usageDependents('NEW')})`)} END`,
  usage_economics_after_update: `CREATE TRIGGER usage_economics_after_update AFTER UPDATE ON usageHistory BEGIN
    DELETE FROM ${TABLE} WHERE id=OLD.id AND OLD.id<>NEW.id;
    ${replaceProjection(`WHERE u.id IN (SELECT NEW.id UNION ${usageDependents('NEW')} UNION ${usageDependents('OLD')})`)} END`,
  usage_economics_after_delete: `CREATE TRIGGER usage_economics_after_delete AFTER DELETE ON usageHistory BEGIN
    DELETE FROM ${TABLE} WHERE id=OLD.id;
    ${replaceProjection(`WHERE u.id IN (${usageDependents('OLD')})`)} END`,
  request_economics_after_insert: `CREATE TRIGGER request_economics_after_insert AFTER INSERT ON requestStats BEGIN
    ${replaceProjection('WHERE u.requestId=NEW.id')} END`,
  request_economics_after_update: `CREATE TRIGGER request_economics_after_update AFTER UPDATE ON requestStats BEGIN
    ${replaceProjection('WHERE u.requestId=NEW.id OR u.requestId=OLD.id')} END`,
  request_economics_after_delete: `CREATE TRIGGER request_economics_after_delete AFTER DELETE ON requestStats BEGIN
    ${replaceProjection('WHERE u.requestId=OLD.id')} END`,
  quarantine_row_economics_after_insert: `CREATE TRIGGER quarantine_row_economics_after_insert AFTER INSERT ON telemetryQuarantineRows BEGIN
    ${replaceProjection(quarantineIdentity('NEW'))} END`,
  quarantine_row_economics_after_update: `CREATE TRIGGER quarantine_row_economics_after_update AFTER UPDATE ON telemetryQuarantineRows BEGIN
    ${replaceProjection(quarantineIdentity('OLD'))}
    ${replaceProjection(quarantineIdentity('NEW'))} END`,
  quarantine_row_economics_after_delete: `CREATE TRIGGER quarantine_row_economics_after_delete AFTER DELETE ON telemetryQuarantineRows BEGIN
    ${replaceProjection(quarantineIdentity('OLD'))} END`,
  quarantine_receipt_economics_after_insert: `CREATE TRIGGER quarantine_receipt_economics_after_insert AFTER INSERT ON telemetryQuarantineReceipts BEGIN
    ${replaceProjection(quarantineReceipt('NEW.id'))} END`,
  quarantine_receipt_economics_after_update: `CREATE TRIGGER quarantine_receipt_economics_after_update AFTER UPDATE OF state,id ON telemetryQuarantineReceipts BEGIN
    ${replaceProjection(quarantineReceipt('OLD.id,NEW.id'))} END`,
  quarantine_receipt_economics_after_delete: `CREATE TRIGGER quarantine_receipt_economics_after_delete AFTER DELETE ON telemetryQuarantineReceipts BEGIN
    ${replaceProjection(quarantineReceipt('OLD.id'))} END`,
});
const canonicalSql = sql => sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();

function createTriggers(db) {
  for (const sql of Object.values(triggerDefinitions())) db.exec(`${sql};`);
}

export function economicsProjectionReady(db, { verifyIntegrity = false } = {}) {
  const objects = new Map(db.all(`SELECT name${verifyIntegrity ? ',sql' : ''} FROM sqlite_master WHERE type IN ('table','trigger')`)
    .map(row => [row.name, row.sql]));
  if (!objects.has(TABLE) || TRIGGERS.some(name => !objects.has(name)) || !objects.has('_meta')) return false;
  if (db.get('SELECT value FROM _meta WHERE key=?', [ECONOMICS_PROJECTION_META_KEY])?.value !== String(ECONOMICS_PROJECTION_VERSION)) return false;
  if (!verifyIntegrity) return true;
  if (!storageClassesPreserved(db)) return false;
  const definitions = triggerDefinitions();
  if (TRIGGERS.some(name => canonicalSql(objects.get(name)) !== canonicalSql(definitions[name]))) return false;
  const foreignKey = db.all(`PRAGMA foreign_key_list(${TABLE})`);
  if (foreignKey.length !== 1 || foreignKey[0].table !== 'usageHistory' || foreignKey[0].from !== 'id'
    || foreignKey[0].to !== 'id' || foreignKey[0].on_delete !== 'CASCADE') return false;
  if (db.all(`PRAGMA foreign_key_check(${TABLE})`).length) return false;
  const source = db.get('SELECT COUNT(*) AS count FROM usageHistory').count;
  if (db.get(`SELECT COUNT(*) AS count FROM ${TABLE}`).count !== source) return false;
  return !db.get(`SELECT 1 FROM usageHistory u LEFT JOIN ${TABLE} p ON p.id=u.id WHERE p.id IS NULL LIMIT 1`)
    && !db.get(`SELECT 1 FROM ${TABLE} p LEFT JOIN usageHistory u ON u.id=p.id WHERE u.id IS NULL LIMIT 1`);
}

export function ensureEconomicsProjection(db, { verifiedReady } = {}) {
  // A failed pre-sync check must force rebuilding. Additive schema repair can
  // supply default origins, but those defaults are not source provenance.
  if (verifiedReady === true || (verifiedReady === undefined && economicsProjectionReady(db, { verifyIntegrity: true }))) return false;
  for (const trigger of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  if (!storageClassesPreserved(db)) {
    db.exec(`DROP TABLE ${TABLE}`);
    db.exec(`CREATE TABLE ${TABLE} (${COLUMNS.map(name => `${name} ${ECONOMICS_PROJECTION_TABLES[TABLE].columns[name]}`).join(',')})`);
  } else db.exec(`DELETE FROM ${TABLE}`);
  db.exec(`${replaceProjection('')} `);
  createTriggers(db);
  setMetaSync(db, ECONOMICS_PROJECTION_META_KEY, ECONOMICS_PROJECTION_VERSION);
  return true;
}

export function ensureEconomicsProjectionIndexes(db) {
  for (const sql of ECONOMICS_PROJECTION_TABLES[TABLE].indexes) db.exec(sql);
}
