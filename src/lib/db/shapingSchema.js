// Immutable scoped profiles, offline results and operator promotion receipts.
// Common migration ownership remains with schema.js; importing has no effects.
export const SHAPING_TABLES = {
  shapingHandoffs: {
    columns: {
      id: 'TEXT PRIMARY KEY', sourceRequestId: 'TEXT NOT NULL', targetRequestId: 'TEXT NOT NULL', projectId: 'TEXT NOT NULL',
      targetClientKeyId: 'TEXT NOT NULL', targetClientRef: 'TEXT NOT NULL', targetProjectRef: 'TEXT NOT NULL', targetClientSessionRef: 'TEXT NOT NULL',
      summary: 'TEXT', contentHash: 'TEXT NOT NULL', createdAt: 'TEXT NOT NULL', expiresAt: 'TEXT NOT NULL', revokedAt: 'TEXT',
    },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_handoff_target ON shapingHandoffs(targetClientKeyId,targetClientRef,targetProjectRef,targetClientSessionRef,expiresAt)', 'CREATE INDEX IF NOT EXISTS idx_handoff_created ON shapingHandoffs(createdAt DESC,id)', 'CREATE INDEX IF NOT EXISTS idx_handoff_expiry_content ON shapingHandoffs(expiresAt) WHERE summary IS NOT NULL'],
  },
  contextHandoffApplications: {
    columns: { handoffId: 'TEXT NOT NULL REFERENCES shapingHandoffs(id)', requestId: 'TEXT NOT NULL REFERENCES requestStats(id) ON DELETE CASCADE',
      executionRequestId: 'TEXT NOT NULL', logicalRequestId: 'TEXT NOT NULL', appliedAt: 'TEXT NOT NULL' },
    primaryKey: 'PRIMARY KEY (handoffId,requestId)',
  },
  shapingEvaluationSets: {
    columns: {
      id: 'TEXT PRIMARY KEY', setId: 'TEXT NOT NULL', name: 'TEXT NOT NULL', revision: 'INTEGER NOT NULL',
      fixtures: 'TEXT NOT NULL', contentHash: 'TEXT NOT NULL', provenance: 'TEXT NOT NULL', createdAt: 'TEXT NOT NULL',
    },
    indexes: ['CREATE UNIQUE INDEX IF NOT EXISTS idx_shaping_evaluation_revision ON shapingEvaluationSets(setId,revision)', 'CREATE INDEX IF NOT EXISTS idx_shaping_evaluation_time ON shapingEvaluationSets(createdAt DESC,id)'],
  },
  shapingProfileVersions: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT', profileId: 'TEXT NOT NULL', name: 'TEXT NOT NULL',
      revision: 'INTEGER NOT NULL', settings: 'TEXT NOT NULL', consent: 'TEXT NOT NULL',
      contentHash: 'TEXT NOT NULL', createdAt: 'TEXT NOT NULL',
    },
    indexes: ['CREATE UNIQUE INDEX IF NOT EXISTS idx_shaping_profile_revision ON shapingProfileVersions(profileId, revision)', 'CREATE INDEX IF NOT EXISTS idx_shaping_profile_history ON shapingProfileVersions(id DESC)'],
  },
  shapingExperiments: {
    columns: {
      id: 'TEXT PRIMARY KEY', baselineVersionId: 'INTEGER NOT NULL REFERENCES shapingProfileVersions(id)',
      candidateVersionId: 'INTEGER NOT NULL REFERENCES shapingProfileVersions(id)', fixtureSetId: 'TEXT NOT NULL',
      result: 'TEXT NOT NULL', createdAt: 'TEXT NOT NULL',
    },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_shaping_experiments_time ON shapingExperiments(createdAt DESC, id)'],
  },
  shapingReceipts: {
    columns: {
      id: 'TEXT PRIMARY KEY', action: "TEXT NOT NULL CHECK (action IN ('promote', 'rollback'))",
      versionId: 'INTEGER NOT NULL REFERENCES shapingProfileVersions(id)', experimentId: 'TEXT REFERENCES shapingExperiments(id)',
      beforeSettings: 'TEXT NOT NULL', afterSettings: 'TEXT NOT NULL', beforeHash: 'TEXT NOT NULL', afterHash: 'TEXT NOT NULL',
      consent: 'TEXT NOT NULL', createdAt: 'TEXT NOT NULL',
    },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_shaping_receipts_time ON shapingReceipts(createdAt DESC, id)'],
  },
};
