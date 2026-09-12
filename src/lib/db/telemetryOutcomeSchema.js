// Origins describe trusted ingestion context. Client headers never set them.
export const TELEMETRY_ORIGIN_COLUMNS = {
  dataOrigin: "TEXT NOT NULL DEFAULT 'unknown' CHECK (dataOrigin IN ('production','test','import','unknown'))",
  originReceiptId: 'TEXT',
};

const STATE = "TEXT NOT NULL CHECK (state IN ('pending','succeeded','failed','cancelled','interrupted','unknown'))";
const DURATION = 'REAL CHECK (durationMs IS NULL OR durationMs >= 0)';

export const TELEMETRY_OUTCOME_TABLES = {
  logicalRequestOutcomes: {
    columns: {
      logicalRequestId: 'TEXT PRIMARY KEY',
      state: STATE,
      firstObservedAt: 'TEXT NOT NULL',
      terminalAt: 'TEXT',
      attemptCount: 'INTEGER NOT NULL DEFAULT 0 CHECK (attemptCount >= 0)',
      terminalAttemptId: 'TEXT',
      terminalStatus: 'INTEGER',
      endToEndDurationMs: 'REAL CHECK (endToEndDurationMs IS NULL OR endToEndDurationMs >= 0)',
      durationSource: "TEXT NOT NULL DEFAULT 'unknown' CHECK (durationSource IN ('backend-monotonic','unknown'))",
      clockDomain: 'TEXT NOT NULL',
      ...TELEMETRY_ORIGIN_COLUMNS,
      updatedAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_logical_outcome_started ON logicalRequestOutcomes(firstObservedAt,logicalRequestId)',
      "CREATE INDEX IF NOT EXISTS idx_logical_outcome_pending ON logicalRequestOutcomes(clockDomain,updatedAt) WHERE state='pending'",
    ],
  },
  frontRequestOutcomes: {
    columns: {
      frontIngressId: 'TEXT PRIMARY KEY',
      logicalRequestId: 'TEXT',
      state: STATE,
      firstObservedAt: 'TEXT NOT NULL',
      terminalAt: 'TEXT',
      queueDurationMs: 'REAL CHECK (queueDurationMs IS NULL OR queueDurationMs >= 0)',
      endToEndDurationMs: 'REAL CHECK (endToEndDurationMs IS NULL OR endToEndDurationMs >= 0)',
      terminalStatus: 'INTEGER',
      clockDomain: 'TEXT NOT NULL',
      receiptId: 'TEXT NOT NULL',
      ...TELEMETRY_ORIGIN_COLUMNS,
      updatedAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_front_outcome_logical ON frontRequestOutcomes(logicalRequestId) WHERE logicalRequestId IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_front_outcome_started ON frontRequestOutcomes(firstObservedAt,frontIngressId)',
    ],
  },
  requestTimingSpans: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      logicalRequestId: 'TEXT',
      attemptRequestId: 'TEXT',
      frontIngressId: 'TEXT',
      processRole: "TEXT NOT NULL CHECK (processRole IN ('front','backend'))",
      stage: "TEXT NOT NULL CHECK (stage IN ('queue','selection','preparation','retry-wait','dispatch','response-headers','stream'))",
      ordinal: 'INTEGER NOT NULL CHECK (ordinal >= 0)',
      relation: "TEXT NOT NULL CHECK (relation IN ('sequential','overlap'))",
      clockDomain: 'TEXT NOT NULL',
      durationMs: DURATION,
      outcome: 'TEXT NOT NULL',
      recordedAt: 'TEXT NOT NULL',
      ...TELEMETRY_ORIGIN_COLUMNS,
    },
    constraints: ["CHECK (logicalRequestId IS NOT NULL OR frontIngressId IS NOT NULL)"],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_request_span_logical ON requestTimingSpans(logicalRequestId,ordinal,id)',
      'CREATE INDEX IF NOT EXISTS idx_request_span_attempt ON requestTimingSpans(attemptRequestId,ordinal)',
      'CREATE INDEX IF NOT EXISTS idx_request_span_front ON requestTimingSpans(frontIngressId,ordinal)',
    ],
  },
  telemetryQuarantineReceipts: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      reasonCode: 'TEXT NOT NULL',
      evidenceSha256: 'TEXT NOT NULL',
      selectorSha256: 'TEXT NOT NULL',
      expectedRows: 'INTEGER NOT NULL CHECK (expectedRows >= 0)',
      actualRows: 'INTEGER NOT NULL CHECK (actualRows >= 0)',
      state: "TEXT NOT NULL CHECK (state IN ('active','reverted'))",
      createdAt: 'TEXT NOT NULL',
      revertedAt: 'TEXT',
      metadata: 'TEXT',
    },
  },
  telemetryQuarantineRows: {
    columns: {
      receiptId: 'TEXT NOT NULL REFERENCES telemetryQuarantineReceipts(id)',
      sourceTable: "TEXT NOT NULL CHECK (sourceTable IN ('requestStats','usageHistory'))",
      rowId: 'TEXT NOT NULL',
      rowFingerprint: 'TEXT NOT NULL',
      quarantinedAt: 'TEXT NOT NULL',
    },
    primaryKey: 'PRIMARY KEY (receiptId,sourceTable,rowId)',
    indexes: ['CREATE INDEX IF NOT EXISTS idx_quarantine_source_row ON telemetryQuarantineRows(sourceTable,rowId,receiptId)'],
  },
};
