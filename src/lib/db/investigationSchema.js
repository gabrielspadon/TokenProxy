// Saved operator workspaces contain validated references, never request bodies.
export const INVESTIGATION_TABLES = {
  investigations: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      ownerScope: 'TEXT NOT NULL',
      kind: "TEXT NOT NULL CHECK (kind IN ('investigation','filter-set','bookmark'))",
      name: 'TEXT NOT NULL',
      definition: 'TEXT NOT NULL',
      version: 'INTEGER NOT NULL CHECK (version > 0)',
      createdAt: 'TEXT NOT NULL',
      updatedAt: 'TEXT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_investigations_owner ON investigations(ownerScope,updatedAt DESC,id)',
    ],
  },
};
