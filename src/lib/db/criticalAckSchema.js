// Shared by schema registration and adapters used before repository migration.
export const CRITICAL_ACK_TABLES = {
  criticalAckState: {
    columns: {
      id: 'INTEGER PRIMARY KEY CHECK (id = 1)',
      epoch: 'TEXT NOT NULL',
      sequence: 'INTEGER NOT NULL CHECK (sequence >= 0)',
      lastMarkerSha256: 'TEXT NOT NULL',
    },
  },
  criticalAckMarkers: {
    columns: {
      sequence: 'INTEGER PRIMARY KEY CHECK (sequence > 0)',
      schemaVersion: 'INTEGER NOT NULL CHECK (schemaVersion = 1)',
      epoch: 'TEXT NOT NULL',
      transactionId: 'TEXT NOT NULL UNIQUE',
      processInstanceId: 'TEXT NOT NULL',
      pid: 'INTEGER NOT NULL',
      driver: 'TEXT NOT NULL',
      buildSha: 'TEXT',
      recordedAt: 'TEXT NOT NULL',
      previousMarkerSha256: 'TEXT NOT NULL',
      intentSha256: 'TEXT NOT NULL',
      mutationChanges: 'INTEGER NOT NULL CHECK (mutationChanges >= 0)',
      markerSha256: 'TEXT NOT NULL UNIQUE',
    },
  },
};

export const CRITICAL_ACK_TRIGGERS = ['UPDATE', 'DELETE'].map((operation) =>
  `CREATE TRIGGER IF NOT EXISTS critical_ack_markers_no_${operation.toLowerCase()}
   BEFORE ${operation} ON criticalAckMarkers BEGIN
     SELECT RAISE(ABORT, 'critical acknowledgment markers are immutable');
   END`,
);

export function ensureCriticalAckSchema(db) {
  for (const [name, { columns }] of Object.entries(CRITICAL_ACK_TABLES)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${Object.entries(columns).map(([column, type]) => `${column} ${type}`).join(', ')})`);
  }
  for (const sql of CRITICAL_ACK_TRIGGERS) db.exec(sql);
}
