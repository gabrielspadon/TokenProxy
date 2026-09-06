// Schema fragment integrated into TABLES by the migration owner. Documents and
// receipts are append-only; only a draft's head advances to a new revision.
export const CONFIG_VERSION_TABLES = {
  configVersions: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      scope: 'TEXT NOT NULL',
      kind: "TEXT NOT NULL CHECK (kind IN ('snapshot', 'draft', 'activation', 'rollback', 'direct'))",
      parentVersionId: 'INTEGER REFERENCES configVersions(id)',
      draftId: 'TEXT',
      revision: 'INTEGER',
      contentHash: 'TEXT NOT NULL',
      document: 'TEXT NOT NULL',
      provenance: 'TEXT NOT NULL',
      createdAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_config_versions_scope ON configVersions(scope, id DESC)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_config_versions_draft_revision ON configVersions(draftId, revision) WHERE draftId IS NOT NULL',
    ],
  },
  configDrafts: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      scope: 'TEXT NOT NULL',
      baseHash: 'TEXT NOT NULL',
      currentVersionId: 'INTEGER NOT NULL REFERENCES configVersions(id)',
      revision: 'INTEGER NOT NULL CHECK (revision > 0)',
      createdAt: 'TEXT NOT NULL',
      updatedAt: 'TEXT NOT NULL',
    },
    indexes: ['CREATE INDEX IF NOT EXISTS idx_config_drafts_scope ON configDrafts(scope, updatedAt DESC, id)'],
  },
  configReceipts: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      operationId: 'TEXT NOT NULL',
      scope: 'TEXT NOT NULL',
      action: 'TEXT NOT NULL',
      outcome: "TEXT NOT NULL CHECK (outcome IN ('staged', 'applied', 'failed', 'partial', 'conflict'))",
      beforeVersionId: 'INTEGER REFERENCES configVersions(id)',
      afterVersionId: 'INTEGER REFERENCES configVersions(id)',
      targetVersionId: 'INTEGER REFERENCES configVersions(id)',
      beforeHash: 'TEXT',
      afterHash: 'TEXT',
      details: 'TEXT NOT NULL',
      provenance: 'TEXT NOT NULL',
      createdAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_config_receipts_scope ON configReceipts(scope, id DESC)',
      'CREATE INDEX IF NOT EXISTS idx_config_receipts_operation ON configReceipts(operationId, id)',
    ],
  },
};
