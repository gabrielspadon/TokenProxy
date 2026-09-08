import { REQUEST_IDENTITY_COLUMNS } from './contextEvidenceSchema.js';

// Historical identities are never filled by similarity or by a later binding.
export const USAGE_PROJECT_COLUMNS = {
  ...REQUEST_IDENTITY_COLUMNS,
  projectBindingId: 'TEXT',
  projectPolicyRevision: 'INTEGER',
};
export const PROJECT_RESERVATION_COLUMNS = {
  ...REQUEST_IDENTITY_COLUMNS,
  projectId: 'TEXT',
  projectBindingId: 'TEXT',
  projectPolicyRevision: 'INTEGER',
  projectBudgetPolicy: 'TEXT',
  projectBudgetMode: 'TEXT',
  projectReservedPromptTokens: 'INTEGER',
  projectReservedCompletionTokens: 'INTEGER',
  projectReservedCostUsd: 'REAL',
};
export const PROJECT_TABLES = {
  projects: {
    columns: {
      id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', revision: 'INTEGER NOT NULL',
      createdAt: 'TEXT NOT NULL', updatedAt: 'TEXT NOT NULL', archived: 'INTEGER NOT NULL DEFAULT 0',
      maxPromptTokens: 'INTEGER', maxCompletionTokens: 'INTEGER', maxCostUsd: 'REAL',
      budgetPolicy: "TEXT NOT NULL DEFAULT 'strict'", budgetMode: "TEXT NOT NULL DEFAULT 'enforce'",
      alertPercent: 'REAL', alertCooldownSeconds: 'INTEGER NOT NULL DEFAULT 3600',
    },
  },
  projectBindings: {
    columns: {
      id: 'TEXT PRIMARY KEY', projectId: 'TEXT NOT NULL', apiKeyId: 'TEXT NOT NULL',
      clientRef: 'TEXT NOT NULL', projectRef: 'TEXT NOT NULL', createdAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_project_binding_identity ON projectBindings(apiKeyId,clientRef,projectRef)',
      'CREATE INDEX IF NOT EXISTS idx_project_binding_project ON projectBindings(projectId,id)',
    ],
  },
  projectPolicyVersions: {
    columns: {
      projectId: 'TEXT NOT NULL', revision: 'INTEGER NOT NULL', changedAt: 'TEXT NOT NULL',
      change: 'TEXT NOT NULL', document: 'TEXT NOT NULL',
    },
    primaryKey: 'PRIMARY KEY (projectId, revision)',
  },
  projectBudgetAccounts: {
    columns: {
      projectId: 'TEXT PRIMARY KEY', recordedPromptTokens: 'INTEGER NOT NULL DEFAULT 0',
      recordedCompletionTokens: 'INTEGER NOT NULL DEFAULT 0', recordedCostUsd: 'REAL NOT NULL DEFAULT 0',
      unknownPromptRows: 'INTEGER NOT NULL DEFAULT 0', unknownCompletionRows: 'INTEGER NOT NULL DEFAULT 0',
      unknownCostRows: 'INTEGER NOT NULL DEFAULT 0', initializedAt: 'TEXT NOT NULL', historyThroughId: 'INTEGER NOT NULL DEFAULT 0',
    },
  },
  projectBudgetAlerts: {
    columns: {
      id: 'TEXT PRIMARY KEY', projectId: 'TEXT NOT NULL', policyRevision: 'INTEGER NOT NULL',
      firedAt: 'TEXT NOT NULL', evidence: 'TEXT NOT NULL',
    },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_project_alert_time ON projectBudgetAlerts(projectId,firedAt,id)'],
  },
  projectBudgetUsageHours: {
    columns: {
      projectId: 'TEXT NOT NULL', hour: 'TEXT NOT NULL', records: 'INTEGER NOT NULL DEFAULT 0',
      promptTokens: 'INTEGER NOT NULL DEFAULT 0', completionTokens: 'INTEGER NOT NULL DEFAULT 0',
      costUsd: 'REAL NOT NULL DEFAULT 0', knownCostRecords: 'INTEGER NOT NULL DEFAULT 0',
      unknownPromptRows: 'INTEGER NOT NULL DEFAULT 0', unknownCompletionRows: 'INTEGER NOT NULL DEFAULT 0',
      historyThroughId: 'INTEGER NOT NULL DEFAULT 0',
    },
    primaryKey: 'PRIMARY KEY (projectId, hour)',
  },
};
export const PROJECT_USAGE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_uh_project_time ON usageHistory(projectId,timestamp,id)',
  'CREATE INDEX IF NOT EXISTS idx_uh_client_project ON usageHistory(clientKeyId,clientRef,projectRef,id)',
];
export const PROJECT_RESERVATION_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_budget_project_state ON apiKeyBudgetReservations(projectId,state)',
];
