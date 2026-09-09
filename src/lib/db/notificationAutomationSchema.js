export const NOTIFICATION_AUTOMATION_TABLES = {
  notificationActionPolicies: {
    columns: {
      ruleId: 'TEXT PRIMARY KEY', revision: 'INTEGER NOT NULL CHECK (revision > 0)', ruleRevision: 'INTEGER NOT NULL',
      connectionId: 'TEXT NOT NULL', action: "TEXT NOT NULL CHECK (action='drain-account')", enabled: 'INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1))',
      cooldownSeconds: 'INTEGER NOT NULL CHECK (cooldownSeconds BETWEEN 60 AND 86400)', dailyLimit: 'INTEGER NOT NULL CHECK (dailyLimit BETWEEN 1 AND 10)',
      maxEvidenceAgeSeconds: 'INTEGER NOT NULL CHECK (maxEvidenceAgeSeconds BETWEEN 60 AND 3600)', createdAt: 'TEXT NOT NULL', updatedAt: 'TEXT NOT NULL',
    },
  },
  notificationActionPolicyVersions: {
    columns: { ruleId: 'TEXT NOT NULL', revision: 'INTEGER NOT NULL', definition: 'TEXT NOT NULL', createdAt: 'TEXT NOT NULL' },
    primaryKey: 'PRIMARY KEY (ruleId,revision)',
  },
  notificationActions: {
    columns: {
      id: 'TEXT PRIMARY KEY', eventId: 'TEXT NOT NULL UNIQUE', ruleId: 'TEXT NOT NULL', policyRevision: 'INTEGER NOT NULL',
      connectionId: 'TEXT NOT NULL', policy: 'TEXT NOT NULL', beforeState: 'TEXT NOT NULL', afterState: 'TEXT',
      state: "TEXT NOT NULL CHECK (state IN ('queued','applied','skipped','conflict','rolled-back'))",
      reasonCode: 'TEXT', createdAt: 'TEXT NOT NULL', appliedAt: 'TEXT', updatedAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_notification_actions_queue ON notificationActions(state,createdAt,id)',
      'CREATE INDEX IF NOT EXISTS idx_notification_actions_rule_applied ON notificationActions(ruleId,appliedAt)',
      'CREATE INDEX IF NOT EXISTS idx_notification_actions_applied ON notificationActions(appliedAt)',
      'CREATE INDEX IF NOT EXISTS idx_notification_actions_history ON notificationActions(createdAt,id)',
      'CREATE INDEX IF NOT EXISTS idx_notification_actions_rule_history ON notificationActions(ruleId,createdAt,id)',
    ],
  },
  notificationActionReceipts: {
    columns: { id: 'INTEGER PRIMARY KEY AUTOINCREMENT', actionId: 'TEXT NOT NULL', operation: 'TEXT NOT NULL', outcome: 'TEXT NOT NULL', reasonCode: 'TEXT', details: 'TEXT NOT NULL', createdAt: 'TEXT NOT NULL' },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_notification_action_receipts ON notificationActionReceipts(actionId,id)'],
  },
};
