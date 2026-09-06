export const SESSION_PIN_COLUMNS = { operatorExpiresAt: 'TEXT' };

// Audit records survive pin expiry, clearing, and telemetry retention.
export const SESSION_PIN_TABLES = {
  sessionPinActions: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      version: 'INTEGER NOT NULL',
      sessionHash: 'TEXT NOT NULL',
      model: 'TEXT NOT NULL',
      action: 'TEXT NOT NULL',
      targetConnectionId: 'TEXT',
      deadline: 'TEXT',
      expectedRevision: 'TEXT NOT NULL',
      expectedBinding: 'TEXT NOT NULL',
      status: 'TEXT NOT NULL',
      reason: 'TEXT',
      beforeState: 'TEXT NOT NULL',
      afterState: 'TEXT',
      preview: 'TEXT NOT NULL',
      createdAt: 'TEXT NOT NULL',
      previewExpiresAt: 'TEXT NOT NULL',
      appliedAt: 'TEXT',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_spa_pin ON sessionPinActions(sessionHash, model, createdAt DESC)',
      'CREATE INDEX IF NOT EXISTS idx_spa_created ON sessionPinActions(createdAt DESC, id)',
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_spa_queued ON sessionPinActions(sessionHash, model) WHERE status = 'queued'",
    ],
  },
};
