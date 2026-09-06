// Immutable scoped profiles, offline results and operator promotion receipts.
// Common migration ownership remains with schema.js; importing has no effects.
export const SHAPING_TABLES = {
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
