// Additive evidence schema. Historical records intentionally retain NULLs.
export const REQUEST_IDENTITY_COLUMNS = {
  clientKeyId: "TEXT",
  clientRef: "TEXT",
  clientSessionRef: "TEXT",
  taskRef: "TEXT",
  projectRef: "TEXT",
  clientIdentitySource: "TEXT",
};

export const CONTEXT_EVIDENCE_TABLES = {
  contextStructures: {
    columns: {
      requestId: "TEXT NOT NULL REFERENCES requestStats(id) ON DELETE CASCADE",
      boundary: "TEXT NOT NULL",
      version: "INTEGER NOT NULL",
      data: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (requestId, boundary)",
  },
  contextClientEvents: {
    columns: {
      id: "TEXT PRIMARY KEY",
      clientKeyId: "TEXT NOT NULL",
      clientEventId: "TEXT NOT NULL",
      occurredAt: "TEXT NOT NULL",
      recordedAt: "TEXT NOT NULL",
      type: "TEXT NOT NULL",
      source: "TEXT NOT NULL DEFAULT 'client-reported'",
      requestId: "TEXT REFERENCES requestStats(id) ON DELETE SET NULL",
      contextSessionId: "INTEGER REFERENCES contextSessions(id) ON DELETE SET NULL",
      logicalRequestId: "TEXT",
      clientRef: "TEXT NOT NULL",
      clientSessionRef: "TEXT",
      taskRef: "TEXT",
      projectRef: "TEXT",
      targetClientRef: "TEXT",
      targetTaskRef: "TEXT",
      outcome: "TEXT",
      beforeTokens: "INTEGER",
      afterTokens: "INTEGER",
      tokenMeasurementMethod: "TEXT",
      payloadHash: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_cce_idempotency ON contextClientEvents(clientKeyId, clientEventId)",
      "CREATE INDEX IF NOT EXISTS idx_cce_time ON contextClientEvents(occurredAt DESC, id)",
      "CREATE INDEX IF NOT EXISTS idx_cce_session ON contextClientEvents(contextSessionId, occurredAt DESC, id)",
      "CREATE INDEX IF NOT EXISTS idx_cce_request ON contextClientEvents(requestId)",
      "CREATE INDEX IF NOT EXISTS idx_cce_logical ON contextClientEvents(logicalRequestId, occurredAt DESC, id)",
      "CREATE INDEX IF NOT EXISTS idx_cce_task ON contextClientEvents(taskRef, occurredAt DESC, id)",
      "CREATE INDEX IF NOT EXISTS idx_cce_project ON contextClientEvents(projectRef, occurredAt DESC, id)",
      "CREATE INDEX IF NOT EXISTS idx_cce_client ON contextClientEvents(clientRef, occurredAt DESC, id)",
    ],
  },
};

export const REQUEST_IDENTITY_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_rs_client_key ON requestStats(clientKeyId, timestamp, id)",
  "CREATE INDEX IF NOT EXISTS idx_rs_client_ref ON requestStats(clientRef, timestamp, id)",
  "CREATE INDEX IF NOT EXISTS idx_rs_client_session ON requestStats(clientSessionRef, timestamp, id)",
  "CREATE INDEX IF NOT EXISTS idx_rs_task_ref ON requestStats(taskRef, timestamp, id)",
  "CREATE INDEX IF NOT EXISTS idx_rs_project_ref ON requestStats(projectRef, timestamp, id)",
];
