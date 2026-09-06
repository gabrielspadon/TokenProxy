// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
import { QUOTA_HISTORY_TABLES } from './schema/quotaHistory.js';
import { CONFIG_VERSION_TABLES } from './configVersionSchema.js';
import {
  CONTEXT_EVIDENCE_TABLES,
  REQUEST_IDENTITY_COLUMNS,
  REQUEST_IDENTITY_INDEXES,
} from './contextEvidenceSchema.js';
import { API_KEY_BUDGET_COLUMNS, BUDGET_TABLES } from './budgetSchema.js';
import { INVESTIGATION_TABLES } from './investigationSchema.js';
import { SESSION_PIN_COLUMNS, SESSION_PIN_TABLES } from './sessionPinSchema.js';
import { SHAPING_TABLES } from './shapingSchema.js';
import { COMPATIBILITY_TABLES } from './compatibilitySchema.js';
import { OPERATION_TABLES } from './operationSchema.js';
import { ACCESS_PROFILE_KEY_COLUMNS, ACCESS_PROFILE_TABLES } from './accessProfileSchema.js';
import { KEY_ROTATION_COLUMNS, KEY_ROTATION_TABLES } from './keyRotationSchema.js';

// 14 = operation events (durable operation evidence). 15 is reserved for
// project budgets - do not reuse it. 16 is left free for a sibling line of
// work; 17 = access profiles and deliberate key rotation.
export const SCHEMA_VERSION = 17;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  ...QUOTA_HISTORY_TABLES,
  ...CONFIG_VERSION_TABLES,
  ...CONTEXT_EVIDENCE_TABLES,
  ...BUDGET_TABLES,
  ...INVESTIGATION_TABLES,
  ...SESSION_PIN_TABLES,
  ...SHAPING_TABLES,
  ...COMPATIBILITY_TABLES,
  ...OPERATION_TABLES,
  ...ACCESS_PROFILE_TABLES,
  ...KEY_ROTATION_TABLES,
  _meta: {
    columns: {
      key: 'TEXT PRIMARY KEY',
      value: 'TEXT NOT NULL',
    },
  },
  settings: {
    columns: {
      id: 'INTEGER PRIMARY KEY CHECK (id = 1)',
      data: 'TEXT NOT NULL',
    },
  },
  providerConnections: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      provider: 'TEXT NOT NULL',
      authType: 'TEXT NOT NULL',
      name: 'TEXT',
      email: 'TEXT',
      priority: 'INTEGER',
      isActive: 'INTEGER DEFAULT 1',
      data: 'TEXT NOT NULL',
      createdAt: 'TEXT NOT NULL',
      updatedAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)',
      'CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)',
      'CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)',
    ],
  },
  providerNodes: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      type: 'TEXT',
      name: 'TEXT',
      data: 'TEXT NOT NULL',
      createdAt: 'TEXT NOT NULL',
      updatedAt: 'TEXT NOT NULL',
    },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)'],
  },
  proxyPools: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      isActive: 'INTEGER DEFAULT 1',
      testStatus: 'TEXT',
      data: 'TEXT NOT NULL',
      createdAt: 'TEXT NOT NULL',
      updatedAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)',
      'CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)',
    ],
  },
  apiKeys: {
    columns: {
      ...API_KEY_BUDGET_COLUMNS,
      ...ACCESS_PROFILE_KEY_COLUMNS,
      ...KEY_ROTATION_COLUMNS,
      id: 'TEXT PRIMARY KEY',
      key: 'TEXT UNIQUE NOT NULL',
      name: 'TEXT',
      machineId: 'TEXT',
      isActive: 'INTEGER DEFAULT 1',
      createdAt: 'TEXT NOT NULL',
      // Optional expiry. NULL means "never expires", which is what a key
      // created without one gets (#2351).
      expiresAt: 'TEXT',
      // Optional spend ceilings. NULL in any of them means "no ceiling", which
      // is what every key issued before them keeps, so an install that upgrades
      // behaves exactly as it did (#3371). The counter is the key's own
      // usageHistory rows — see idx_uh_apikey below — so no bookkeeping table
      // is introduced and a ceiling applies to traffic already recorded.
      maxPromptTokens: 'INTEGER',
      maxCompletionTokens: 'INTEGER',
      maxCostUsd: 'REAL',
    },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)'],
  },
  combos: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT UNIQUE NOT NULL',
      kind: 'TEXT',
      models: 'TEXT NOT NULL',
      createdAt: 'TEXT NOT NULL',
      updatedAt: 'TEXT NOT NULL',
    },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)'],
  },
  kv: {
    columns: {
      scope: 'TEXT NOT NULL',
      key: 'TEXT NOT NULL',
      value: 'TEXT NOT NULL',
    },
    primaryKey: 'PRIMARY KEY (scope, key)',
    indexes: ['CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)'],
  },
  usageHistory: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      timestamp: 'TEXT NOT NULL',
      provider: 'TEXT',
      model: 'TEXT',
      connectionId: 'TEXT',
      apiKey: 'TEXT',
      endpoint: 'TEXT',
      promptTokens: 'INTEGER DEFAULT 0',
      completionTokens: 'INTEGER DEFAULT 0',
      cost: 'REAL DEFAULT 0',
      status: 'TEXT',
      tokens: 'TEXT',
      meta: 'TEXT',
      requestId: 'TEXT',
      logicalRequestId: 'TEXT',
      attempt: 'INTEGER',
      contextSessionId: 'INTEGER',
      projectId: 'TEXT',
      rateSnapshotId: 'TEXT',
      pricingCapturedAt: 'TEXT',
      dispatchCoverage: 'TEXT',
      costSource: 'TEXT',
      costEvidence: 'TEXT',
      usageSource: 'TEXT',
      estimatedCostUsd: 'REAL',
      reportedCostUsd: 'REAL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)',
      'CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)',
      'CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)',
      'CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)',
      // Enforcing an API key's ceiling sums this table for one key on the auth
      // path. Without this index that is a full scan of a table nothing prunes.
      'CREATE INDEX IF NOT EXISTS idx_uh_apikey ON usageHistory(apiKey)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_uh_request_id ON usageHistory(requestId) WHERE requestId IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_uh_logical ON usageHistory(logicalRequestId, id)',
      'CREATE INDEX IF NOT EXISTS idx_uh_session ON usageHistory(contextSessionId, id)',
      'CREATE INDEX IF NOT EXISTS idx_uh_project ON usageHistory(projectId, id)',
    ],
  },
  usageRateSnapshots: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      provider: 'TEXT',
      model: 'TEXT',
      currency: 'TEXT NOT NULL',
      unit: 'TEXT NOT NULL',
      calculatorVersion: 'TEXT NOT NULL',
      source: 'TEXT NOT NULL',
      rates: 'TEXT',
      capturedAt: 'TEXT NOT NULL',
    },
  },
  usageDaily: {
    columns: {
      dateKey: 'TEXT PRIMARY KEY',
      data: 'TEXT NOT NULL',
    },
  },
  requestDetails: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      timestamp: 'TEXT NOT NULL',
      provider: 'TEXT',
      model: 'TEXT',
      connectionId: 'TEXT',
      status: 'TEXT',
      data: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)',
      'CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)',
      'CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)',
      'CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)',
    ],
  },
  // Tracks which provider/models the user has already "seen". Used by the
  // New Models discovery feature to surface newly-added models (free or paid)
  // across every connected provider, including self-added compatible nodes.
  seenModels: {
    columns: {
      id: 'TEXT PRIMARY KEY', // `${providerAlias}::${modelId}`
      providerAlias: 'TEXT NOT NULL',
      modelId: 'TEXT NOT NULL',
      isFree: 'INTEGER DEFAULT 0',
      firstSeenAt: 'TEXT NOT NULL',
      acknowledged: 'INTEGER DEFAULT 0',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_sm_provider ON seenModels(providerAlias)',
      'CREATE INDEX IF NOT EXISTS idx_sm_unseen ON seenModels(acknowledged)',
    ],
  },
  // Full-history statistics source (45-day retention). Written once per
  // request from the same detail used for requestDetails; the Statistics page
  // reads all aggregation from this table only.
  contextSessions: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      sessionHash: 'TEXT UNIQUE NOT NULL',
      identitySource: 'TEXT NOT NULL',
      projectLabel: 'TEXT',
      firstSeenAt: 'TEXT NOT NULL',
      lastSeenAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_cs_seen ON contextSessions(lastSeenAt DESC)',
      'CREATE INDEX IF NOT EXISTS idx_cs_project ON contextSessions(projectLabel)',
    ],
  },
  contextStages: {
    columns: {
      requestId: 'TEXT NOT NULL REFERENCES requestStats(id) ON DELETE CASCADE',
      ordinal: 'INTEGER NOT NULL',
      stage: 'TEXT NOT NULL',
      beforeBytes: 'INTEGER NOT NULL',
      afterBytes: 'INTEGER NOT NULL',
      deltaBytes: 'INTEGER NOT NULL',
      outcome: 'TEXT NOT NULL',
      risk: 'TEXT NOT NULL',
    },
    primaryKey: 'PRIMARY KEY (requestId, ordinal)',
  },
  requestStats: {
    columns: {
      ...REQUEST_IDENTITY_COLUMNS,
      id: 'TEXT PRIMARY KEY',
      timestamp: 'TEXT NOT NULL',
      provider: 'TEXT',
      model: 'TEXT',
      connectionId: 'TEXT',
      status: 'TEXT',
      promptTokens: 'INTEGER DEFAULT 0',
      completionTokens: 'INTEGER DEFAULT 0',
      cachedTokens: 'INTEGER DEFAULT 0',
      cacheCreationTokens: 'INTEGER DEFAULT 0',
      reasoningTokens: 'INTEGER DEFAULT 0',
      latencyTotal: 'INTEGER DEFAULT 0',
      latencyTtft: 'INTEGER DEFAULT 0',
      contextSessionId: 'INTEGER',
      contextTelemetryError: 'TEXT',
      logicalRequestId: 'TEXT',
      rateSnapshotId: 'TEXT',
      pricingCapturedAt: 'TEXT',
      dispatchCoverage: 'TEXT',
      requestedModel: 'TEXT',
      clientTool: 'TEXT',
      contextEstimate: 'INTEGER',
      inputEstimate: 'INTEGER',
      bodyBeforeBytes: 'INTEGER',
      bodyAfterBytes: 'INTEGER',
      cachePrefixBytes: 'INTEGER',
      compactHint: 'INTEGER',
      usageSource: 'TEXT',
      usageInputPresent: 'INTEGER',
      usageOutputPresent: 'INTEGER',
      cacheReadPresent: 'INTEGER',
      cacheWritePresent: 'INTEGER',
      messageCount: 'INTEGER',
      toolCount: 'INTEGER',
      routeKind: 'TEXT',
      formatPair: 'TEXT',
      selection: 'TEXT',
      contextControls: 'TEXT',
      attempt: 'INTEGER',
    },
    indexes: [
      ...REQUEST_IDENTITY_INDEXES,
      'CREATE INDEX IF NOT EXISTS idx_rs_ts ON requestStats(timestamp DESC)',
      'CREATE INDEX IF NOT EXISTS idx_rs_context_session ON requestStats(contextSessionId, timestamp, id)',
      'CREATE INDEX IF NOT EXISTS idx_rs_context_request ON requestStats(logicalRequestId)',
      'CREATE INDEX IF NOT EXISTS idx_rs_context_client ON requestStats(clientTool, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_rs_provider ON requestStats(provider)',
      'CREATE INDEX IF NOT EXISTS idx_rs_model ON requestStats(model)',
      'CREATE INDEX IF NOT EXISTS idx_rs_conn ON requestStats(connectionId)',
    ],
  },
  // Normalized quota evidence, one row per (connection, window). The shape is
  // fixed by the Account Scheduling Contract: every provider's general-use quota
  // collapses into scope/remaining/limit/resetAt/observedAt/confidence, so a
  // five-hour, seven-day, thirty-day or future window is the same type and the
  // ranker in src/shared/utils/quotaRanking.js never learns provider dialects.
  // `limit` is a SQLite keyword, hence the quoted identifier; migrate.js
  // compares column names with the quotes stripped.
  quotaWindows: {
    columns: {
      connectionId: 'TEXT NOT NULL',
      // Provider window name verbatim, e.g. "session (5h)", "weekly (7d)".
      scope: 'TEXT NOT NULL',
      // Absolute units, not percentages — a percentage cannot express headroom
      // across windows whose limits differ by three orders of magnitude.
      remaining: 'REAL',
      '"limit"': 'REAL',
      // ISO-8601 UTC. NULL means the provider gave no reset evidence, which the
      // ranker treats as unusable entitlement rather than as usable-forever.
      resetAt: 'TEXT',
      observedAt: 'TEXT NOT NULL',
      // "fresh" | "stale" | "unknown". Unknown evidence stays selectable but
      // never outranks fresh known evidence (Scheduling Contract rule 2).
      confidence: "TEXT NOT NULL DEFAULT 'unknown'",
    },
    primaryKey: 'PRIMARY KEY (connectionId, scope)',
    indexes: [
      // "which window resets next across every account" drives reset-aware
      // repin (rule 5). Per-connection reads ride the primary key.
      'CREATE INDEX IF NOT EXISTS idx_qw_reset ON quotaWindows(resetAt)',
    ],
  },
  // Durable client-session to account affinity (Scheduling Contract rule 4).
  // A table rather than a Map because the pin must survive a process restart:
  // a session that re-pins on every boot is round-robin with extra steps.
  sessionAffinity: {
    columns: {
      ...SESSION_PIN_COLUMNS,
      // Salted hash of the client session identity. Never the raw identity,
      // never a credential, never a prompt body (rule 8).
      sessionHash: 'TEXT NOT NULL',
      model: 'TEXT NOT NULL',
      connectionId: 'TEXT NOT NULL',
      providerNode: 'TEXT',
      pinnedAt: 'TEXT NOT NULL',
      // NULL means no TTL; the pin then ends only on exhaustion, reset, drain
      // or model-specific failure.
      expiresAt: 'TEXT',
      lastSeenAt: 'TEXT NOT NULL',
    },
    primaryKey: 'PRIMARY KEY (sessionHash, model)',
    indexes: [
      // Draining or exhausting one account has to find every session pinned to
      // it in one pass.
      'CREATE INDEX IF NOT EXISTS idx_sa_conn ON sessionAffinity(connectionId)',
      // TTL sweep.
      'CREATE INDEX IF NOT EXISTS idx_sa_expires ON sessionAffinity(expiresAt)',
    ],
  },
  // Why a session left one account for another (Scheduling Contract rule 8).
  // An append-only receipt log: every switch records the evidence that caused
  // it, so a repin is auditable after the windows it was based on have moved on.
  accountSwitches: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      // Same salted hash the affinity row is keyed by. Never the raw identity.
      sessionHash: 'TEXT NOT NULL',
      model: 'TEXT NOT NULL',
      // NULL fromConnectionId means the first pin for this session (no switch
      // away from anything), which is still worth a receipt.
      fromConnectionId: 'TEXT',
      toConnectionId: 'TEXT NOT NULL',
      // "exhaustion" | "reset" | "drain" | "model-failure" | "initial-pin".
      trigger: 'TEXT NOT NULL',
      reason: 'TEXT',
      // JSON snapshot of the normalized windows the decision was made on, per
      // connection. Quota evidence only — rule 8 forbids secrets and prompt
      // bodies here, and nothing on this path ever sees either.
      windows: 'TEXT',
      switchedAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_as_session ON accountSwitches(sessionHash, switchedAt DESC)',
      'CREATE INDEX IF NOT EXISTS idx_as_conn ON accountSwitches(toConnectionId)',
      'CREATE INDEX IF NOT EXISTS idx_as_at ON accountSwitches(switchedAt DESC)',
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  if (def.constraints) cols.push(...def.constraints);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(', ')})`;
}
