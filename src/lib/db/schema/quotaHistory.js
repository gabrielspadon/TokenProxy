// Additive history only. No backfill or initialization side effects.
export const QUOTA_CHECK_OUTCOME_COLUMNS = {
  targetModel: 'TEXT',
  outcome: 'TEXT',
  resourceType: 'TEXT',
  unit: 'TEXT',
  observationId: 'TEXT',
};

export const QUOTA_HISTORY_TABLES = {
  quotaObservations: {
    columns: {
      id: "TEXT PRIMARY KEY",
      connectionId: "TEXT NOT NULL",
      provider: "TEXT",
      scope: "TEXT NOT NULL",
      source: "TEXT NOT NULL",
      observationKind: "TEXT NOT NULL",
      resourceType: "TEXT",
      unit: "TEXT",
      remaining: "REAL",
      '"limit"': "REAL",
      percentage: "REAL",
      resetAt: "TEXT",
      observedAt: "TEXT",
      capturedAt: "TEXT NOT NULL",
      confidence: "TEXT NOT NULL",
      windowDurationMs: "INTEGER",
      windowType: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_qo_connection_observed ON quotaObservations(connectionId, observedAt, capturedAt, id)",
      "CREATE INDEX IF NOT EXISTS idx_qo_provider_scope_captured ON quotaObservations(provider, scope, capturedAt, id)",
      "CREATE INDEX IF NOT EXISTS idx_qo_captured ON quotaObservations(capturedAt, id)",
    ],
  },
  quotaCheckEvents: {
    columns: {
      ...QUOTA_CHECK_OUTCOME_COLUMNS,
      jobId: "TEXT",
      id: "TEXT PRIMARY KEY",
      checkId: "TEXT NOT NULL",
      connectionId: "TEXT NOT NULL",
      provider: "TEXT",
      scope: "TEXT",
      source: "TEXT NOT NULL",
      eventType: "TEXT NOT NULL",
      scheduledFor: "TEXT",
      resetAt: "TEXT",
      observedAt: "TEXT",
      capturedAt: "TEXT NOT NULL",
      code: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_qce_connection_captured ON quotaCheckEvents(connectionId, capturedAt, id)",
      "CREATE INDEX IF NOT EXISTS idx_qce_check_captured ON quotaCheckEvents(checkId, capturedAt, id)",
      "CREATE INDEX IF NOT EXISTS idx_qce_captured ON quotaCheckEvents(capturedAt, id)",
    ],
  },
  quotaCheckJobs: {
    columns: {
      id: 'TEXT PRIMARY KEY', connectionId: 'TEXT NOT NULL', provider: 'TEXT NOT NULL',
      status: 'TEXT NOT NULL', nextCheckAt: 'TEXT NOT NULL', reason: 'TEXT NOT NULL',
      targets: "TEXT NOT NULL DEFAULT '[]'", claimToken: 'TEXT', checkId: 'TEXT',
      leaseExpiresAt: 'TEXT', startedAt: 'TEXT', finishedAt: 'TEXT',
      lastOutcome: 'TEXT', cancelReason: 'TEXT', createdAt: 'TEXT NOT NULL', updatedAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_qcj_due ON quotaCheckJobs(status,nextCheckAt,id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_qcj_account ON quotaCheckJobs(connectionId,provider)',
    ],
  },
};
