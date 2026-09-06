// Fixtures are explicitly submitted local test inputs, never captured traffic.
// Terminal run results are immutable; pending runs are never replayed on restart.
export const COMPATIBILITY_TABLES = {
  compatibilityFixtures: {
    columns: {
      id: 'TEXT NOT NULL',
      revision: 'INTEGER NOT NULL CHECK (revision > 0)',
      ownerScope: 'TEXT NOT NULL',
      name: 'TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120)',
      definition: 'TEXT NOT NULL CHECK (length(CAST(definition AS BLOB)) <= 65536)',
      contentHash: 'TEXT NOT NULL',
      archived: 'INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))',
      createdAt: 'TEXT NOT NULL',
    },
    primaryKey: 'PRIMARY KEY (id, revision)',
    indexes: ['CREATE INDEX IF NOT EXISTS idx_compat_fixtures_owner ON compatibilityFixtures(ownerScope,createdAt DESC,id,revision DESC)'],
  },
  compatibilityRuns: {
    columns: {
      id: 'TEXT PRIMARY KEY', ownerScope: 'TEXT NOT NULL',
      fixtureId: 'TEXT NOT NULL', fixtureRevision: 'INTEGER NOT NULL CHECK (fixtureRevision > 0)',
      fixtureHash: 'TEXT NOT NULL',
      scope: "TEXT NOT NULL CHECK (scope = 'local-translation')",
      status: "TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','timed-out','interrupted'))",
      implementationVersion: 'TEXT NOT NULL', processOwner: 'TEXT NOT NULL',
      result: 'TEXT CHECK (result IS NULL OR length(CAST(result AS BLOB)) <= 524288)',
      error: 'TEXT', createdAt: 'TEXT NOT NULL', startedAt: 'TEXT', finishedAt: 'TEXT',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_compat_runs_owner ON compatibilityRuns(ownerScope,createdAt DESC,id)',
      'CREATE INDEX IF NOT EXISTS idx_compat_runs_fixture ON compatibilityRuns(fixtureId,fixtureRevision,createdAt DESC)',
      'CREATE INDEX IF NOT EXISTS idx_compat_runs_pending ON compatibilityRuns(processOwner,status)',
    ],
  },
};
