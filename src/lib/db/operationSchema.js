// Events are retained separately from mutable current health and configuration.
export const OPERATION_TABLES = {
  operationEvents: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      operationId: 'TEXT NOT NULL',
      phase: "TEXT NOT NULL CHECK (phase IN ('configuration','process','reachability','authentication','inference'))",
      state: "TEXT NOT NULL CHECK (state IN ('started','succeeded','failed','cancelled','uncertain','conflict'))",
      source: 'TEXT NOT NULL',
      actorClass: "TEXT NOT NULL CHECK (actorClass IN ('operator','background','gateway','unverified'))",
      subjectKind: 'TEXT NOT NULL',
      subjectId: 'TEXT NOT NULL',
      provider: 'TEXT',
      connectionId: 'TEXT',
      requestId: 'INTEGER',
      logicalRequestId: 'TEXT',
      occurredAt: 'TEXT NOT NULL',
      capturedAt: 'TEXT NOT NULL',
      code: 'TEXT',
      details: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_operation_events_captured ON operationEvents(capturedAt, id)',
      'CREATE INDEX IF NOT EXISTS idx_operation_events_subject ON operationEvents(subjectKind, subjectId, id)',
      'CREATE INDEX IF NOT EXISTS idx_operation_events_connection ON operationEvents(connectionId, id)',
      'CREATE INDEX IF NOT EXISTS idx_operation_events_provider ON operationEvents(provider, id)',
      'CREATE INDEX IF NOT EXISTS idx_operation_events_request ON operationEvents(requestId, id)',
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_events_start ON operationEvents(operationId, phase) WHERE state = 'started'",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_events_terminal ON operationEvents(operationId, phase) WHERE state != 'started'",
    ],
  },
};
